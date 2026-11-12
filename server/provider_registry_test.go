package main

import (
	"net/http"
	"slices"
	"testing"

	"app/server/providers/provider"
)

// Capabilities are derived from the interfaces a module implements. Each
// moved service's derived list must equal the hand-written list it had before
// it became a module, so the move changes nothing users can see.
func TestModuleCapabilitiesMatchPreviousLists(t *testing.T) {
	recovering := []string{"auth.api_key", "server.test", "libraries.read", "libraries.sync", "users.read", "users.sync", "users.libraries.update", "users.provision", "invitations.redeem", "labels.downloads.sync"}
	// Jellyfin and Emby also sync library catalogues (still read by the core).
	catalogued := []string{"auth.api_key", "server.test", "libraries.read", "libraries.sync", "users.read", "users.sync", "users.libraries.update", "libraries.items.sync", "users.provision", "invitations.redeem", "labels.downloads.sync"}
	// Plex provisions by sharing, keeps its sharing features in the core and
	// has no download labels.
	plexList := []string{"auth.api_key", "server.test", "libraries.read", "libraries.sync", "users.read", "users.sync", "users.libraries.update", "libraries.items.sync", "users.provision", "invitations.redeem", "integrations.overseerr"}
	// RomM cannot edit library access: its grants cover every platform.
	romm := []string{"auth.api_key", "server.test", "libraries.read", "libraries.sync", "users.read", "users.sync", "users.provision", "invitations.redeem", "labels.downloads.sync"}
	for id, want := range map[string][]string{"komga": recovering, "audiobookshelf": recovering, "kavita": recovering, "romm": romm, "jellyfin": catalogued, "emby": catalogued, "plex": plexList} {
		m, ok := findMediaModule(id)
		if !ok {
			t.Fatalf("%s module not registered", id)
		}
		if got := moduleCapabilities(m); !slices.Equal(got, want) {
			t.Fatalf("%s capabilities changed: got %v, want %v", id, got, want)
		}
	}
}

// Every registered module is listed once, keeps its definition in the
// provider list and gives the core what it relies on for that capability.
func TestRegisteredModulesAreConsistent(t *testing.T) {
	seen := map[string]bool{}
	for _, m := range mediaModules {
		id := m.Definition.ID
		if id == "" || seen[id] {
			t.Fatalf("missing or duplicate module ID %q", id)
		}
		seen[id] = true
		listed, ok := providerDefinition(id)
		if !ok || listed != definitionFromModule(m.Definition) {
			t.Fatalf("%s: provider list does not match the module definition", id)
		}
		instance := m.New(provider.Config{})
		if instance == nil {
			t.Fatalf("%s: constructor returned nil", id)
		}
		capabilities := moduleCapabilities(m)
		if slices.Contains(capabilities, "users.provision") && !supportsProvisioning(id) {
			t.Fatalf("%s: provisioning advertised without recorded-account recovery", id)
		}
		if _, deletes := instance.(accountDeleter); deletes != serviceRemoteDeletable(id) {
			t.Fatalf("%s: remote delete support disagrees with the module", id)
		}
		if scope := serviceRemoteScope(id); moduleRecovers(instance) && scope == "" {
			t.Fatalf("%s: recovering module has no remote access scope", id)
		}
		// Only the services MUM monitors read live sessions.
		if want := id == "plex" || id == "jellyfin" || id == "emby"; activitySupported(id) != want {
			t.Fatalf("%s: session monitoring support is %v", id, !want)
		}
		// A live connection only nudges session reads, so it needs them.
		if _, live := instance.(liveConnector); live && !activitySupported(id) {
			t.Fatalf("%s: live connection without session reads", id)
		}
	}
}

// guardedRequest sends one request through a connection's guarded transport,
// the path every module request takes.
func guardedRequest(t *testing.T, p *serverConnection, method, target string, body any) ([]byte, error) {
	t.Helper()
	if body != nil {
		t.Fatal("guardedRequest sends no body")
	}
	req, err := http.NewRequestWithContext(t.Context(), method, target, nil)
	if err != nil {
		t.Fatal(err)
	}
	return p.transport().Send(req)
}
