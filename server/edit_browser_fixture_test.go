package main

import (
	"context"
	"io/fs"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

// Opt-in disposable browser fixture. It has no configured external providers;
// fixed test credentials and its database live only for this test process.
func TestEditBrowserFixture(t *testing.T) {
	file := os.Getenv("MUM_EDIT_BROWSER_FIXTURE")
	if file == "" {
		t.Skip("opt-in browser fixture")
	}
	assets, err := fs.Sub(os.DirFS("."), "dist")
	if err != nil {
		t.Fatal(err)
	}
	s := testStore(t)
	queue, err := NewLogQueue(s, QueueOptions{})
	if err != nil {
		t.Fatal(err)
	}
	a, err := NewApp(s, queue, assets)
	if err != nil {
		t.Fatal(err)
	}
	token, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), token)
	for _, name := range []string{"Browser Alice", "Browser Bob"} {
		if _, err := s.CreateAccount(t.Context(), owner.UUID, name, "fixture-hash", false); err != nil {
			t.Fatal(err)
		}
	}
	if w := apiRequest(a, "POST", "/api/setup/app", token, map[string]string{"app_name": "Disposable edit fixture", "app_base_url": "http://localhost"}, nil); w.Code != 200 {
		t.Fatalf("setup %d %s", w.Code, w.Body.String())
	}
	if w := apiRequest(a, "POST", "/api/setup/complete", token, map[string]any{}, nil); w.Code != 200 {
		t.Fatalf("finish setup %d %s", w.Code, w.Body.String())
	}
	fixture := httptest.NewServer(a)
	t.Cleanup(func() {
		a.CloseScheduler()
		a.CloseProvisioning()
		a.CloseRealtime()
		fixture.Close()
		_ = queue.Shutdown(context.Background())
		_ = os.Remove(file)
	})
	if err := os.WriteFile(file, []byte(fixture.URL), 0600); err != nil {
		t.Fatal(err)
	}
	stop := file + ".stop"
	deadline := time.Now().Add(15 * time.Minute)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(stop); err == nil {
			_ = os.Remove(stop)
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
}
