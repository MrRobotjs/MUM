package main

import (
	"database/sql"
	"net/http"
)

type serverRefreshSettingsDTO struct {
	Revision         int64 `json:"revision"`
	ServerRevision   int64 `json:"server_revision"`
	UsersHours       int   `json:"users_interval_hours"`
	LibrariesHours   int   `json:"libraries_interval_hours"`
	UsersStartup     bool  `json:"users_on_startup"`
	LibrariesStartup bool  `json:"libraries_on_startup"`
	Children         bool  `json:"include_episodes_and_tracks"`
}

func (a *App) serverRefreshSettings(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	id, ok := pathID(w, r, "server")
	if !ok {
		return
	}
	if r.URL.RawQuery != "" {
		fail(w, 400, "INVALID_REFRESH_SETTINGS", "Unexpected query")
		return
	}
	if r.Method == http.MethodGet {
		tx, err := a.beginAdminRoleRead(r.Context(), actor.UUID, bearer(r))
		if err != nil {
			domainError(w, err)
			return
		}
		defer tx.Rollback()
		var settings serverRefreshSettingsDTO
		err = tx.QueryRowContext(r.Context(), `SELECT p.revision,s.config_revision,u.interval_seconds/3600,l.interval_seconds/3600,u.refresh_on_startup,l.refresh_on_startup,p.include_episodes_and_tracks FROM server_refresh_settings p JOIN media_servers s ON s.id=p.server_id JOIN server_refresh_schedules u ON u.server_id=s.id AND u.scope='users' JOIN server_refresh_schedules l ON l.server_id=s.id AND l.scope='libraries' WHERE s.id=?`, id).Scan(&settings.Revision, &settings.ServerRevision, &settings.UsersHours, &settings.LibrariesHours, &settings.UsersStartup, &settings.LibrariesStartup, &settings.Children)
		if err == nil {
			err = tx.Commit()
		}
		if err != nil {
			domainError(w, err)
			return
		}
		respond(w, 200, settings)
		return
	}
	var in struct {
		Revision         int64  `json:"revision"`
		ServerRevision   *int64 `json:"server_revision"`
		UsersHours       int    `json:"users_interval_hours"`
		LibrariesHours   int    `json:"libraries_interval_hours"`
		UsersStartup     *bool  `json:"users_on_startup"`
		LibrariesStartup *bool  `json:"libraries_on_startup"`
		Children         *bool  `json:"include_episodes_and_tracks"`
	}
	if !decodeStrictBody(w, r, &in) {
		return
	}
	if in.Revision < 1 || in.ServerRevision == nil || *in.ServerRevision < 0 || in.UsersHours < 1 || in.UsersHours > 8760 || in.LibrariesHours < 1 || in.LibrariesHours > 8760 || in.UsersStartup == nil || in.LibrariesStartup == nil || in.Children == nil {
		fail(w, 400, "INVALID_REFRESH_SETTINGS", "Use valid revisions, intervals and preferences")
		return
	}
	err := a.store.write(r.Context(), func(tx *sql.Tx) error {
		if err := notificationAuthority(r.Context(), tx, actor.UUID, bearer(r)); err != nil {
			return err
		}
		var revision, serverRevision int64
		var oldChildren bool
		if err := tx.QueryRowContext(r.Context(), `SELECT p.revision,s.config_revision,p.include_episodes_and_tracks FROM server_refresh_settings p JOIN media_servers s ON s.id=p.server_id WHERE p.server_id=?`, id).Scan(&revision, &serverRevision, &oldChildren); err != nil {
			return err
		}
		if revision != in.Revision || serverRevision != *in.ServerRevision {
			return ErrConflict
		}
		if _, err := tx.ExecContext(r.Context(), `UPDATE server_refresh_settings SET include_episodes_and_tracks=?,revision=revision+1 WHERE server_id=?`, *in.Children, id); err != nil {
			return err
		}
		for _, scope := range []struct {
			name    string
			hours   int
			startup bool
		}{{"users", in.UsersHours, *in.UsersStartup}, {"libraries", in.LibrariesHours, *in.LibrariesStartup}} {
			childrenChanged := scope.name == "libraries" && oldChildren != *in.Children
			if _, err := tx.ExecContext(r.Context(), `UPDATE server_refresh_schedules SET next_run_at=CASE WHEN interval_seconds<>? THEN strftime('%Y-%m-%dT%H:%M:%fZ','now','+'||?||' seconds') ELSE next_run_at END,interval_seconds=?,refresh_on_startup=?,revision=revision+1 WHERE server_id=? AND scope=? AND (interval_seconds<>? OR refresh_on_startup<>? OR ?)`, scope.hours*3600, scope.hours*3600, scope.hours*3600, scope.startup, id, scope.name, scope.hours*3600, scope.startup, childrenChanged); err != nil {
				return err
			}
		}
		return auditAction(r.Context(), tx, actor.UUID, "server.refresh.configure")
	})
	if err != nil {
		domainError(w, err)
		return
	}
	a.tasksChanged()
	respond(w, 200, map[string]any{"revision": in.Revision + 1})
}
