package tofa

import (
	"app/server/providers/provider"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/mail"
	"strings"
)

// OnboardingInvite identifies an invitation, not a user account.
type OnboardingInvite struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	State string `json:"state"`
}

func (s *Server) onboardingRequest(ctx context.Context, method, path string, input any) (OnboardingInvite, error) {
	var result OnboardingInvite
	var body []byte
	var err error
	if input != nil {
		if body, err = json.Marshal(input); err != nil {
			return result, err
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, s.url+path, bytes.NewReader(body))
	if err != nil {
		return result, err
	}
	req.Header.Set("Authorization", "Bearer "+s.key)
	req.Header.Set("Accept", "application/json")
	if input != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	raw, err := s.transport.Send(req)
	if err != nil {
		return result, err
	}
	if len(raw) > 65536 {
		return result, errors.New("invalid Tofa invitation response")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	if provider.UniqueJSONKeys(d) != nil {
		return result, errors.New("invalid Tofa invitation response")
	}
	if _, err = d.Token(); err != io.EOF {
		return result, errors.New("invalid Tofa invitation response")
	}
	if json.Unmarshal(raw, &result) != nil || !uuid.MatchString(result.ID) || !validInviteEmail(result.Email) {
		return OnboardingInvite{}, errors.New("invalid Tofa invitation response")
	}
	switch result.State {
	case "queued", "waiting", "invited", "joined", "failed", "revoked":
	default:
		return OnboardingInvite{}, errors.New("invalid Tofa invitation state")
	}
	return result, nil
}

func validInviteEmail(email string) bool {
	if len(email) > 320 || email != strings.TrimSpace(email) {
		return false
	}
	address, err := mail.ParseAddress(email)
	return err == nil && address.Address == email
}

// ValidGrant: Tofa onboarding invites set library access only; the API has no
// download permission field.
func (s *Server) ValidGrant(grant provider.Grant) bool {
	if grant.AllowDownloads || len(grant.LibraryIDs) > 1000 || grant.AllLibraries && len(grant.LibraryIDs) > 0 || !grant.AllLibraries && len(grant.LibraryIDs) == 0 {
		return false
	}
	seen := map[string]bool{}
	for _, id := range grant.LibraryIDs {
		id = strings.ToLower(id)
		if !uuid.MatchString(id) || seen[id] {
			return false
		}
		seen[id] = true
	}
	return true
}

func (s *Server) CreateOnboardingInvite(ctx context.Context, key, email string, all bool, libraries []string) (OnboardingInvite, error) {
	if !provider.ValidText(key, 128) || key == "" || !validInviteEmail(email) || len(libraries) > 1000 || all && len(libraries) > 0 || !all && len(libraries) == 0 {
		return OnboardingInvite{}, errors.New("invalid Tofa invitation request")
	}
	seen := map[string]bool{}
	for _, id := range libraries {
		id = strings.ToLower(id)
		if !uuid.MatchString(id) || seen[id] {
			return OnboardingInvite{}, errors.New("invalid Tofa invitation libraries")
		}
		seen[id] = true
	}
	if libraries == nil {
		libraries = []string{}
	}
	result, err := s.onboardingRequest(ctx, http.MethodPost, "/api/v1/onboarding/invites", map[string]any{"idempotency_key": key, "email": email, "unrestricted_libraries": all, "library_ids": libraries})
	if err == nil && !strings.EqualFold(result.Email, email) {
		return OnboardingInvite{}, errors.New("unexpected Tofa invitation response")
	}
	return result, err
}

func (s *Server) InspectOnboardingInvite(ctx context.Context, id string) (OnboardingInvite, error) {
	if !uuid.MatchString(id) {
		return OnboardingInvite{}, errors.New("invalid Tofa invitation ID")
	}
	result, err := s.onboardingRequest(ctx, http.MethodGet, "/api/v1/onboarding/invites/"+id, nil)
	if err == nil && !strings.EqualFold(result.ID, id) {
		return OnboardingInvite{}, errors.New("unexpected Tofa invitation response")
	}
	return result, err
}

func (s *Server) RevokeOnboardingInvite(ctx context.Context, id string) (OnboardingInvite, error) {
	if !uuid.MatchString(id) {
		return OnboardingInvite{}, errors.New("invalid Tofa invitation ID")
	}
	result, err := s.onboardingRequest(ctx, http.MethodPost, "/api/v1/onboarding/invites/"+id+"/revoke", nil)
	if err == nil && !strings.EqualFold(result.ID, id) {
		return OnboardingInvite{}, errors.New("unexpected Tofa invitation response")
	}
	return result, err
}
