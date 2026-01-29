-- Migration: 0007_groups.sql
-- Creates groups, group_members, acls, and acl_entries tables for access control

-- Enable foreign key constraints
PRAGMA foreign_keys = ON;

-- Groups table
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX idx_groups_name ON groups(name);
CREATE INDEX idx_groups_created_by ON groups(created_by);
CREATE INDEX idx_groups_created_at ON groups(created_at);

-- Group members table (users or groups can be members of a group)
CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL,
  member_type TEXT NOT NULL CHECK(member_type IN ('user', 'group')),
  member_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  PRIMARY KEY (group_id, member_type, member_id),
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- Index on group_members for reverse membership lookups
CREATE INDEX idx_group_members_member ON group_members(member_type, member_id);

-- ACLs table (deduplicated access control lists)
CREATE TABLE IF NOT EXISTS acls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_acls_hash ON acls(hash);

-- ACL entries table (individual permissions within an ACL)
CREATE TABLE IF NOT EXISTS acl_entries (
  acl_id INTEGER NOT NULL,
  principal_type TEXT NOT NULL CHECK(principal_type IN ('user', 'group')),
  principal_id TEXT NOT NULL,
  permission TEXT NOT NULL CHECK(permission IN ('read', 'write')),
  PRIMARY KEY (acl_id, principal_type, principal_id, permission),
  FOREIGN KEY (acl_id) REFERENCES acls(id) ON DELETE CASCADE
);

-- Index on acl_entries for finding ACLs that grant access to a principal
CREATE INDEX idx_acl_entries_principal ON acl_entries(principal_type, principal_id);

-- Add acl_id columns to entities and links tables
-- Note: SQLite doesn't support adding foreign key constraints to existing tables,
-- so we add the column without the FK constraint. The constraint will be enforced at the application level.
ALTER TABLE entities ADD COLUMN acl_id INTEGER;
ALTER TABLE links ADD COLUMN acl_id INTEGER;

-- Create indexes on acl_id for efficient ACL-based filtering
CREATE INDEX idx_entities_acl_id ON entities(acl_id);
CREATE INDEX idx_links_acl_id ON links(acl_id);
