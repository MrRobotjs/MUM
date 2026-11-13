package plex

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"app/server/providers/provider"
)

// Plex movie/show catalogue. MUM's core pins the library kind and revisions
// around these reads.

// CatalogueLibrarySupported: Plex catalogues numeric movie and show sections.
func (s *Server) CatalogueLibrarySupported(kind, section string) bool {
	return NumericID(section) && (kind == "movie" || kind == "show")
}

// ValidPoster reports whether path is the item's own poster (optionally
// versioned).
func ValidPoster(item, path string) bool {
	if !NumericID(item) {
		return false
	}
	base := "/library/metadata/" + item + "/thumb"
	if path == base {
		return true
	}
	if !strings.HasPrefix(path, base+"/") {
		return false
	}
	version := strings.TrimPrefix(path, base+"/")
	return version == "0" || NumericID(version)
}

// validCollectionPoster accepts a collection's generated composite or custom
// poster, either way bound to the collection's own rating key.
func validCollectionPoster(collection, path string) bool {
	if ValidPoster(collection, path) {
		return true
	}
	base := "/library/collections/" + collection + "/composite/"
	return NumericID(collection) && strings.HasPrefix(path, base) && NumericID(strings.TrimPrefix(path, base))
}

// catalogueGet reads one catalogue page or poster with header-only
// credentials, a 15-second bound and at most max bytes. start >= 0 requests
// one page of that offset.
func (s *Server) catalogueGet(ctx context.Context, path, accept string, start int, max int64, allowType func(string) bool) (string, []byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.url+path, nil)
	if err != nil {
		return "", nil, errors.New("invalid Plex catalogue request")
	}
	req.Header.Set("Accept", accept)
	req.Header.Set("X-Plex-Token", s.token)
	req.Header.Set("X-Plex-Client-Identifier", DefaultClientID)
	if start >= 0 {
		req.Header.Set("X-Plex-Container-Start", strconv.Itoa(start))
		req.Header.Set("X-Plex-Container-Size", strconv.Itoa(provider.CataloguePageSize))
	}
	kind, body, err := s.transport.Fetch(req, max, allowType)
	switch {
	case errors.Is(err, provider.ErrRequestFailed):
		return "", nil, errors.New("Plex catalogue request failed or timed out")
	case errors.Is(err, provider.ErrUnreadableBody):
		return "", nil, errors.New("Plex catalogue response is empty, oversized or unreadable")
	case errors.Is(err, provider.ErrUnsupportedType):
		return "", nil, errors.New("unsupported Plex catalogue image type")
	case err != nil:
		return "", nil, err
	}
	return kind, body, nil
}

// CatalogueEntry is one item or directory in a catalogue page.
type CatalogueEntry struct {
	XMLName   xml.Name
	ID        string   `xml:"ratingKey,attr"`
	Kind      string   `xml:"type,attr"`
	Title     string   `xml:"title,attr"`
	SortTitle string   `xml:"titleSort,attr"`
	Summary   string   `xml:"summary,attr"`
	Section   string   `xml:"librarySectionID,attr"`
	Poster    string   `xml:"thumb,attr"`
	Year      *int64   `xml:"year,attr"`
	Rating    *float64 `xml:"rating,attr"`
	Duration  *int64   `xml:"duration,attr"`
	Added     *int64   `xml:"addedAt,attr"`
	Children  *int64   `xml:"childCount,attr"`
	Smart     string   `xml:"smart,attr"`
	// Episodes only: their show, season number and episode number.
	Show        string `xml:"grandparentRatingKey,attr"`
	SeasonIndex *int64 `xml:"parentIndex,attr"`
	Index       *int64 `xml:"index,attr"`
}

// CataloguePage is one page of a section listing.
type CataloguePage struct {
	XMLName xml.Name         `xml:"MediaContainer"`
	Size    *int             `xml:"size,attr"`
	Total   *int             `xml:"totalSize,attr"`
	Offset  *int             `xml:"offset,attr"`
	Section string           `xml:"librarySectionID,attr"`
	Items   []CatalogueEntry `xml:",any"`
}

// DecodeCataloguePage decodes a Plex MediaContainer strictly. encoding/xml
// ignores unknown fields and permits duplicate attributes, so ambiguity, extra
// roots and excessive nesting are refused before decoding values.
func DecodeCataloguePage(body []byte) (CataloguePage, error) {
	var page CataloguePage
	decoder := xml.NewDecoder(bytes.NewReader(body))
	depth, roots := 0, 0
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return page, errors.New("invalid Plex catalogue XML")
		}
		switch node := token.(type) {
		case xml.StartElement:
			if depth == 0 {
				roots++
			}
			depth++
			if depth > 64 || node.Name.Space != "" {
				return page, errors.New("unsupported Plex catalogue XML structure")
			}
			seen := map[xml.Name]bool{}
			for _, attr := range node.Attr {
				if seen[attr.Name] || attr.Name.Space != "" {
					return page, errors.New("ambiguous Plex catalogue XML attributes")
				}
				seen[attr.Name] = true
			}
		case xml.EndElement:
			depth--
		case xml.Directive:
			return page, errors.New("unsupported Plex catalogue XML directive")
		case xml.CharData:
			if depth <= 1 && strings.TrimSpace(string(node)) != "" {
				return page, errors.New("invalid Plex catalogue XML content")
			}
		}
	}
	if roots != 1 || depth != 0 {
		return page, errors.New("invalid Plex catalogue XML roots")
	}
	if err := xml.Unmarshal(body, &page); err != nil {
		return page, errors.New("invalid Plex catalogue fields")
	}
	return page, nil
}

