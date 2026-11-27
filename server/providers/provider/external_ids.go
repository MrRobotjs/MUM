package provider

import (
	"regexp"
	"strconv"
	"strings"
)

// ExternalIDs are a title's IDs in the shared movie and TV databases, the
// same on every server: TMDB, TVDB and IMDb. Zero or "" means unknown.
type ExternalIDs struct {
	TMDB int64
	TVDB int64
	IMDb string
}

var imdbID = regexp.MustCompile(`^tt[0-9]{6,10}$`)

// externalNumber accepts a positive database ID.
func externalNumber(value string) int64 {
	n, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
	if err != nil || n <= 0 || n > 1<<31 {
		return 0
	}
	return n
}

// Set records one ID by its database name (tmdb, tvdb or imdb, any case),
// ignoring malformed values and keeping the first value of each.
func (ids *ExternalIDs) Set(database, value string) {
	switch strings.ToLower(strings.TrimSpace(database)) {
	case "tmdb":
		if ids.TMDB == 0 {
			ids.TMDB = externalNumber(value)
		}
	case "tvdb":
		if ids.TVDB == 0 {
			ids.TVDB = externalNumber(value)
		}
	case "imdb":
		if v := strings.TrimSpace(value); ids.IMDb == "" && imdbID.MatchString(v) {
			ids.IMDb = v
		}
	}
}

// SetGuid records an ID written as database://value, as Plex reports them.
func (ids *ExternalIDs) SetGuid(guid string) {
	if database, value, ok := strings.Cut(guid, "://"); ok {
		ids.Set(database, value)
	}
}
