// Package kavita is MUM's Kavita module: library and user reads,
// username-only provisioning with selected libraries, recorded-account
// recovery and role-based disable and enable. Kavita deletes accounts by
// username, so MUM only deletes them in bulk, right after re-verifying the
// recorded ID still has that name.
package kavita

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"

	"app/server/providers/provider"
)

var Definition = provider.Definition{
	ID:             "kavita",
	Name:           "Kavita",
	Description:    "Kavita synchronization, username-only provisioning with selected libraries and recorded-account recovery",
	DownloadLabels: true,
}

var errCredentials = &provider.CredentialsError{Code: "INVALID_KAVITA_CREDENTIALS", Message: "Kavita requires a username without @ and a password of at most 256 bytes"}

// Server is one configured Kavita server.
type Server struct {
	url, apiKey string
	transport   provider.Transport
}

func New(cfg provider.Config) *Server {
	return &Server{url: strings.TrimRight(cfg.URL, "/"), apiKey: cfg.APIKey, transport: cfg.Transport}
}

func (s *Server) authorize(header http.Header) { header.Set("x-api-key", s.apiKey) }

func (s *Server) api(ctx context.Context, method, endpoint string, body, out any) error {
	return s.transport.JSON(ctx, method, s.url+"/api"+endpoint, s.authorize, body, out)
}

// RecordedID parses Kavita's canonical positive 32-bit user or library ID.
func RecordedID(id string) (int64, error) {
	value, err := strconv.ParseInt(id, 10, 32)
	if err != nil || value < 1 || strconv.FormatInt(value, 10) != id {
		return 0, provider.ErrConflict
	}
	return value, nil
}

