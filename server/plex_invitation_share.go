package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// Plex invitations follow the Flask flow (user decision 2026-11-07): the
// invitee signs in with Plex in the invite wizard, and MUM shares the invited
// libraries with that verified Plex account using the server owner's token.
// The invitee accepts the share in Plex themselves.
//
// The requests mirror plexapi 4.18 (the Flask reference):
//   - not yet sharing this server: MyPlexAccount.inviteFriend, a POST to
//     plex.tv/api/servers/{machine}/shared_servers with invited_email and
//     sharing_settings;
//   - already sharing it: MyPlexAccount.updateFriend, a PUT to
//     .../shared_servers/{share id} with the invited library sections.

var (
	errPlexAuthRequired = errors.New("sign in with Plex for this invitation first")
	errPlexAccountOwned = errors.New("this Plex account already belongs to another MUM user")
)

// plexShareError is errPlexShare with plex.tv's HTTP status (0 when no
// response arrived) or the read check that failed, for the administrator log
// only.
type plexShareError struct {
	Status int
	Reason string
}

// plexShareInvalid reports which read-only check rejected plex.tv's data.
func plexShareInvalid(reason string) error { return &plexShareError{Reason: reason} }

func (e *plexShareError) Error() string        { return errPlexShare.Error() }
func (e *plexShareError) Is(target error) bool { return target == errPlexShare }

func plexShareFailure(err error) error {
	var status *providerHTTPError
	if errors.As(err, &status) {
		return &plexShareError{Status: status.StatusCode}
	}
	return &plexShareError{}
}

// invitationFailureLog reduces a provisioning failure to a short code and an
// upstream HTTP status for the log; no tokens, addresses or bodies.
func invitationFailureLog(err error) (string, int) {
	var share *plexShareError
	if errors.As(err, &share) {
		if share.Reason != "" {
			return "PLEX_SHARE_CHECK_" + share.Reason, 0
		}
		return "PLEX_SHARE_FAILED", share.Status
	}
	var status *providerHTTPError
	if errors.As(err, &status) {
		return "PROVIDER_HTTP_ERROR", status.StatusCode
	}
	switch {
	case errors.Is(err, errPlexShare):
		return "PLEX_SHARE_UNVERIFIED", 0
	case errors.Is(err, errPlexAccountOwned):
		return "PLEX_ACCOUNT_IN_USE", 0
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled):
		return "TIMEOUT", 0
	case errors.Is(err, ErrConflict):
		return "CONFLICT", 0
	}
	return "PROVIDER_ERROR", 0
}

type plexInviteBody struct {
	Server string `json:"server_id"`
	Share  struct {
		Libraries []int64 `json:"library_section_ids"`
		Invited   string  `json:"invited_email,omitempty"`
	} `json:"shared_server"`
	Settings *plexSharingSettings `json:"sharing_settings,omitempty"`
}
type plexSharingSettings struct {
	AllowSync         string `json:"allowSync"`
	AllowCameraUpload string `json:"allowCameraUpload"`
	AllowChannels     string `json:"allowChannels"`
	FilterMovies      string `json:"filterMovies"`
	FilterTelevision  string `json:"filterTelevision"`
	FilterMusic       string `json:"filterMusic"`
}

