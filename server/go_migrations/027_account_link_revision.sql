CREATE TABLE account_link_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    revision INTEGER NOT NULL CHECK(revision>0 AND typeof(revision)='integer')
);
INSERT INTO account_link_state VALUES(1,1);
CREATE TRIGGER account_link_insert AFTER INSERT ON service_links BEGIN
    UPDATE account_link_state SET revision=revision+1 WHERE singleton=1;
END;
CREATE TRIGGER account_link_update AFTER UPDATE ON service_links BEGIN
    UPDATE account_link_state SET revision=revision+1 WHERE singleton=1;
END;
CREATE TRIGGER account_link_delete AFTER DELETE ON service_links BEGIN
    UPDATE account_link_state SET revision=revision+1 WHERE singleton=1;
END;
