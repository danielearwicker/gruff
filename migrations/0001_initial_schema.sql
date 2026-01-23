-- Initial schema for Gruff graph database
-- Migration: 0001_initial_schema.sql

-- Enable foreign key constraints
PRAGMA foreign_keys = ON;

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT,
  provider TEXT,
  provider_id TEXT,
  password_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  is_active INTEGER DEFAULT 1 CHECK(is_active IN (0, 1))
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_provider ON users(provider, provider_id);

-- Types table
CREATE TABLE IF NOT EXISTS types (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('entity', 'link')),
  description TEXT,
  json_schema TEXT,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX idx_types_name ON types(name);
CREATE INDEX idx_types_category ON types(category);

-- Entities table
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  type_id TEXT NOT NULL,
  properties TEXT,
  version INTEGER NOT NULL CHECK(version > 0),
  previous_version_id TEXT,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  is_deleted INTEGER DEFAULT 0 CHECK(is_deleted IN (0, 1)),
  is_latest INTEGER DEFAULT 1 CHECK(is_latest IN (0, 1)),
  FOREIGN KEY (type_id) REFERENCES types(id),
  FOREIGN KEY (previous_version_id) REFERENCES entities(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX idx_entities_type_latest_deleted ON entities(type_id, is_latest, is_deleted);
CREATE INDEX idx_entities_created_by ON entities(created_by);
CREATE INDEX idx_entities_created_at ON entities(created_at);

-- Links table
CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY,
  type_id TEXT NOT NULL,
  source_entity_id TEXT NOT NULL,
  target_entity_id TEXT NOT NULL,
  properties TEXT,
  version INTEGER NOT NULL CHECK(version > 0),
  previous_version_id TEXT,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  is_deleted INTEGER DEFAULT 0 CHECK(is_deleted IN (0, 1)),
  is_latest INTEGER DEFAULT 1 CHECK(is_latest IN (0, 1)),
  FOREIGN KEY (type_id) REFERENCES types(id),
  FOREIGN KEY (source_entity_id) REFERENCES entities(id),
  FOREIGN KEY (target_entity_id) REFERENCES entities(id),
  FOREIGN KEY (previous_version_id) REFERENCES links(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX idx_links_source_latest_deleted ON links(source_entity_id, is_latest, is_deleted);
CREATE INDEX idx_links_target_latest_deleted ON links(target_entity_id, is_latest, is_deleted);
CREATE INDEX idx_links_type ON links(type_id);
CREATE INDEX idx_links_created_by ON links(created_by);
CREATE INDEX idx_links_created_at ON links(created_at);
