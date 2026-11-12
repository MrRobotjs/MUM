package main

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
)

// Plex movie/show catalogue adapter; callers pin library kind and revisions.
func validPlexCatalogueID(value string) bool {
	id, err := strconv.ParseInt(value, 10, 64)
	return err == nil && id > 0 && strconv.FormatInt(id, 10) == value
}

func validPlexCataloguePoster(item, path string) bool {
	if !validPlexCatalogueID(item) {
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
	return version == "0" || validPlexCatalogueID(version)
}

// Header-only credentials, bounded bytes/time, and the provider client's
// redirect refusal apply to both XML pages and binary posters.
func (p *jsonProvider) plexCatalogueGet(ctx context.Context, path, accept string, start int, max int64) (string, []byte, error) {
	if p.config.Type != "plex" {
		return "", nil, errCatalogueUnsupported
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(p.config.URL, "/")+path, nil)
	if err != nil {
		return "", nil, errors.New("invalid Plex catalogue request")
	}
	req.Header.Set("Accept", accept)
	req.Header.Set("X-Plex-Token", p.config.APIKey)
	req.Header.Set("X-Plex-Client-Identifier", "mum-go")
	if start >= 0 {
		req.Header.Set("X-Plex-Container-Start", strconv.Itoa(start))
		req.Header.Set("X-Plex-Container-Size", strconv.Itoa(cataloguePageSize))
	}
	response, err := p.client.Do(req)
	if err != nil {
		return "", nil, errors.New("Plex catalogue request failed or timed out")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", nil, &providerHTTPError{StatusCode: response.StatusCode}
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, max+1))
	if err != nil || len(body) > int(max) || len(body) == 0 {
		return "", nil, errors.New("Plex catalogue response is empty, oversized or unreadable")
	}
	return strings.ToLower(strings.TrimSpace(strings.Split(response.Header.Get("Content-Type"), ";")[0])), body, nil
}

type plexCatalogueEntry struct {
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
}

type plexCataloguePage struct {
	XMLName xml.Name             `xml:"MediaContainer"`
	Size    *int                 `xml:"size,attr"`
	Total   *int                 `xml:"totalSize,attr"`
	Offset  *int                 `xml:"offset,attr"`
	Section string               `xml:"librarySectionID,attr"`
	Items   []plexCatalogueEntry `xml:",any"`
}

