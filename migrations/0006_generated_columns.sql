-- Generated columns for JSON property indexing
-- Migration: 0006_generated_columns.sql
--
-- This migration creates:
-- 1. A metadata table to track which generated columns exist
-- 2. Generated columns for frequently queried JSON properties
-- 3. Indexes on the generated columns for improved query performance
--
-- SQLite generated columns can be STORED (persisted to disk) or VIRTUAL (computed at query time).
-- We use STORED columns for indexed properties to enable efficient B-tree index lookups.
--
-- Note: SQLite has limitations on ALTER TABLE for adding generated columns after table creation.
-- The workaround is to create new tables and migrate data, which is what this migration does.

-- Disable foreign key constraints during migration to avoid constraint violations
PRAGMA foreign_keys = OFF;

-- ============================================================================
-- Metadata table to track generated columns
-- ============================================================================

CREATE TABLE IF NOT EXISTS generated_columns (
  id TEXT PRIMARY KEY,
  table_name TEXT NOT NULL CHECK(table_name IN ('entities', 'links')),
  column_name TEXT NOT NULL,
  json_path TEXT NOT NULL,
  data_type TEXT NOT NULL CHECK(data_type IN ('TEXT', 'INTEGER', 'REAL', 'BOOLEAN')),
  is_indexed INTEGER DEFAULT 1 CHECK(is_indexed IN (0, 1)),
  created_at INTEGER NOT NULL,
  created_by TEXT,
  description TEXT,
  UNIQUE(table_name, column_name),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX idx_generated_columns_table ON generated_columns(table_name);

-- ============================================================================
-- Create new entities table with generated columns
-- ============================================================================

-- Step 1: Create new entities table with generated columns
CREATE TABLE entities_new (
  id TEXT PRIMARY KEY,
  type_id TEXT NOT NULL,
  properties TEXT,
  version INTEGER NOT NULL CHECK(version > 0),
  previous_version_id TEXT,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  is_deleted INTEGER DEFAULT 0 CHECK(is_deleted IN (0, 1)),
  is_latest INTEGER DEFAULT 1 CHECK(is_latest IN (0, 1)),
  -- Generated columns for frequently queried properties
  -- These are STORED (persisted) to allow efficient indexing
  prop_name TEXT GENERATED ALWAYS AS (json_extract(properties, '$.name')) STORED,
  prop_status TEXT GENERATED ALWAYS AS (json_extract(properties, '$.status')) STORED,
  prop_email TEXT GENERATED ALWAYS AS (json_extract(properties, '$.email')) STORED,
  FOREIGN KEY (type_id) REFERENCES types(id),
  FOREIGN KEY (previous_version_id) REFERENCES entities_new(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- Step 2: Copy data from old table to new table
INSERT INTO entities_new (id, type_id, properties, version, previous_version_id, created_at, created_by, is_deleted, is_latest)
SELECT id, type_id, properties, version, previous_version_id, created_at, created_by, is_deleted, is_latest
FROM entities;

-- Step 3: Drop old table
DROP TABLE entities;

-- Step 4: Rename new table to original name
ALTER TABLE entities_new RENAME TO entities;

-- Step 5: Recreate indexes (including new ones on generated columns)
CREATE INDEX idx_entities_type_latest_deleted ON entities(type_id, is_latest, is_deleted);
CREATE INDEX idx_entities_created_by ON entities(created_by);
CREATE INDEX idx_entities_created_at ON entities(created_at);

-- New indexes on generated columns
CREATE INDEX idx_entities_prop_name ON entities(prop_name) WHERE prop_name IS NOT NULL;
CREATE INDEX idx_entities_prop_status ON entities(prop_status) WHERE prop_status IS NOT NULL;
CREATE INDEX idx_entities_prop_email ON entities(prop_email) WHERE prop_email IS NOT NULL;

-- Composite indexes for common query patterns
CREATE INDEX idx_entities_type_name ON entities(type_id, prop_name) WHERE is_latest = 1 AND is_deleted = 0;
CREATE INDEX idx_entities_type_status ON entities(type_id, prop_status) WHERE is_latest = 1 AND is_deleted = 0;

-- Step 6: Recreate triggers
DROP TRIGGER IF EXISTS entities_auto_version;
CREATE TRIGGER entities_auto_version
AFTER INSERT ON entities
FOR EACH ROW
WHEN NEW.version IS NULL OR NEW.version = 0
BEGIN
  UPDATE entities
  SET version = CASE
    WHEN NEW.previous_version_id IS NULL THEN 1
    ELSE (SELECT version + 1 FROM entities WHERE id = NEW.previous_version_id)
  END
  WHERE id = NEW.id;
END;

DROP TRIGGER IF EXISTS entities_update_is_latest;
CREATE TRIGGER entities_update_is_latest
AFTER INSERT ON entities
FOR EACH ROW
WHEN NEW.previous_version_id IS NOT NULL
BEGIN
  UPDATE entities
  SET is_latest = 0
  WHERE id = NEW.previous_version_id;
END;

-- ============================================================================
-- Create new links table with generated columns
-- ============================================================================

-- Step 1: Create new links table with generated columns
CREATE TABLE links_new (
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
  -- Generated columns for frequently queried link properties
  prop_role TEXT GENERATED ALWAYS AS (json_extract(properties, '$.role')) STORED,
  prop_weight REAL GENERATED ALWAYS AS (CAST(json_extract(properties, '$.weight') AS REAL)) STORED,
  FOREIGN KEY (type_id) REFERENCES types(id),
  FOREIGN KEY (source_entity_id) REFERENCES entities(id),
  FOREIGN KEY (target_entity_id) REFERENCES entities(id),
  FOREIGN KEY (previous_version_id) REFERENCES links_new(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- Step 2: Copy data from old table to new table
INSERT INTO links_new (id, type_id, source_entity_id, target_entity_id, properties, version, previous_version_id, created_at, created_by, is_deleted, is_latest)
SELECT id, type_id, source_entity_id, target_entity_id, properties, version, previous_version_id, created_at, created_by, is_deleted, is_latest
FROM links;

-- Step 3: Drop old table
DROP TABLE links;

-- Step 4: Rename new table to original name
ALTER TABLE links_new RENAME TO links;

-- Step 5: Recreate indexes (including new ones on generated columns)
CREATE INDEX idx_links_source_latest_deleted ON links(source_entity_id, is_latest, is_deleted);
CREATE INDEX idx_links_target_latest_deleted ON links(target_entity_id, is_latest, is_deleted);
CREATE INDEX idx_links_type ON links(type_id);
CREATE INDEX idx_links_created_by ON links(created_by);
CREATE INDEX idx_links_created_at ON links(created_at);

-- New indexes on generated columns
CREATE INDEX idx_links_prop_role ON links(prop_role) WHERE prop_role IS NOT NULL;
CREATE INDEX idx_links_prop_weight ON links(prop_weight) WHERE prop_weight IS NOT NULL;

-- Composite indexes for common query patterns
CREATE INDEX idx_links_type_role ON links(type_id, prop_role) WHERE is_latest = 1 AND is_deleted = 0;

-- Step 6: Recreate triggers
DROP TRIGGER IF EXISTS links_auto_version;
CREATE TRIGGER links_auto_version
AFTER INSERT ON links
FOR EACH ROW
WHEN NEW.version IS NULL OR NEW.version = 0
BEGIN
  UPDATE links
  SET version = CASE
    WHEN NEW.previous_version_id IS NULL THEN 1
    ELSE (SELECT version + 1 FROM links WHERE id = NEW.previous_version_id)
  END
  WHERE id = NEW.id;
END;

DROP TRIGGER IF EXISTS links_update_is_latest;
CREATE TRIGGER links_update_is_latest
AFTER INSERT ON links
FOR EACH ROW
WHEN NEW.previous_version_id IS NOT NULL
BEGIN
  UPDATE links
  SET is_latest = 0
  WHERE id = NEW.previous_version_id;
END;

-- ============================================================================
-- Register the generated columns in metadata
-- ============================================================================

INSERT INTO generated_columns (id, table_name, column_name, json_path, data_type, is_indexed, created_at, created_by, description)
VALUES
  ('gc-entities-name', 'entities', 'prop_name', '$.name', 'TEXT', 1, strftime('%s', 'now'), NULL, 'Entity name property - commonly used for display and search'),
  ('gc-entities-status', 'entities', 'prop_status', '$.status', 'TEXT', 1, strftime('%s', 'now'), NULL, 'Entity status property - commonly used for filtering'),
  ('gc-entities-email', 'entities', 'prop_email', '$.email', 'TEXT', 1, strftime('%s', 'now'), NULL, 'Entity email property - commonly used for user lookup'),
  ('gc-links-role', 'links', 'prop_role', '$.role', 'TEXT', 1, strftime('%s', 'now'), NULL, 'Link role property - commonly used for relationship filtering'),
  ('gc-links-weight', 'links', 'prop_weight', '$.weight', 'REAL', 1, strftime('%s', 'now'), NULL, 'Link weight property - commonly used for weighted graph operations');

-- Re-enable foreign key constraints
PRAGMA foreign_keys = ON;
