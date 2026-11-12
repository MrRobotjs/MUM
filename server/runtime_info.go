package main

import (
	"net/http"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"time"
)

type runtimeInformation struct {
	Actor           string  `json:"actor_uuid"`
	GoVersion       string  `json:"go_version"`
	Platform        string  `json:"platform"`
	Timezone        string  `json:"timezone"`
	TimezoneOffset  int     `json:"timezone_offset_seconds"`
	Database        string  `json:"database_type"`
	DatabaseVersion string  `json:"database_version"`
	DatabaseFile    *string `json:"database_file"`
	DataDirectory   *string `json:"data_directory"`
	LogStorage      string  `json:"log_storage"`
	BuildRevision   *string `json:"build_revision"`
	BuildModified   *bool   `json:"build_modified"`
}

// runtimeInfo reports observed facts, never arbitrary environment/build settings.
// Filesystem locations are visible only to the owner.
func (a *App) runtimeInfo(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	if r.URL.RawQuery != "" {
		fail(w, 400, "INVALID_RUNTIME_QUERY", "Runtime information does not accept query parameters")
		return
	}
	tx, err := a.beginAdminRoleRead(r.Context(), p.UUID, bearer(r))
	if err != nil {
		domainError(w, err)
		return
	}
	defer tx.Rollback()
	zone, offset := time.Now().Zone()
	info := runtimeInformation{Actor: p.UUID, GoVersion: runtime.Version(), Platform: runtime.GOOS + "/" + runtime.GOARCH,
		Timezone: zone, TimezoneOffset: offset, Database: "SQLite", LogStorage: "SQLite log_entries; process output"}
	if err = tx.QueryRowContext(r.Context(), "SELECT sqlite_version()").Scan(&info.DatabaseVersion); err != nil {
		domainError(w, err)
		return
	}
	if p.Kind == "owner" {
		var sequence int
		var name, file string
		if err = tx.QueryRowContext(r.Context(), "PRAGMA database_list").Scan(&sequence, &name, &file); err != nil {
			domainError(w, err)
			return
		}
		directory := filepath.Dir(file)
		info.DatabaseFile, info.DataDirectory = &file, &directory
	}
	if build, found := debug.ReadBuildInfo(); found {
		for _, setting := range build.Settings {
			switch setting.Key {
			case "vcs.revision":
				value := setting.Value
				info.BuildRevision = &value
			case "vcs.modified":
				if setting.Value == "true" || setting.Value == "false" {
					value := setting.Value == "true"
					info.BuildModified = &value
				}
			}
		}
	}
	if err = tx.Commit(); err != nil {
		domainError(w, err)
		return
	}
	respond(w, http.StatusOK, info)
}
