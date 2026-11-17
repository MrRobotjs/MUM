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
	"strconv"
	"strings"
	"time"
)

// discordAPIBase is fixed; tests replace App.DiscordAPI with a local fixture.
const discordAPIBase = "https://discord.com/api/v10"

var discordSnowflake = regexp.MustCompile(`^[0-9]{17,20}$`)

// The one Discord callback for invitations, linking and sign-in
// (DISCORD_SIGN_IN_DESIGN.md). It is computed from APP_BASE_URL unless an
// explicit redirect is stored.
const discordCallbackPath = "/api/discord/callback"

type discordSettings struct {
	Revision     int64
	Enabled      bool
	ClientID     string
	secret       string
	RedirectURI  string
	GuildID      string
	GuildName    string
	InviteURL    string
	VerifiedAt   string
	SignIn       bool
	SignInAdmins bool
	DefaultAuth  bool
	DefaultGuild bool
}

func readDiscordSettings(ctx context.Context, q queryRower) (discordSettings, error) {
	var s discordSettings
	err := q.QueryRowContext(ctx, `SELECT revision,oauth_enabled,coalesce(client_id,''),coalesce(client_secret,''),coalesce(redirect_uri_invite,''),coalesce(guild_id,''),coalesce(guild_name,''),coalesce(server_invite_url,''),coalesce(verified_at,''),
	 sign_in_enabled,sign_in_admins,default_require_auth,default_require_guild FROM discord_settings WHERE singleton=1`).
		Scan(&s.Revision, &s.Enabled, &s.ClientID, &s.secret, &s.RedirectURI, &s.GuildID, &s.GuildName, &s.InviteURL, &s.VerifiedAt, &s.SignIn, &s.SignInAdmins, &s.DefaultAuth, &s.DefaultGuild)
	return s, err
}

var (
	errDiscordInviteExpires = errors.New("this invite link expires")
	errDiscordInviteInvalid = errors.New("Discord does not know this invite link")
)

var discordInviteCode = regexp.MustCompile(`^[A-Za-z0-9-]{2,32}$`)

// discordInviteLinkCode is the invite code in a discord.gg or
// discord.com/invite link.
func discordInviteLinkCode(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	code := strings.TrimPrefix(u.Path, "/")
	if u.Host == "discord.com" {
		code = strings.TrimPrefix(u.Path, "/invite/")
	}
	if !discordInviteCode.MatchString(code) {
		return ""
	}
	return code
}

