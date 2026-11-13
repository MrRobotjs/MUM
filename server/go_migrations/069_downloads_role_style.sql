-- A Downloads role created by a sync before migration 068 has no colour or
-- icon and shows grey. Give it the Flask version's style, unless it was
-- already given one.
UPDATE user_roles SET color='#3b82f6',icon='fa-solid fa-download'
WHERE id IN (SELECT role_id FROM download_role) AND is_auto_managed=1
AND (color IS NULL OR color='#808080') AND (icon IS NULL OR icon='');
