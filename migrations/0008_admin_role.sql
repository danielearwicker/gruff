-- Add admin role to users table
-- Migration: 0008_admin_role.sql

-- Add is_admin column to users table
-- Default is 0 (non-admin), 1 means admin
ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0 CHECK(is_admin IN (0, 1));

-- Create index for efficient admin lookups
CREATE INDEX idx_users_is_admin ON users(is_admin);

-- Make the test-user-001 an admin for backward compatibility
UPDATE users SET is_admin = 1 WHERE id = 'test-user-001';
