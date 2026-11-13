package main

import (
	"context"
	"errors"
	"net/http"
	"time"

	"app/server/providers/audiobookshelf"
	"app/server/providers/emby"
	"app/server/providers/jellyfin"
	"app/server/providers/kavita"
	"app/server/providers/komga"
	"app/server/providers/plex"
	"app/server/providers/provider"
	"app/server/providers/romm"
)

// providerHTTPError is the transport's HTTP status error, so existing
// errors.As checks match module and core requests alike.
type providerHTTPError = provider.HTTPError

// mediaModule is one compiled media service module (server/providers/<id>).
// Adding a service means adding its package and one entry here, plus its
// icon and colours in frontend/src/config/pluginMetadata.tsx.
type mediaModule struct {
	Definition provider.Definition
	New        func(provider.Config) any
}

var mediaModules = []mediaModule{
	{jellyfin.Definition, func(c provider.Config) any { return jellyfin.New(c) }},
	{emby.Definition, func(c provider.Config) any { return emby.New(c) }},
	{kavita.Definition, func(c provider.Config) any { return kavita.New(c) }},
	{plex.Definition, func(c provider.Config) any { return plex.New(c) }},
	{audiobookshelf.Definition, func(c provider.Config) any { return audiobookshelf.New(c) }},
	{komga.Definition, func(c provider.Config) any { return komga.New(c) }},
	{romm.Definition, func(c provider.Config) any { return romm.New(c) }},
}

func findMediaModule(kind string) (mediaModule, bool) {
	for _, m := range mediaModules {
		if m.Definition.ID == kind {
			return m, true
		}
	}
	return mediaModule{}, false
}

// moduleRules returns a module instance without a server, for the account
// rules and capabilities that do not contact a server. nil means the service
// is not (yet) a module.
func moduleRules(kind string) any {
	m, ok := findMediaModule(kind)
	if !ok {
		return nil
	}
	return m.New(provider.Config{})
}

// module returns this server's module, wired to MUM's transport: redirects
// are refused and the current operation's authority is rechecked around
// every request. nil means the service is still served by serverConnection.
func (p *serverConnection) module() any {
	m, ok := findMediaModule(p.config.Type)
	if !ok {
		return nil
	}
	return m.New(provider.Config{URL: p.config.URL, APIKey: p.config.APIKey, Transport: p.transport(), ClientID: p.plexClientID, Locations: p.locations})
}

func (p *serverConnection) transport() provider.Transport {
	return provider.Transport{Client: p.client, Guard: p.guard}
}

// guard rechecks the authority attached to this provider for the current
// operation: provisioning review, owner remote access or an Edit operation.
func (p *serverConnection) guard(ctx context.Context) error {
	if err := p.reviewAuthority.check(ctx); err != nil {
		return err
	}
	if err := p.serviceAuthority.check(ctx); err != nil {
		return err
	}
	if p.editAuthority != nil {
		return p.editAuthority(ctx)
	}
	return nil
}