// lookupDiscordInvite asks Discord's public invite lookup, which needs no
// credentials, for the server an invite link opens. A link that expires is
// refused: invitees use it to join the server, so it must keep working.
func (a *App) lookupDiscordInvite(ctx context.Context, link string) (id, name string, err error) {
	code := discordInviteLinkCode(link)
	if code == "" {
		return "", "", errDiscordInviteInvalid
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.discordBase()+"/invites/"+code+"?with_expiration=true", nil)
	if err != nil {
		return "", "", err
	}
	var invite struct {
		ExpiresAt *string `json:"expires_at"`
		Guild     *struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"guild"`
	}
	if err := discordJSON(a.discordHTTP(), req, &invite); err != nil {
		var status *providerHTTPError
		if errors.As(err, &status) && (status.StatusCode == 404 || status.StatusCode == 400) {
			return "", "", errDiscordInviteInvalid
		}
		return "", "", errors.New("Discord could not be reached to check the invite link; try again")
	}
	if invite.Guild == nil || !discordSnowflake.MatchString(invite.Guild.ID) {
		return "", "", errDiscordInviteInvalid
	}
	if invite.ExpiresAt != nil {
		return "", "", errDiscordInviteExpires
	}
	name = strings.TrimSpace(invite.Guild.Name)
	if len(name) > 100 {
		name = ""
	}
	return invite.Guild.ID, name, nil
}

// discordRedirectProblem says why the redirect address will not work with
// Discord: it is missing (no App Base URL), or it is plain HTTP, which Discord
// accepts only for this computer.
func discordRedirectProblem(redirect string) any {
	if redirect == "" {
		return "missing"
	}
	u, err := url.Parse(redirect)
	if err != nil {
		return "missing"
	}
	if u.Scheme == "http" && u.Hostname() != "localhost" && u.Hostname() != "127.0.0.1" && u.Hostname() != "::1" {
		return "not_https"
	}
	return nil
}

func (a *App) discordBase() string {
	if a.DiscordAPI != "" {
		return a.DiscordAPI
	}
	return discordAPIBase
}

// verifyDiscordClient asks Discord's token endpoint for a client-credentials
// token, which succeeds only for a valid client ID and secret. The returned
// token is discarded unread; no Discord credential beyond the secret is stored.
func (a *App) verifyDiscordClient(ctx context.Context, clientID, secret string) error {
	client := &http.Client{Timeout: 8 * time.Second}
	if a.ProviderHTTP != nil {
		copied := *a.ProviderHTTP
		client = &copied
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	form := url.Values{"grant_type": {"client_credentials"}, "scope": {"identify"}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.discordBase()+"/oauth2/token", strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.SetBasicAuth(clientID, secret)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := client.Do(req)
	if err != nil {
		return errors.New("Discord is unreachable")
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1<<16))
	switch {
	case response.StatusCode == 401 || response.StatusCode == 400:
		return errors.New("Discord rejected the client ID or secret")
	case response.StatusCode < 200 || response.StatusCode >= 300:
		return errors.New("Discord returned HTTP " + strconv.Itoa(response.StatusCode))
	}
	return nil
}

func (a *App) discordRedirect(ctx context.Context, s discordSettings) string {
	if s.RedirectURI != "" {
		return s.RedirectURI
	}
	if base := strings.TrimRight(a.setting(ctx, "APP_BASE_URL", ""), "/"); base != "" {
		return base + discordCallbackPath
	}
	return ""
}

func (a *App) discordSettingsDTO(ctx context.Context, s discordSettings) map[string]any {
	nullable := func(value string) any {
		if value == "" {
			return nil
		}
		return value
	}
	// The unimplemented bot and whitelist are reported as off, never as
	// configured. invite_ready and membership_ready tell the invitation form
	// whether it may require Discord sign-in and server membership.
	redirect := a.discordRedirect(ctx, s)
	inviteReady := discordReady(s) && discordRedirectProblem(redirect) == nil
	return map[string]any{
		"revision": s.Revision, "enable_oauth": s.Enabled, "client_id": nullable(s.ClientID), "client_secret_set": s.secret != "",
		"oauth_auth_url": nil, "redirect_uri_invite": nullable(redirect), "redirect_problem": discordRedirectProblem(redirect), "redirect_uri_admin": nil,
		"default_require_discord_auth": s.DefaultAuth, "default_require_discord_guild_membership": s.DefaultGuild, "enable_membership_requirement": false,
		"guild_id": nullable(s.GuildID), "guild_name": nullable(s.GuildName), "server_invite_url": nullable(s.InviteURL),
		"sign_in_enabled": s.SignIn, "sign_in_admins": s.SignIn && s.SignInAdmins, "invite_ready": inviteReady, "membership_ready": inviteReady && s.GuildID != "",
		"enable_bot": false, "bot_token_set": false, "monitored_role_id": nil, "thread_channel_id": nil, "bot_log_channel_id": nil,
		"whitelist_sharers": false, "admin_linked": false, "admin_user": nil, "verified_at": nullable(s.VerifiedAt),
	}
}

func (a *App) getDiscordSettings(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	tx, err := a.store.reader.BeginTx(r.Context(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		domainError(w, err)
		return
	}
	defer tx.Rollback()
	var s discordSettings
	if err = notificationAuthority(r.Context(), tx, p.UUID, bearer(r)); err == nil {
		s, err = readDiscordSettings(r.Context(), tx)
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, a.discordSettingsDTO(r.Context(), s))
}

type discordSettingsInput struct {
	Revision       *int64  `json:"revision"`
	Enabled        bool    `json:"enable_oauth"`
	ClientID       string  `json:"client_id"`
	ClientSecret   string  `json:"client_secret"`
	AuthURL        *string `json:"oauth_auth_url"`
	RedirectInvite *string `json:"redirect_uri_invite"`
	RedirectAdmin  *string `json:"redirect_uri_admin"`
	GuildID        string  `json:"guild_id"`
	ServerInvite   string  `json:"server_invite_url"`
	// Defaults that pre-tick new invitations, and sign-in with Discord.
	RequireAuth  bool `json:"default_require_discord_auth"`
	RequireGuild bool `json:"default_require_discord_guild_membership"`
	SignIn       bool `json:"sign_in_enabled"`
	SignInAdmins bool `json:"sign_in_admins"`
	// Features that are not implemented: accepted only when off/empty.
	Bot           bool   `json:"enable_bot"`
	Membership    bool   `json:"enable_membership_requirement"`
	Whitelist     bool   `json:"whitelist_sharers"`
	BotToken      string `json:"bot_token"`
	MonitoredRole string `json:"monitored_role_id"`
	ThreadChannel string `json:"thread_channel_id"`
	BotLogChannel string `json:"bot_log_channel_id"`
}

func validDiscordInviteURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "https" && u.User == nil && u.Fragment == "" && (u.Host == "discord.gg" || u.Host == "discord.com" && strings.HasPrefix(u.Path, "/invite/")) && len(raw) <= 512 && len(u.Path) > 1
}

func validRedirectURI(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Host != "" && u.User == nil && u.Fragment == "" && len(raw) <= 512
}

func (a *App) saveDiscordSettings(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	var input discordSettingsInput
	if !decodeStrictBody(w, r, &input) {
		return
	}
	if input.Revision == nil || *input.Revision < 1 {
		fail(w, 400, "DISCORD_REVISION_REQUIRED", "Read the current Discord settings before saving")
		return
	}
	if input.Bot || input.Membership || input.Whitelist || input.BotToken != "" || input.MonitoredRole != "" || input.ThreadChannel != "" || input.BotLogChannel != "" {
		fail(w, 422, "DISCORD_FEATURE_UNAVAILABLE", "The Discord bot is not available yet; turn its settings off to save")
		return
	}
	if input.AuthURL != nil && *input.AuthURL != "" {
		fail(w, 422, "DISCORD_FEATURE_UNAVAILABLE", "Custom authorize URLs are not supported; MUM builds the Discord authorize URL itself")
		return
	}
	if input.RedirectAdmin != nil && *input.RedirectAdmin != "" {
		fail(w, 422, "DISCORD_FEATURE_UNAVAILABLE", "Administrator Discord linking is not available")
		return
	}
	clientID, secret := strings.TrimSpace(input.ClientID), input.ClientSecret
	guild, invite := strings.TrimSpace(input.GuildID), strings.TrimSpace(input.ServerInvite)
	redirect := ""
	if input.RedirectInvite != nil {
		redirect = strings.TrimSpace(*input.RedirectInvite)
	}
	if clientID != "" && !discordSnowflake.MatchString(clientID) || len(secret) > 128 || strings.ContainsAny(secret, " \t\r\n") || guild != "" && !discordSnowflake.MatchString(guild) || invite != "" && !validDiscordInviteURL(invite) || redirect != "" && !validRedirectURI(redirect) {
		fail(w, 400, "INVALID_DISCORD_SETTINGS", "Use a numeric Discord client/guild ID, a Discord invite URL and an absolute HTTP(S) redirect URI")
		return
	}
	current, err := readDiscordSettings(r.Context(), a.store.reader)
	if err != nil {
		domainError(w, err)
		return
	}
	if *input.Revision != current.Revision {
		domainError(w, ErrConflict)
		return
	}
	if clientID == "" {
		clientID = current.ClientID
	}
	// An empty secret keeps the stored one; it is never returned.
	if secret == "" {
		secret = current.secret
	}
	// A redirect equal to the computed default is not pinned.
	if redirect == a.discordRedirect(r.Context(), discordSettings{}) {
		redirect = ""
	}
	verified := current.VerifiedAt
	if clientID != current.ClientID || secret != current.secret {
		verified = ""
	}
	requireGuild := input.RequireGuild
	requireAuth := input.RequireAuth || requireGuild
	signInAdmins := input.SignIn && input.SignInAdmins
	if (requireAuth || input.SignIn) && !input.Enabled {
		fail(w, 400, "DISCORD_OAUTH_REQUIRED", "Turn on Discord before requiring Discord on new invites or allowing sign-in with Discord")
		return
	}
	// The server comes from the invite link: Discord's public lookup gives its
	// ID and name, outside the writer. An unchanged link is not looked up
	// again; without a link, a typed server ID is kept.
	guildName := ""
	switch {
	case invite == "":
	case invite == current.InviteURL && current.GuildID != "":
		guild, guildName = current.GuildID, current.GuildName
	default:
		id, name, err := a.lookupDiscordInvite(r.Context(), invite)
		switch {
		case errors.Is(err, errDiscordInviteExpires):
			fail(w, 422, "DISCORD_INVITE_EXPIRES", "This invite link expires. In Discord, open Invite People, choose Edit invite link, set Expire After to Never and Max Number of Uses to No limit, then paste the new link.")
			return
		case errors.Is(err, errDiscordInviteInvalid):
			fail(w, 422, "DISCORD_INVITE_INVALID", "Discord does not recognise this invite link. Check it opens your server, then paste it again.")
			return
		case err != nil:
			fail(w, 502, "DISCORD_UNREACHABLE", err.Error())
			return
		}
		guild, guildName = id, name
	}
	if requireGuild && guild == "" {
		fail(w, 400, "DISCORD_GUILD_REQUIRED", "Add your Discord server's invite link before requiring server membership on new invites")
		return
	}
	if input.Enabled {
		if clientID == "" || secret == "" {
			fail(w, 400, "DISCORD_CREDENTIALS_REQUIRED", "A Discord client ID and secret are required to enable OAuth")
			return
		}
		// Verify new or unverified credentials before saving, outside the writer.
		if verified == "" {
			if err := a.verifyDiscordClient(r.Context(), clientID, secret); err != nil {
				fail(w, 502, "DISCORD_VERIFICATION_FAILED", err.Error())
				return
			}
			verified = utcTimestamp(time.Now())
		}
	}
	var saved discordSettings
	err = a.store.write(r.Context(), func(tx *sql.Tx) error {
		if err := notificationAuthority(r.Context(), tx, p.UUID, bearer(r)); err != nil {
			return err
		}
		result, err := tx.ExecContext(r.Context(), `UPDATE discord_settings SET oauth_enabled=?,client_id=nullif(?,''),client_secret=nullif(?,''),redirect_uri_invite=nullif(?,''),guild_id=nullif(?,''),guild_name=nullif(?,''),server_invite_url=nullif(?,''),verified_at=nullif(?,''),
		 default_require_auth=?,default_require_guild=?,sign_in_enabled=?,sign_in_admins=?,updated_at=?,revision=revision+1 WHERE singleton=1 AND revision=?`,
			input.Enabled, clientID, secret, redirect, guild, guildName, invite, verified, requireAuth, requireGuild, input.SignIn, signInAdmins, utcTimestamp(time.Now()), current.Revision)
		if err != nil {
			return err
		}
		if count, _ := result.RowsAffected(); count != 1 {
			return ErrConflict
		}
		details, _ := json.Marshal(map[string]any{"enable_oauth": input.Enabled, "client_id": clientID, "secret_changed": secret != current.secret, "verified": verified != "",
			"guild_id": guild, "sign_in": input.SignIn, "sign_in_admins": signInAdmins, "default_require_auth": requireAuth, "default_require_guild": requireGuild})
		if _, err = tx.ExecContext(r.Context(), "INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(?,'settings.discord.save',?,?)", p.UUID, string(details), utcTimestamp(time.Now())); err != nil {
			return err
		}
		saved, err = readDiscordSettings(r.Context(), tx)
		return err
	})
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, a.discordSettingsDTO(r.Context(), saved))
}

func (a *App) testDiscordSettings(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	var input struct {
		Type string `json:"type"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	tx, err := a.store.reader.BeginTx(r.Context(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		domainError(w, err)
		return
	}
	defer tx.Rollback()
	var s discordSettings
	if err = notificationAuthority(r.Context(), tx, p.UUID, bearer(r)); err == nil {
		s, err = readDiscordSettings(r.Context(), tx)
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		domainError(w, err)
		return
	}
	switch {
	case input.Type == "bot":
		respond(w, 200, map[string]any{"success": false, "message": "The Discord bot is not available in this version"})
	case input.Type != "" && input.Type != "oauth":
		fail(w, 400, "INVALID_DISCORD_TEST", "Test type must be oauth or bot")
	case s.ClientID == "" || s.secret == "":
		respond(w, 200, map[string]any{"success": false, "message": "Discord OAuth credentials are not configured"})
	default:
		if err := a.verifyDiscordClient(r.Context(), s.ClientID, s.secret); err != nil {
			respond(w, 200, map[string]any{"success": false, "message": err.Error()})
			return
		}
		// The invite link can stop working later, for example when someone
		// deletes it in Discord.
		if s.InviteURL != "" {
			if _, _, err := a.lookupDiscordInvite(r.Context(), s.InviteURL); err != nil {
				message := "The Discord invite link no longer works; create a link that never expires and save it again"
				if !errors.Is(err, errDiscordInviteExpires) && !errors.Is(err, errDiscordInviteInvalid) {
					message = "Discord accepted the client ID and secret, but the invite link could not be checked; try again"
				}
				respond(w, 200, map[string]any{"success": false, "message": message})
				return
			}
		}
		respond(w, 200, map[string]any{"success": true, "message": "Discord accepted the client ID and secret, and the invite link works"})
	}
}
