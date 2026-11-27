package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
)

// A run's log keeps at most 25 items per entry and 300 per run, counts the
// rest, and drops item lists before going over the stored size.
func TestRefreshLogItemCaps(t *testing.T) {
	items := func(n int) []refreshLogItem {
		out := make([]refreshLogItem, n)
		for i := range out {
			out[i] = refreshLogItem{Title: fmt.Sprintf("Title %d", i), Change: "added"}
		}
		return out
	}
	log := &refreshLog{}
	log.addItems(refreshLogSuccess, "Movies: 40 items saved", "", items(40), 40)
	if e := log.entries[0]; len(e.Items) != refreshLogEntryItems || e.More != 15 {
		t.Fatal("per-entry cap", len(e.Items), e.More)
	}
	for range 20 {
		log.addItems(refreshLogSuccess, "More", "", items(25), 25)
	}
	kept := 0
	for _, e := range log.entries {
		kept += len(e.Items)
	}
	if kept != refreshLogRunItems || log.entries[len(log.entries)-1].More != 25 {
		t.Fatal("per-run cap", kept)
	}

	long := &refreshLog{}
	for range refreshLogMaxEntries {
		big := items(refreshLogEntryItems)
		for i := range big {
			big[i].Title = strings.Repeat("x", refreshLogMaxText)
		}
		long.addItems(refreshLogSuccess, strings.Repeat("y", 200), "", big, len(big))
	}
	encoded := long.encoded()
	var entries []refreshLogEntry
	if len(encoded) > refreshLogMaxBytes || json.Unmarshal([]byte(encoded), &entries) != nil || len(entries) != refreshLogMaxEntries {
		t.Fatal("size cap", len(encoded))
	}
	for _, e := range entries {
		if len(e.Items) != 0 || e.More == 0 {
			t.Fatal("item lists not dropped", e)
		}
	}
}

// Failures are explained in MUM's own words, matched only on the adapters'
// fixed errors; anything else gets a generic explanation with its log code.
func TestRefreshProblemExplanations(t *testing.T) {
	code, explanation := refreshProblem(fmt.Errorf("%w: %w", errEpisodeRead, errors.New("Tofa file show identity unavailable")))
	if code != "TOFA_VERSION_NOT_MATCHED" || !strings.Contains(explanation, "TMDB") {
		t.Fatal(code, explanation)
	}
	if code, _ := refreshProblem(errors.New("invalid Tofa season snapshot")); code != "TOFA_INVALID_RESPONSE" {
		t.Fatal(code)
	}
	code, explanation = refreshProblem(errors.New("upstream said: secret-token-123 is wrong"))
	if code != "OPERATION_FAILED" || strings.Contains(explanation, "secret") {
		t.Fatal("provider text leaked", code, explanation)
	}
}
