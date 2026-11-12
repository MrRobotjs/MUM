package main

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestPlexInvitationDoesNotAdoptAnotherServersOrFriendOnlyInvite(t *testing.T) {
	for _, sample := range []struct{ name, body string }{
		{"other-server", `<MediaContainer size="1"><Invite id="2" friend="0" home="0" server="1"><Server machineIdentifier="other-machine"/></Invite></MediaContainer>`},
		{"friend-only", `<MediaContainer size="1"><Invite id="2" friend="1" home="0" server="0"/></MediaContainer>`},
	} {
		for _, lost := range []bool{false, true} {
			t.Run(sample.name+map[bool]string{false: "confirmed", true: "lost"}[lost], func(t *testing.T) {
				a, _, token, proof, cookie, _, f := plexInviteSetup(t, "new", "")
				f.failPost = lost
				base := f.client(t).Transport
				a.ProviderHTTP = &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
					if r.Method == "GET" && r.URL.Host == "plex.tv" && r.URL.Path == "/api/invites/requested" {
						return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(sample.body)), Request: r}, nil
					}
					return base.RoundTrip(r)
				})}
				result := redeemPlexInvite(t, a, token, proof, cookie, "scoped-reader")
				if len(f.posts) != 1 {
					t.Fatalf("unrelated invitation suppressed required send: %d sends", len(f.posts))
				}
				if lost {
					if result["status"] != "failed" || result["requires_review"] != true {
						t.Fatal("unrelated invitation falsely confirmed a lost send", result)
					}
				} else if result["status"] != "completed" {
					t.Fatal(result)
				}
			})
		}
	}
}

func TestPlexInvitationRefreshesInvalidIDSnapshotBeforeFirstSend(t *testing.T) {
	for _, recovers := range []bool{false, true} {
		t.Run(map[bool]string{false: "persistent-invalid", true: "fresh-valid"}[recovers], func(t *testing.T) {
			a, s, token, proof, cookie, _, f := plexInviteSetup(t, "new", "")
			base := f.client(t).Transport
			reads := 0
			a.ProviderHTTP = &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
				if r.Method == "GET" && r.URL.Host == "plex.tv" && r.URL.Path == "/api/invites/requested" {
					reads++
					body := `<MediaContainer size="1"><Invite id="" friend="0" home="0" server="0"/></MediaContainer>`
					if recovers && reads > 1 {
						body = `<MediaContainer size="0"/>`
					}
					return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
				}
				return base.RoundTrip(r)
			})}
			request := plexReservationBody(proof, "snapshot-reader", newUUID())
			response := apiRequest(a, "POST", "/api/public/invitations/"+token+"/redeem", "", request, cookie)
			if response.Code != 201 {
				t.Fatal(response.Code, response.Body.String())
			}
			result := responseData(t, response)
			if reads != 2 {
				t.Fatalf("expected bounded two-read validation, got %d", reads)
			}
			if recovers {
				if result["status"] != "completed" || len(f.posts) != 1 {
					t.Fatal("fresh complete snapshot should permit exactly one first send", result, len(f.posts))
				}
			} else {
				if result["status"] != "failed" || result["requires_review"] != true || len(f.posts) != 0 {
					t.Fatal("invalid snapshot allowed send or success", result, len(f.posts))
				}
				var active, held bool
				var stage string
				if err := s.reader.QueryRow("SELECT u.is_active,j.reservation_held,p.stage FROM provisioning_jobs j JOIN user_accounts u ON u.uuid=j.user_uuid JOIN provisioning_steps p ON p.job_id=j.id WHERE j.id=?", result["id"]).Scan(&active, &held, &stage); err != nil || active || !held || stage != "pending" {
					t.Fatal("failed pre-send reservation state changed", err, active, held, stage)
				}
			}
			again := apiRequest(a, "POST", "/api/public/invitations/"+token+"/redeem", "", request, cookie)
			if again.Code != 200 {
				t.Fatal("recorded request should return its existing receipt", again.Code, again.Body.String())
			}
			if reads != 2 || len(f.posts) > 1 {
				t.Fatal("receipt replay retried remote work")
			}
		})
	}
}

func TestPlexSentInvitationIDFailureReasonsAreSpecific(t *testing.T) {
	for _, tc := range []struct{ name, xml, reason string }{
		{"missing", `<Invite friend="0" home="0" server="0"/>`, "SENT_INVITE_ID_MISSING"},
		{"invalid", `<Invite id="opaque-fixture" friend="0" home="0" server="0"/>`, "SENT_INVITE_ID_INVALID"},
		{"duplicate", `<Invite id="2" friend="0" home="0" server="0"/><Invite id="2" friend="0" home="0" server="0"/>`, "SENT_INVITE_ID_DUPLICATE"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			size := "1"
			if tc.name == "duplicate" {
				size = "2"
			}
			p, _ := newMediaProvider(ProviderConfig{"plex", "http://fixture.invalid", "fixture-secret"}, &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`<MediaContainer size="` + size + `">` + tc.xml + `</MediaContainer>`)), Request: r}, nil
			})})
			_, err := p.(*jsonProvider).plexSentInvitations(t.Context())
			code, _ := invitationFailureLog(err)
			if code != "PLEX_SHARE_CHECK_"+tc.reason {
				t.Fatalf("got %q want classified failure %s", code, tc.reason)
			}
		})
	}
}
