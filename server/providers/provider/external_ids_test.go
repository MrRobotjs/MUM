package provider

import "testing"

func TestExternalIDsKeepOnlyWellFormedValues(t *testing.T) {
	var ids ExternalIDs
	ids.SetGuid("tmdb://603")
	ids.SetGuid("TVDB://81189")
	ids.SetGuid("imdb://tt0133093")
	ids.SetGuid("tmdb://999") // a second TMDB ID keeps the first
	ids.SetGuid("plex://movie/5d7768")
	if ids != (ExternalIDs{TMDB: 603, TVDB: 81189, IMDb: "tt0133093"}) {
		t.Fatalf("%+v", ids)
	}
	for _, bad := range [][2]string{{"tmdb", "0"}, {"tmdb", "-4"}, {"tmdb", "12a"}, {"tmdb", "99999999999"}, {"tvdb", ""}, {"imdb", "0133093"}, {"imdb", "tt12"}, {"imdb", "tt0133093x"}, {"imdb", "nm0000206"}, {"anidb", "5"}} {
		var none ExternalIDs
		none.Set(bad[0], bad[1])
		if none != (ExternalIDs{}) {
			t.Fatalf("%v accepted: %+v", bad, none)
		}
	}
	var spaced ExternalIDs
	spaced.Set(" Imdb ", " tt10872600 ")
	if spaced.IMDb != "tt10872600" {
		t.Fatalf("%+v", spaced)
	}
}
