-- Add admin_role_change operation type to audit_logs
-- Migration: 0009_audit_admin_role_change.sql
--
-- SQLite doesn't support ALTER CHECK constraint, so we need to recreate the table

-- Step 1: Create new table with updated constraint
CREATE TABLE audit_logs_new (
  id TEXT PRIMARY KEY,
  operation TEXT NOT NULL CHECK(operation IN ('create', 'update', 'delete', 'restore', 'admin_role_change')),
  resource_type TEXT NOT NULL CHECK(resource_type IN ('entity', 'link', 'type', 'user')),
  resource_id TEXT NOT NULL,
  user_id TEXT,
  timestamp INTEGER NOT NULL,
  details TEXT, -- JSON stored as TEXT containing operation-specific details
  ip_address TEXT,
  user_agent TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Step 2: Copy existing data
INSERT INTO audit_logs_new SELECT * FROM audit_logs;

-- Step 3: Drop old table
DROP TABLE audit_logs;

-- Step 4: Rename new table
ALTER TABLE audit_logs_new RENAME TO audit_logs;

-- Step 5: Recreate indexes
CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_resource ON audit_logs(resource_type, resource_id);
CREATE INDEX idx_audit_logs_timestamp ON audit_logs(timestamp);
CREATE INDEX idx_audit_logs_operation ON audit_logs(operation);
