package main

import (
	"app/server/providers/provider"
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/url"
	"strings"
	"testing"
)

func TestSocketPlaybackDiagnosticRedactsIdentifiers(t *testing.T) {
	var output bytes.Buffer
	a := &App{logger: slog.New(slog.NewTextHandler(&output, nil)), imageKey: []byte("fixture-key")}
	position := int64(25000000)
	a.logSocketPlaybackEvent(5, "plex", provider.PlaybackEvent{Session: "private-session", Item: "private-title", State: "playing", Position: &position})
	a.logActivitySnapshot(activityReadClaim{Server: 5, Provider: "plex", Source: "ws"}, activitySnapshot{Sessions: []activitySession{{Session: "private-session", Title: "Fixture movie", Position: &position}}})
	got := output.String()
	for _, expected := range []string{"WebSocket playback notification", "Stream session updated", `title="Fixture movie"`, "transport=http", "trigger=ws", "position_ms=2500", "state=playing", "session_ref="} {
		if !strings.Contains(got, expected) {
			t.Fatalf("missing %s: %s", expected, got)
		}
	}
	if strings.Contains(got, "private-session") || strings.Contains(got, "private-title") {
		t.Fatal(got)
	}
	if strings.Count(got, "session_ref="+a.activitySessionReference(5, "private-session")) != 2 {
		t.Fatal("socket and HTTP updates did not correlate", got)
	}
}

func TestConsoleLogLevelsAndSafeErrors(t *testing.T) {
	var output bytes.Buffer
	logger, err := newConsoleLogger(&output, "debug")
	if err != nil {
		t.Fatal(err)
	}
	logger.Debug("poll started", "server_id", 1)
	if !strings.Contains(output.String(), "level=DEBUG") {
		t.Fatal(output.String())
	}
	output.Reset()
	logger, err = newConsoleLogger(&output, "")
	if err != nil {
		t.Fatal(err)
	}
	logger.Debug("hidden")
	logger.Info("visible")
	if strings.Contains(output.String(), "hidden") || !strings.Contains(output.String(), "level=INFO") {
		t.Fatal(output.String())
	}
	if _, err := newConsoleLogger(&output, "secret-invalid-value"); err == nil || strings.Contains(err.Error(), "secret-invalid-value") {
		t.Fatal("invalid level not safely rejected", err)
	}
	for _, tc := range []struct {
		err  error
		code string
	}{
		{&providerHTTPError{StatusCode: 401}, "UPSTREAM_AUTH_REJECTED"},
		{errActivitySnapshot, "INVALID_ACTIVITY_SNAPSHOT"},
		{context.DeadlineExceeded, "TIMEOUT"},
		{&url.Error{Op: "Get", URL: "https://secret-user:secret-password@fixture/?token=secret-token", Err: errors.New("secret-response")}, "OPERATION_FAILED"},
	} {
		if got := consoleErrorCode(tc.err); got != tc.code {
			t.Fatalf("got %s want %s", got, tc.code)
		}
	}
}

func TestConsoleInventoryExplainsDisabledMonitoring(t *testing.T) {
	a, _ := testApp(t)
	token, _ := bootstrapOwner(t, a)
	server := createManagedServer(t, a, token, "plex", "http://127.0.0.1:1")
	configureTestMonitor(t, a, token, server, false)
	var output bytes.Buffer
	a.logger = slog.New(slog.NewTextHandler(&output, nil))
	a.logActivityMonitorInventory(t.Context())
	if !strings.Contains(output.String(), "state=disabled") || !strings.Contains(output.String(), "provider=plex") {
		t.Fatal(output.String())
	}
	configureTestMonitor(t, a, token, server, true)
	output.Reset()
	a.logActivityMonitorInventory(t.Context())
	if !strings.Contains(output.String(), "state=enabled") {
		t.Fatal(output.String())
	}
	if err := a.runOneActivityMonitor(t.Context()); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "Activity poll failed") || !strings.Contains(output.String(), "stage=provider_read") {
		t.Fatal(output.String())
	}
	for _, secret := range []string{"fixture-secret", "http://", "127.0.0.1", "token="} {
		if strings.Contains(output.String(), secret) {
			t.Fatalf("private provider details in console: %s", output.String())
		}
	}
}

func TestConsoleQueueLogsOnlyStallTransitions(t *testing.T) {
	var output bytes.Buffer
	q := &LogQueue{logger: slog.New(slog.NewTextHandler(&output, nil))}
	q.setStall(errors.New("private SQL and secret"))
	q.setStall(errors.New("another private failure"))
	q.setStall(nil)
	q.setStall(nil)
	if strings.Count(output.String(), "Log persistence stalled") != 1 || strings.Count(output.String(), "Log persistence resumed") != 1 || strings.Contains(output.String(), "private") || strings.Contains(output.String(), "secret") {
		t.Fatal(output.String())
	}
}
