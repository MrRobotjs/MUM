package main

import (
	"app/server/providers/provider"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"path"
	"strings"
	"sync"
	"time"
)

type attemptWindow struct {
	start time.Time
	count int
}
type App struct {
	locationCache    provider.LocationCache
	logger           *slog.Logger
	scheduler        *syncScheduler
	providerSockets  *providerSocketRuntime
	store            *Store
	queue            *LogQueue
	hub              *realtimeHub
	handler          http.Handler
	dummyHash        string
	passwordSlots    chan struct{}
	provisionSlots   chan struct{}
	provisionMu      sync.Mutex
	provisionClosing bool
	provisionWG      sync.WaitGroup
	provisionCtx     context.Context
	provisionCancel  context.CancelFunc
	loginMu          sync.Mutex
	attempts         map[string]attemptWindow
	SecureCookies    bool
	TrustedProxies   []netip.Prefix // Reverse proxies whose X-Forwarded-* headers are honoured.
	ProviderHTTP     *http.Client
	DiscordAPI       string // test-only override of the fixed Discord API base
	syncRun          sync.Mutex
	syncMu           sync.Mutex
	syncState        map[string]any
	// Library item catalogue runs (bounded) and the per-process image URL key.
	// API route patterns, recorded at registration for the OpenAPI document.
	apiRoutes     []apiRoute
	catalogueMu   sync.Mutex
	catalogueRuns map[int64]*catalogueProgress
	episodeRuns   map[int64]bool
	imageKey      []byte
	imageSlots    chan struct{}
}

