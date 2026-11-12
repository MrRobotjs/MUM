package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// MaxResponseBytes bounds every media server response.
const MaxResponseBytes = 16 << 20

// Transport sends a module's HTTP requests. MUM's core builds it: Client never
// follows redirects (credentials must not reach another endpoint), and Guard
// rechecks the authority behind the current operation (review, remote access
// or bulk edit) before each request, after the response arrives and after the
// body is read. A module cannot skip either.
type Transport struct {
	Client *http.Client
	Guard  func(context.Context) error
}

func (t Transport) guard(ctx context.Context) error {
	if t.Guard == nil {
		return nil
	}
	return t.Guard(ctx)
}

// Send performs one request and returns the bounded body of a 2xx response.
// Transport failures and non-2xx statuses are reported without upstream text,
// so secrets in error pages never reach logs.
func (t Transport) Send(req *http.Request) ([]byte, error) {
	ctx := req.Context()
	if err := t.guard(ctx); err != nil {
		return nil, err
	}
	response, err := t.Client.Do(req)
	if response != nil {
		defer response.Body.Close()
	}
	if authorityErr := t.guard(ctx); authorityErr != nil {
		return nil, authorityErr
	}
	if err != nil {
		return nil, errors.New("provider request failed or timed out")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, &HTTPError{StatusCode: response.StatusCode}
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, MaxResponseBytes+1))
	if err != nil || len(body) > MaxResponseBytes {
		return nil, errors.New("provider response exceeds size limit or could not be read")
	}
	if err := t.guard(ctx); err != nil {
		return nil, err
	}
	return body, nil
}

// JSON sends input (when not nil) as JSON and decodes a JSON reply into out
// (when not nil). authorize adds the service's credential headers.
func (t Transport) JSON(ctx context.Context, method, target string, authorize func(http.Header), input, out any) error {
	var encoded []byte
	if input != nil {
		var err error
		if encoded, err = json.Marshal(input); err != nil {
			return errors.New("invalid provider request body")
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, target, bytes.NewReader(encoded))
	if err != nil {
		return errors.New("invalid provider request")
	}
	SetJSONHeaders(req.Header, input != nil)
	if authorize != nil {
		authorize(req.Header)
	}
	body, err := t.Send(req)
	if err != nil {
		return err
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return errors.New("provider returned invalid JSON")
	}
	return nil
}

// Form sends form as an application/x-www-form-urlencoded body, accepting a
// JSON reply that is not decoded. authorize adds the credential headers.
func (t Transport) Form(ctx context.Context, method, target string, authorize func(http.Header), form url.Values) error {
	req, err := http.NewRequestWithContext(ctx, method, target, bytes.NewReader([]byte(form.Encode())))
	if err != nil {
		return errors.New("invalid provider request")
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if authorize != nil {
		authorize(req.Header)
	}
	_, err = t.Send(req)
	return err
}

// Errors from Fetch, so each module can report them in its own words.
var (
	ErrRequestFailed   = errors.New("provider request failed or timed out")
	ErrUnsupportedType = errors.New("provider returned an unsupported content type")
	ErrUnreadableBody  = errors.New("provider response is empty, oversized or unreadable")
)

// Fetch performs req for content that is not JSON, such as images or paged
// XML. Like Send it applies the guard and the redirect refusal. A status other
// than 200 is an *HTTPError and its body is not read. allowType (when not nil)
// is checked against the media type before the body is read, and the body must
// be 1 to max bytes. It returns the lower-case media type and the body.
func (t Transport) Fetch(req *http.Request, max int64, allowType func(string) bool) (string, []byte, error) {
	ctx := req.Context()
	if err := t.guard(ctx); err != nil {
		return "", nil, err
	}
	response, err := t.Client.Do(req)
	if response != nil {
		defer response.Body.Close()
	}
	if authorityErr := t.guard(ctx); authorityErr != nil {
		return "", nil, authorityErr
	}
	if err != nil {
		return "", nil, ErrRequestFailed
	}
	if response.StatusCode != http.StatusOK {
		return "", nil, &HTTPError{StatusCode: response.StatusCode}
	}
	kind := strings.ToLower(strings.TrimSpace(strings.Split(response.Header.Get("Content-Type"), ";")[0]))
	if allowType != nil && !allowType(kind) {
		return "", nil, ErrUnsupportedType
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, max+1))
	if err != nil || int64(len(body)) > max || len(body) == 0 {
		return "", nil, ErrUnreadableBody
	}
	if err := t.guard(ctx); err != nil {
		return "", nil, err
	}
	return kind, body, nil
}

// ImageType accepts the image types MUM serves to browsers.
func ImageType(kind string) bool {
	return kind == "image/jpeg" || kind == "image/png" || kind == "image/webp" || kind == "image/gif"
}
