package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"
)

// The authorize page is a fixed Discord origin; MUM never accepts a custom one.
const discordAuthorizeURL = "https://discord.com/oauth2/authorize"
const discordInviteCookie = "mum_discord_invite"
const (
	discordPendingTTL  = 10 * time.Minute
	discordVerifiedTTL = 30 * time.Minute
	discordGuildPages  = 5
)

var (
	errDiscordRequired = errors.New("a verified Discord sign-in for this invitation is required")
	errDiscordInUse    = errors.New("this Discord account is already linked to another profile")
	errDiscordRate     = errors.New("too many Discord sign-ins are in progress")
	discordAvatarHash  = regexp.MustCompile(`^(a_)?[0-9a-f]{32}$`)
)

// The cookie is SameSite=Lax because Discord returns to the callback through a
// top-level navigation; it is HttpOnly and carries only the proof ID and a
// browser secret whose digest is stored.
func (a *App) setDiscordInviteCookie(w http.ResponseWriter, r *http.Request, value string, maxAge int) {
	http.SetCookie(w, &http.Cookie{Name: discordInviteCookie, Value: value, Path: "/api/", HttpOnly: true, Secure: a.secureCookie(r), SameSite: http.SameSiteLaxMode, MaxAge: maxAge})
}

func discordProofCookie(r *http.Request) (string, string, bool) {
	cookie, err := r.Cookie(discordInviteCookie)
	if err != nil {
		return "", "", false
	}
	id, secret, ok := strings.Cut(cookie.Value, ".")
	return id, secret, ok && validAdminMemberCursor(id) && len(secret) == 43
}

type discordInvite struct {
	ID           int64
	Revision     int64
	Valid        bool
	RequireAuth  bool
	RequireGuild bool
}

func readDiscordInvite(ctx context.Context, q queryRower, digest string) (discordInvite, error) {
	var i discordInvite
	err := q.QueryRowContext(ctx, `SELECT i.id,i.revision,i.is_active=1 AND i.archived_at IS NULL AND (i.expires_at IS NULL OR julianday(i.expires_at)>julianday('now')) AND i.current_uses+(SELECT count(*) FROM provisioning_jobs j WHERE j.invite_id=i.id AND j.reservation_held=1)<coalesce(i.max_uses,9223372036854775807),coalesce(i.require_discord_auth,0),coalesce(i.require_discord_guild_membership,0) FROM invites i WHERE i.token=?`, digest).Scan(&i.ID, &i.Revision, &i.Valid, &i.RequireAuth, &i.RequireGuild)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return i, err
}

// discordReady reports whether invitations may require Discord sign-in.
func discordReady(s discordSettings) bool {
	return s.Enabled && s.ClientID != "" && s.secret != "" && s.VerifiedAt != ""
}