func NewApp(store *Store, queue *LogQueue, assets fs.FS) (*App, error) {
	dummy, err := hashPassword("invalid-login-dummy-password")
	if err != nil {
		return nil, err
	}
	a := &App{logger: slog.Default(), store: store, queue: queue, dummyHash: dummy, passwordSlots: make(chan struct{}, 4), attempts: make(map[string]attemptWindow)}
	schedulerCtx, schedulerCancel := context.WithCancel(context.Background())
	a.scheduler = &syncScheduler{ctx: schedulerCtx, cancel: schedulerCancel, done: make(chan struct{}), runner: newUUID()}
	a.providerSockets = &providerSocketRuntime{workers: map[int64]*providerSocketWorker{}, done: make(chan struct{})}
	a.provisionSlots = make(chan struct{}, 2)
	a.catalogueRuns = map[int64]*catalogueProgress{}
	a.episodeRuns = map[int64]bool{}
	a.imageSlots = make(chan struct{}, 8)
	a.imageKey = make([]byte, 32)
	if _, err := rand.Read(a.imageKey); err != nil {
		return nil, err
	}
	a.provisionCtx, a.provisionCancel = context.WithCancel(context.Background())
	if err := a.recoverProvisioning(context.Background()); err != nil {
		return nil, err
	}
	if err := a.recoverEdit(context.Background()); err != nil {
		return nil, err
	}
	a.hub = newRealtimeHub(store)
	mux := http.NewServeMux()
	// Every API route pattern is recorded for the generated OpenAPI document,
	// so the document cannot drift from the routes actually served.
	handle := func(pattern string, handler func(http.ResponseWriter, *http.Request)) {
		mux.HandleFunc(pattern, handler)
		if method, path, ok := strings.Cut(pattern, " "); ok && strings.HasPrefix(path, "/api/") {
			a.apiRoutes = append(a.apiRoutes, apiRoute{method, path})
		}
	}
	handle("GET /api/openapi/openapi.json", a.openAPIDocument)
	handle("GET /api/activity/images/{item}", a.activityImageProxy)
	handle("GET /api/activity/history-images/{item}", a.activityHistoryImageProxy)
	handle("GET /api/activity/avatars/{item}", a.activityAvatarProxy)
	handle("GET /api/user-avatars/{item}", a.userAvatarProxy)
	handle("POST /api/public/invitations/{token}/plex-authorizations", a.startInvitationPlexAuthorization)
	handle("POST /api/public/invitations/{token}/receipt", a.publicProvisioningReceipt)
	handle("POST /api/public/invitations/{token}/plex-authorizations/{authorization}/poll", a.pollInvitationPlexAuthorization)
	handle("POST /api/public/invitations/{token}/plex-authorizations/{authorization}/confirm", a.confirmInvitationPlexAuthorization)
	handle("GET /api/account/profile", a.accountProfile)
	handle("POST /api/account/password", a.changeAccountPassword)
	handle("PATCH /api/account/email", a.changeAccountEmail)
	handle("GET /api/account/preferences", a.accountPreferences)
	handle("PUT /api/account/preferences", a.saveAccountPreferences)
	handle("GET /api/account/display", a.accountDisplay)
	handle("PUT /api/account/display", a.saveAccountDisplay)
	handle("GET /api/account/username", a.accountUsername)
	handle("PATCH /api/account/username", a.changeAccountUsername)
	handle("GET /api/admins", a.listAdmins)
	handle("POST /api/admins", a.createAdmin)
	handle("PATCH /api/admins/{admin}", a.updateAdminRoles)
	handle("DELETE /api/admins/{admin}", a.unsupportedAdminAction)
	handle("POST /api/admins/{admin}/reset-password", a.unsupportedAdminAction)
	handle("GET /api/admin-roles", a.adminRolesRead)
	handle("GET /api/admin-roles/{role}", a.adminRolesRead)
	handle("GET /api/admin-roles/{role}/users", a.adminRoleMembersRead)
	handle("GET /api/admin-permissions", a.adminPermissionsRead)
	handle("POST /api/admin-roles", a.changeAdminRole)
	handle("PUT /api/admin-roles/{role}", a.changeAdminRole)
	handle("DELETE /api/admin-roles/{role}", a.changeAdminRole)
	handle("POST /api/admin-roles/reorder", a.changeAdminRole)
	handle("POST /api/admin-roles/{role}/memberships", a.changeAdminRoleMembership)
	handle("GET /api/admin-roles/{role}/candidates", a.adminRoleCandidatesRead)
	handle("POST /api/plex/authorizations", a.startPlexAuthorization)
	handle("POST /api/plex/authorizations/{authorization}/poll", a.pollPlexAuthorization)
	handle("POST /api/plex/authorizations/{authorization}/confirm", a.confirmPlexAuthorization)
	handle("GET /api/plex/connection", a.getPlexConnection)
	handle("POST /api/plex/connections/{connection}/revoke", a.revokePlexConnection)
	handle("GET /api/notifications", a.notificationList)
	handle("POST /api/notifications/state", a.notificationState)
	handle("GET /api/activity/current", a.activityRead)
	handle("GET /api/activity/history", a.activityRead)
	handle("GET /api/activity/summary", a.activitySummary)
	handle("GET /api/graphs/analytics", a.graphAnalytics)
	handle("GET /api/activity/identities/{identity}/current", a.activityRead)
	handle("GET /api/activity/identities/{identity}/history", a.activityRead)
	handle("GET /api/activity/identities/{identity}/summary", a.activitySummary)
	handle("GET /api/settings/activity-monitoring", a.activityMonitorSettings)
	handle("GET /api/settings/streaming-map", a.streamingMapSettings)
	handle("PUT /api/settings/streaming-map", a.streamingMapSettings)
	handle("GET /api/activity/map-tiles/{theme}/{z}/{x}/{y}", a.streamingMapTile)
	handle("PUT /api/settings/activity-monitoring/{server}", a.configureActivityMonitor)
	handle("GET /api/health", a.health)
	handle("GET /api/setup/status", a.setupStatus)
	handle("POST /api/setup/account", a.setupAccount)
	handle("POST /api/auth/login", a.login)
	handle("POST /api/auth/refresh", a.refresh)
	handle("POST /api/auth/logout", a.logout)
	handle("GET /api/auth/session", a.session)
	handle("POST /api/setup/app", a.setupConfig)
	handle("POST /api/setup/complete", a.setupComplete)
	handle("GET /api/settings/user-accounts", func(w http.ResponseWriter, r *http.Request) {
		respond(w, 200, map[string]any{"allow_user_accounts": true})
	})
	handle("GET /api/settings/general", a.generalSettings)
	handle("PATCH /api/settings/general", a.saveGeneralSettings)
	handle("GET /api/settings/runtime-info", a.runtimeInfo)
	handle("GET /api/activity/statistics", a.activityStatistics)
	handle("GET /api/audit-events", a.recentAuditEvents)
	handle("GET /api/settings/discord", a.getDiscordSettings)
	handle("PATCH /api/settings/discord", a.saveDiscordSettings)
	handle("POST /api/settings/discord/test", a.testDiscordSettings)
	handle("GET /api/settings/scheduled-tasks", a.scheduledTasks)
	handle("PUT /api/settings/scheduled-tasks/{server}", a.configureScheduledSync)
	handle("POST /api/events", a.ingestEvents)
	handle("POST /api/chat", a.postChat)
	handle("GET /api/chat", a.getChat)
	handle("GET /api/providers", a.providers)
	handle("POST /api/providers/{provider}/enable", a.setProviderEnabled)
	handle("POST /api/providers/{provider}/disable", a.setProviderEnabled)
	handle("POST /api/providers/{provider}/test-connection", a.testProviderConnection)
	handle("GET /api/providers/{provider}/servers", a.listServers)
	handle("POST /api/providers/{provider}/servers", a.saveServer)
	handle("GET /api/servers", a.listServers)
	handle("POST /api/servers", a.saveServer)
	handle("GET /api/servers/{server}", a.getServer)
	handle("PATCH /api/servers/{server}", a.saveServer)
	handle("DELETE /api/servers/{server}", a.deleteServer)
	handle("POST /api/servers/{server}/test-connection", a.testSavedServer)
	handle("POST /api/servers/{server}/sync", a.syncServerEndpoint)
	handle("POST /api/servers/{server}/sync-libraries", a.syncServerEndpoint)
	handle("POST /api/servers/{server}/sync-users", a.syncServerEndpoint)
	handle("GET /api/libraries", a.listLibraries)
	handle("GET /api/libraries/{library}", a.listLibraries)
	handle("GET /api/libraries/{library}/media", a.libraryCatalogueItems)
	handle("GET /api/libraries/{library}/media/{item}", a.libraryCatalogueItem)
	handle("GET /api/libraries/{library}/media/{item}/episodes", a.listEpisodeCatalogue)
	handle("POST /api/libraries/{library}/media/{item}/episodes/sync", a.syncEpisodeCatalogue)
	handle("POST /api/libraries/{library}/media/{item}/episodes/purge", a.purgeEpisodeCatalogue)
	handle("POST /api/libraries/{library}/sync", a.syncLibraryCatalogue)
	handle("POST /api/libraries/{library}/purge", a.purgeLibraryCatalogue)
	handle("GET /api/libraries/{library}/sync-status", a.librarySyncStatus)
	handle("GET /api/libraries/{library}/stats", a.libraryStats)
	handle("GET /api/libraries/{library}/activity", a.libraryActivity)
	handle("GET /api/libraries/{library}/collections", a.libraryCollections)
	handle("GET /api/media/images/{item}", a.catalogueImageProxy)
	handle("GET /api/media/collections/images/{collection}", a.collectionImageProxy)
	handle("GET /api/sync/status", a.getSyncStatus)
	handle("GET /api/users", a.listUsers)
	handle("POST /api/users", a.createUser)
	handle("GET /api/users/{user}", a.listUsers)
	handle("GET /api/users/{user}/notes", a.profileNotes)
	handle("PUT /api/users/{user}/notes", a.profileNotes)
	handle("GET /api/users/{user}/activation", a.humanActivation)
	handle("PUT /api/users/{user}/activation", a.humanActivation)
	handle("GET /api/users/{user}/local-credentials", a.humanCredentials)
	handle("PUT /api/users/{user}/local-credentials", a.humanCredentials)
	handle("GET /api/users/{user}/expiry", a.humanExpiry)
	handle("PUT /api/users/{user}/expiry", a.humanExpiry)
	handle("GET /api/service-accounts/{service}/expiry", a.serviceExpiry)
	handle("PUT /api/service-accounts/{service}/expiry", a.serviceExpiry)
	handle("GET /api/service-accounts/{service}/remote-access", a.serviceRemoteAccess)
	handle("POST /api/service-accounts/{service}/remote-access/disable", a.disableServiceRemoteAccess)
	handle("POST /api/service-accounts/{service}/remote-access/enable", a.enableServiceRemoteAccess)
	handle("POST /api/service-accounts/{service}/remote-access/delete", a.deleteServiceRemoteAccess)
	handle("GET /api/users/{user}/remote-access", a.profileRemoteAccess)
	handle("GET /api/users/{user}/overseerr", a.profileOverseerr)
	handle("GET /api/users/{user}/debug", a.userDebug)
	handle("POST /api/servers/{server}/overseerr/requests/{request}/{action}", a.overseerrRequestAction)
	handle("GET /api/users/{user}/user-roles", a.humanUserRoles)
	handle("PUT /api/users/{user}/user-roles", a.humanUserRoles)
	handle("POST /api/user-role-catalog", a.createUserRole)
	handle("GET /api/user-role-catalog", a.userRoleCatalog)
	handle("POST /api/user-role-catalog/changes", a.userRoleCatalog)
	handle("GET /api/user-role-catalog/{role}/members", a.userRoleMembers)
	handle("POST /api/user-role-catalog/{role}/members", a.userRoleMembers)
	handle("POST /api/users/sync-all", a.syncAllUsers)
	handle("POST /api/users/edit", a.editUsers)
	handle("POST /api/users/edit/prepare", a.prepareEdit)
	handle("POST /api/users/edit/expiry", a.editExpiry)
	handle("POST /api/edit-operations/{operation}/execute", a.executeEdit)
	handle("GET /api/edit-operations/{operation}", a.readEditReceipt)
	handle("POST /api/edit-operations/{operation}/reconcile", a.reconcileEdit)
	handle("GET /api/account-links/{user}/{service}", a.accountLinkCapabilities)
	handle("GET /api/account-links/{user}/accounts", a.accountLinkAccounts)
	handle("PUT /api/account-links/{user}/{service}", a.changeAccountLink)
	handle("DELETE /api/account-links/{user}/{service}", a.changeAccountLink)
	handle("GET /api/invitations", a.listInvitations)
	handle("POST /api/invitations", a.createInvitation)
	handle("GET /api/invitations/{invitation}", a.getInvitation)
	handle("PATCH /api/invitations/{invitation}", a.updateInvitation)
	handle("GET /api/invitations/{invitation}/share-link", a.invitationShareLink)
	handle("POST /api/invitations/actions", a.invitationActions)
	handle("DELETE /api/invitations/{invitation}", a.revokeInvitation)
	handle("GET /api/public/invitations/{token}", a.publicInvitation)
	handle("GET /api/public/invitation-paths/{path}", a.resolveInvitationPath)
	handle("POST /api/public/invitations/{token}/discord-authorizations", a.startInvitationDiscord)
	handle("GET /api/public/invitations/{token}/discord-authorization", a.invitationDiscordStatus)
	handle("GET /api/invitations/discord/callback", a.discordCallback)
	handle("POST /api/public/invitations/{token}/redeem", a.redeemInvitation)
	handle("GET /api/provisioning-jobs/{job}", a.getProvisioningJob)
	handle("GET /api/provisioning-jobs", a.listProvisioningJobs)
	handle("POST /api/provisioning-jobs/{job}/plex/{server}/{plex_action}", a.plexAdministratorJobAction)
	handle("POST /api/provisioning-jobs/{job}/{action}", func(w http.ResponseWriter, r *http.Request) {
		if r.PathValue("action") == "resume" {
			a.resumeProvisioningJob(w, r)
			return
		}
		if r.PathValue("action") != "disable-accounts" && r.PathValue("action") != "cancel" {
			fail(w, 404, "NOT_FOUND", "Review action not found")
			return
		}
		a.reviewProvisioningJob(w, r)
	})
	handle("GET /ws", a.hub.serve)
	handle("/api/", func(w http.ResponseWriter, r *http.Request) { fail(w, 404, "NOT_FOUND", "API route not found") })
	handle("/socket.io/", func(w http.ResponseWriter, r *http.Request) { fail(w, 404, "NOT_FOUND", "Route not found") })
	mux.Handle("/", spaHandler(assets, func(r *http.Request) bool { return a.setting(r.Context(), "SETUP_COMPLETE", "") == "true" }))
	a.handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r = a.applyForwarded(r)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
		}
		if r.Method != "GET" && r.Method != "HEAD" && r.Method != "OPTIONS" {
			if origin := r.Header.Get("Origin"); origin != "" {
				u, err := url.Parse(origin)
				scheme := "http"
				if requestHTTPS(r) {
					scheme = "https"
				}
				if err != nil || u.Host != r.Host || u.Scheme != scheme {
					fail(w, 403, "ORIGIN_REJECTED", "Origin is not permitted")
					return
				}
			}
		}
		mux.ServeHTTP(w, r)
	})
	return a, nil
}

