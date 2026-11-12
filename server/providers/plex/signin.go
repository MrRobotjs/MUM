package plex

import (
	"app/server/providers/provider"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Device is a plex.tv sign-in device: a client ID and Ed25519 key used for
// PIN sign-in, account verification and token refresh.
//
// This device-key adapter is not a login, account-link or invitation endpoint.
// Persist a separate device identity per authorized connection before exposing
// it, and bind every subsequent use to that connection's verified account ID.
type Device struct {
	client *http.Client
	// ClientID, KeyID and PrivateKey are the device identity MUM stores
	// (encrypted) with a sign-in, so a later step can act as the same device.
	// They are never JSON-encoded.
	ClientID   string             `json:"-"`
	KeyID      string             `json:"-"`
	PrivateKey ed25519.PrivateKey `json:"-"`
}

// PIN is a pending plex.tv sign-in. Its fields are never JSON-encoded: the
// code is a secret, and MUM stores it encrypted.
type PIN struct {
	ID               int64     `json:"-"`
	Code             string    `json:"-"`
	Expires          time.Time `json:"-"`
	ClientID         string    `json:"-"`
	AuthorizationURL string    `json:"-"`
}
type AuthenticatedAccount struct {
	ID       string `json:"id"`
	Username string `json:"username"`
	Email    string `json:"email"`
}
type AuthenticationResult struct {
	Pending bool                  `json:"pending"`
	Account *AuthenticatedAccount `json:"account,omitempty"`
	// AuthToken is the verified account token; it is never encoded.
	AuthToken string `json:"-"`
}

var ErrAuthentication = errors.New("Plex authentication could not be verified")

func NewDevice(client *http.Client) (*Device, error) {
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
	return &Device{&copyClient, newUUID(), provider.RandomToken(), key}, nil
}
func (p *Device) Valid() bool {
	return p != nil && p.client != nil && provider.ValidID(p.ClientID) && provider.ValidID(p.KeyID) && len(p.PrivateKey) == ed25519.PrivateKeySize
}
func (p *Device) Request(ctx context.Context, method, target, token string, input, out any) error {
	if !p.Valid() {
		return ErrAuthentication
	}
	u, err := url.Parse(target)
	if err != nil || u.Scheme != "https" || (u.Host != "clients.plex.tv" && u.Host != "plex.tv") || u.User != nil || u.Fragment != "" {
		return ErrAuthentication
	}
	var encoded []byte
	if input != nil {
		encoded, err = json.Marshal(input)
		if err != nil {
			return ErrAuthentication
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, target, bytes.NewReader(encoded))
	if err != nil {
		return ErrAuthentication
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-Plex-Product", "MUM")
	req.Header.Set("X-Plex-Client-Identifier", p.ClientID)
	if input != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("X-Plex-Token", token)
	}
	response, err := p.client.Do(req)
	// A transport error can embed the deviceJWT query; never propagate it.
	if err != nil {
		return ErrAuthentication
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return ErrAuthentication
	}
	const max = 1 << 20
	data, err := io.ReadAll(io.LimitReader(response.Body, max+1))
	if err != nil || len(data) > max || json.Unmarshal(data, out) != nil {
		return ErrAuthentication
	}
	return nil
}
func opaqueValue(value string, min, max int) bool {
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
func (p *Device) BeginPIN(ctx context.Context) (PIN, error) {
	if !p.Valid() {
		return PIN{}, ErrAuthentication
	}
	public := p.PrivateKey.Public().(ed25519.PublicKey)
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
	body.JWK.KeyID = p.KeyID
	body.JWK.Algorithm = "EdDSA"
	var response struct {
		ID        int64   `json:"id"`
		Code      string  `json:"code"`
		ExpiresAt string  `json:"expiresAt"`
		AuthToken *string `json:"authToken"`
		ClientID  string  `json:"clientIdentifier"`
	}
	if err := p.Request(ctx, http.MethodPost, "https://clients.plex.tv/api/v2/pins", "", body, &response); err != nil {
		return PIN{}, err
	}
	now := time.Now()
	expires, err := time.Parse(time.RFC3339, response.ExpiresAt)
	if err != nil || response.ID < 1 || !opaqueValue(response.Code, 16, 128) || !expires.After(now) || response.ClientID != "" && response.ClientID != p.ClientID || response.AuthToken != nil && *response.AuthToken != "" {
		return PIN{}, ErrAuthentication
	}
	// Never let a remote lifetime create an unbounded local challenge.
	if expires.After(now.Add(15 * time.Minute)) {
		expires = now.Add(15 * time.Minute)
	}
	query := url.Values{"clientID": {p.ClientID}, "code": {response.Code}, "context[device][product]": {"MUM"}}
	return PIN{ID: response.ID, Code: response.Code, Expires: expires, ClientID: p.ClientID, AuthorizationURL: "https://app.plex.tv/auth#?" + query.Encode()}, nil
}
func (p *Device) deviceJWT(nonce string) (string, error) {
	if !p.Valid() {
		return "", ErrAuthentication
	}
	header := struct {
		Algorithm string `json:"alg"`
		KeyID     string `json:"kid"`
		Type      string `json:"typ"`
	}{"EdDSA", p.KeyID, "JWT"}
	now := time.Now().Unix()
	claims := struct {
		Audience string `json:"aud"`
		Issuer   string `json:"iss"`
		Issued   int64  `json:"iat"`
		Expires  int64  `json:"exp"`
		Scope    string `json:"scope"`
		Nonce    string `json:"nonce,omitempty"`
	}{"plex.tv", p.ClientID, now, now + 60, "username,email,restricted,anonymous", nonce}
	h, err := json.Marshal(header)
	if err != nil {
		return "", ErrAuthentication
	}
	c, err := json.Marshal(claims)
	if err != nil {
		return "", ErrAuthentication
	}
	signing := base64.RawURLEncoding.EncodeToString(h) + "." + base64.RawURLEncoding.EncodeToString(c)
	return signing + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(p.PrivateKey, []byte(signing))), nil
}
func JWTShape(token string) bool {
	if len(token) > 16384 {
		return false
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return false
	}
	for _, part := range parts {
		if !opaqueValue(part, 1, 16384) {
			return false
		}
		if _, err := base64.RawURLEncoding.DecodeString(part); err != nil {
			return false
		}
	}
	return true
}
func (p *Device) VerifyAccount(ctx context.Context, token, expectedID string) (AuthenticationResult, error) {
	// The token's claims are not trusted locally. Verify it through the fixed
	// Plex account endpoint and bind refreshes to the previously verified ID.
	if !JWTShape(token) {
		return AuthenticationResult{}, ErrAuthentication
	}
	var account struct {
		ID         *int64 `json:"id"`
		Username   string `json:"username"`
		Email      string `json:"email"`
		Restricted *bool  `json:"restricted"`
		Anonymous  *bool  `json:"anonymous"`
	}
	if err := p.Request(ctx, http.MethodGet, "https://plex.tv/api/v2/user", token, nil, &account); err != nil {
		return AuthenticationResult{}, err
	}
	if account.ID == nil || *account.ID < 1 || strings.TrimSpace(account.Username) == "" || len(account.Username) > 255 || len(account.Email) > 320 || account.Restricted == nil || *account.Restricted || account.Anonymous == nil || *account.Anonymous {
		return AuthenticationResult{}, ErrAuthentication
	}
	id := strconv.FormatInt(*account.ID, 10)
	if expectedID != "" && expectedID != id {
		return AuthenticationResult{}, ErrAuthentication
	}
	return AuthenticationResult{Account: &AuthenticatedAccount{id, account.Username, account.Email}, AuthToken: token}, nil
}
func (p *Device) PollPIN(ctx context.Context, pin PIN) (AuthenticationResult, error) {
	if !p.Valid() || pin.ClientID != p.ClientID || pin.ID < 1 || !opaqueValue(pin.Code, 16, 128) || !pin.Expires.After(time.Now()) {
		return AuthenticationResult{}, ErrAuthentication
	}
	assertion, err := p.deviceJWT("")
	if err != nil {
		return AuthenticationResult{}, err
	}
	query := url.Values{"deviceJWT": {assertion}}
	var response struct {
		ID        int64           `json:"id"`
		Code      string          `json:"code"`
		AuthToken json.RawMessage `json:"authToken"`
		ClientID  string          `json:"clientIdentifier"`
	}
	if err := p.Request(ctx, http.MethodGet, "https://clients.plex.tv/api/v2/pins/"+strconv.FormatInt(pin.ID, 10)+"?"+query.Encode(), "", nil, &response); err != nil {
		return AuthenticationResult{}, err
	}
	if response.ClientID != "" && response.ClientID != p.ClientID || response.ID != pin.ID || response.Code != "" && response.Code != pin.Code {
		return AuthenticationResult{}, ErrAuthentication
	}
	if len(response.AuthToken) == 0 {
		return AuthenticationResult{}, ErrAuthentication
	}
	var token *string
	if json.Unmarshal(response.AuthToken, &token) != nil {
		return AuthenticationResult{}, ErrAuthentication
	}
	if token == nil || *token == "" {
		return AuthenticationResult{Pending: true}, nil
	}
	return p.VerifyAccount(ctx, *token, "")
}
func (p *Device) RefreshAccount(ctx context.Context, expectedID string) (AuthenticationResult, error) {
	id, err := strconv.ParseInt(expectedID, 10, 64)
	if err != nil || id < 1 || strconv.FormatInt(id, 10) != expectedID {
		return AuthenticationResult{}, ErrAuthentication
	}
	var response struct {
		Nonce string `json:"nonce"`
	}
	if err := p.Request(ctx, http.MethodGet, "https://clients.plex.tv/api/v2/auth/nonce", "", nil, &response); err != nil {
		return AuthenticationResult{}, err
	}
	if !opaqueValue(response.Nonce, 16, 256) {
		return AuthenticationResult{}, ErrAuthentication
	}
	assertion, err := p.deviceJWT(response.Nonce)
	if err != nil {
		return AuthenticationResult{}, err
	}
	var refreshed struct {
		Token string `json:"auth_token"`
	}
	if err := p.Request(ctx, http.MethodPost, "https://clients.plex.tv/api/v2/auth/token", "", struct {
		JWT string `json:"jwt"`
	}{assertion}, &refreshed); err != nil {
		return AuthenticationResult{}, err
	}
	return p.VerifyAccount(ctx, refreshed.Token, expectedID)
}

// newUUID returns a random (version 4) UUID, used as the device client ID.
func newUUID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		panic(err)
	}
	bytes[6] = bytes[6]&0x0f | 0x40
	bytes[8] = bytes[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", bytes[:4], bytes[4:6], bytes[6:8], bytes[8:10], bytes[10:])
}