// libraryIDs converts an explicit grant to Kavita library IDs. Kavita grants
// are always explicit lists; an all-libraries grant is refused.
func libraryIDs(grant provider.Grant) ([]int64, error) {
	if grant.AllLibraries || len(grant.LibraryIDs) == 0 {
		return nil, provider.ErrConflict
	}
	ids := []int64{}
	for _, value := range grant.LibraryIDs {
		id, err := RecordedID(value)
		if err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, nil
}

// Account rules.

func (s *Server) ValidGrant(grant provider.Grant) bool {
	_, err := libraryIDs(grant)
	return err == nil
}
func (s *Server) ValidRecordedID(id string) bool {
	_, err := RecordedID(id)
	return err == nil
}
func (s *Server) ValidRemoteName(name string) bool { return name != "" && !strings.Contains(name, "@") }
func (s *Server) PasswordMaxBytes() int            { return 256 }
func (s *Server) CheckCredentials(name, password string) error {
	if strings.Contains(name, "@") || len(password) > 256 {
		return errCredentials
	}
	return nil
}

// Reads.

func (s *Server) Test(ctx context.Context) (provider.Info, error) {
	libraries, err := s.Libraries(ctx)
	if err == nil {
		err = provider.CheckLibraries(libraries)
	}
	return provider.Info{Name: "Kavita"}, err
}

func (s *Server) Libraries(ctx context.Context) ([]provider.Library, error) {
	var rows []struct {
		ID          *int64          `json:"id"`
		Name        string          `json:"name"`
		Type        json.RawMessage `json:"type"`
		SeriesCount *int64          `json:"seriesCount"`
	}
	if err := s.api(ctx, http.MethodGet, "/Library/libraries", nil, &rows); err != nil {
		return nil, err
	}
	if rows == nil {
		return nil, errors.New("provider returned null library list")
	}
	result := []provider.Library{}
	for _, r := range rows {
		if r.ID == nil {
			return nil, errors.New("library is missing its ID")
		}
		kind := "book"
		if len(r.Type) > 0 {
			var value int
			if err := json.Unmarshal(r.Type, &value); err != nil {
				return nil, errors.New("invalid Kavita library type")
			}
			types := map[int]string{0: "manga", 1: "comic", 2: "book", 3: "image", 4: "light_novel", 5: "comic"}
			if name, ok := types[value]; ok {
				kind = name
			} else {
				kind = "mixed"
			}
		}
		result = append(result, provider.Library{ID: strconv.FormatInt(*r.ID, 10), Name: r.Name, Type: kind, ItemCount: r.SeriesCount})
	}
	return result, nil
}

func (s *Server) Users(ctx context.Context) ([]provider.User, error) {
	var rows []struct {
		ID        *int64    `json:"id"`
		Username  string    `json:"username"`
		Email     string    `json:"email"`
		IsPending *bool     `json:"isPending"`
		Roles     *[]string `json:"roles"`
		Libraries []struct {
			ID int64 `json:"id"`
		} `json:"libraries"`
	}
	if err := s.api(ctx, http.MethodGet, "/Users", nil, &rows); err != nil {
		return nil, err
	}
	if rows == nil {
		return nil, errors.New("provider returned null user list")
	}
	result := []provider.User{}
	for _, r := range rows {
		if r.ID == nil || *r.ID < 1 || r.IsPending == nil || r.Roles == nil {
			return nil, errors.New("user is missing identity or access policy")
		}
		for _, role := range *r.Roles {
			if strings.TrimSpace(role) == "" {
				return nil, errors.New("invalid Kavita role observation")
			}
		}
		libraries := []string{}
		for _, l := range r.Libraries {
			libraries = append(libraries, strconv.FormatInt(l.ID, 10))
		}
		roles := *r.Roles
		result = append(result, provider.User{
			ID: strconv.FormatInt(*r.ID, 10), Name: r.Username, Email: r.Email,
			Active:     !*r.IsPending && (slices.Contains(roles, "Login") || slices.Contains(roles, "Admin")),
			LibraryIDs: libraries,
			Access:     &provider.UserAccess{LibrariesKnown: true, DownloadsKnown: true, AllowDownloads: slices.Contains(roles, "Download") || slices.Contains(roles, "Admin")},
		})
	}
	return result, nil
}

// Recorded accounts.

type AgeRestriction struct {
	AgeRating       int  `json:"ageRating"`
	IncludeUnknowns bool `json:"includeUnknowns"`
}

// Observed is a Kavita account's observed roles, libraries and age limit; it
// is the Detail of the provider.Account this module returns.
type Observed struct {
	ID        int64
	Name      string
	Roles     []string
	Libraries []int64
	Age       AgeRestriction
}

func observed(a provider.Account) *Observed {
	o, _ := a.Detail.(*Observed)
	return o
}

func roles(downloads, enabled bool) []string {
	result := []string{"Pleb", "Change Password"}
	if downloads {
		result = append(result, "Download")
	}
	if enabled {
		result = append(result, "Login")
	}
	return result
}

func sortedEqual[T int64 | string](a, b []T) bool {
	a, b = slices.Clone(a), slices.Clone(b)
	slices.Sort(a)
	slices.Sort(b)
	return slices.Equal(a, b)
}

// InspectAccount reads the recorded account from the administrator-only,
// unpaginated member list, which includes pending accounts. HTTP errors and
// null or malformed lists never prove absence, and nothing is adopted by
// username.
func (s *Server) InspectAccount(ctx context.Context, id, name string) (provider.Account, error) {
	value, err := RecordedID(id)
	if err != nil || name == "" {
		return provider.Account{}, provider.ErrConflict
	}
	var members []struct {
		ID               *int64    `json:"id"`
		Username         string    `json:"username"`
		Pending          *bool     `json:"isPending"`
		IdentityProvider *int      `json:"identityProvider"`
		Roles            *[]string `json:"roles"`
		Libraries        *[]struct {
			ID *int64 `json:"id"`
		} `json:"libraries"`
		Age *struct {
			Rating          *int  `json:"ageRating"`
			IncludeUnknowns *bool `json:"includeUnknowns"`
		} `json:"ageRestriction"`
	}
	if err := s.api(ctx, http.MethodGet, "/Users?includePending=true", nil, &members); err != nil {
		return provider.Account{}, err
	}
	if members == nil || len(members) > 10000 {
		return provider.Account{}, provider.ErrConflict
	}
	seen := map[int64]bool{}
	seenNames := map[string]bool{}
	result := provider.Account{ID: id, Name: name, Absent: true}
	for _, member := range members {
		if member.ID == nil || *member.ID < 1 || *member.ID > 2147483647 || seen[*member.ID] {
			return provider.Account{}, provider.ErrConflict
		}
		seen[*member.ID] = true
		nameKey := strings.ToLower(member.Username)
		if nameKey == "" || seenNames[nameKey] {
			return provider.Account{}, provider.ErrConflict
		}
		seenNames[nameKey] = true
		if *member.ID != value {
			continue
		}
		if member.Username != name || member.Pending == nil || *member.Pending || member.IdentityProvider == nil || *member.IdentityProvider != 0 || member.Roles == nil || member.Libraries == nil || member.Age == nil || member.Age.Rating == nil || member.Age.IncludeUnknowns == nil {
			return provider.Account{}, provider.ErrConflict
		}
		observedRoles := map[string]bool{}
		for _, role := range *member.Roles {
			if observedRoles[role] {
				return provider.Account{}, provider.ErrConflict
			}
			observedRoles[role] = true
			switch role {
			case "Pleb", "Login", "Download", "Change Password", "Bookmark", "Change Restriction", "Read Only", "Promote":
			default:
				return provider.Account{}, provider.ErrConflict
			}
		}
		if !observedRoles["Pleb"] {
			return provider.Account{}, provider.ErrConflict
		}
		libraries := []int64{}
		seenLibraries := map[int64]bool{}
		for _, library := range *member.Libraries {
			if library.ID == nil || *library.ID < 1 || *library.ID > 2147483647 || seenLibraries[*library.ID] {
				return provider.Account{}, provider.ErrConflict
			}
			seenLibraries[*library.ID] = true
			libraries = append(libraries, *library.ID)
		}
		o := Observed{value, name, slices.Clone(*member.Roles), libraries, AgeRestriction{*member.Age.Rating, *member.Age.IncludeUnknowns}}
		result = provider.Account{ID: id, Name: name, Disabled: !observedRoles["Login"], Detail: &o}
	}
	return result, nil
}

func grantMatches(user *Observed, grant provider.Grant, enabled bool) bool {
	if user == nil {
		return false
	}
	libraries, err := libraryIDs(grant)
	if err != nil {
		return false
	}
	return sortedEqual(libraries, user.Libraries) && sortedEqual(user.Roles, roles(grant.AllowDownloads, enabled))
}

// update writes roles and libraries. Kavita adds Pleb itself. The username,
// identity provider and observed age limit are preserved; email is omitted
// to avoid an unrelated email-change side effect.
func (s *Server) update(ctx context.Context, user Observed, wanted []string, libraries []int64) error {
	requested := []string{}
	for _, role := range wanted {
		if role != "Pleb" {
			requested = append(requested, role)
		}
	}
	body := struct {
		UserID           int64          `json:"userId"`
		Username         string         `json:"username"`
		Roles            []string       `json:"roles"`
		Libraries        []int64        `json:"libraries"`
		Age              AgeRestriction `json:"ageRestriction"`
		IdentityProvider int            `json:"identityProvider"`
	}{user.ID, user.Name, requested, libraries, user.Age, 0}
	return s.api(ctx, http.MethodPost, "/Account/update", body, nil)
}

// setLogin adds or removes the Login role and verifies that roles, libraries
// and the age limit are otherwise unchanged.
func (s *Server) setLogin(ctx context.Context, original provider.Account, enabled bool) error {
	o := observed(original)
	if o == nil {
		return provider.ErrConflict
	}
	user := *o
	wanted := slices.Clone(user.Roles)
	if !enabled {
		wanted = slices.DeleteFunc(wanted, func(role string) bool { return role == "Login" })
	} else if !slices.Contains(wanted, "Login") {
		wanted = append(wanted, "Login")
	}
	if err := s.update(ctx, user, wanted, user.Libraries); err != nil {
		return err
	}
	verified, err := s.InspectAccount(ctx, original.ID, original.Name)
	if err != nil {
		return err
	}
	v := observed(verified)
	if verified.Absent || verified.Disabled == enabled || v == nil || v.Age != user.Age {
		return provider.ErrConflict
	}
	if !sortedEqual(v.Roles, wanted) || !sortedEqual(v.Libraries, user.Libraries) {
		return provider.ErrConflict
	}
	return nil
}

// DisableAccount removes the Login role.
func (s *Server) DisableAccount(ctx context.Context, original provider.Account) error {
	return s.setLogin(ctx, original, false)
}

// EnableAccount adds the Login role back.
func (s *Server) EnableAccount(ctx context.Context, original provider.Account) error {
	return s.setLogin(ctx, original, true)
}

func (s *Server) matches(ctx context.Context, id int64, name string, grant provider.Grant, enabled bool) error {
	user, err := s.InspectAccount(ctx, strconv.FormatInt(id, 10), name)
	if err != nil {
		return err
	}
	if !grantMatches(observed(user), grant, enabled) {
		return provider.ErrConflict
	}
	return nil
}

// ProvisionAccount invites the username (which prevents email delivery),
// confirms the invitation with the bound token through the configured API,
// verifies the account without Login, then enables it and verifies again.
func (s *Server) ProvisionAccount(ctx context.Context, username, password string, grant provider.Grant, checkpoint func(stage, remoteID string) error) error {
	if strings.Contains(username, "@") || len(password) > 256 {
		return errCredentials
	}
	ids, err := libraryIDs(grant)
	if err != nil {
		return err
	}
	if err := checkpoint("inviting", ""); err != nil {
		return err
	}
	// Never follow the returned URL: extract its bound token and call the
	// configured API only.
	var invite struct {
		EmailLink string `json:"emailLink"`
		EmailSent bool   `json:"emailSent"`
	}
	age := AgeRestriction{-1, true}
	body := struct {
		Email          string         `json:"email"`
		Roles          []string       `json:"roles"`
		Libraries      []int64        `json:"libraries"`
		AgeRestriction AgeRestriction `json:"ageRestriction"`
	}{username, roles(grant.AllowDownloads, false)[1:], ids, age}
	if err := s.api(ctx, http.MethodPost, "/Account/invite", body, &invite); err != nil {
		return err
	}
	link, err := url.Parse(invite.EmailLink)
	if err != nil || invite.EmailSent || link == nil || link.User != nil || link.Fragment != "" || !strings.HasSuffix(link.Path, "/registration/confirm-email") {
		return provider.ErrConflict
	}
	query, err := url.ParseQuery(link.RawQuery)
	if err != nil || len(query["email"]) != 1 || query.Get("email") != username || len(query["token"]) != 1 || len(query.Get("token")) == 0 || len(query.Get("token")) > 8192 {
		return provider.ErrConflict
	}
	if err := checkpoint("confirming", ""); err != nil {
		return err
	}
	var confirmed struct {
		ID       int64  `json:"id"`
		Username string `json:"username"`
	}
	confirmation := struct {
		Email    string `json:"email"`
		Username string `json:"username"`
		Password string `json:"password"`
		Token    string `json:"token"`
	}{username, username, password, query.Get("token")}
	if err := s.api(ctx, http.MethodPost, "/Account/confirm-email", confirmation, &confirmed); err != nil {
		return err
	}
	if confirmed.ID < 1 || confirmed.ID > 2147483647 || confirmed.Username != username {
		return provider.ErrConflict
	}
	id := strconv.FormatInt(confirmed.ID, 10)
	if err := checkpoint("configuring", id); err != nil {
		return err
	}
	if err := s.matches(ctx, confirmed.ID, username, grant, false); err != nil {
		return err
	}
	if err := checkpoint("enabling", id); err != nil {
		return err
	}
	update := struct {
		UserID           int64          `json:"userId"`
		Username         string         `json:"username"`
		Roles            []string       `json:"roles"`
		Libraries        []int64        `json:"libraries"`
		AgeRestriction   AgeRestriction `json:"ageRestriction"`
		IdentityProvider int            `json:"identityProvider"`
	}{confirmed.ID, username, roles(grant.AllowDownloads, true)[1:], ids, age, 0}
	if err := s.api(ctx, http.MethodPost, "/Account/update", update, nil); err != nil {
		return err
	}
	if err := s.matches(ctx, confirmed.ID, username, grant, true); err != nil {
		return err
	}
	return checkpoint("remote_completed", id)
}

// ResumeAccount finishes an interrupted setup: write the grant without Login,
// reset the password by the name just verified against the recorded ID, then
// enable, verifying the age limit is kept after each write.
func (s *Server) ResumeAccount(ctx context.Context, target provider.Resume, checkpoint func(stage string) error) error {
	user, err := s.InspectAccount(ctx, target.RemoteID, target.RemoteName)
	if err != nil {
		return err
	}
	o := observed(user)
	if user.Absent || o == nil {
		return provider.ErrConflict
	}
	ids, err := libraryIDs(target.Grant)
	if err != nil {
		return err
	}
	if err := checkpoint("configuring"); err != nil {
		return err
	}
	if err := s.update(ctx, *o, roles(target.Grant.AllowDownloads, false), ids); err != nil {
		return err
	}
	disabled, err := s.InspectAccount(ctx, user.ID, user.Name)
	if err != nil {
		return err
	}
	if d := observed(disabled); !grantMatches(d, target.Grant, false) || d.Age != o.Age {
		return provider.ErrConflict
	}
	if err := checkpoint("password"); err != nil {
		return err
	}
	// Kavita's administrative reset takes a username, so only the name just
	// verified against the durable ID is used. No invitation is replayed.
	body := struct {
		Username string `json:"userName"`
		Password string `json:"password"`
	}{user.Name, target.Password}
	if err := s.api(ctx, http.MethodPost, "/Account/reset-password", body, nil); err != nil {
		return err
	}
	if err := checkpoint("enabling"); err != nil {
		return err
	}
	// Re-inspect the durable identity after the name-based password operation.
	current, err := s.InspectAccount(ctx, user.ID, user.Name)
	if err != nil {
		return err
	}
	c := observed(current)
	if !grantMatches(c, target.Grant, false) || c.Age != o.Age {
		return provider.ErrConflict
	}
	if err := s.update(ctx, *c, roles(target.Grant.AllowDownloads, true), ids); err != nil {
		return err
	}
	verified, err := s.InspectAccount(ctx, user.ID, user.Name)
	if err != nil {
		return err
	}
	if v := observed(verified); !grantMatches(v, target.Grant, true) || v.Age != o.Age {
		return provider.ErrConflict
	}
	return checkpoint("verified")
}

// DeleteVerifiedByName deletes by username, the only way Kavita offers. MUM
// calls it only in a bulk delete, right after re-inspecting the recorded ID
// as present, disabled and still holding this name.
func (s *Server) DeleteVerifiedByName(ctx context.Context, user provider.Account) error {
	return s.api(ctx, http.MethodDelete, "/Users/delete-user?username="+url.QueryEscape(user.Name), nil, nil)
}

// Library access for bulk edits. Kavita grants are explicit lists, so "all
// libraries" means every library on the server now.

func (s *Server) LibraryAccess(user provider.Account) (all bool, ids []string, ok bool) {
	o := observed(user)
	if o == nil {
		return false, nil, false
	}
	for _, id := range o.Libraries {
		ids = append(ids, strconv.FormatInt(id, 10))
	}
	return false, ids, true
}

func (s *Server) allLibraryIDs(ctx context.Context) ([]string, error) {
	libraries, err := s.Libraries(ctx)
	if err != nil {
		return nil, err
	}
	if err := provider.CheckLibraries(libraries); err != nil {
		return nil, err
	}
	ids := []string{}
	for _, l := range libraries {
		ids = append(ids, l.ID)
	}
	return ids, nil
}

// LibraryGrantMatches compares the account's libraries with the requested
// ones, expanding "all" to the server's current libraries.
func (s *Server) LibraryGrantMatches(ctx context.Context, user provider.Account, all bool, ids []string) bool {
	_, actual, ok := s.LibraryAccess(user)
	if !ok {
		return false
	}
	if all {
		every, err := s.allLibraryIDs(ctx)
		if err != nil {
			return false
		}
		ids = every
	}
	return sortedEqual(actual, ids)
}

// WriteLibraryAccess replaces the account's libraries, keeping its roles and
// age limit; "all" is written as the server's current libraries.
func (s *Server) WriteLibraryAccess(ctx context.Context, user provider.Account, all bool, ids []string) error {
	o := observed(user)
	if o == nil {
		return provider.ErrConflict
	}
	if all {
		every, err := s.allLibraryIDs(ctx)
		if err != nil {
			return err
		}
		ids = every
	}
	numbers := []int64{}
	for _, id := range ids {
		n, err := RecordedID(id)
		if err != nil {
			return err
		}
		numbers = append(numbers, n)
	}
	return s.update(ctx, *o, o.Roles, numbers)
}

// StateWithoutLibraryAccess is the observed state minus the library grant.
func (s *Server) StateWithoutLibraryAccess(user provider.Account) any {
	o := observed(user)
	if o == nil {
		return nil
	}
	v := *o
	v.Roles = slices.Clone(v.Roles)
	slices.Sort(v.Roles)
	v.Libraries = nil
	return &v
}
