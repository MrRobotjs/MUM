import { useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useServerTimeline } from '../../hooks/useServerTimeline';
import { HistoryTable, initialHistoryView, type HistoryView } from './HistoryTable';

// Everyone's plays on one server: fixed to a server on its History tab, or
// with a server picker on the History page, which remembers the last server
// chosen in this browser.
const lastServerKey = 'mum.history.server';

const rememberedServer = () => {
  try {
    const value = window.localStorage.getItem(lastServerKey);
    return value && (value === 'all' || /^[1-9]\d{0,18}$/.test(value)) ? value : undefined;
  } catch {
    return undefined;
  }
};

export function ServerHistory({ serverId, description }: { serverId?: string; description: string }) {
  const { isAdministrator } = useAuth();
  const pinned = serverId !== undefined;
  const [view, setView] = useState<HistoryView>(() => ({ ...initialHistoryView, server: serverId ?? rememberedServer() ?? 'all' }));
  useEffect(() => { if (pinned) setView({ ...initialHistoryView, server: serverId }); }, [pinned, serverId]);
  const history = useServerTimeline(view.server, view.user, view.records, { types: view.types, methods: view.methods });
  // A remembered server that no longer exists falls back to the newest one.
  useEffect(() => {
    if (!pinned && history.error && view.server) setView({ ...initialHistoryView });
  }, [pinned, history.error, view.server]);
  const onViewChange = (next: HistoryView) => {
    const server = pinned ? serverId : next.server;
    // A different server starts with everyone and no filters.
    const changed = server !== view.server;
    setView(changed ? { ...initialHistoryView, server } : { ...next, server });
    if (!pinned && server) {
      try { window.localStorage.setItem(lastServerKey, server); } catch { /* the choice just isn't remembered */ }
    }
  };
  return <HistoryTable history={history} mode={{ kind: 'server', pickServer: !pinned }} view={view} onViewChange={onViewChange} admin={isAdministrator} description={description} />;
}
