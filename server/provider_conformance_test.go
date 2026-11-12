package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"

	"app/server/providers/provider"
)

// Shared checks every registered media module must pass. A new module is
// picked up automatically when it is added to mediaModules; its own fixture
// tests cover what its service returns when it works.

const conformanceSecret = "conformance-secret-key"

// conformanceReads calls each read a module implements, with arguments every
// module accepts.
func conformanceReads(instance any) map[string]func(context.Context) error {
	reads := map[string]func(context.Context) error{}
	if m, ok := instance.(connectionTester); ok {
		reads["Test"] = func(ctx context.Context) error { _, err := m.Test(ctx); return err }
	}
	if m, ok := instance.(libraryReader); ok {
		reads["Libraries"] = func(ctx context.Context) error { _, err := m.Libraries(ctx); return err }
	}
	if m, ok := instance.(userReader); ok {
		reads["Users"] = func(ctx context.Context) error { _, err := m.Users(ctx); return err }
	}
	if m, ok := instance.(libraryAwareUserReader); ok {
		reads["UsersWithLibraries"] = func(ctx context.Context) error {
			_, err := m.UsersWithLibraries(ctx, []provider.Library{{ID: "1", Name: "Library", Type: "movie"}})
			return err
		}
	}
	if m, ok := instance.(accountInspector); ok {
		reads["InspectAccount"] = func(ctx context.Context) error { _, err := m.InspectAccount(ctx, "1", "reader"); return err }
	}
	if m, ok := instance.(activityReader); ok {
		reads["ActivitySnapshot"] = func(ctx context.Context) error { _, err := m.ActivitySnapshot(ctx); return err }
	}
	if m, ok := instance.(catalogueReader); ok {
		reads["CatalogueItems"] = func(ctx context.Context) error { _, err := m.CatalogueItems(ctx, "1", "movie", nil); return err }
	}
	if m, ok := instance.(episodeReader); ok {
		reads["CatalogueEpisodes"] = func(ctx context.Context) error { _, err := m.CatalogueEpisodes(ctx, "1"); return err }
	}
	if m, ok := instance.(collectionReader); ok {
		reads["CatalogueCollections"] = func(ctx context.Context) error { _, err := m.CatalogueCollections(ctx, "1", "movie"); return err }
	}
	return reads
}

// conformanceModule builds a module against a local server answering every
// request with status and body.
func conformanceModule(t *testing.T, m mediaModule, status int, body string, guard func(context.Context) error) (any, *atomic.Int64) {
	t.Helper()
	var requests atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(upstream.Close)
	connection, err := newServerConnection(ProviderConfig{Type: m.Definition.ID, URL: upstream.URL, APIKey: conformanceSecret}, upstream.Client())
	if err != nil {
		t.Fatal(m.Definition.ID, err)
	}
	connection.bulkAuthority = guard
	return connection.module(), &requests
}

// Adding a service touches the registry, a migration and two frontend files.
// This catches a forgotten one.
func TestRegisteredModulesAreWiredEverywhere(t *testing.T) {
	_, s := testApp(t)
	rows, err := s.reader.Query("SELECT provider_id FROM provider_settings")
	if err != nil {
		t.Fatal(err)
	}
	settings := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		settings[id] = true
	}
	if err := rows.Close(); err != nil {
		t.Fatal(err)
	}
	serviceTypes, err := os.ReadFile("../frontend/src/config/serviceTypes.ts")
	if err != nil {
		t.Fatal(err)
	}
	metadata, err := os.ReadFile("../frontend/src/config/pluginMetadata.tsx")
	if err != nil {
		t.Fatal(err)
	}
	if listed := strings.Count(string(serviceTypes), "{ value: '"); listed != len(mediaModules) {
		t.Fatalf("frontend lists %d services, the registry %d", listed, len(mediaModules))
	}
	for _, m := range mediaModules {
		id := m.Definition.ID
		if !settings[id] {
			t.Errorf("%s: no provider_settings row (add a migration inserting it)", id)
		}
		if !strings.Contains(string(serviceTypes), "{ value: '"+id+"',") {
			t.Errorf("%s: missing from frontend/src/config/serviceTypes.ts", id)
		}
		if !strings.Contains(string(metadata), "\n  "+id+": {") {
			t.Errorf("%s: missing from SERVICE_META in frontend/src/config/pluginMetadata.tsx", id)
		}
	}
}

func TestModuleConformance(t *testing.T) {
	denied := errors.New("conformance authority revoked")
	for _, m := range mediaModules {
		t.Run(m.Definition.ID, func(t *testing.T) {
			if m.Definition.Name == "" || m.Definition.Description == "" {
				t.Fatal("definition needs a name and description")
			}
			if _, ok := findMediaModule(m.Definition.ID); !ok {
				t.Fatal("module is not found by its ID")
			}
			if len(conformanceReads(m.New(provider.Config{}))) == 0 {
				t.Fatal("module implements no read")
			}

			// Every request goes through the core's transport: a revoked
			// authority stops each read before anything is sent.
			instance, requests := conformanceModule(t, m, http.StatusOK, "{}", func(context.Context) error { return denied })
			for name, read := range conformanceReads(instance) {
				if err := read(t.Context()); err == nil {
					t.Errorf("%s succeeded without authority", name)
				}
			}
			if n := requests.Load(); n != 0 {
				t.Errorf("%d requests sent without authority", n)
			}

			// A failing or garbled server is an error, never an empty
			// successful result, and errors never carry the credential.
			for _, reply := range []struct {
				status int
				body   string
			}{{http.StatusInternalServerError, "upstream failure " + conformanceSecret}, {http.StatusOK, "<<not a valid reply " + conformanceSecret}} {
				instance, _ := conformanceModule(t, m, reply.status, reply.body, nil)
				for name, read := range conformanceReads(instance) {
					err := read(t.Context())
					if err == nil {
						t.Errorf("%s accepted an HTTP %d reply %q", name, reply.status, reply.body)
					} else if strings.Contains(err.Error(), conformanceSecret) {
						t.Errorf("%s error exposes the credential: %v", name, err)
					}
				}
			}
		})
	}
}
