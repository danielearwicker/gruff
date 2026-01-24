-- Audit logging table for tracking all operations
-- Migration: 0005_audit_logs.sql

-- Audit logs table
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  operation TEXT NOT NULL CHECK(operation IN ('create', 'update', 'delete', 'restore')),
  resource_type TEXT NOT NULL CHECK(resource_type IN ('entity', 'link', 'type', 'user')),
  resource_id TEXT NOT NULL,
  user_id TEXT,
  timestamp INTEGER NOT NULL,
  details TEXT, -- JSON stored as TEXT containing operation-specific details
  ip_address TEXT,
  user_agent TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Indexes for common query patterns
CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_resource ON audit_logs(resource_type, resource_id);
CREATE INDEX idx_audit_logs_timestamp ON audit_logs(timestamp);
CREATE INDEX idx_audit_logs_operation ON audit_logs(operation);
