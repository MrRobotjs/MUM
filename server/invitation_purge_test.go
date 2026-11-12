package main

import (
	"fmt"
	"strings"
	"testing"
)

// Every table that refers to an invitation, or to a record purge removes, must
// be handled by purgeInvitationSQL, or a purge would fail on a foreign key or
// leave orphaned history behind.
func TestPurgeInvitationCoversEveryReference(t *testing.T) {
	_, s := testApp(t)
	removed := map[string]bool{"invites": true}
	for _, query := range purgeInvitationSQL {
		if table, ok := strings.CutPrefix(query, "DELETE FROM "); ok {
			removed[strings.Fields(table)[0]] = true
		}
	}
	rows, err := s.reader.Query(`SELECT m.name,f."table" FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f WHERE m.type='table'`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var child, parent string
		if err := rows.Scan(&child, &parent); err != nil {
			t.Fatal(err)
		}
		if !removed[parent] {
			continue
		}
		handled := false
		for _, query := range purgeInvitationSQL {
			if strings.Contains(query, " "+child+" ") {
				handled = true
			}
		}
		if !handled {
			t.Errorf("%s refers to %s but purgeInvitationSQL does not handle it", child, parent)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
}

func TestArchivedInvitationReleasesCustomPathAndPurgesHistory(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newProvisioningFixture(t, "")
	_, _, servers := prepareInvitation(t, a, admin, f)
	grants := []InvitationGrant{{ServerID: servers[0], LibraryIDs: []string{"movies"}}}
	create := func() (int64, string) {
		w := apiRequest(a, "POST", "/api/invitations", admin, map[string]any{"expires_at": nil, "max_uses": nil, "custom_path": "family", "grants": grants}, nil)
		if w.Code != 201 {
			t.Fatal(w.Code, w.Body.String())
		}
		data := responseData(t, w)
		return int64(data["id"].(float64)), data["token"].(string)
	}
	bulk := func(action string, ids ...int64) (int, string) {
		w := apiRequest(a, "POST", "/api/invitations/bulk-action", admin, map[string]any{"ids": ids, "action": action}, nil)
		return w.Code, w.Body.String()
	}

	old, token := create()
	if w := apiRequest(a, "POST", "/api/public/invitations/"+token+"/redeem", "", redeemBody("Family Member", newUUID()), nil); w.Code != 201 || responseData(t, w)["status"] != "completed" {
		t.Fatal(w.Code, w.Body.String())
	}
	var user string
	if err := s.reader.QueryRow("SELECT uuid FROM user_accounts WHERE used_invite_id=?", old).Scan(&user); err != nil {
		t.Fatal(err)
	}
	if code, body := bulk("purge", old); code != 409 || !strings.Contains(body, "INVITATION_NOT_ARCHIVED") {
		t.Fatal("purged an invitation that was not archived", code, body)
	}
	if code, body := bulk("archive", old); code != 200 {
		t.Fatal(code, body)
	}

	// The archived invitation keeps showing its path, but the path is free again.
	if w := apiRequest(a, "GET", fmt.Sprintf("/api/invitations/%d?include_archived=1", old), admin, nil, nil); w.Code != 200 || responseData(t, w)["custom_path"] != "family" {
		t.Fatal(w.Code, w.Body.String())
	}
	current, _ := create()
	if w := apiRequest(a, "GET", "/api/public/invitation-paths/family", "", nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if code, body := bulk("purge", old, current); code != 409 {
		t.Fatal("mixed purge accepted", code, body)
	}

	if code, body := bulk("purge", old); code != 200 {
		t.Fatal(code, body)
	}
	for _, query := range []string{"SELECT count(*) FROM invites WHERE id=?", "SELECT count(*) FROM provisioning_jobs WHERE invite_id=?", "SELECT count(*) FROM invitation_secrets WHERE invite_id=?", "SELECT count(*) FROM invitation_grants WHERE invite_id=?", "SELECT count(*) FROM user_accounts WHERE used_invite_id=?", "SELECT count(*) FROM service_accounts WHERE used_invite_id=?"} {
		var n int
		if err := s.reader.QueryRow(query, old).Scan(&n); err != nil || n != 0 {
			t.Fatal(query, n, err)
		}
	}
	// The person who joined through the invitation keeps their account.
	var kept int
	if err := s.reader.QueryRow("SELECT count(*) FROM user_accounts WHERE uuid=?", user).Scan(&kept); err != nil || kept != 1 {
		t.Fatal("purge removed the invited user", kept, err)
	}
	if w := apiRequest(a, "GET", fmt.Sprintf("/api/invitations/%d?include_archived=1", old), admin, nil, nil); w.Code != 404 {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestPurgeRefusesInvitationWaitingForReview(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newProvisioningFixture(t, "password")
	id, token, _ := prepareInvitation(t, a, admin, f)
	if w := apiRequest(a, "POST", "/api/public/invitations/"+token+"/redeem", "", redeemBody("Review Recipient", newUUID()), nil); w.Code != 201 || responseData(t, w)["status"] != "failed" {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := apiRequest(a, "POST", "/api/invitations/bulk-action", admin, map[string]any{"ids": []int64{id}, "action": "archive"}, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	w := apiRequest(a, "POST", "/api/invitations/bulk-action", admin, map[string]any{"ids": []int64{id}, "action": "purge"}, nil)
	if w.Code != 409 || !strings.Contains(w.Body.String(), "INVITATION_IN_USE") {
		t.Fatal(w.Code, w.Body.String())
	}
	var n int
	if err := s.reader.QueryRow("SELECT count(*) FROM provisioning_jobs WHERE invite_id=?", id).Scan(&n); err != nil || n == 0 {
		t.Fatal("refused purge removed the review record", n, err)
	}
}
