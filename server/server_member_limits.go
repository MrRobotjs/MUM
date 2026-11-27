package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"time"

	"app/server/providers/plex"
)

// Member limits. Plex limits how many people one Plex account can share with
// (plex.MemberLimit, Plex Home members included, and plex.HomeLimit of them in
// Plex Home). The other services have no limit, so they report none.
//
// A Plex account's members are counted across every Plex server in MUM it
// owns, since the limit is per account: each person once, from the last user
// sync, with invitations still awaiting acceptance and shares being made by
// redemptions right now. The owner and accounts MUM only saw in playback are
// not members. A server that refused a share as full stays full until its
// next user sync.
//
// Invites read plex.tv's own counts too, so a share made in Plex since the
// last sync is not missed: the larger of the two counts applies. They are read
// at most once a minute per Plex account, shared between requests, and never
// inside a database transaction; when plex.tv can't be read the stored count
// applies alone.

const (
	plexNearlyFullMembers = 95
	plexNearlyFullHome    = 13
)

type serverCapacity struct {
	Members   int    `json:"members"`
	Limit     int    `json:"limit"`
	Home      int    `json:"home_members"`
	HomeLimit int    `json:"home_limit"`
	State     string `json:"state"`
	HomeState string `json:"home_state"`
	// inFlight is the shares running redemptions are making; reached is a
	// server's earlier "full" answer.
	inFlight int
	reached  bool
}

func (c *serverCapacity) settle() {
	c.State = capacityState(c.Members, plexNearlyFullMembers, c.Limit, c.reached)
	c.HomeState = capacityState(c.Home, plexNearlyFullHome, c.HomeLimit, false)
}

func capacityState(count, nearly, limit int, reached bool) string {
	switch {
	case reached || count >= limit:
		return "full"
	case count >= nearly:
		return "nearly_full"
	default:
		return "open"
	}
}

type capacityReader interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

// readServerCapacity returns the server's member count against its limit, or
// nil for a service without one.
func readServerCapacity(ctx context.Context, q capacityReader, server int64, kind string) (*serverCapacity, error) {
	if kind != "plex" {
		return nil, nil
	}
	group := []int64{server}
	var owner string
	err := q.QueryRowContext(ctx, "SELECT coalesce(external_account_id,'') FROM service_accounts WHERE server_id=? AND external_user_id=?", server, plexOwnerAccountID).Scan(&owner)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if owner != "" {
		var ids string
		if err := q.QueryRowContext(ctx, `SELECT coalesce(json_group_array(sa.server_id),'[]') FROM service_accounts sa JOIN media_servers m ON m.id=sa.server_id
		 WHERE m.service_type='plex' AND sa.external_user_id=? AND sa.external_account_id=?`, plexOwnerAccountID, owner).Scan(&ids); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(ids), &group); err != nil || len(group) == 0 {
			group = []int64{server}
		}
	}
	encoded, _ := json.Marshal(group)
	c := &serverCapacity{Limit: plex.MemberLimit, HomeLimit: plex.HomeLimit}
	err = q.QueryRowContext(ctx, `SELECT
	 (SELECT count(DISTINCT external_user_id) FROM service_accounts WHERE server_id IN (SELECT value FROM json_each(?1)) AND external_user_id<>?2 AND removed_at IS NULL
	   AND (is_active=1 OR coalesce(json_extract(service_settings,'$.invitation_pending'),0)=1) AND coalesce(json_extract(service_settings,'$.activity_observed'),0)<>1),
	 (SELECT count(DISTINCT external_user_id) FROM service_accounts WHERE server_id IN (SELECT value FROM json_each(?1)) AND external_user_id<>?2 AND removed_at IS NULL
	   AND is_active=1 AND coalesce(json_extract(service_settings,'$.plex_home'),0)=1),
	 (SELECT count(*) FROM provisioning_steps st JOIN provisioning_jobs j ON j.id=st.job_id WHERE j.status='running' AND st.status IN ('pending','running')
	   AND st.server_id IN (SELECT value FROM json_each(?1))
	   AND NOT EXISTS(SELECT 1 FROM service_accounts sa WHERE sa.server_id=st.server_id AND sa.external_user_id=st.remote_id AND sa.removed_at IS NULL)),
	 (SELECT coalesce(max(member_limit_reached),0) FROM media_servers WHERE id IN (SELECT value FROM json_each(?1)))`,
		string(encoded), plexOwnerAccountID).Scan(&c.Members, &c.Home, &c.inFlight, &c.reached)
	if err != nil {
		return nil, err
	}
	c.Members += c.inFlight
	c.settle()
	return c, nil
}

const (
	plexCountTTL     = time.Minute
	plexCountMaxAge  = 5 * time.Minute
	plexCountTimeout = 5 * time.Second
)

type plexLiveCount struct {
	members, home int
	at            time.Time
}

// plexCountCache holds plex.tv's counts per Plex account (keyed by a digest
// of the owner token), with one read at a time per account.
type plexCountCache struct {
	mu      sync.Mutex
	counts  map[string]plexLiveCount
	loading map[string]chan struct{}
}