func (a *App) ServeHTTP(w http.ResponseWriter, r *http.Request) { a.handler.ServeHTTP(w, r) }
func (a *App) CloseRealtime()                                   { a.hub.close() }

func respond(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"data": data})
}
func fail(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": code, "message": message}})
}
func decodeBody(w http.ResponseWriter, r *http.Request, value any) bool {
	return decodeJSONBody(w, r, value, false)
}

func decodeStrictBody(w http.ResponseWriter, r *http.Request, value any) bool {
	return decodeJSONBody(w, r, value, true)
}

func decodeJSONBody(w http.ResponseWriter, r *http.Request, value any, strict bool) bool {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		fail(w, 415, "JSON_REQUIRED", "Send application/json")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	decoder := json.NewDecoder(r.Body)
	if strict {
		decoder.DisallowUnknownFields()
	}
	if err := decoder.Decode(value); err != nil {
		fail(w, 400, "INVALID_BODY", "Invalid JSON body")
		return false
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		fail(w, 400, "INVALID_BODY", "One JSON object is required")
		return false
	}
	return true
}
func bearer(r *http.Request) string {
	scheme, token, _ := strings.Cut(r.Header.Get("Authorization"), " ")
	if scheme != "Bearer" {
		return ""
	}
	return token
}
func (a *App) principal(w http.ResponseWriter, r *http.Request, admin bool) (Principal, bool) {
	p, err := a.store.Authenticate(r.Context(), bearer(r))
	if err != nil {
		fail(w, 401, "UNAUTHENTICATED", "Sign in required")
		return p, false
	}
	if admin && !p.Admin {
		fail(w, 403, "FORBIDDEN", "Administrator permission required")
		return p, false
	}
	return p, true
}

