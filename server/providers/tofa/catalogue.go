package tofa

import (
	"encoding/json"
	"errors"
)

type mediaPageItem struct {
	ID             string   `json:"id"`
	LibraryID      string   `json:"library_id"`
	MediaType      string   `json:"media_type"`
	Title          string   `json:"title"`
	Overview       *string  `json:"overview"`
	ReleaseDate    *string  `json:"release_date"`
	Rating         *float64 `json:"rating"`
	RuntimeMinutes *int64   `json:"runtime_minutes"`
	PosterPath     *string  `json:"poster_path"`
	TMDBID         *int64   `json:"tmdb_id"`
}

type mediaPage struct {
	Items                            []mediaPageItem
	Page, PerPage, Total, TotalPages int
}

func decodeMediaPage(body []byte) (mediaPage, error) {
	var raw struct {
		Items      *[]mediaPageItem `json:"items"`
		Page       *int             `json:"page"`
		PerPage    *int             `json:"per_page"`
		Total      *int             `json:"total"`
		TotalPages *int             `json:"total_pages"`
	}
	if json.Unmarshal(body, &raw) != nil || raw.Items == nil || raw.Page == nil || raw.PerPage == nil || raw.Total == nil || raw.TotalPages == nil || *raw.Page < 1 || *raw.PerPage < 1 || *raw.Total < 0 || *raw.TotalPages < 0 || len(*raw.Items) > *raw.PerPage {
		return mediaPage{}, errors.New("invalid Tofa media page")
	}
	for _, item := range *raw.Items {
		if !uuid.MatchString(item.ID) || !uuid.MatchString(item.LibraryID) || item.Title == "" || (item.MediaType != "movie" && item.MediaType != "tv" && item.MediaType != "other") {
			return mediaPage{}, errors.New("invalid Tofa media item")
		}
	}
	return mediaPage{Items: *raw.Items, Page: *raw.Page, PerPage: *raw.PerPage, Total: *raw.Total, TotalPages: *raw.TotalPages}, nil
}
