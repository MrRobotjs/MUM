package main

import (
	"net/http"
	"testing"
)

// Fixtures for Plex invitation redemption (see plex_invitation_share_test.go).
// The earlier manual reservation path these served was replaced by the Flask
// flow on 2026-11-07.

func plexReservationFixture(t *testing.T) (*App, *Store, string, string, *http.Cookie, int64, int64) {
	t.Helper()
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newPlexAuthFixture(t, "")
	a.ProviderHTTP = f.client
	token, invite, server := seedPlexProofInvitation(t, a, admin)
	if _, err := s.writer.Exec("INSERT INTO media_libraries(server_id,external_id,name) VALUES(?,'1','Movies')", server); err != nil {
		t.Fatal(err)
	}
	if _, err := s.writer.Exec(`UPDATE invitation_grants SET all_libraries=0,library_ids='["1"]' WHERE invite_id=?`, invite); err != nil {
		t.Fatal(err)
	}
	proof, cookie := startInvitationProof(t, a, token)
	confirmInvitationProof(t, a, token, proof, cookie)
	return a, s, token, proof, cookie, invite, server
}

func plexReservationBody(proof, name, request string) map[string]any {
	body := redeemBody(name, request)
	body["plex_authorization_id"] = proof
	body["invitation_revision"] = 1
	return body
}
