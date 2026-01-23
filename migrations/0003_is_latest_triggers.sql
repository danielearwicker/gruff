-- is_latest flag management triggers
-- Migration: 0003_is_latest_triggers.sql
--
-- These triggers automatically set is_latest = false on the previous version
-- when a new version is created (i.e., when previous_version_id is set).
--
-- Logic:
-- - When inserting a new entity/link with a previous_version_id:
--   - Set is_latest = false on the previous version
--   - The new version defaults to is_latest = true (per schema default)
--
-- This ensures that only the most recent version of each entity/link
-- is marked as is_latest = true, which optimizes queries for current state.

-- Trigger for entities: mark previous version as not latest
CREATE TRIGGER IF NOT EXISTS entities_update_is_latest
AFTER INSERT ON entities
FOR EACH ROW
WHEN NEW.previous_version_id IS NOT NULL
BEGIN
  UPDATE entities
  SET is_latest = 0
  WHERE id = NEW.previous_version_id;
END;

-- Trigger for links: mark previous version as not latest
CREATE TRIGGER IF NOT EXISTS links_update_is_latest
AFTER INSERT ON links
FOR EACH ROW
WHEN NEW.previous_version_id IS NOT NULL
BEGIN
  UPDATE links
  SET is_latest = 0
  WHERE id = NEW.previous_version_id;
END;
