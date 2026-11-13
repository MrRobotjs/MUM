package main

import (
	"encoding/json"
	"net/http"
	"slices"
	"strings"
)

// The OpenAPI document is generated from the routes registered in NewApp, so it
// always lists exactly the API this binary serves. It describes paths, methods,
// path parameters and authentication; request and response schemas are not
// modelled. Every route uses the same envelope: {"data": …} on success and
// {"error": {"code", "message"}} on failure.

type apiRoute struct {
	Method, Path string
}

// publicAPIRoutes are served without a bearer access token. They authenticate
// in other ways (invitation tokens, the refresh cookie, signed image links,
// password sign-in, first-run setup) or expose no account data. A test checks
// this list against every registered route.
var publicAPIRoutes = map[string]string{
	"GET /api/activity/history-images/{item}":                                          "Signed, short-lived link; administrator session and the retained play's stored poster are rechecked on every fetch",
	"GET /api/user-avatars/{item}":                                                     "Signed, short-lived link; administrator session and current user avatar source are rechecked on every fetch",
	"GET /api/activity/avatars/{item}":                                                 "Signed, short-lived link; administrator session and current avatar source are rechecked on every fetch",
	"GET /api/activity/images/{item}":                                                  "Signed, short-lived link; administrator session and current activity are rechecked on every fetch",
	"GET /api/openapi/openapi.json":                                                    "This document",
	"GET /api/health":                                                                  "Health check",
	"GET /api/setup/status":                                                            "First-run setup state",
	"POST /api/setup/account":                                                          "Creates the owner during first-run setup only",
	"POST /api/auth/login":                                                             "Password sign-in",
	"POST /api/auth/plex":                                                              "Starts Sign in with Plex, bound to this browser by an HttpOnly cookie",
	"POST /api/auth/plex/{attempt}/poll":                                               "Finishes Sign in with Plex from the browser that started it; signs in only the MUM account linked to the verified Plex account",
	"POST /api/auth/logout":                                                            "Ends the session named by the HttpOnly refresh cookie, if any",
	"GET /api/settings/general":                                                        "Application name and URLs shown on sign-in pages",
	"GET /api/settings/user-accounts":                                                  "Whether user accounts are enabled",
	"GET /api/media/images/{item}":                                                     "Signed, short-lived link; the session is rechecked on every fetch",
	"GET /api/media/collections/images/{collection}":                                   "Signed, short-lived link; the session is rechecked on every fetch",
	"GET /api/public/invitations/{token}":                                              "Invitation token",
	"GET /api/public/invitation-paths/{path}":                                          "Custom invite path",
	"POST /api/public/invitations/{token}/redeem":                                      "Invitation token",
	"POST /api/public/invitations/{token}/receipt":                                     "Invitation token",
	"POST /api/public/invitations/{token}/discord-authorizations":                      "Invitation token",
	"GET /api/public/invitations/{token}/discord-authorization":                        "Invitation token",
	"GET /api/invitations/discord/callback":                                            "Discord OAuth callback, bound to its stored state",
	"POST /api/public/invitations/{token}/plex-authorizations":                         "Invitation token",
	"POST /api/public/invitations/{token}/plex-authorizations/{authorization}/poll":    "Invitation token",
	"POST /api/public/invitations/{token}/plex-authorizations/{authorization}/confirm": "Invitation token",
}

// cookieAPIRoutes authenticate with the HttpOnly refresh cookie instead of a
// bearer token and answer 401 without it.
var cookieAPIRoutes = map[string]string{
	"POST /api/auth/refresh": "Rotates the session using the HttpOnly refresh cookie",
}

func apiTag(path string) string {
	segments := strings.Split(strings.TrimPrefix(path, "/api/"), "/")
	return segments[0]
}

func (a *App) openAPIDocument(w http.ResponseWriter, r *http.Request) {
	routes := slices.Clone(a.apiRoutes)
	slices.SortFunc(routes, func(x, y apiRoute) int {
		if c := strings.Compare(x.Path, y.Path); c != 0 {
			return c
		}
		return strings.Compare(x.Method, y.Method)
	})
	paths := map[string]map[string]any{}
	tags := []string{}
	for _, route := range routes {
		operations := paths[route.Path]
		if operations == nil {
			operations = map[string]any{}
			paths[route.Path] = operations
		}
		tag := apiTag(route.Path)
		if !slices.Contains(tags, tag) {
			tags = append(tags, tag)
		}
		parameters := []map[string]any{}
		for _, segment := range strings.Split(route.Path, "/") {
			if strings.HasPrefix(segment, "{") && strings.HasSuffix(segment, "}") {
				parameters = append(parameters, map[string]any{"name": strings.Trim(segment, "{}"), "in": "path", "required": true, "schema": map[string]string{"type": "string"}})
			}
		}
		operation := map[string]any{
			"operationId": strings.ToLower(route.Method) + strings.NewReplacer("/", "_", "{", "", "}", "", "-", "_", ".", "_").Replace(route.Path),
			"summary":     route.Method + " " + route.Path,
			"tags":        []string{tag},
			"responses": map[string]any{
				"default": map[string]any{"description": `JSON envelope: {"data": …} on success, {"error": {"code", "message"}} on failure`},
			},
		}
		if len(parameters) > 0 {
			operation["parameters"] = parameters
		}
		if reason, public := publicAPIRoutes[route.Method+" "+route.Path]; public {
			operation["security"] = []any{}
			operation["description"] = "No bearer token. " + reason + "."
		} else if reason, cookie := cookieAPIRoutes[route.Method+" "+route.Path]; cookie {
			operation["security"] = []map[string][]string{{"RefreshCookie": {}}}
			operation["description"] = reason + "."
		}
		operations[strings.ToLower(route.Method)] = operation
	}
	slices.Sort(tags)
	tagObjects := make([]map[string]string, 0, len(tags))
	for _, tag := range tags {
		tagObjects = append(tagObjects, map[string]string{"name": tag})
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	// An OpenAPI document is served bare, not inside the {"data": …} envelope.
	_ = json.NewEncoder(w).Encode(map[string]any{
		"openapi": "3.1.0",
		"info": map[string]any{
			"title":       "MUM API",
			"version":     "current",
			"description": "Generated from the routes served by this MUM binary. Paths, methods, path parameters and authentication are exact; request and response bodies are not modelled. Administrator routes also require the matching permission.",
		},
		"servers":  []map[string]string{{"url": "/"}},
		"security": []map[string][]string{{"BearerAuth": {}}},
		"tags":     tagObjects,
		"paths":    paths,
		"components": map[string]any{"securitySchemes": map[string]any{
			"BearerAuth":    map[string]string{"type": "http", "scheme": "bearer", "description": "Access token from sign-in or refresh"},
			"RefreshCookie": map[string]string{"type": "apiKey", "in": "cookie", "name": "mum_refresh", "description": "HttpOnly refresh cookie set by sign-in; scoped to /api/auth"},
		}},
	})
}