// refreshPlexCounts rereads plex.tv's counts for these servers' Plex accounts
// when the cached ones are older than a minute.
func (a *App) refreshPlexCounts(ctx context.Context, servers []ManagedServer) {
	for _, s := range servers {
		if s.Type != "plex" || s.apiKey == "" || !s.EffectiveActive {
			continue
		}
		key := tokenHash(s.apiKey)
		c := &a.plexCounts
		c.mu.Lock()
		if c.counts == nil {
			c.counts, c.loading = map[string]plexLiveCount{}, map[string]chan struct{}{}
		}
		if cached, ok := c.counts[key]; ok && time.Since(cached.at) < plexCountTTL {
			c.mu.Unlock()
			continue
		}
		if wait, busy := c.loading[key]; busy {
			c.mu.Unlock()
			select {
			case <-wait:
			case <-ctx.Done():
				return
			}
			continue
		}
		done := make(chan struct{})
		c.loading[key] = done
		c.mu.Unlock()
		read, cancel := context.WithTimeout(ctx, plexCountTimeout)
		var members, home int
		connection, err := newServerConnection(ProviderConfig{s.Type, s.URL, s.apiKey}, a.ProviderHTTP)
		if err == nil {
			members, home, err = connection.plexServer().MemberCounts(read)
		}
		cancel()
		c.mu.Lock()
		if err == nil {
			c.counts[key] = plexLiveCount{members: members, home: home, at: time.Now()}
		} else {
			a.logger.Debug("Plex member counts unavailable", "server_id", s.ID, "code", consoleErrorCode(err))
		}
		delete(c.loading, key)
		close(done)
		c.mu.Unlock()
	}
}

func (a *App) cachedPlexCounts(s ManagedServer) (plexLiveCount, bool) {
	if s.Type != "plex" || s.apiKey == "" {
		return plexLiveCount{}, false
	}
	a.plexCounts.mu.Lock()
	defer a.plexCounts.mu.Unlock()
	cached, ok := a.plexCounts.counts[tokenHash(s.apiKey)]
	return cached, ok && time.Since(cached.at) < plexCountMaxAge
}

// serverCapacity is the stored count, raised to plex.tv's own count when a
// recent one was read.
func (a *App) serverCapacity(ctx context.Context, q capacityReader, s ManagedServer) (*serverCapacity, error) {
	c, err := readServerCapacity(ctx, q, s.ID, s.Type)
	if err != nil || c == nil {
		return c, err
	}
	if live, ok := a.cachedPlexCounts(s); ok {
		c.Members = max(c.Members, live.members+c.inFlight)
		c.Home = max(c.Home, live.home)
		c.settle()
	}
	return c, nil
}

// Why an invited server can't take a new member right now, for the invite
// wizard; "" when it can.
const (
	serverClosedFull        = "full"
	serverClosedHomeFull    = "home_full"
	serverClosedUnavailable = "unavailable"
)

// serverClosedReason uses cached plex.tv counts only, so it is safe inside a
// transaction: refreshPlexCounts runs before. A grant that invites into Plex
// Home also needs room in Home.
func (a *App) serverClosedReason(ctx context.Context, q capacityReader, s ManagedServer, g InvitationGrant) (string, error) {
	if !s.EffectiveActive || !supportsProvisioning(s.Type) {
		return serverClosedUnavailable, nil
	}
	capacity, err := a.serverCapacity(ctx, q, s)
	if err != nil {
		return "", err
	}
	switch {
	case capacity == nil:
		return "", nil
	case capacity.State == "full":
		return serverClosedFull, nil
	case g.InvitesToHome() && capacity.HomeState == "full":
		return serverClosedHomeFull, nil
	}
	return "", nil
}

// plexRefusedAsFull reports a share Plex refused because the account's member
// limit is reached: plex.tv answers 422.
func plexRefusedAsFull(err error) bool {
	share, ok := errors.AsType[*plexShareError](err)
	return ok && share.Status == http.StatusUnprocessableEntity
}

// markMemberLimitReached keeps a server full until its next user sync, after
// the server refused a new member as full.
func (a *App) markMemberLimitReached(server int64) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := a.store.write(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, "UPDATE media_servers SET member_limit_reached=1 WHERE id=?", server)
		return err
	}); err != nil {
		a.logger.Warn("Could not record that a server is full", "server_id", server, "code", consoleErrorCode(err))
	}
}

// invitedServers are the servers an invitation grants, read without a
// transaction; an unreadable invitation has none.
func (a *App) invitedServers(ctx context.Context, digest string) []ManagedServer {
	var id int64
	if err := a.store.reader.QueryRowContext(ctx, "SELECT id FROM invites WHERE token=?", digest).Scan(&id); err != nil {
		return nil
	}
	grants, err := loadInvitationGrants(ctx, a.store.reader, id)
	if err != nil {
		return nil
	}
	servers := make([]ManagedServer, 0, len(grants))
	for _, g := range grants {
		if s, err := a.loadServer(ctx, g.ServerID); err == nil {
			servers = append(servers, s)
		}
	}
	return servers
}