func (a *App) passwordAdmission(w http.ResponseWriter, r *http.Request) bool {
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		ip = r.RemoteAddr
	}
	a.loginMu.Lock()
	now := time.Now()
	window := a.attempts[ip]
	if now.Sub(window.start) >= time.Minute {
		window = attemptWindow{start: now}
	}
	window.count++
	if len(a.attempts) >= 4096 {
		for key, old := range a.attempts {
			if now.Sub(old.start) > time.Minute {
				delete(a.attempts, key)
			}
		}
	}
	allowed := window.count <= 20 && (len(a.attempts) < 4096 || !a.attempts[ip].start.IsZero())
	if allowed {
		a.attempts[ip] = window
	}
	a.loginMu.Unlock()
	if !allowed {
		w.Header().Set("Retry-After", "60")
		fail(w, 429, "RATE_LIMITED", "Try again later")
		return false
	}
	select {
	case a.passwordSlots <- struct{}{}:
		return true
	default:
		fail(w, 503, "BUSY", "Try again shortly")
		return false
	}
}

func (a *App) setRefreshCookie(w http.ResponseWriter, r *http.Request, t sessionTokens) {
	http.SetCookie(w, &http.Cookie{Name: "mum_refresh", Value: t.Refresh, Path: "/api/auth", HttpOnly: true, Secure: a.secureCookie(r), SameSite: http.SameSiteStrictMode, Expires: t.RefreshExpires, MaxAge: int(time.Until(t.RefreshExpires).Seconds())})
}

