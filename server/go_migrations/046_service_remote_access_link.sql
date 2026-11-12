-- Delegated remote revocation depends on who primarily owns the account. Pin the
-- global account-link revision in the lease so an ownership change during the
-- operation invalidates it. Leases from before this migration lack the pin and
-- are therefore invalid; startup recovery records them as unknown.
ALTER TABLE service_remote_access ADD COLUMN link_revision INTEGER CHECK(link_revision IS NULL OR (link_revision>0 AND typeof(link_revision)='integer'));
UPDATE service_remote_access SET link_revision=NULL;
