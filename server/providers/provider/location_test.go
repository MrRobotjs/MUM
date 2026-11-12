package provider

import (
	"net/netip"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestLocationCacheCapacityAndExpiry(t *testing.T) {
	cache := &LocationCache{}
	ip := netip.MustParseAddr("8.8.8.8")
	for i := 0; i < 300; i++ {
		cache.Set(strconv.Itoa(i), ip, &Location{Latitude: 1, Longitude: 2})
	}
	if len(cache.entries) != locationCacheSize {
		t.Fatal("unbounded location cache", len(cache.entries))
	}
	cache.entries[locationKey{Scope: "expired", IP: ip}] = locationEntry{Until: time.Now().Add(-time.Second)}
	if _, known := cache.Get("expired", ip); known {
		t.Fatal("expired location reused")
	}
	cache.Set("failed", ip, nil)
	if location, known := cache.Get("failed", ip); !known || location != nil {
		t.Fatal("failed lookup not remembered")
	}
	var none *LocationCache
	none.Set("x", ip, &Location{})
	if _, known := none.Get("x", ip); known {
		t.Fatal("nil cache remembered a lookup")
	}
}

func TestDecodeObjectRejectsDuplicatesAndTrailingData(t *testing.T) {
	for _, body := range []string{`{"a":1,"a":2}`, `{"a":{"b":1,"b":2}}`, `{"a":1} {}`, `[1]`, `{`} {
		if _, err := DecodeObject([]byte(body), 1024); err == nil {
			t.Fatal("accepted", body)
		}
	}
	if _, err := DecodeObject([]byte(`{"a":"`+strings.Repeat("x", 2000)+`"}`), 1024); err == nil {
		t.Fatal("oversized object accepted")
	}
	object, err := DecodeObject([]byte(`{"a":1,"b":{"c":2}}`), 1024)
	if err != nil || len(object) != 2 {
		t.Fatal(object, err)
	}
}