func (a *App) setupAccount(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Username string `json:"username"`
		Password string `json:"password"`
		Confirm  string `json:"confirm_password"`
	}
	if !decodeBody(w, r, &input) {
		return
	}
	if strings.TrimSpace(input.Username) == "" || len(input.Username) > 255 || input.Password != input.Confirm {
		fail(w, 400, "INVALID_ACCOUNT", "Valid username and matching passwords required")
		return
	}
	if !a.passwordAdmission(w, r) {
		return
	}
	defer func() { <-a.passwordSlots }()
	hash, err := hashPassword(input.Password)
	if err != nil {
		fail(w, 400, "INVALID_PASSWORD", err.Error())
		return
	}
	uuid, err := a.store.CreateAccount(r.Context(), "", input.Username, hash, true)
	if errors.Is(err, ErrConflict) {
		fail(w, 409, "SETUP_CLOSED", "Owner already exists")
		return
	}
	if err != nil {
		fail(w, 500, "SETUP_FAILED", "Could not create owner")
		return
	}
	tokens, err := a.store.issuePasswordSession(r.Context(), uuid, hash, 1, false)
	if err != nil {
		fail(w, 500, "SESSION_FAILED", "Sign in to continue")
		return
	}
	a.setRefreshCookie(w, r, tokens)
	respond(w, 201, map[string]any{"access_token": tokens.Access})
}