// pages reads every page of one listing and hands each entry to visit. Plex
// has no snapshot isolation, so missing or inconsistent paging, a changed
// total, a mis-scoped page or a short final count rejects the whole snapshot.
// A listing outside one known section (a show's episodes) passes section ""
// and must then keep to whichever single section its first page reports.
func (s *Server) pages(ctx context.Context, path, section string, max int, query url.Values, progress func(fetched, total int), visit func(CatalogueEntry) error) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	total, read := -1, 0
	for start := 0; ; {
		_, body, err := s.catalogueGet(ctx, path+"?"+query.Encode(), "application/xml", start, 16<<20, nil)
		if err != nil {
			return err
		}
		page, err := DecodeCataloguePage(body)
		if err != nil {
			return err
		}
		if section == "" && NumericID(page.Section) {
			section = page.Section
		}
		if page.Size == nil || page.Total == nil || page.Offset == nil || *page.Total < 0 || *page.Total > max || *page.Size < 0 || *page.Size > provider.CataloguePageSize || *page.Size != len(page.Items) || *page.Offset != start || page.Section != "" && page.Section != section {
			return errors.New("invalid Plex catalogue pagination or section")
		}
		if total >= 0 && total != *page.Total {
			return errors.New("Plex catalogue changed during synchronization")
		}
		total = *page.Total
		for _, row := range page.Items {
			if section == "" && NumericID(row.Section) {
				section = row.Section
			}
			if row.Section != "" && row.Section != section {
				return errors.New("mis-scoped Plex catalogue entry")
			}
			if err := visit(row); err != nil {
				return err
			}
		}
		read += len(page.Items)
		if read > total {
			return errors.New("Plex catalogue exceeds reported total")
		}
		if progress != nil {
			progress(read, total)
		}
		if read == total {
			return nil
		}
		if len(page.Items) == 0 {
			return errors.New("Plex catalogue ended before its reported total")
		}
		start += len(page.Items)
	}
}

func addedAt(added *int64) string {
	if added != nil && *added >= 0 && *added <= 253402300799 {
		return provider.Timestamp(time.Unix(*added, 0))
	}
	return ""
}

