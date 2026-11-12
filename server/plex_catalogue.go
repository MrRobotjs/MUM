package main

import "app/server/providers/plex"

// Plex identifiers and poster paths used by the core's activity and catalogue
// code. The Plex catalogue reads live in server/providers/plex.

func validPlexCatalogueID(value string) bool { return plex.NumericID(value) }

func validPlexCataloguePoster(item, path string) bool { return plex.ValidPoster(item, path) }