// encoding/xml ignores unknown fields and permits duplicate attributes. Refuse
// ambiguity, extra roots and excessive nesting before decoding domain values.
func decodePlexCataloguePage(body []byte) (plexCataloguePage, error) {
	var page plexCataloguePage
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

// plexCataloguePages reads every page of one section listing and hands each
// entry to visit. The provider has no snapshot isolation, so missing or
// inconsistent pagination, a changed total, a mis-scoped page or a short final
// count rejects the whole snapshot.
func (p *jsonProvider) plexCataloguePages(ctx context.Context, section, path string, query url.Values, progress func(fetched, total int), visit func(plexCatalogueEntry) error) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	total, read := -1, 0
	for start := 0; ; {
		_, body, err := p.plexCatalogueGet(ctx, "/library/sections/"+section+path+"?"+query.Encode(), "application/xml", start, 16<<20)
		if err != nil {
			return err
		}
		page, err := decodePlexCataloguePage(body)
		if err != nil {
			return err
		}
		if page.Size == nil || page.Total == nil || page.Offset == nil || *page.Total < 0 || *page.Total > catalogueMaxItems || *page.Size < 0 || *page.Size > cataloguePageSize || *page.Size != len(page.Items) || *page.Offset != start || page.Section != "" && page.Section != section {
			return errors.New("invalid Plex catalogue pagination or section")
		}
		if total >= 0 && total != *page.Total {
			return errors.New("Plex catalogue changed during synchronization")
		}
		total = *page.Total
		for _, row := range page.Items {
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

func (p *jsonProvider) plexCatalogueItems(ctx context.Context, section, kind string, progress func(fetched, total int)) ([]catalogueItem, error) {
	if p.config.Type != "plex" || !validPlexCatalogueID(section) || kind != "movie" && kind != "show" {
		return nil, errCatalogueUnsupported
	}
	itemType, element := "1", "Video"
	if kind == "show" {
		itemType, element = "2", "Directory"
	}
	items := []catalogueItem{}
	seen := map[string]bool{}
	query := url.Values{"type": {itemType}, "includeCollections": {"0"}, "sort": {"titleSort:asc"}}
	err := p.plexCataloguePages(ctx, section, "/all", query, progress, func(row plexCatalogueEntry) error {
		title := truncateRunes(row.Title, 512)
		if row.XMLName.Local != element || row.Kind != kind || !validPlexCatalogueID(row.ID) || seen[row.ID] || title == "" || row.Poster != "" && !validPlexCataloguePoster(row.ID, row.Poster) {
			return errors.New("invalid, duplicate or mis-scoped Plex catalogue item")
		}
		seen[row.ID] = true
		item := catalogueItem{ID: row.ID, Type: kind, Title: title, SortTitle: truncateRunes(row.SortTitle, 512), Summary: truncateRunes(row.Summary, 8000), ImageTag: row.Poster}
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
		item.AddedAt = plexAddedAt(row.Added)
		items = append(items, item)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return items, nil
}

func plexAddedAt(added *int64) string {
	if added != nil && *added >= 0 && *added <= 253402300799 {
		return utcTimestamp(time.Unix(*added, 0))
	}
	return ""
}

// Collection posters are either a generated composite or a custom poster, and
// either way bound to the collection's own rating key.
func validPlexCollectionPoster(collection, path string) bool {
	if validPlexCataloguePoster(collection, path) {
		return true
	}
	base := "/library/collections/" + collection + "/composite/"
	return validPlexCatalogueID(collection) && strings.HasPrefix(path, base) && validPlexCatalogueID(strings.TrimPrefix(path, base))
}

type catalogueCollection struct {
	ID, Title, SortTitle, ImageTag, AddedAt string
	ChildCount                              *int64
	Smart                                   bool
}

// plexCatalogueCollections reads one section's complete collection list. A
// poster reference in an unrecognized form is dropped rather than stored, so
// it is never fetched; every other inconsistency rejects the snapshot.
func (p *jsonProvider) plexCatalogueCollections(ctx context.Context, section, kind string) ([]catalogueCollection, error) {
	if p.config.Type != "plex" || !validPlexCatalogueID(section) || kind != "movie" && kind != "show" {
		return nil, errCatalogueUnsupported
	}
	collections := []catalogueCollection{}
	seen := map[string]bool{}
	err := p.plexCataloguePages(ctx, section, "/collections", url.Values{"sort": {"titleSort:asc"}}, nil, func(row plexCatalogueEntry) error {
		title := truncateRunes(row.Title, 512)
		if row.XMLName.Local != "Directory" || row.Kind != "collection" || !validPlexCatalogueID(row.ID) || seen[row.ID] || title == "" || row.Children != nil && *row.Children < 0 || row.Smart != "" && row.Smart != "0" && row.Smart != "1" {
			return errors.New("invalid, duplicate or mis-scoped Plex collection")
		}
		seen[row.ID] = true
		c := catalogueCollection{ID: row.ID, Title: title, SortTitle: truncateRunes(row.SortTitle, 512), ChildCount: row.Children, Smart: row.Smart == "1", AddedAt: plexAddedAt(row.Added)}
		if c.SortTitle == "" {
			c.SortTitle = title
		}
		if validPlexCollectionPoster(row.ID, row.Poster) {
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

func (p *jsonProvider) plexCollectionImage(ctx context.Context, collection, poster string) (string, []byte, error) {
	if p.config.Type != "plex" || !validPlexCollectionPoster(collection, poster) {
		return "", nil, errors.New("invalid Plex collection poster identity")
	}
	return p.plexPoster(ctx, poster)
}

func (p *jsonProvider) plexCatalogueImage(ctx context.Context, item, poster string) (string, []byte, error) {
	if p.config.Type != "plex" || !validPlexCataloguePoster(item, poster) {
		return "", nil, errors.New("invalid Plex catalogue poster identity")
	}
	return p.plexPoster(ctx, poster)
}

func (p *jsonProvider) plexPoster(ctx context.Context, poster string) (string, []byte, error) {
	kind, body, err := p.plexCatalogueGet(ctx, poster, "image/*", -1, catalogueImageMax)
	if err != nil {
		return "", nil, err
	}
	if kind != "image/jpeg" && kind != "image/png" && kind != "image/webp" && kind != "image/gif" {
		return "", nil, errors.New("unsupported Plex catalogue image type")
	}
	return kind, body, nil
}