// CatalogueItems reads a movie or show section's complete item list.
func (s *Server) CatalogueItems(ctx context.Context, section, kind string, progress func(fetched, total int)) ([]provider.CatalogueItem, error) {
	if !s.CatalogueLibrarySupported(kind, section) {
		return nil, provider.ErrCatalogueUnsupported
	}
	itemType, element := "1", "Video"
	if kind == "show" {
		itemType, element = "2", "Directory"
	}
	items := []provider.CatalogueItem{}
	seen := map[string]bool{}
	query := url.Values{"type": {itemType}, "includeCollections": {"0"}, "sort": {"titleSort:asc"}}
	err := s.pages(ctx, "/library/sections/"+section+"/all", section, provider.CatalogueMaxItems, query, progress, func(row CatalogueEntry) error {
		title := provider.TruncateRunes(row.Title, 512)
		if row.XMLName.Local != element || row.Kind != kind || !NumericID(row.ID) || seen[row.ID] || title == "" || row.Poster != "" && !ValidPoster(row.ID, row.Poster) {
			return errors.New("invalid, duplicate or mis-scoped Plex catalogue item")
		}
		seen[row.ID] = true
		item := provider.CatalogueItem{ID: row.ID, Type: kind, Title: title, SortTitle: provider.TruncateRunes(row.SortTitle, 512), Summary: provider.TruncateRunes(row.Summary, 8000), ImageTag: row.Poster}
		if item.SortTitle == "" {
			item.SortTitle = title
		}
		if row.Year != nil && *row.Year > 0 && *row.Year < 10000 {
			item.Year = row.Year
		}
		if row.Rating != nil && !math.IsNaN(*row.Rating) && !math.IsInf(*row.Rating, 0) && *row.Rating >= 0 && *row.Rating <= 10 {
			item.Rating = row.Rating
		}
		if row.Duration != nil && *row.Duration >= 0 {
			item.DurationMS = row.Duration
		}
		item.AddedAt = addedAt(row.Added)
		items = append(items, item)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return items, nil
}

// CatalogueEpisodes reads one show's complete episode list: every episode of
// every season, from the show's "all leaves" listing. Each episode must be its
// own numbered item of that show; anything else rejects the snapshot. A
// thumbnail that is not the episode's own is dropped rather than stored, so it
// is never fetched.
func (s *Server) CatalogueEpisodes(ctx context.Context, show string) ([]provider.CatalogueItem, error) {
	if !NumericID(show) {
		return nil, errors.New("invalid Plex show identifier")
	}
	items := []provider.CatalogueItem{}
	seen := map[string]bool{}
	err := s.pages(ctx, "/library/metadata/"+show+"/allLeaves", "", provider.CatalogueMaxEpisodes, url.Values{}, nil, func(row CatalogueEntry) error {
		title := provider.TruncateRunes(row.Title, 512)
		if row.XMLName.Local != "Video" || row.Kind != "episode" || !NumericID(row.ID) || seen[row.ID] || row.Show != show || title == "" {
			return errors.New("invalid, duplicate or mis-scoped Plex episode")
		}
		seen[row.ID] = true
		item := provider.CatalogueItem{ID: row.ID, Type: "episode", Title: title, SortTitle: provider.TruncateRunes(row.SortTitle, 512), Summary: provider.TruncateRunes(row.Summary, 8000)}
		if item.SortTitle == "" {
			item.SortTitle = title
		}
		if ValidPoster(row.ID, row.Poster) {
			item.ImageTag = row.Poster
		}
		if row.Year != nil && *row.Year > 0 && *row.Year < 10000 {
			item.Year = row.Year
		}
		if row.Rating != nil && !math.IsNaN(*row.Rating) && !math.IsInf(*row.Rating, 0) && *row.Rating >= 0 && *row.Rating <= 10 {
			item.Rating = row.Rating
		}
		if row.Duration != nil && *row.Duration >= 0 {
			item.DurationMS = row.Duration
		}
		if row.SeasonIndex != nil && *row.SeasonIndex >= 0 && *row.SeasonIndex <= 100000 {
			item.Season = row.SeasonIndex
		}
		if row.Index != nil && *row.Index >= 0 && *row.Index <= 100000 {
			item.Episode = row.Index
		}
		item.AddedAt = addedAt(row.Added)
		items = append(items, item)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return items, nil
}

// CatalogueCollections reads one section's complete collection list. A
// poster reference in an unrecognised form is dropped rather than stored, so
// it is never fetched; every other inconsistency rejects the snapshot.
func (s *Server) CatalogueCollections(ctx context.Context, section, kind string) ([]provider.CatalogueCollection, error) {
	if !s.CatalogueLibrarySupported(kind, section) {
		return nil, provider.ErrCatalogueUnsupported
	}
	collections := []provider.CatalogueCollection{}
	seen := map[string]bool{}
	err := s.pages(ctx, "/library/sections/"+section+"/collections", section, provider.CatalogueMaxItems, url.Values{"sort": {"titleSort:asc"}}, nil, func(row CatalogueEntry) error {
		title := provider.TruncateRunes(row.Title, 512)
		if row.XMLName.Local != "Directory" || row.Kind != "collection" || !NumericID(row.ID) || seen[row.ID] || title == "" || row.Children != nil && *row.Children < 0 || row.Smart != "" && row.Smart != "0" && row.Smart != "1" {
			return errors.New("invalid, duplicate or mis-scoped Plex collection")
		}
		seen[row.ID] = true
		c := provider.CatalogueCollection{ID: row.ID, Title: title, SortTitle: provider.TruncateRunes(row.SortTitle, 512), ChildCount: row.Children, Smart: row.Smart == "1", AddedAt: addedAt(row.Added)}
		if c.SortTitle == "" {
			c.SortTitle = title
		}
		if validCollectionPoster(row.ID, row.Poster) {
			c.ImageTag = row.Poster
		}
		collections = append(collections, c)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return collections, nil
}

// CatalogueImage fetches an item's own poster.
func (s *Server) CatalogueImage(ctx context.Context, item, poster string) (string, []byte, error) {
	if !ValidPoster(item, poster) {
		return "", nil, errors.New("invalid Plex catalogue poster identity")
	}
	return s.catalogueGet(ctx, poster, "image/*", -1, provider.CatalogueImageMax, provider.ImageType)
}

// CollectionImage fetches a collection's poster.
func (s *Server) CollectionImage(ctx context.Context, collection, poster string) (string, []byte, error) {
	if !validCollectionPoster(collection, poster) {
		return "", nil, errors.New("invalid Plex collection poster identity")
	}
	return s.catalogueGet(ctx, poster, "image/*", -1, provider.CatalogueImageMax, provider.ImageType)
}

// Read fetches a server path as XML with the catalogue's headers and bounds.
// The core's activity reads use it until they move into this package.
func (s *Server) Read(ctx context.Context, path string, max int64) ([]byte, error) {
	_, body, err := s.catalogueGet(ctx, path, "application/xml", -1, max, nil)
	return body, err
}
