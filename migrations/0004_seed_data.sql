-- Seed data for local development
-- Migration: 0004_seed_data.sql
--
-- This file provides sample data for testing and development purposes.
-- It creates:
-- - A test user
-- - Sample entity and link types
-- - Sample entities and links demonstrating the graph structure

-- Create a test user
INSERT INTO users (id, email, display_name, provider, provider_id, password_hash, created_at, updated_at, is_active)
VALUES (
  'test-user-001',
  'test@example.com',
  'Test User',
  'local',
  NULL,
  -- This is a placeholder password hash (not a real hash)
  -- In production, use proper password hashing
  '$argon2id$v=19$m=65536,t=3,p=4$placeholder',
  strftime('%s', 'now'),
  strftime('%s', 'now'),
  1
);

-- Create sample entity types
INSERT INTO types (id, name, category, description, json_schema, created_at, created_by)
VALUES
  (
    'type-person',
    'Person',
    'entity',
    'Represents a person in the graph',
    '{"type":"object","properties":{"name":{"type":"string"},"age":{"type":"number"},"email":{"type":"string"}},"required":["name"]}',
    strftime('%s', 'now'),
    'test-user-001'
  ),
  (
    'type-organization',
    'Organization',
    'entity',
    'Represents an organization in the graph',
    '{"type":"object","properties":{"name":{"type":"string"},"industry":{"type":"string"},"founded":{"type":"number"}},"required":["name"]}',
    strftime('%s', 'now'),
    'test-user-001'
  ),
  (
    'type-project',
    'Project',
    'entity',
    'Represents a project in the graph',
    '{"type":"object","properties":{"name":{"type":"string"},"status":{"type":"string","enum":["active","completed","archived"]},"description":{"type":"string"}},"required":["name","status"]}',
    strftime('%s', 'now'),
    'test-user-001'
  );

-- Create sample link types
INSERT INTO types (id, name, category, description, json_schema, created_at, created_by)
VALUES
  (
    'type-works-for',
    'WorksFor',
    'link',
    'Represents an employment relationship',
    '{"type":"object","properties":{"role":{"type":"string"},"start_date":{"type":"string"},"end_date":{"type":"string"}}}',
    strftime('%s', 'now'),
    'test-user-001'
  ),
  (
    'type-manages',
    'Manages',
    'link',
    'Represents a management relationship',
    '{"type":"object","properties":{"since":{"type":"string"}}}',
    strftime('%s', 'now'),
    'test-user-001'
  ),
  (
    'type-contributes-to',
    'ContributesTo',
    'link',
    'Represents a contribution relationship to a project',
    '{"type":"object","properties":{"role":{"type":"string"},"hours_per_week":{"type":"number"}}}',
    strftime('%s', 'now'),
    'test-user-001'
  );

-- Create sample entities (people)
INSERT INTO entities (id, type_id, properties, version, previous_version_id, created_at, created_by, is_deleted, is_latest)
VALUES
  (
    'entity-alice',
    'type-person',
    '{"name":"Alice Johnson","age":32,"email":"alice@example.com"}',
    1,
    NULL,
    strftime('%s', 'now'),
    'test-user-001',
    0,
    1
  ),
  (
    'entity-bob',
    'type-person',
    '{"name":"Bob Smith","age":28,"email":"bob@example.com"}',
    1,
    NULL,
    strftime('%s', 'now'),
    'test-user-001',
    0,
    1
  ),
  (
    'entity-carol',
    'type-person',
    '{"name":"Carol Williams","age":45,"email":"carol@example.com"}',
    1,
    NULL,
    strftime('%s', 'now'),
    'test-user-001',
    0,
    1
  );

-- Create sample entities (organizations)
INSERT INTO entities (id, type_id, properties, version, previous_version_id, created_at, created_by, is_deleted, is_latest)
VALUES
  (
    'entity-acme-corp',
    'type-organization',
    '{"name":"Acme Corporation","industry":"Technology","founded":2015}',
    1,
    NULL,
    strftime('%s', 'now'),
    'test-user-001',
    0,
    1
  ),
  (
    'entity-techstart',
    'type-organization',
    '{"name":"TechStart Inc","industry":"Software","founded":2020}',
    1,
    NULL,
    strftime('%s', 'now'),
    'test-user-001',
    0,
    1
  );

-- Create sample entities (projects)
INSERT INTO entities (id, type_id, properties, version, previous_version_id, created_at, created_by, is_deleted, is_latest)
VALUES
  (
    'entity-project-alpha',
    'type-project',
    '{"name":"Project Alpha","status":"active","description":"Revolutionary AI platform"}',
    1,
    NULL,
    strftime('%s', 'now'),
    'test-user-001',
    0,
    1
  ),
  (
    'entity-project-beta',
    'type-project',
    '{"name":"Project Beta","status":"completed","description":"Mobile app development"}',
    1,
    NULL,
    strftime('%s', 'now'),
    'test-user-001',
    0,
    1
  );

-- Create sample links (employment relationships)
INSERT INTO links (id, type_id, source_entity_id, target_entity_id, properties, version, previous_version_id, created_at, created_by, is_deleted, is_latest)
VALUES
  (
    'link-alice-acme',
    'type-works-for',
    'entity-alice',
    'entity-acme-corp',
    '{"role":"Senior Engineer","start_date":"2020-01-15"}',
    1,
    NULL,
    strftime('%s', 'now'),
    'test-user-001',
    0,
    1
  ),
  (
    'link-bob-acme',
    'type-works-for',
    'entity-bob',
    'entity-acme-corp',
    '{"role":"Software Developer","start_date":"2021-06-01"}',
    1,
    NULL,
    strftime('%s', 'now'),
    'test-user-001',
    0,
    1
  ),
  (
    'link-carol-techstart',
    'type-works-for',
    'entity-carol',
    'entity-techstart',
    '{"role":"CTO","start_date":"2020-03-01"}',
    1,
    NULL,
    strftime('%s', 'now'),
    'test-user-001',
    0,
    1
  );

-- Create sample links (management relationships)
INSERT INTO links (id, type_id, source_entity_id, target_entity_id, properties, version, previous_version_id, created_at, created_by, is_deleted, is_latest)
VALUES
  (
    'link-alice-manages-bob',
    'type-manages',
    'entity-alice',
    'entity-bob',
    '{"since":"2022-01-01"}',
    1,
    NULL,
    strftime('%s', 'now'),
    'test-user-001',
    0,
    1
  );

-- Create sample links (project contributions)
INSERT INTO links (id, type_id, source_entity_id, target_entity_id, properties, version, previous_version_id, created_at, created_by, is_deleted, is_latest)
VALUES
  (
    'link-alice-project-alpha',
    'type-contributes-to',
    'entity-alice',
    'entity-project-alpha',
    '{"role":"Lead Developer","hours_per_week":40}',
    1,
    NULL,
    strftime('%s', 'now'),
    'test-user-001',
    0,
    1
  ),
  (
    'link-bob-project-alpha',
    'type-contributes-to',
    'entity-bob',
    'entity-project-alpha',
    '{"role":"Developer","hours_per_week":40}',
    1,
    NULL,
    strftime('%s', 'now'),
    'test-user-001',
    0,
    1
  ),
  (
    'link-carol-project-beta',
    'type-contributes-to',
    'entity-carol',
    'entity-project-beta',
    '{"role":"Technical Advisor","hours_per_week":10}',
    1,
    NULL,
    strftime('%s', 'now'),
    'test-user-001',
    0,
    1
  );
