package main

import (
	"encoding/json"
	"regexp"
	"strings"
	"testing"
)

var pathParameter = regexp.MustCompile(`\{[^}]+\}`)

// Every registered API route is called without a bearer token. A route the
// document marks as secured must answer 401; a route it marks as public must
// not, so the document's authentication claims match real behaviour.
func TestOpenAPIDocumentMatchesServedRoutesAndAuthentication(t *testing.T) {
	a, _ := testApp(t)
	if len(a.apiRoutes) < 100 {
		t.Fatal("routes were not recorded", len(a.apiRoutes))
	}
	for name := range cookieAPIRoutes {
		if _, both := publicAPIRoutes[name]; both {
			t.Fatal("route is both public and cookie-authenticated", name)
		}
	}
	for name := range publicAPIRoutes {
		method, path, _ := strings.Cut(name, " ")
		found := false
		for _, r := range a.apiRoutes {
			found = found || r.Method == method && r.Path == path
		}
		if !found {
			t.Fatal("public list names an unregistered route", name)
		}
	}
	mismatches := []string{}
	for _, r := range a.apiRoutes {
		// Use a real action value so the dispatcher reaches its authentication check.
		path := pathParameter.ReplaceAllStringFunc(r.Path, func(p string) string {
			if p == "{action}" {
				return "cancel"
			}
			return "1"
		})
		w := apiRequest(a, r.Method, path, "", nil, nil)
		_, public := publicAPIRoutes[r.Method+" "+r.Path]
		if unauthenticated := w.Code == 401; unauthenticated == public {
			mismatches = append(mismatches, r.Method+" "+r.Path+" -> "+w.Result().Status)
		}
	}
	if len(mismatches) > 0 {
		t.Fatalf("authentication claims differ from behaviour:\n%s", strings.Join(mismatches, "\n"))
	}

	w := apiRequest(a, "GET", "/api/openapi/openapi.json", "", nil, nil)
	if w.Code != 200 || !strings.HasPrefix(w.Header().Get("Content-Type"), "application/json") {
		t.Fatal(w.Code, w.Header())
	}
	var doc struct {
		OpenAPI string                               `json:"openapi"`
		Paths   map[string]map[string]map[string]any `json:"paths"`
		Comps   struct {
			Schemes map[string]map[string]string `json:"securitySchemes"`
		} `json:"components"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &doc); err != nil {
		t.Fatal(err)
	}
	if doc.OpenAPI != "3.1.0" || doc.Comps.Schemes["BearerAuth"]["scheme"] != "bearer" {
		t.Fatal(doc.OpenAPI, doc.Comps)
	}
	operations, ids := 0, map[string]bool{}
	for path, methods := range doc.Paths {
		for method, op := range methods {
			operations++
			id := op["operationId"].(string)
			if ids[id] {
				t.Fatal("duplicate operationId", id)
			}
			ids[id] = true
			params, _ := op["parameters"].([]any)
			if len(params) != len(pathParameter.FindAllString(path, -1)) {
				t.Fatal("path parameters", method, path, params)
			}
			key := strings.ToUpper(method) + " " + path
			_, public := publicAPIRoutes[key]
			_, cookie := cookieAPIRoutes[key]
			security, hasOverride := op["security"].([]any)
			switch {
			case public && !(hasOverride && len(security) == 0),
				cookie && !(hasOverride && len(security) == 1 && strings.Contains(asJSON(security), "RefreshCookie")),
				!public && !cookie && hasOverride:
				t.Fatal("security marking", key, security)
			}
		}
	}
	if operations != len(a.apiRoutes) {
		t.Fatal("document operations", operations, "registered", len(a.apiRoutes))
	}
	for _, secret := range []string{"api_key", "password_hash", "fixture-secret"} {
		if strings.Contains(w.Body.String(), secret) {
			t.Fatal("document exposes", secret)
		}
	}
}

func asJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}
