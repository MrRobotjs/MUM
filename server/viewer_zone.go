package main

import (
	"time"
)

// Charts that group plays by hour or day group them in the viewer's
// timezone: the IANA name sent as the tz query value, which the account's
// display settings resolve to. Without one they use UTC. Plays are grouped by
// quarter hour, the finest step any timezone offset takes, so every group
// falls inside one local hour and one local day.

// loadViewerZone loads a tz query value. LoadLocation can consult the
// filesystem, so call it before opening a transaction.
func loadViewerZone(name string) (*time.Location, error) {
	if name == "UTC" {
		return time.UTC, nil
	}
	if !validDisplayShape(accountDisplayValues{Mode: "named", TimeFormat: "24", TimeZone: &name}) {
		return nil, ErrConflict
	}
	zone, err := time.LoadLocation(name)
	if err != nil {
		return nil, ErrConflict
	}
	return zone, nil
}

// zoneQuarterColumns selects a fixed-width UTC timestamp column as two
// columns: its UTC hour (YYYY-MM-DDTHH) and its quarter of that hour (0-3).
func zoneQuarterColumns(column string) string {
	return "substr(" + column + ",1,13),cast(substr(" + column + ",15,2) AS INTEGER)/15"
}

// zoneQuarter is the start of a zoneQuarterColumns group in the zone.
func zoneQuarter(hour string, quarter int64, zone *time.Location) (time.Time, error) {
	at, err := time.Parse("2006-01-02T15", hour)
	if err != nil || len(hour) != 13 || quarter < 0 || quarter > 3 {
		return time.Time{}, ErrConflict
	}
	return at.Add(time.Duration(quarter) * 15 * time.Minute).In(zone), nil
}

// zoneToday is today's calendar date in the zone, as midnight UTC, for
// calendar arithmetic that never crosses a daylight-saving change.
func zoneToday(now time.Time, zone *time.Location) time.Time {
	y, m, d := now.In(zone).Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

// zoneMidnight is the instant a calendar date (from zoneToday) starts in the zone.
func zoneMidnight(day time.Time, zone *time.Location) time.Time {
	y, m, d := day.Date()
	return time.Date(y, m, d, 0, 0, 0, 0, zone)
}