// Features a module may implement. The core checks for them with a type
// assertion instead of comparing service names, and derives the capabilities
// it advertises from them, so an unimplemented feature is never offered.
type (
	connectionTester interface {
		Test(context.Context) (provider.Info, error)
	}
	libraryReader interface {
		Libraries(context.Context) ([]provider.Library, error)
	}
	userReader interface {
		Users(context.Context) ([]provider.User, error)
	}
	// libraryAwareUserReader resolves users against libraries the caller has
	// just read, avoiding a second library read during synchronization.
	libraryAwareUserReader interface {
		UsersWithLibraries(context.Context, []provider.Library) ([]provider.User, error)
	}
	accountInspector interface {
		InspectAccount(ctx context.Context, id, name string) (provider.Account, error)
	}
	accountProvisioner interface {
		ProvisionAccount(ctx context.Context, name, password string, grant provider.Grant, checkpoint func(stage, remoteID string) error) error
	}
	accountResumer interface {
		ResumeAccount(ctx context.Context, target provider.Resume, checkpoint func(stage string) error) error
	}
	accountDisabler interface {
		DisableAccount(context.Context, provider.Account) error
	}
	accountEnabler interface {
		EnableAccount(context.Context, provider.Account) error
	}
	accountDeleter interface {
		DeleteAccount(context.Context, provider.Account) error
	}
	libraryAccessEditor interface {
		LibraryAccess(provider.Account) (all bool, ids []string, ok bool)
		WriteLibraryAccess(ctx context.Context, user provider.Account, all bool, ids []string) error
		StateWithoutLibraryAccess(provider.Account) any
	}
	// libraryGrantMatcher compares library access itself, for services whose
	// grants are explicit lists where "all" means every current library.
	libraryGrantMatcher interface {
		LibraryGrantMatches(ctx context.Context, user provider.Account, all bool, ids []string) bool
	}
	// nameDeleter deletes by username. The core uses it only in an Edit delete,
	// right after re-inspecting the recorded ID as present, disabled and named.
	nameDeleter interface {
		DeleteVerifiedByName(context.Context, provider.Account) error
	}
	// Library catalogues.
	catalogueReader interface {
		CatalogueItems(ctx context.Context, library, kind string, progress func(fetched, total int)) ([]provider.CatalogueItem, error)
	}
	episodeReader interface {
		CatalogueEpisodes(ctx context.Context, show string) ([]provider.CatalogueItem, error)
	}
	// statisticsReader reads a server's own dashboard statistics.
	statisticsReader interface {
		Bandwidth(ctx context.Context, timespan string, since time.Time) (provider.BandwidthStatistics, error)
		Resources(ctx context.Context) ([]provider.ResourceSample, error)
	}
	// trackReader reads an album's tracks, with any music videos of them.
	trackReader interface {
		CatalogueTracks(ctx context.Context, album string) ([]provider.CatalogueItem, error)
	}
	collectionReader interface {
		CatalogueCollections(ctx context.Context, library, kind string) ([]provider.CatalogueCollection, error)
	}
	catalogueImageReader interface {
		CatalogueImage(ctx context.Context, item, tag string) (string, []byte, error)
	}
	collectionImageReader interface {
		CollectionImage(ctx context.Context, collection, poster string) (string, []byte, error)
	}
	// Live sessions.
	liveConnector interface {
		LiveConnection(device string) (provider.LiveConnection, error)
		// LiveEvent classifies one frame: hint is an allowlisted change type
		// ("" to ignore the frame) and reply, when set, is written back
		// instead of recording a hint.
		LiveEvent(frame []byte) (hint string, reply []byte, err error)
	}
	activityReader interface {
		ActivitySnapshot(ctx context.Context) (provider.ActivitySnapshot, error)
	}
	// Avatar downloads (Plex playback and profile avatars).
	activityAvatarReader interface {
		ActivityAvatarImage(ctx context.Context, path string) (string, []byte, error)
	}
	userAvatarReader interface {
		UserAvatarImage(ctx context.Context, path string) (string, []byte, error)
	}
	// catalogueLibraryRule limits which libraries a module catalogues; without
	// it every library of a catalogue module is supported.
	catalogueLibraryRule interface {
		CatalogueLibrarySupported(kind, library string) bool
	}
	// Account rules applied before and during provisioning.
	remoteNameRule interface {
		ValidRemoteName(string) bool
	}
	recordedIDRule interface {
		ValidRecordedID(string) bool
	}
	grantRule interface {
		ValidGrant(provider.Grant) bool
	}
	passwordASCIIRule interface {
		PasswordASCIIOnly() bool
	}
	contentRestrictionReporter interface {
		ContentRestrictionsReported() bool
	}
	passwordLimit interface {
		PasswordMaxBytes() int
	}
	cleanupScoper interface {
		CleanupScope() string
	}
	credentialChecker interface {
		CheckCredentials(name, password string) error
	}
)

// moduleIdentityValid applies a module's recorded-ID and remote-name rules,
// defaulting to a URL-safe ID and a non-empty name.
func moduleIdentityValid(m any, id, name string) bool {
	idOK := validProvisionedID(id)
	if rule, ok := m.(recordedIDRule); ok {
		idOK = rule.ValidRecordedID(id)
	}
	nameOK := name != ""
	if rule, ok := m.(remoteNameRule); ok {
		nameOK = rule.ValidRemoteName(name)
	}
	return idOK && nameOK
}

// moduleRecovers reports whether a module can provision, inspect, resume and
// revoke recorded accounts: what recorded-account recovery needs.
func moduleRecovers(m any) bool {
	_, provisions := m.(accountProvisioner)
	_, inspects := m.(accountInspector)
	_, resumes := m.(accountResumer)
	_, disables := m.(accountDisabler)
	return provisions && inspects && resumes && disables
}

// moduleCapabilities derives the advertised capabilities from what a module
// implements.
func moduleCapabilities(m mediaModule) []string {
	instance := m.New(provider.Config{})
	capabilities := []string{"auth.api_key", "server.test"}
	if _, ok := instance.(libraryReader); ok {
		capabilities = append(capabilities, "libraries.read", "libraries.sync")
	}
	if _, ok := instance.(userReader); ok {
		capabilities = append(capabilities, "users.read", "users.sync")
	}
	// Plex sharing (Edit share changes, provisioning by sharing and the Overseerr
	// integration) is still implemented by the core's sharing workflow.
	plexSharing := m.Definition.ID == "plex"
	if _, ok := instance.(libraryAccessEditor); ok || plexSharing {
		capabilities = append(capabilities, "users.libraries.update")
	}
	if _, ok := instance.(catalogueReader); ok {
		capabilities = append(capabilities, "libraries.items.sync")
	}
	if moduleRecovers(instance) || plexSharing {
		capabilities = append(capabilities, "users.provision", "invitations.redeem")
	}
	if m.Definition.DownloadLabels {
		capabilities = append(capabilities, "labels.downloads.sync")
	}
	if plexSharing {
		capabilities = append(capabilities, "integrations.overseerr")
	}
	return capabilities
}

func definitionFromModule(d provider.Definition) ProviderDefinition {
	return ProviderDefinition{ID: d.ID, Name: d.Name, Description: d.Description}
}

// credentialsFailure writes a module's credentials error with its stable API
// code and reports whether err was one.
func credentialsFailure(w http.ResponseWriter, err error) bool {
	var credentials *provider.CredentialsError
	if !errors.As(err, &credentials) {
		return false
	}
	fail(w, 400, credentials.Code, credentials.Message)
	return true
}