func (a *App) startInvitationDiscord(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	if !validPlexInvitationToken(token) {
		domainError(w, ErrNotFound)
		return
	}
	var input struct {
		Revision int64 `json:"invitation_revision"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	settings, err := readDiscordSettings(r.Context(), a.store.reader)
	if err != nil {
		domainError(w, err)
		return
	}
	redirect := a.discordRedirect(r.Context(), settings)
	id, state, secret := newUUID(), randomToken(), randomToken()
	expires := time.Now().Add(discordPendingTTL)
	var requireGuild bool
	err = a.store.write(r.Context(), func(tx *sql.Tx) error {
		invite, err := readDiscordInvite(r.Context(), tx, tokenHash(token))
		if err != nil {
			return err
		}
		current, err := readDiscordSettings(r.Context(), tx)
		if err != nil {
			return err
		}
		switch {
		case !invite.Valid:
			return errInvitationUnavailable
		case input.Revision != invite.Revision:
			return ErrConflict
		case !invite.RequireAuth || !discordReady(current) || current.Revision != settings.Revision || redirect == "" || invite.RequireGuild && current.GuildID == "":
			return errDiscordUnavailable
		}
		requireGuild = invite.RequireGuild
		now := utcTimestamp(time.Now())
		if _, err := tx.ExecContext(r.Context(), "DELETE FROM invitation_discord_proofs WHERE status<>'consumed' AND julianday(expires_at)<julianday('now','-1 day')"); err != nil {
			return err
		}
		var perInvite, global int
		if err := tx.QueryRowContext(r.Context(), "SELECT count(*) FILTER (WHERE invite_id=?),count(*) FROM invitation_discord_proofs WHERE status IN ('pending','exchanging') AND julianday(expires_at)>julianday('now')", invite.ID).Scan(&perInvite, &global); err != nil {
			return err
		}
		if perInvite >= 20 || global >= 500 {
			return errDiscordRate
		}
		_, err = tx.ExecContext(r.Context(), "INSERT INTO invitation_discord_proofs(id,invite_id,invitation_revision,settings_revision,require_guild,state_hash,browser_hash,status,created_at,expires_at,updated_at) VALUES(?,?,?,?,?,?,?,'pending',?,?,?)",
			id, invite.ID, invite.Revision, current.Revision, invite.RequireGuild, tokenHash(state), tokenHash(secret), now, utcTimestamp(expires), now)
		return err
	})
	if err != nil {
		discordInvitationError(w, err)
		return
	}
	scope := "identify"
	if requireGuild {
		scope += " guilds"
	}
	query := url.Values{"response_type": {"code"}, "client_id": {settings.ClientID}, "scope": {scope}, "state": {state}, "redirect_uri": {redirect}, "prompt": {"consent"}}
	a.setDiscordInviteCookie(w, r, id+"."+secret, int(discordVerifiedTTL/time.Second))
	respond(w, 201, map[string]any{"authorization_id": id, "redirect_url": discordAuthorizeURL + "?" + query.Encode(), "expires_at": utcTimestamp(expires)})
}

var (
	errInvitationUnavailable = errors.New("invitation unavailable")
	errDiscordUnavailable    = errors.New("Discord sign-in is not available for this invitation")
)

func discordInvitationError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errInvitationUnavailable):
		fail(w, 410, "INVITATION_UNAVAILABLE", "Invitation is expired, revoked or fully reserved")
	case errors.Is(err, errDiscordUnavailable):
		fail(w, 409, "DISCORD_UNAVAILABLE", errDiscordUnavailable.Error())
	case errors.Is(err, errDiscordRate):
		fail(w, 429, "DISCORD_RATE_LIMITED", errDiscordRate.Error())
	default:
		domainError(w, err)
	}
}

type discordIdentity struct {
	ID       string
	Username string
	Avatar   string
}

func (a *App) discordHTTP() *http.Client {
	client := &http.Client{Timeout: 8 * time.Second}
	if a.ProviderHTTP != nil {
		copied := *a.ProviderHTTP
		client = &copied
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return client
}

func discordJSON(client *http.Client, req *http.Request, out any) error {
	response, err := client.Do(req)
	if err != nil {
		return errors.New("Discord is unreachable")
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20+1))
	if err != nil || len(body) > 1<<20 {
		return errors.New("Discord response could not be read")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return &providerHTTPError{StatusCode: response.StatusCode}
	}
	if json.Unmarshal(body, out) != nil {
		return errors.New("Discord returned malformed JSON")
	}
	return nil
}

// readDiscordIdentity exchanges the one-time code, reads the user and, when
// required, whether they belong to the configured guild. The access token
// only lives in this function's memory.
func (a *App) readDiscordIdentity(ctx context.Context, s discordSettings, redirect, code string, requireGuild bool) (discordIdentity, bool, error) {
	client := a.discordHTTP()
	form := url.Values{"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {redirect}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.discordBase()+"/oauth2/token", strings.NewReader(form.Encode()))
	if err != nil {
		return discordIdentity{}, false, err
	}
	req.SetBasicAuth(s.ClientID, s.secret)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	var grant struct {
		AccessToken string `json:"access_token"`
		TokenType   string `json:"token_type"`
		Scope       string `json:"scope"`
	}
	if err = discordJSON(client, req, &grant); err != nil {
		return discordIdentity{}, false, err
	}
	scopes := strings.Fields(grant.Scope)
	if grant.AccessToken == "" || !strings.EqualFold(grant.TokenType, "Bearer") || !slices.Contains(scopes, "identify") || requireGuild && !slices.Contains(scopes, "guilds") {
		return discordIdentity{}, false, errors.New("Discord did not grant the required scopes")
	}
	get := func(path string, out any) error {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.discordBase()+path, nil)
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+grant.AccessToken)
		return discordJSON(client, req, out)
	}
	var user struct {
		ID       string  `json:"id"`
		Username string  `json:"username"`
		Avatar   *string `json:"avatar"`
	}
	if err = get("/users/@me", &user); err != nil {
		return discordIdentity{}, false, err
	}
	if !discordSnowflake.MatchString(user.ID) || user.Username == "" || len(user.Username) > 64 {
		return discordIdentity{}, false, errors.New("Discord returned an invalid user")
	}
	identity := discordIdentity{ID: user.ID, Username: user.Username}
	if user.Avatar != nil && discordAvatarHash.MatchString(*user.Avatar) {
		identity.Avatar = *user.Avatar
	}
	if !requireGuild {
		return identity, false, nil
	}
	after := ""
	for range discordGuildPages {
		path := "/users/@me/guilds?limit=200"
		if after != "" {
			path += "&after=" + after
		}
		var guilds []struct {
			ID string `json:"id"`
		}
		if err = get(path, &guilds); err != nil {
			return discordIdentity{}, false, err
		}
		for _, g := range guilds {
			if !discordSnowflake.MatchString(g.ID) {
				return discordIdentity{}, false, errors.New("Discord returned an invalid guild")
			}
			if g.ID == s.GuildID {
				return identity, true, nil
			}
			after = g.ID
		}
		if len(guilds) < 200 {
			break
		}
	}
	return identity, false, nil
}

// discordCallback completes one browser-bound proof. Every outcome redirects
// back to the wizard; no Discord response text is shown.
func (a *App) discordCallback(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	back := func(path string) { http.Redirect(w, r, path, http.StatusSeeOther) }
	query := r.URL.Query()
	state, code := query.Get("state"), query.Get("code")
	id, secret, ok := discordProofCookie(r)
	if !ok || len(state) != 43 {
		back("/invite?discord=failed")
		return
	}
	var proof struct {
		invite, revision, settings int64
		guild                      bool
		browser, status            string
	}
	var digest string
	var sealed []byte
	err := a.store.reader.QueryRowContext(r.Context(), `SELECT p.invite_id,p.invitation_revision,p.settings_revision,p.require_guild,p.browser_hash,p.status,i.token,s.ciphertext FROM invitation_discord_proofs p JOIN invites i ON i.id=p.invite_id JOIN invitation_secrets s ON s.invite_id=i.id WHERE p.id=? AND p.state_hash=?`, id, tokenHash(state)).Scan(&proof.invite, &proof.revision, &proof.settings, &proof.guild, &proof.browser, &proof.status, &digest, &sealed)
	if err != nil || proof.browser != tokenHash(secret) {
		back("/invite?discord=failed")
		return
	}
	token, err := a.store.openInvitationToken(r.Context(), digest, sealed)
	if err != nil {
		back("/invite?discord=failed")
		return
	}
	wizard := "/invite/" + url.PathEscape(token)
	// Claim the pending proof once; a replayed callback finds it no longer pending.
	err = a.store.write(r.Context(), func(tx *sql.Tx) error {
		result, err := tx.ExecContext(r.Context(), "UPDATE invitation_discord_proofs SET status='exchanging',updated_at=? WHERE id=? AND status='pending' AND julianday(expires_at)>julianday('now')", utcTimestamp(time.Now()), id)
		if err != nil {
			return err
		}
		if count, _ := result.RowsAffected(); count != 1 {
			return ErrConflict
		}
		return nil
	})
	if err != nil {
		if proof.status == "verified" {
			back(wizard + "?discord=connected")
		} else {
			back(wizard + "?discord=failed")
		}
		return
	}
	finish := func(identity discordIdentity, guild bool, code string) {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 3*time.Second)
		defer cancel()
		err := a.store.write(ctx, func(tx *sql.Tx) error {
			status, expires := "verified", utcTimestamp(time.Now().Add(discordVerifiedTTL))
			if code == "" {
				invite, err := readDiscordInvite(ctx, tx, digest)
				if err != nil {
					return err
				}
				if !invite.Valid || invite.Revision != proof.revision {
					code = "INVITATION_CHANGED"
				}
			}
			var avatar, user, name any
			var guildValue any
			if code != "" {
				status, expires = "failed", utcTimestamp(time.Now())
			} else {
				user, name = identity.ID, identity.Username
				if identity.Avatar != "" {
					avatar = identity.Avatar
				}
				if proof.guild {
					guildValue = guild
				}
			}
			_, err := tx.ExecContext(ctx, "UPDATE invitation_discord_proofs SET status=?,error_code=nullif(?,''),discord_user_id=?,discord_username=?,discord_avatar=?,guild_verified=?,expires_at=?,updated_at=? WHERE id=? AND status='exchanging'", status, code, user, name, avatar, guildValue, expires, utcTimestamp(time.Now()), id)
			return err
		})
		if err != nil || code != "" {
			back(wizard + "?discord=failed")
			return
		}
		back(wizard + "?discord=connected")
	}
	if query.Get("error") != "" || code == "" || len(code) > 512 {
		finish(discordIdentity{}, false, "DISCORD_DENIED")
		return
	}
	settings, err := readDiscordSettings(r.Context(), a.store.reader)
	if err != nil || settings.Revision != proof.settings || !discordReady(settings) {
		finish(discordIdentity{}, false, "DISCORD_SETTINGS_CHANGED")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	stop := context.AfterFunc(a.provisionCtx, cancel)
	defer stop()
	identity, guild, err := a.readDiscordIdentity(ctx, settings, a.discordRedirect(r.Context(), settings), code, proof.guild)
	switch {
	case err != nil:
		finish(discordIdentity{}, false, "DISCORD_VERIFICATION_FAILED")
	case proof.guild && !guild:
		finish(discordIdentity{}, false, "DISCORD_GUILD_REQUIRED")
	default:
		finish(identity, guild, "")
	}
}

// invitationDiscordStatus returns this browser's latest proof for the invitation.
func (a *App) invitationDiscordStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	id, secret, ok := discordProofCookie(r)
	if !ok {
		domainError(w, ErrNotFound)
		return
	}
	var status, browser string
	var code, user, name, avatar sql.NullString
	var guild sql.NullBool
	var requireGuild, expired bool
	err := a.store.reader.QueryRowContext(r.Context(), `SELECT p.status,p.browser_hash,p.error_code,p.discord_user_id,p.discord_username,p.discord_avatar,p.guild_verified,p.require_guild,julianday(p.expires_at)<=julianday('now') FROM invitation_discord_proofs p JOIN invites i ON i.id=p.invite_id WHERE p.id=? AND i.token=?`, id, tokenHash(r.PathValue("token"))).Scan(&status, &browser, &code, &user, &name, &avatar, &guild, &requireGuild, &expired)
	if err != nil || browser != tokenHash(secret) {
		domainError(w, ErrNotFound)
		return
	}
	if status == "verified" && expired {
		status = "expired"
	}
	out := map[string]any{"authorization_id": id, "status": status, "error_code": nil, "user": nil, "guild_verified": nil, "invite_url": nil}
	if code.Valid {
		out["error_code"] = code.String
	}
	if (status == "verified" || status == "consumed") && user.Valid {
		out["user"] = map[string]any{"id": user.String, "username": name.String, "avatar": nullableString(avatar)}
	}
	if guild.Valid {
		out["guild_verified"] = guild.Bool
	}
	if requireGuild {
		if s, err := readDiscordSettings(r.Context(), a.store.reader); err == nil && s.InviteURL != "" {
			out["invite_url"] = s.InviteURL
		}
	}
	respond(w, 200, out)
}

func nullableString(v sql.NullString) any {
	if v.Valid {
		return v.String
	}
	return nil
}

// checkDiscordProof validates, inside the reservation transaction, that this
// browser holds a verified, unexpired proof for the current invitation
// revision and that the Discord account is not linked to another profile.
func checkDiscordProof(ctx context.Context, tx *sql.Tx, invite discordInvite, proofID, cookie string) (discordIdentity, error) {
	id, secret, ok := strings.Cut(cookie, ".")
	if !ok || id != proofID {
		return discordIdentity{}, errDiscordRequired
	}
	// Failed and pending proofs carry no identity, so every column is nullable here.
	var user, name, avatar sql.NullString
	var valid bool
	err := tx.QueryRowContext(ctx, `SELECT discord_user_id,discord_username,discord_avatar,(status='verified' AND invite_id=? AND invitation_revision=? AND require_guild=? AND browser_hash=? AND julianday(expires_at)>julianday('now')) FROM invitation_discord_proofs WHERE id=?`, invite.ID, invite.Revision, invite.RequireGuild, tokenHash(secret), id).Scan(&user, &name, &avatar, &valid)
	if errors.Is(err, sql.ErrNoRows) || err == nil && (!valid || !user.Valid || !name.Valid) {
		return discordIdentity{}, errDiscordRequired
	}
	if err != nil {
		return discordIdentity{}, err
	}
	identity := discordIdentity{ID: user.String, Username: name.String, Avatar: avatar.String}
	var used bool
	if err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM user_accounts WHERE discord_user_id=?)", identity.ID).Scan(&used); err != nil {
		return discordIdentity{}, err
	}
	if used {
		return discordIdentity{}, errDiscordInUse
	}
	return identity, nil
}

func consumeDiscordProof(ctx context.Context, tx *sql.Tx, proofID, jobID string) error {
	result, err := tx.ExecContext(ctx, "UPDATE invitation_discord_proofs SET status='consumed',job_id=?,updated_at=? WHERE id=? AND status='verified'", jobID, utcTimestamp(time.Now()), proofID)
	if err != nil {
		return err
	}
	if count, _ := result.RowsAffected(); count != 1 {
		return errDiscordRequired
	}
	return nil
}

var errInvitationDiscordSetting = errors.New("invitation Discord requirements need verified Discord OAuth settings")

// An invitation may require Discord only while OAuth is verified and enabled;
// requiring guild membership also needs a configured guild and implies sign-in.
func validateInvitationDiscord(ctx context.Context, tx *sql.Tx, requireAuth, requireGuild bool) error {
	if requireGuild && !requireAuth {
		return errInvitationDiscordSetting
	}
	if !requireAuth {
		return nil
	}
	s, err := readDiscordSettings(ctx, tx)
	if err != nil {
		return err
	}
	if !discordReady(s) || requireGuild && s.GuildID == "" {
		return errInvitationDiscordSetting
	}
	return nil
}

func invitationDiscordSettingError(w http.ResponseWriter, err error) {
	if errors.Is(err, errInvitationDiscordSetting) {
		fail(w, 409, "DISCORD_NOT_CONFIGURED", "Enable verified Discord OAuth (and a guild ID for membership) before requiring it, and require sign-in whenever membership is required")
		return
	}
	domainError(w, err)
}
