-- Catalog capability checks must inspect every affected identity by role.
CREATE INDEX identity_user_roles_role ON identity_user_roles(role_id,user_uuid);
