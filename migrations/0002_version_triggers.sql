-- Auto-increment version triggers
-- Migration: 0002_version_triggers.sql
--
-- These triggers automatically set the version field when inserting entities or links
-- if the version is not explicitly provided (NULL or 0).
--
-- Logic:
-- - If previous_version_id IS NULL: version = 1 (first version)
-- - If previous_version_id IS NOT NULL: version = previous_version.version + 1

-- Trigger for entities: auto-increment version on insert
CREATE TRIGGER IF NOT EXISTS entities_auto_version
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

-- Trigger for links: auto-increment version on insert
CREATE TRIGGER IF NOT EXISTS links_auto_version
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