func (a *App) login(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Username string `json:"username"`
		Password string `json:"password"`
		Remember bool   `json:"remember"`
	}
	if !decodeBody(w, r, &input) {
		return
	}
	if !a.passwordAdmission(w, r) {
		return
	}
	defer func() { <-a.passwordSlots }()
	var uuid, hash string
	var revision int64
	err := a.store.reader.QueryRowContext(r.Context(), "SELECT uuid,password_hash,profile_revision FROM user_accounts WHERE local_username=?", strings.TrimSpace(input.Username)).Scan(&uuid, &hash, &revision)
	if err != nil {
		hash = a.dummyHash
	}
	valid := verifyPassword(hash, input.Password)
	if err != nil || !valid {
		fail(w, 401, "INVALID_CREDENTIALS", "Invalid username or password")
		return
	}
	tokens, err := a.store.issuePasswordSession(r.Context(), uuid, hash, revision, input.Remember)
	if err != nil {
		fail(w, 401, "INVALID_CREDENTIALS", "Account is unavailable")
		return
	}
	p, err := loadPrincipal(r.Context(), a.store.reader, uuid)
	if err != nil {
		fail(w, 401, "INVALID_CREDENTIALS", "Account is unavailable")
		return
	}
	a.setRefreshCookie(w, r, tokens)
	respond(w, 200, map[string]any{"access_token": tokens.Access, "user": p})
}
func (a *App) refresh(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie("mum_refresh")
	if err != nil {
		fail(w, 401, "UNAUTHENTICATED", "Sign in required")
		return
	}
	tokens, p, err := a.store.refreshSession(r.Context(), cookie.Value)
	if err != nil {
		fail(w, 401, "UNAUTHENTICATED", "Session expired")
		return
	}
	a.setRefreshCookie(w, r, tokens)
	respond(w, 200, map[string]any{"access_token": tokens.Access, "user": p})
}
func (a *App) logout(w http.ResponseWriter, r *http.Request) {
	refresh := ""
	if cookie, err := r.Cookie("mum_refresh"); err == nil {
		refresh = cookie.Value
	}
	if err := a.store.write(r.Context(), func(tx *sql.Tx) error {
		_, err := tx.ExecContext(r.Context(), "DELETE FROM app_sessions WHERE id IN(SELECT session_id FROM session_access_tokens WHERE token_hash=?) OR refresh_hash=?", tokenHash(bearer(r)), tokenHash(refresh))
		return err
	}); err != nil {
		fail(w, 500, "LOGOUT_FAILED", "Could not revoke session")
		return
	}
	http.SetCookie(w, &http.Cookie{Name: "mum_refresh", Path: "/api/auth", Value: "", MaxAge: -1, HttpOnly: true, Secure: a.secureCookie(r), SameSite: http.SameSiteStrictMode})
	respond(w, 200, map[string]any{"success": true})
}
func (a *App) session(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, false)
	if !ok {
		return
	}
	respond(w, 200, map[string]any{"user": p, "permissions": p.Permissions, "setup_complete": a.setting(r.Context(), "SETUP_COMPLETE", "") == "true", "feature_flags": map[string]bool{}, "app_name": a.setting(r.Context(), "APP_NAME", "MUM")})
}

