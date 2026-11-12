package main

import (
	"bytes"
	"encoding/json"
	"strings"
)

// Provider play methods (Jellyfin/Emby PlayerStateInfo.PlayMethod) mapped to
// stored values. Unrecognised methods are recorded as unknown.
var activityPlayMethods = map[string]string{"DirectPlay": "direct_play", "DirectStream": "direct_stream", "Transcode": "transcode"}

// optionalActivityLabel reads an optional provider string. Absent, null,
// blank, oversized or control-character values are unknown (""); a value of
// another JSON type makes the snapshot malformed.
func optionalActivityLabel(raw json.RawMessage, maximum int) (string, error) {
	if raw == nil || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return "", nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", errActivitySnapshot
	}
	value = strings.Join(strings.Fields(value), " ")
	if !activityText(value, maximum) {
		return "", nil
	}
	return value, nil
}

var activityDeviceLabels = []struct {
	markers []string
	label   string
}{
	{[]string{"nvidia shield", "shield android tv", "shield tv"}, "NVIDIA Shield"},
	{[]string{"apple tv"}, "Apple TV"},
	{[]string{"roku"}, "Roku"},
	{[]string{"chromecast", "google tv"}, "Chromecast / Google TV"},
	{[]string{"fire tv", "firestick", "fire stick"}, "Fire TV"},
	{[]string{"webos", "lg webos"}, "LG webOS TV"},
	{[]string{"tizen", "samsung tizen"}, "Samsung Tizen TV"},
	{[]string{"android tv"}, "Android TV"},
	{[]string{"xbox"}, "Xbox"},
	{[]string{"playstation", "ps5", "ps4"}, "PlayStation"},
	{[]string{"nintendo switch"}, "Nintendo Switch"},
	{[]string{"iphone"}, "iPhone"},
	{[]string{"ipad"}, "iPad"},
	{[]string{"android tablet", "tablet"}, "Android Tablet"},
	{[]string{"android mobile", "android phone"}, "Android Phone"},
	{[]string{"jellyfin media player"}, "Jellyfin Media Player"},
	{[]string{"infuse"}, "Infuse"},
	{[]string{"chrome"}, "Chrome"},
	{[]string{"edge"}, "Edge"},
	{[]string{"firefox"}, "Firefox"},
	{[]string{"safari"}, "Safari"},
}

// classifyActivityDevice buckets a client application and device name for
// the Graphs device mix. Device names can be personal ("Bob's iPhone"), so
// they are only searched for known markers; the fallback label is the client
// application name, never the device name.
func classifyActivityDevice(client, device string) string {
	text := strings.ToLower(strings.TrimSpace(client + " " + device))
	if text == "" {
		return "Unknown"
	}
	for _, entry := range activityDeviceLabels {
		for _, marker := range entry.markers {
			if strings.Contains(text, marker) {
				return entry.label
			}
		}
	}
	if strings.Contains(text, "ios") {
		return "iOS"
	}
	if strings.Contains(text, "android") {
		return "Android"
	}
	client = strings.TrimSpace(client)
	if client == "" {
		return "Unknown"
	}
	if runes := []rune(client); len(runes) > 36 {
		return string(runes[:33]) + "..."
	}
	return client
}
