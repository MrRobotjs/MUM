package main

import (
	"strconv"
	"strings"
)

// versionNumbers reads a release's leading dotted numbers ("1.43.5.11079" from
// Plex's "1.43.5.11079-b3b13e506"), or nil when it has none.
func versionNumbers(v string) []int {
	v, _, _ = strings.Cut(v, "-")
	v, _, _ = strings.Cut(v, "+")
	var numbers []int
	for part := range strings.SplitSeq(v, ".") {
		n, err := strconv.Atoi(part)
		if err != nil || n < 0 {
			break
		}
		numbers = append(numbers, n)
	}
	return numbers
}

// versionCheck compares a server's release with the one MUM was tested
// against, as far as the tested release goes: "tested", "newer", "older", or
// "" when either is unknown.
func versionCheck(tested, actual string) string {
	want, got := versionNumbers(tested), versionNumbers(actual)
	if len(want) == 0 || len(got) == 0 {
		return ""
	}
	for i, n := range want {
		have := 0
		if i < len(got) {
			have = got[i]
		}
		switch {
		case have > n:
			return "newer"
		case have < n:
			return "older"
		}
	}
	return "tested"
}