// sharePlexInvitation gives the verified Plex account the invited libraries and
// reports whether the account has already accepted a share of this server. A
// lost invitation response is resolved by reading plex.tv's sent invitations;
// it is never sent a second time.
func (p *jsonProvider) sharePlexInvitation(ctx context.Context, account, username string, grant InvitationGrant, checkpoint func(stage, remoteID string) error) (bool, error) {
	if p.config.Type != "plex" || !plexNumericID(account) || username == "" {
		return false, errPlexShare
	}
	plan, err := p.inspectPlexShare(ctx, account, grant)
	if err != nil {
		return false, err
	}
	sections := []int64{}
	for _, section := range plan.Sections {
		id, err := strconv.ParseInt(section.CloudID, 10, 64)
		if err != nil {
			return false, errPlexShare
		}
		sections = append(sections, id)
	}
	target := "https://plex.tv/api/servers/" + url.PathEscape(plan.Machine) + "/shared_servers"
	var body plexInviteBody
	body.Server = plan.Machine
	body.Share.Libraries = sections
	if plan.ShareID != "" {
		// Already sharing this server (accepted or awaiting acceptance): update
		// the libraries, as Flask's updateFriend did.
		if err := checkpoint("plex_share_update", account); err != nil {
			return false, err
		}
		if _, err := p.fetch(ctx, http.MethodPut, target+"/"+url.PathEscape(plan.ShareID), body); err != nil {
			return false, plexShareFailure(err)
		}
		return plan.State == "accepted", checkpoint("remote_completed", account)
	}
	if plan.Friend {
		// A friend who does not share this server (for example after leaving
		// it): plexapi's updateFriend adds the server by account ID. The
		// email-style invitation is only for people who are not friends.
		if err := checkpoint("plex_share_adding", account); err != nil {
			return false, err
		}
		id, _ := strconv.ParseInt(account, 10, 64)
		friendBody := map[string]any{"server_id": plan.Machine, "shared_server": map[string]any{"library_section_ids": sections, "invited_id": id}}
		if _, sendErr := p.fetch(ctx, http.MethodPost, target, friendBody); sendErr != nil {
			// A lost response is resolved by reading the share, never by resending.
			after, err := p.inspectPlexShare(ctx, account, grant)
			if err != nil || after.ShareID == "" {
				return false, plexShareFailure(sendErr)
			}
			return after.State == "accepted", checkpoint("remote_completed", account)
		}
		return false, checkpoint("remote_completed", account)
	}
	sent, err := p.plexSentInvitations(ctx)
	if err != nil {
		var invalid *plexShareError
		if errors.As(err, &invalid) && (invalid.Reason == "SENT_INVITE_ID_MISSING" || invalid.Reason == "SENT_INVITE_ID_INVALID" || invalid.Reason == "SENT_INVITE_ID_DUPLICATE") && ctx.Err() == nil {
			// This is still read-only preflight: no send intent or POST exists.
			// A fresh complete snapshot may replace an inconsistent response;
			// a second invalid response fails closed. Never retry a mutation.
			sent, err = p.plexSentInvitations(ctx)
		}
	}
	if err != nil {
		return false, err
	}
	if hasPlexSentInviteForServer(sent, account, plan.Machine) {
		// An invitation is already waiting for this account; it is not resent.
		return false, checkpoint("remote_completed", account)
	}
	// Durable intent before the request, so an interrupted send is inspected
	// rather than repeated.
	if err := checkpoint("plex_invite_sending", account); err != nil {
		return false, err
	}
	allow := "0"
	if grant.AllowDownloads {
		allow = "1"
	}
	body.Share.Invited = username
	body.Settings = &plexSharingSettings{AllowSync: allow, AllowCameraUpload: "0", AllowChannels: "0"}
	if _, sendErr := p.fetch(ctx, http.MethodPost, target, body); sendErr != nil {
		sent, err := p.plexSentInvitations(ctx)
		if err != nil || !hasPlexSentInviteForServer(sent, account, plan.Machine) {
			return false, plexShareFailure(sendErr)
		}
	}
	return false, checkpoint("remote_completed", account)
}

// consumePlexInvitationShareProof spends the invitee's confirmed Plex sign-in
// for this invitation inside the reservation transaction. It must be bound to
// this browser, this invitation and its current grants. The verified account is
// returned; the invitee's Plex token is not kept.
func consumePlexInvitationShareProof(ctx context.Context, tx *sql.Tx, digest, id, browser string, inviteID int64, job string) (string, string, error) {
	if !validProvisionedID(id) || len(browser) != 43 {
		return "", "", errPlexAuthRequired
	}
	row, err := scanPlexInvitationAuthorization(tx.QueryRowContext(ctx, plexInvitationSelect, id, digest))
	if err != nil {
		return "", "", ErrForbidden
	}
	if row.Status != "confirmed" || row.InviteID != inviteID || !plexAuthorizationBound(row.plexAuthorization, browser) || !plexNumericID(row.AccountID) || row.Username == "" {
		return "", "", ErrForbidden
	}
	if row.Expires <= utcTimestamp(time.Now()) {
		return "", "", ErrConflict
	}
	if err := verifyPlexInvitationScope(ctx, tx, row, job); err != nil {
		return "", "", err
	}
	result, err := tx.ExecContext(ctx, `UPDATE plex_invitation_authorizations SET status='consumed',secret=NULL,revision=revision+1,updated_at=? WHERE id=? AND invite_digest=? AND revision=? AND status='confirmed' AND operation_token IS NULL`, utcTimestamp(time.Now()), row.ID, digest, row.Revision)
	if err != nil {
		return "", "", err
	}
	if count, _ := result.RowsAffected(); count != 1 {
		return "", "", ErrConflict
	}
	return row.AccountID, row.Username, auditAction(ctx, tx, "", "plex.invitation.proof.consume")
}

