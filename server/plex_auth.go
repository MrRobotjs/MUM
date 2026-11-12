package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// This device-key adapter is not a login, account-link or invitation endpoint.
// Persist a separate device identity per authorized connection before exposing
// it, and bind every subsequent use to that connection's verified account ID.
type plexDeviceAuth struct {
	client          *http.Client
	clientID, keyID string
	privateKey      ed25519.PrivateKey
}
type plexPIN struct {
	id               int64
	code             string
	expires          time.Time
	clientID         string
	authorizationURL string
}
type plexAuthenticatedAccount struct {
	ID       string `json:"id"`
	Username string `json:"username"`
	Email    string `json:"email"`
}
type plexAuthenticationResult struct {
	Pending   bool                      `json:"pending"`
	Account   *plexAuthenticatedAccount `json:"account,omitempty"`
	authToken string
}

var errPlexAuthentication = errors.New("Plex authentication could not be verified")

func newPlexDeviceAuth(client *http.Client) (*plexDeviceAuth, error) {
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	if client == nil {
		client = &http.Client{}
	}
	copyClient := *client
	if copyClient.Timeout <= 0 || copyClient.Timeout > 15*time.Second {
		copyClient.Timeout = 15 * time.Second
	}
	copyClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &plexDeviceAuth{&copyClient, newUUID(), randomToken(), key}, nil
}
func (p *plexDeviceAuth) validDevice() bool {
	return p != nil && p.client != nil && validProvisionedID(p.clientID) && validProvisionedID(p.keyID) && len(p.privateKey) == ed25519.PrivateKeySize
}
func (p *plexDeviceAuth) request(ctx context.Context, method, target, token string, input, out any) error {
	if !p.validDevice() {
		return errPlexAuthentication
	}
	u, err := url.Parse(target)
	if err != nil || u.Scheme != "https" || (u.Host != "clients.plex.tv" && u.Host != "plex.tv") || u.User != nil || u.Fragment != "" {
		return errPlexAuthentication
	}
	var encoded []byte
	if input != nil {
		encoded, err = json.Marshal(input)
		if err != nil {
			return errPlexAuthentication
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, target, bytes.NewReader(encoded))
	if err != nil {
		return errPlexAuthentication
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-Plex-Product", "MUM")
	req.Header.Set("X-Plex-Client-Identifier", p.clientID)
	if input != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("X-Plex-Token", token)
	}
	response, err := p.client.Do(req)
	// A transport error can embed the deviceJWT query; never propagate it.
	if err != nil {
		return errPlexAuthentication
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return errPlexAuthentication
	}
	const max = 1 << 20
	data, err := io.ReadAll(io.LimitReader(response.Body, max+1))
	if err != nil || len(data) > max || json.Unmarshal(data, out) != nil {
		return errPlexAuthentication
	}
	return nil
}
func plexOpaqueValue(value string, min, max int) bool {
	if len(value) < min || len(value) > max {
		return false
	}
	for _, c := range []byte(value) {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}
func (p *plexDeviceAuth) beginPIN(ctx context.Context) (plexPIN, error) {
	if !p.validDevice() {
		return plexPIN{}, errPlexAuthentication
	}
	public := p.privateKey.Public().(ed25519.PublicKey)
	body := struct {
		Strong bool `json:"strong"`
		JWK    struct {
			Type      string `json:"kty"`
			Curve     string `json:"crv"`
			X         string `json:"x"`
			KeyID     string `json:"kid"`
			Algorithm string `json:"alg"`
		} `json:"jwk"`
	}{Strong: true}
	body.JWK.Type = "OKP"
	body.JWK.Curve = "Ed25519"
	body.JWK.X = base64.RawURLEncoding.EncodeToString(public)
	body.JWK.KeyID = p.keyID
	body.JWK.Algorithm = "EdDSA"
	var response struct {
		ID        int64   `json:"id"`
		Code      string  `json:"code"`
		ExpiresAt string  `json:"expiresAt"`
		AuthToken *string `json:"authToken"`
		ClientID  string  `json:"clientIdentifier"`
	}
	if err := p.request(ctx, http.MethodPost, "https://clients.plex.tv/api/v2/pins", "", body, &response); err != nil {
		return plexPIN{}, err
	}
	now := time.Now()
	expires, err := time.Parse(time.RFC3339, response.ExpiresAt)
	if err != nil || response.ID < 1 || !plexOpaqueValue(response.Code, 16, 128) || !expires.After(now) || response.ClientID != "" && response.ClientID != p.clientID || response.AuthToken != nil && *response.AuthToken != "" {
		return plexPIN{}, errPlexAuthentication
	}
	// Never let a remote lifetime create an unbounded local challenge.
	if expires.After(now.Add(15 * time.Minute)) {
		expires = now.Add(15 * time.Minute)
	}
	query := url.Values{"clientID": {p.clientID}, "code": {response.Code}, "context[device][product]": {"MUM"}}
	return plexPIN{response.ID, response.Code, expires, p.clientID, "https://app.plex.tv/auth#?" + query.Encode()}, nil
}
func (p *plexDeviceAuth) deviceJWT(nonce string) (string, error) {
	if !p.validDevice() {
		return "", errPlexAuthentication
	}
	header := struct {
		Algorithm string `json:"alg"`
		KeyID     string `json:"kid"`
		Type      string `json:"typ"`
	}{"EdDSA", p.keyID, "JWT"}
	now := time.Now().Unix()
	claims := struct {
		Audience string `json:"aud"`
		Issuer   string `json:"iss"`
		Issued   int64  `json:"iat"`
		Expires  int64  `json:"exp"`
		Scope    string `json:"scope"`
		Nonce    string `json:"nonce,omitempty"`
	}{"plex.tv", p.clientID, now, now + 60, "username,email,restricted,anonymous", nonce}
	h, err := json.Marshal(header)
	if err != nil {
		return "", errPlexAuthentication
	}
	c, err := json.Marshal(claims)
	if err != nil {
		return "", errPlexAuthentication
	}
	signing := base64.RawURLEncoding.EncodeToString(h) + "." + base64.RawURLEncoding.EncodeToString(c)
	return signing + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(p.privateKey, []byte(signing))), nil
}
func plexJWTShape(token string) bool {
	if len(token) > 16384 {
		return false
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return false
	}
	for _, part := range parts {
		if !plexOpaqueValue(part, 1, 16384) {
			return false
		}
		if _, err := base64.RawURLEncoding.DecodeString(part); err != nil {
			return false
		}
	}
	return true
}
func (p *plexDeviceAuth) verifyAccount(ctx context.Context, token, expectedID string) (plexAuthenticationResult, error) {
	// The token's claims are not trusted locally. Verify it through the fixed
	// Plex account endpoint and bind refreshes to the previously verified ID.
	if !plexJWTShape(token) {
		return plexAuthenticationResult{}, errPlexAuthentication
	}
	var account struct {
		ID         *int64 `json:"id"`
		Username   string `json:"username"`
		Email      string `json:"email"`
		Restricted *bool  `json:"restricted"`
		Anonymous  *bool  `json:"anonymous"`
	}
	if err := p.request(ctx, http.MethodGet, "https://plex.tv/api/v2/user", token, nil, &account); err != nil {
		return plexAuthenticationResult{}, err
	}
	if account.ID == nil || *account.ID < 1 || strings.TrimSpace(account.Username) == "" || len(account.Username) > 255 || len(account.Email) > 320 || account.Restricted == nil || *account.Restricted || account.Anonymous == nil || *account.Anonymous {
		return plexAuthenticationResult{}, errPlexAuthentication
	}
	id := strconv.FormatInt(*account.ID, 10)
	if expectedID != "" && expectedID != id {
		return plexAuthenticationResult{}, errPlexAuthentication
	}
	return plexAuthenticationResult{Account: &plexAuthenticatedAccount{id, account.Username, account.Email}, authToken: token}, nil
}
func (p *plexDeviceAuth) pollPIN(ctx context.Context, pin plexPIN) (plexAuthenticationResult, error) {
	if !p.validDevice() || pin.clientID != p.clientID || pin.id < 1 || !plexOpaqueValue(pin.code, 16, 128) || !pin.expires.After(time.Now()) {
		return plexAuthenticationResult{}, errPlexAuthentication
	}
	assertion, err := p.deviceJWT("")
	if err != nil {
		return plexAuthenticationResult{}, err
	}
	query := url.Values{"deviceJWT": {assertion}}
	var response struct {
		ID        int64           `json:"id"`
		Code      string          `json:"code"`
		AuthToken json.RawMessage `json:"authToken"`
		ClientID  string          `json:"clientIdentifier"`
	}
	if err := p.request(ctx, http.MethodGet, "https://clients.plex.tv/api/v2/pins/"+strconv.FormatInt(pin.id, 10)+"?"+query.Encode(), "", nil, &response); err != nil {
		return plexAuthenticationResult{}, err
	}
	if response.ClientID != "" && response.ClientID != p.clientID || response.ID != pin.id || response.Code != "" && response.Code != pin.code {
		return plexAuthenticationResult{}, errPlexAuthentication
	}
	if len(response.AuthToken) == 0 {
		return plexAuthenticationResult{}, errPlexAuthentication
	}
	var token *string
	if json.Unmarshal(response.AuthToken, &token) != nil {
		return plexAuthenticationResult{}, errPlexAuthentication
	}
	if token == nil || *token == "" {
		return plexAuthenticationResult{Pending: true}, nil
	}
	return p.verifyAccount(ctx, *token, "")
}
func (p *plexDeviceAuth) refreshAccount(ctx context.Context, expectedID string) (plexAuthenticationResult, error) {
	id, err := strconv.ParseInt(expectedID, 10, 64)
	if err != nil || id < 1 || strconv.FormatInt(id, 10) != expectedID {
		return plexAuthenticationResult{}, errPlexAuthentication
	}
	var response struct {
		Nonce string `json:"nonce"`
	}
	if err := p.request(ctx, http.MethodGet, "https://clients.plex.tv/api/v2/auth/nonce", "", nil, &response); err != nil {
		return plexAuthenticationResult{}, err
	}
	if !plexOpaqueValue(response.Nonce, 16, 256) {
		return plexAuthenticationResult{}, errPlexAuthentication
	}
	assertion, err := p.deviceJWT(response.Nonce)
	if err != nil {
		return plexAuthenticationResult{}, err
	}
	var refreshed struct {
		Token string `json:"auth_token"`
	}
	if err := p.request(ctx, http.MethodPost, "https://clients.plex.tv/api/v2/auth/token", "", struct {
		JWT string `json:"jwt"`
	}{assertion}, &refreshed); err != nil {
		return plexAuthenticationResult{}, err
	}
	return p.verifyAccount(ctx, refreshed.Token, expectedID)
}
