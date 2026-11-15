package main

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"time"

	"app/server/providers/provider"
)

// Sign in with Jellyfin Quick Connect, part of media server sign-in. MUM asks
// the chosen Jellyfin server for a short code; the user approves it in a
// Jellyfin app where they are already signed in, and this browser checks until
// the server reports which user approved it. That user then signs in exactly
// as with their Jellyfin password.
//
// Attempts live only in memory, bound to the browser that started them by an
// HttpOnly cookie: the server's Quick Connect secret is a credential and never
// reaches the database, the browser or the logs. A restart only means
// starting again.

var (
	errQuickConnectOff  = errors.New("Quick Connect is turned off on this server")
	errQuickConnectWait = errors.New("Quick Connect checked too soon")
)

// quickConnector is the module feature that runs Quick Connect.
type quickConnector interface {
	StartQuickConnect(ctx context.Context) (provider.QuickConnectRequest, error)
	CheckQuickConnect(ctx context.Context, secret string) (bool, error)
	FinishQuickConnect(ctx context.Context, secret string) (provider.VerifiedLogin, error)
}

// quickConnectTypesSQL are the server types with Quick Connect.
const quickConnectTypesSQL = `('jellyfin')`

const (
	// quickConnectLifetime matches how long Jellyfin keeps a request.
	quickConnectLifetime    = 10 * time.Minute
	quickConnectInterval    = 2 * time.Second
	quickConnectMaxAttempts = 100
)

type quickConnectAttempt struct {
	browser   string // hash of the browser cookie
	server    int64
	secret    string
	remember  bool
	expires   time.Time
	pollAfter time.Time
	busy      bool
}

// quickConnectAttempts holds the attempts in progress, at most
// quickConnectMaxAttempts at once; expired ones are dropped as new ones start.
type quickConnectAttempts struct {
	mu   sync.Mutex
	byID map[string]*quickConnectAttempt
}

func (q *quickConnectAttempts) add(id string, attempt quickConnectAttempt, now time.Time) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.byID == nil {
		q.byID = map[string]*quickConnectAttempt{}
	}
	for key, existing := range q.byID {
		if !existing.expires.After(now) && !existing.busy {
			delete(q.byID, key)
		}
	}
	if len(q.byID) >= quickConnectMaxAttempts {
		return errServiceLoginBusy
	}
	q.byID[id] = &attempt
	return nil
}

// claim takes the attempt for one check by the browser that started it.
func (q *quickConnectAttempts) claim(id, browser string, now time.Time) (quickConnectAttempt, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	attempt := q.byID[id]
	if attempt == nil || len(browser) != 43 || tokenHash(browser) != attempt.browser || !attempt.expires.After(now) {
		return quickConnectAttempt{}, ErrForbidden
	}
	if attempt.busy {
		return quickConnectAttempt{}, ErrConflict
	}
	if attempt.pollAfter.After(now) {
		return quickConnectAttempt{}, errQuickConnectWait
	}
	attempt.busy, attempt.pollAfter = true, now.Add(quickConnectInterval)
	return *attempt, nil
}

func (q *quickConnectAttempts) release(id string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if attempt := q.byID[id]; attempt != nil {
		attempt.busy = false
	}
}

func (q *quickConnectAttempts) remove(id string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	delete(q.byID, id)
}

func quickConnectCookieName(id string) string { return "mum_quick_connect_" + id }
func (a *App) setQuickConnectCookie(w http.ResponseWriter, r *http.Request, id, value string, maxAge int) {
	http.SetCookie(w, &http.Cookie{Name: quickConnectCookieName(id), Value: value, Path: "/api/auth/quick-connect/" + id, HttpOnly: true, Secure: a.secureCookie(r), SameSite: http.SameSiteStrictMode, MaxAge: maxAge})
}

func quickConnectError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errQuickConnectOff):
		fail(w, 409, "QUICK_CONNECT_OFF", "Quick Connect is turned off on this server. Sign in with your username and password.")
	case errors.Is(err, errQuickConnectWait):
		w.Header().Set("Retry-After", "2")
		fail(w, 429, "QUICK_CONNECT_WAIT", "Wait before checking Quick Connect again.")
	case errors.Is(err, ErrForbidden), errors.Is(err, provider.ErrQuickConnectExpired):
		fail(w, 403, "QUICK_CONNECT_EXPIRED", "This Quick Connect code has expired or belongs to another browser. Start again.")
	case errors.Is(err, ErrConflict):
		fail(w, 409, "QUICK_CONNECT_CONFLICT", "This Quick Connect sign-in is already being checked.")
	default:
		serviceLoginError(w, err)
	}
}