// plexAccountOwnedByOther reports whether the Plex account on this server is
// already the primary account of another MUM user.
func plexAccountOwnedByOther(ctx context.Context, tx *sql.Tx, server int64, account string) (bool, error) {
	var owned bool
	err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM service_accounts a JOIN service_links l ON l.service_uuid=a.uuid AND l.link_kind='owner' WHERE a.server_id=? AND a.external_user_id=?)`, server, account).Scan(&owned)
	return owned, err
}

// commitPlexInvitationStep records the shared Plex account for the new MUM
// user. An account already known from user sync is linked rather than
// duplicated; a new one is created inactive until the invitee accepts, which
// the regular Plex user sync then records.
func (a *App) commitPlexInvitationStep(ctx context.Context, jobID, userUUID string, inviteID int64, s ManagedServer, g InvitationGrant, username string, accepted bool) error {
	return a.store.write(ctx, func(tx *sql.Tx) error {
		if err := provisionStillAllowed(ctx, tx, inviteID, s); err != nil {
			return err
		}
		var account string
		if err := tx.QueryRowContext(ctx, "SELECT remote_id FROM provisioning_steps WHERE job_id=? AND server_id=? AND stage='remote_completed' AND status='running'", jobID, s.ID).Scan(&account); err != nil {
			return err
		}
		owned, err := plexAccountOwnedByOther(ctx, tx, s.ID, account)
		if err != nil {
			return err
		}
		if owned {
			return errPlexAccountOwned
		}
		now := utcTimestamp(time.Now())
		ids, _ := json.Marshal(g.LibraryIDs)
		// An invitation still awaiting acceptance is never treated as removed by
		// the next sync; the sync replaces these settings once Plex lists the user.
		settings, _ := json.Marshal(map[string]bool{"all_libraries": g.AllLibraries, "library_policy_known": true, "invitation_pending": !accepted})
		var uuid string
		err = tx.QueryRowContext(ctx, "SELECT uuid FROM service_accounts WHERE server_id=? AND external_user_id=?", s.ID, account).Scan(&uuid)
		switch {
		case errors.Is(err, sql.ErrNoRows):
			uuid = newUUID()
			if _, err := tx.ExecContext(ctx, "INSERT INTO identities(uuid,kind) VALUES(?,'service')", uuid); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO service_accounts(uuid,server_id,external_user_id,external_username,allowed_library_ids,allow_downloads,service_settings,is_active,used_invite_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, uuid, s.ID, account, username, string(ids), g.AllowDownloads, string(settings), accepted, inviteID, now, now); err != nil {
				return err
			}
		case err != nil:
			return err
		default:
			// A returning (removed) account is restored with its history.
			if _, err := tx.ExecContext(ctx, `UPDATE service_accounts SET external_username=?,allowed_library_ids=?,service_settings=?,used_invite_id=?,removed_at=NULL,is_active=CASE WHEN ? THEN 1 ELSE is_active END,updated_at=? WHERE uuid=?`, username, string(ids), string(settings), inviteID, accepted, now, uuid); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, "INSERT INTO service_links(user_uuid,service_uuid,link_kind,created_at) VALUES(?,?,'owner',?)", userUUID, uuid, now); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, "UPDATE provisioning_steps SET status='completed',stage='completed' WHERE job_id=? AND server_id=?", jobID, s.ID)
		return err
	})
}
