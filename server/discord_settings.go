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

// The invitation callback path the next Discord slice serves. It is computed
// from APP_BASE_URL unless an explicit redirect is stored.
const discordInviteCallbackPath = "/api/invitations/discord/callback"

type discordSettings struct {
	Revision    int64
	Enabled     bool
	ClientID    string
	secret      string
	RedirectURI string
	GuildID     string
	InviteURL   string
	VerifiedAt  string
}

func readDiscordSettings(ctx context.Context, q queryRower) (discordSettings, error) {
	var s discordSettings
	err := q.QueryRowContext(ctx, "SELECT revision,oauth_enabled,coalesce(client_id,''),coalesce(client_secret,''),coalesce(redirect_uri_invite,''),coalesce(guild_id,''),coalesce(server_invite_url,''),coalesce(verified_at,'') FROM discord_settings WHERE singleton=1").Scan(&s.Revision, &s.Enabled, &s.ClientID, &s.secret, &s.RedirectURI, &s.GuildID, &s.InviteURL, &s.VerifiedAt)
	return s, err
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
		return base + discordInviteCallbackPath
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
	// Unimplemented bot, whitelist and invitation-requirement features are
	// reported as off, never as configured.
	return map[string]any{
		"revision": s.Revision, "enable_oauth": s.Enabled, "client_id": nullable(s.ClientID), "client_secret_set": s.secret != "",
		"oauth_auth_url": nil, "redirect_uri_invite": nullable(a.discordRedirect(ctx, s)), "redirect_uri_admin": nil,
		"default_require_discord_auth": false, "default_require_discord_guild_membership": false, "enable_membership_requirement": false,
		"guild_id": nullable(s.GuildID), "server_invite_url": nullable(s.InviteURL),
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
	// Features that are not implemented: accepted only when off/empty.
	Bot           bool   `json:"enable_bot"`
	Membership    bool   `json:"enable_membership_requirement"`
	RequireAuth   bool   `json:"default_require_discord_auth"`
	RequireGuild  bool   `json:"default_require_discord_guild_membership"`
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
	if input.Bot || input.Membership || input.RequireAuth || input.RequireGuild || input.Whitelist || input.BotToken != "" || input.MonitoredRole != "" || input.ThreadChannel != "" || input.BotLogChannel != "" {
		fail(w, 422, "DISCORD_FEATURE_UNAVAILABLE", "Discord bot, whitelist and invitation requirements are not available yet; turn them off to save")
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
		result, err := tx.ExecContext(r.Context(), `UPDATE discord_settings SET oauth_enabled=?,client_id=nullif(?,''),client_secret=nullif(?,''),redirect_uri_invite=nullif(?,''),guild_id=nullif(?,''),server_invite_url=nullif(?,''),verified_at=nullif(?,''),updated_at=?,revision=revision+1 WHERE singleton=1 AND revision=?`,
			input.Enabled, clientID, secret, redirect, guild, invite, verified, utcTimestamp(time.Now()), current.Revision)
		if err != nil {
			return err
		}
		if count, _ := result.RowsAffected(); count != 1 {
			return ErrConflict
		}
		details, _ := json.Marshal(map[string]any{"enable_oauth": input.Enabled, "client_id": clientID, "secret_changed": secret != current.secret, "verified": verified != ""})
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
		respond(w, 200, map[string]any{"success": true, "message": "Discord accepted the OAuth client credentials"})
	}
}