// quickConnectModule returns the Quick Connect feature of serverID.
func (a *App) quickConnectModule(ctx context.Context, serverID int64) (quickConnector, error) {
	module, err := a.signInModule(ctx, serverID)
	if err != nil {
		return nil, err
	}
	connector, ok := module.(quickConnector)
	if !ok {
		return nil, errServiceLoginServer
	}
	return connector, nil
}

// startQuickConnectLogin asks the chosen Jellyfin server for a code.
func (a *App) startQuickConnectLogin(w http.ResponseWriter, r *http.Request) {
	var input struct {
		ServerID int64 `json:"server_id"`
		Remember bool  `json:"remember"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	if input.ServerID < 1 {
		fail(w, 400, "INVALID_SIGN_IN", "Choose a server")
		return
	}
	ctx, done, ok := a.startSignInOperation(w, r)
	if !ok {
		return
	}
	defer done()
	// Codes count toward the attempt limits per address and per server.
	source := requestSource(r)
	if err := a.admitServerSignIn(ctx, r, input.ServerID, quickConnectTypesSQL, "quick-connect\x00"+source); err != nil {
		quickConnectError(w, err)
		return
	}
	connector, err := a.quickConnectModule(ctx, input.ServerID)
	if err != nil {
		quickConnectError(w, err)
		return
	}
	request, err := connector.StartQuickConnect(ctx)
	if errors.Is(err, provider.ErrQuickConnectOff) {
		err = errQuickConnectOff
	}
	if err != nil {
		quickConnectError(w, err)
		return
	}
	now := time.Now()
	id, browser := newUUID(), randomToken()
	attempt := quickConnectAttempt{browser: tokenHash(browser), server: input.ServerID, secret: request.Secret, remember: input.Remember, expires: now.Add(quickConnectLifetime), pollAfter: now}
	if err := a.quickConnect.add(id, attempt, now); err != nil {
		quickConnectError(w, err)
		return
	}
	a.setQuickConnectCookie(w, r, id, browser, int(quickConnectLifetime.Seconds()))
	respond(w, 201, map[string]any{"id": id, "status": "pending", "code": request.Code, "expires_at": utcTimestamp(attempt.expires)})
}

// pollQuickConnectLogin checks the attempt once. When the server reports the
// code approved, the attempt is used up and the approving user signs in.
func (a *App) pollQuickConnectLogin(w http.ResponseWriter, r *http.Request) {
	var input struct{}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	id := r.PathValue("attempt")
	cookie, err := r.Cookie(quickConnectCookieName(id))
	if !validProvisionedID(id) || err != nil {
		quickConnectError(w, ErrForbidden)
		return
	}
	ctx, done, ok := a.startSignInOperation(w, r)
	if !ok {
		return
	}
	defer done()
	attempt, err := a.quickConnect.claim(id, cookie.Value, time.Now())
	if err != nil {
		quickConnectError(w, err)
		return
	}
	// Turning sign-in or the server off ends attempts in progress.
	if err := serverSignInAvailable(ctx, a.store.reader, attempt.server, quickConnectTypesSQL); err != nil {
		a.quickConnect.remove(id)
		quickConnectError(w, err)
		return
	}
	connector, err := a.quickConnectModule(ctx, attempt.server)
	if err != nil {
		a.quickConnect.release(id)
		quickConnectError(w, err)
		return
	}
	approved, err := connector.CheckQuickConnect(ctx, attempt.secret)
	if errors.Is(err, provider.ErrQuickConnectExpired) {
		a.quickConnect.remove(id)
	} else {
		a.quickConnect.release(id)
	}
	if err != nil {
		quickConnectError(w, err)
		return
	}
	if !approved {
		respond(w, 200, map[string]any{"id": id, "status": "pending", "expires_at": utcTimestamp(attempt.expires)})
		return
	}
	// Approved: the attempt is used up whatever happens next, so it ends in
	// at most one session and an uncertain completion is never retried.
	a.quickConnect.remove(id)
	a.setQuickConnectCookie(w, r, id, "", -1)
	login, err := connector.FinishQuickConnect(ctx, attempt.secret)
	if err != nil {
		quickConnectError(w, err)
		return
	}
	tokens, principal, err := a.issueServiceSession(ctx, attempt.server, login, attempt.remember, "auth.login.quick_connect")
	if err != nil {
		serviceLoginError(w, err)
		return
	}
	a.setRefreshCookie(w, r, tokens)
	respond(w, 200, map[string]any{"id": id, "status": "signed_in", "access_token": tokens.Access, "user": principal})
}
