package main

import (
	"container/list"
	"context"
	"database/sql"
	"net/http"
	"sync"
	"time"
)

// Keys contain only validated source identifiers, never provider credentials.
type imageCacheKey struct {
	server, revision  int64
	purpose, external string
}
type cachedImage struct {
	key     imageCacheKey
	kind    string
	body    []byte
	expires time.Time
}
type imageCache struct {
	mu          sync.Mutex
	entries     map[imageCacheKey]*list.Element
	order       list.List
	versions    map[int64]uint64
	size, limit int
	ttl         time.Duration
}

func (c *imageCache) generation(server int64) uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.versions[server]
}
func (c *imageCache) remove(e *list.Element) {
	entry := e.Value.(*cachedImage)
	delete(c.entries, entry.key)
	c.size -= len(entry.body)
	c.order.Remove(e)
}
func (c *imageCache) get(key imageCacheKey, now time.Time) (string, []byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e := c.entries[key]
	if e == nil {
		return "", nil, false
	}
	entry := e.Value.(*cachedImage)
	if !now.Before(entry.expires) {
		c.remove(e)
		return "", nil, false
	}
	c.order.MoveToFront(e)
	return entry.kind, entry.body, true
}
func (c *imageCache) put(key imageCacheKey, kind string, body []byte, now time.Time, version uint64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.limit <= 0 || c.ttl <= 0 || len(body) == 0 || len(body) > c.limit || c.versions[key.server] != version {
		return
	}
	if c.entries == nil {
		c.entries = make(map[imageCacheKey]*list.Element)
	}
	if old := c.entries[key]; old != nil {
		c.remove(old)
	}
	for c.size+len(body) > c.limit {
		c.remove(c.order.Back())
	}
	entry := &cachedImage{key: key, kind: kind, body: append([]byte(nil), body...), expires: now.Add(c.ttl)}
	c.entries[key] = c.order.PushFront(entry)
	c.size += len(body)
}
func (c *imageCache) clear(server int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.versions == nil {
		c.versions = make(map[int64]uint64)
	}
	c.versions[server]++
	for e := c.order.Back(); e != nil; {
		prev := e.Prev()
		if e.Value.(*cachedImage).key.server == server {
			c.remove(e)
		}
		e = prev
	}
}

func (a *App) imageCacheEnabled(ctx context.Context, server int64) (bool, error) {
	if server <= 0 {
		return false, nil
	}
	var enabled bool
	err := a.store.reader.QueryRowContext(ctx, `SELECT cache_images FROM media_servers WHERE id=?`, server).Scan(&enabled)
	return enabled, err
}

func (a *App) clearServerImageCache(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	id, ok := pathID(w, r, "server")
	if !ok {
		return
	}
	err := a.store.write(r.Context(), func(tx *sql.Tx) error {
		if err := notificationAuthority(r.Context(), tx, actor.UUID, bearer(r)); err != nil {
			return err
		}
		if err := requirePermission(r.Context(), tx, actor.UUID, "administrator"); err != nil {
			return err
		}
		var exists bool
		if err := tx.QueryRowContext(r.Context(), `SELECT EXISTS(SELECT 1 FROM media_servers WHERE id=?)`, id).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return ErrNotFound
		}
		return auditAction(r.Context(), tx, actor.UUID, "server.image_cache.clear")
	})
	if err != nil {
		domainError(w, err)
		return
	}
	a.imageCache.clear(id)
	respond(w, http.StatusOK, map[string]bool{"cleared": true})
}
