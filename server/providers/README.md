# Media service modules

Each media service MUM manages (Plex, Jellyfin, Emby, Kavita, Audiobookshelf, Komga, RomM) is a Go package here. A module talks to its service over HTTP and returns plain data. MUM's core does everything else: the database, jobs and checkpoints, permissions, audit records, scheduling and the API. Modules are compiled into the executable; there is no plugin loading.

```
providers/
  provider/       shared types, the HTTP transport, helpers every module uses
  mediabrowser/   the API Jellyfin and Emby share
  <service>/      one package per service
```

## How the core uses a module

`server/provider_registry.go` holds the one list of modules (`mediaModules`). For each operation, the core builds the module with `New(provider.Config)` and checks which features it implements with a type assertion against small interfaces defined in the same file (`userReader`, `accountProvisioner`, `activityReader`…). The capabilities shown in the UI (`users.sync`, `users.provision`, `libraries.items.sync`…) are derived from those interfaces, so a feature that is not implemented is never offered.

Implement only what the service supports. A read-only module needs just `Libraries` and `Users` (and `Test` if the service has a cheaper check than listing users).

| Feature | Methods | What it enables |
| --- | --- | --- |
| Connection test | `Test` | "Test connection"; otherwise the user list is read |
| Sync | `Libraries`, `Users` (or `UsersWithLibraries`) | library and user sync |
| Invitations and recovery | `ProvisionAccount`, `InspectAccount`, `ResumeAccount`, `DisableAccount` (all four) | `users.provision`, `invitations.redeem`, interrupted-job recovery |
| Remote access | `EnableAccount`, `DeleteAccount` | enabling and deleting recorded accounts |
| Library access edits | `LibraryAccess`, `WriteLibraryAccess`, `StateWithoutLibraryAccess` | `users.libraries.update`, the Users page Edit |
| Catalogue | `CatalogueItems` (plus `CatalogueEpisodes`, `CatalogueCollections`, `CatalogueImage`, `CollectionImage`) | `libraries.items.sync`, library pages and posters |
| Activity | `ActivitySnapshot` (plus `LiveConnection` and `LiveEvent` for instant updates) | stream monitoring |
| Account rules | `ValidRemoteName`, `ValidRecordedID`, `ValidGrant`, `PasswordMaxBytes`, `PasswordASCIIOnly`, `CheckCredentials`, `CleanupScope`, `ContentRestrictionsReported` | validation before and during provisioning |

Set `DownloadLabels: true` in the module's `Definition` when the service can carry a download permission label (`labels.downloads.sync`).

## Rules every module follows

- **Send every request through `cfg.Transport`** (`Send`, `JSON`, `Form` or `Fetch`). It refuses redirects so credentials never reach another host, bounds response sizes, keeps upstream text out of errors, and runs the core's authority check before and after each request. Never build your own `http.Client`.
- **Never touch the database** and never hold state between calls: a module is rebuilt for every operation. Shared state the core owns, such as the location cache, comes in through `provider.Config`.
- **A failed or incomplete read is an error**, never an empty result. Reject duplicates, wrong types and short pages instead of returning part of a list.
- **Report progress through the `checkpoint` callback** before and after each remote step of provisioning, and never retry an uncertain create blindly: `ResumeAccount` finds the recorded account by its ID.
- **Keep secrets out** of errors, logs and returned data. Use `provider.CredentialsError` for user-facing credential rules.
- **No CGO** and only AGPL-compatible dependencies.

## Adding a service

1. Create `server/providers/<id>/` with `var Definition = provider.Definition{...}`, `func New(cfg provider.Config) *Server`, and the methods from the table. `komga/` is a compact example with full provisioning; `audiobookshelf/` and `romm/` are others.
2. Add one entry to `mediaModules` in `server/provider_registry.go`. Its position sets the order in the Media Servers list.
3. Add a migration in `server/go_migrations/` inserting the service's settings row, for example `INSERT INTO provider_settings(provider_id) VALUES ('<id>');`.
4. Frontend: add the ID and label to `frontend/src/config/serviceTypes.ts`, its icon and colours to `SERVICE_META` in `frontend/src/config/pluginMetadata.tsx`, and its colour tokens (`--color-<id>`…) to `frontend/src/index.css`.
5. Service-specific UI rules: if the service has its own invitation rules (identity by email, password limits, grant restrictions), add them where the existing services' rules live: `frontend/src/lib/invitationConstraints.ts`, `frontend/src/lib/invitationWizard.ts` and `frontend/src/pages/InviteWizardPage.tsx`.
6. Tests: write fixture tests against a local `httptest` server (see the `provisioning_*_test.go` files in `server/`). Never point tests at a real server.

Two shared tests then check the new module automatically:

- `TestModuleConformance` runs every read the module implements with a revoked authority (nothing may be sent), against an HTTP 500 and against a garbled reply (both must be errors that do not contain the API key).
- `TestRegisteredModulesAreWiredEverywhere` fails if the settings row or either frontend entry is missing.

Then run `go vet ./...` and `go test ./...` from `server/`, the frontend tests (`node --test tests/frontend_*.test.mjs`) and a Vite build.