func (a *App) setting(ctx context.Context, key, fallback string) string {
	var value string
	if err := a.store.reader.QueryRowContext(ctx, "SELECT value FROM settings WHERE key=?", key).Scan(&value); err != nil {
		return fallback
	}
	return value
}
func putSetting(ctx context.Context, tx *sql.Tx, key, value string) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO settings(key,value,value_type) VALUES(?,?,'string') ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, value)
	return err
}
func (a *App) setupStatus(w http.ResponseWriter, r *http.Request) {
	var account bool
	if err := a.store.reader.QueryRowContext(r.Context(), "SELECT EXISTS(SELECT 1 FROM user_accounts WHERE kind='owner')").Scan(&account); err != nil {
		fail(w, 503, "DATABASE_UNAVAILABLE", "Database unavailable")
		return
	}
	configured := a.setting(r.Context(), "APP_CONFIGURED", "") == "true"
	complete := a.setting(r.Context(), "SETUP_COMPLETE", "") == "true"
	steps := []string{}
	if account {
		steps = append(steps, "account")
	}
	if configured {
		steps = append(steps, "app")
	}
	var providersConfigured bool
	if err := a.store.reader.QueryRowContext(r.Context(), "SELECT EXISTS(SELECT 1 FROM media_servers s JOIN provider_settings p ON p.provider_id=s.service_type WHERE s.is_active=1 AND p.enabled=1)").Scan(&providersConfigured); err != nil {
		domainError(w, err)
		return
	}
	if providersConfigured {
		steps = append(steps, "plugins")
	}
	respond(w, 200, map[string]any{"account_complete": account, "app_complete": configured, "plugins_complete": providersConfigured, "discord_complete": false, "setup_complete": complete, "completed_steps": steps})
}
func (a *App) setupConfig(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	if p.Kind != "owner" {
		fail(w, 403, "FORBIDDEN", "Owner permission required")
		return
	}
	var input struct {
		Name  string `json:"app_name"`
		Base  string `json:"app_base_url"`
		Local string `json:"app_local_url"`
	}
	if !decodeBody(w, r, &input) {
		return
	}
	if code, message, valid := validAppSettings(input.Name, input.Base, input.Local); !valid {
		fail(w, 400, code, message)
		return
	}
	err := a.store.write(r.Context(), func(tx *sql.Tx) error {
		var closed bool
		if err := tx.QueryRowContext(r.Context(), "SELECT EXISTS(SELECT 1 FROM settings WHERE key='SETUP_COMPLETE' AND value='true')").Scan(&closed); err != nil {
			return err
		}
		if closed {
			return ErrConflict
		}
		for key, value := range map[string]string{"APP_NAME": input.Name, "APP_BASE_URL": input.Base, "APP_LOCAL_URL": input.Local, "APP_CONFIGURED": "true"} {
			if err := putSetting(r.Context(), tx, key, value); err != nil {
				return err
			}
		}
		return nil
	})
	if errors.Is(err, ErrConflict) {
		fail(w, 409, "SETUP_CLOSED", "Setup is complete")
		return
	}
	if err != nil {
		fail(w, 500, "SAVE_FAILED", "Could not save settings")
		return
	}
	respond(w, 200, map[string]any{"app_name": input.Name})
}
func (a *App) setupComplete(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	if p.Kind != "owner" {
		fail(w, 403, "FORBIDDEN", "Owner permission required")
		return
	}
	if a.setting(r.Context(), "APP_CONFIGURED", "") != "true" {
		fail(w, 409, "SETUP_INCOMPLETE", "Configure the application first")
		return
	}
	if err := a.store.write(r.Context(), func(tx *sql.Tx) error { return putSetting(r.Context(), tx, "SETUP_COMPLETE", "true") }); err != nil {
		fail(w, 500, "SAVE_FAILED", "Could not complete setup")
		return
	}
	respond(w, 200, map[string]any{"setup_complete": true})
}
func (a *App) generalSettings(w http.ResponseWriter, r *http.Request) {
	respond(w, 200, map[string]any{"app_name": a.setting(r.Context(), "APP_NAME", "MUM"), "app_base_url": a.setting(r.Context(), "APP_BASE_URL", ""), "app_local_url": a.setting(r.Context(), "APP_LOCAL_URL", ""),
		// Read-only: fixed by this build (see saveGeneralSettings).
		"jwt_access_token_expires_minutes": int(accessTokenLifetime / time.Minute), "jwt_refresh_token_expires_days": int(refreshSessionLifetime / (24 * time.Hour)), "jwt_cookie_secure": a.SecureCookies})
}
func (a *App) health(w http.ResponseWriter, r *http.Request) {
	if a.store.reader.PingContext(r.Context()) != nil || a.queue.Err() != nil {
		fail(w, 503, "UNHEALTHY", "Persistence is unavailable")
		return
	}
	respond(w, 200, map[string]any{"status": "ok"})
}
func (a *App) ingestEvents(w http.ResponseWriter, r *http.Request) {
	_, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	var entry LogEntry
	if !decodeBody(w, r, &entry) {
		return
	}
	if err := a.queue.Enqueue(entry); err != nil {
		status := 400
		if errors.Is(err, ErrQueueFull) {
			status = 429
		} else if errors.Is(err, ErrQueueFailed) || errors.Is(err, ErrQueueClosed) {
			status = 503
		}
		fail(w, status, "EVENT_REJECTED", "Event could not be accepted")
		return
	}
	respond(w, 202, map[string]any{"accepted": true, "durable": false})
}

// spaHandler serves embedded assets and the SPA shell. Until first-run setup
// is complete, page requests outside the setup wizard redirect to it, as the
// Flask app's setup_required did; API, socket and asset requests are not
// redirected.
func spaHandler(assets fs.FS, setupComplete func(*http.Request) bool) http.Handler {
	files := http.FileServer(http.FS(assets))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" && r.Method != "HEAD" {
			http.Error(w, "Method not allowed", 405)
			return
		}
		name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if name == "" {
			name = "index.html"
		}
		page := name == "index.html" || !strings.Contains(path.Base(name), ".") && !strings.HasPrefix(name, "api") && !strings.HasPrefix(name, "ws") && !strings.HasPrefix(name, "assets/") && !strings.HasPrefix(name, "static/")
		if page && name != "setup" && !strings.HasPrefix(name, "setup/") && !setupComplete(r) {
			http.Redirect(w, r, "/setup", http.StatusFound)
			return
		}
		if info, err := fs.Stat(assets, name); err == nil && !info.IsDir() {
			files.ServeHTTP(w, r)
			return
		}
		if strings.HasPrefix(name, "api") || strings.HasPrefix(name, "ws") || strings.HasPrefix(name, "assets/") || strings.HasPrefix(name, "static/") || strings.Contains(path.Base(name), ".") {
			http.NotFound(w, r)
			return
		}
		body, err := fs.ReadFile(assets, "index.html")
		if err != nil {
			http.Error(w, "Frontend assets unavailable", 503)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		if r.Method != "HEAD" {
			_, _ = w.Write(body)
		}
	})
}
