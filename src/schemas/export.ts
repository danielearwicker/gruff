import { z } from 'zod';
import {
  uuidSchema,
  typeIdSchema,
  jsonPropertiesSchema,
  sanitizedJsonPropertiesSchema,
  timestampSchema,
} from './common.js';
import { escapeHtml } from '../utils/sanitize.js';

// Maximum number of items in a single export (to prevent abuse and memory issues)
export const MAX_EXPORT_ITEMS = 1000;

// Maximum number of items in a single import (to prevent abuse and stay within D1 limits)
export const MAX_IMPORT_ITEMS = 100;

// Schema for export query parameters
export const exportQuerySchema = z.object({
  // Filter by entity type IDs
  type_ids: z
    .string()
    .optional()
    .transform(val => (val ? val.split(',').filter(id => id.trim()) : undefined)),
  // Filter by creation date range
  created_after: z
    .string()
    .optional()
    .transform(val => (val ? parseInt(val, 10) : undefined))
    .pipe(z.number().int().positive().optional()),
  created_before: z
    .string()
    .optional()
    .transform(val => (val ? parseInt(val, 10) : undefined))
    .pipe(z.number().int().positive().optional()),
  // Include soft-deleted items
  include_deleted: z
    .string()
    .optional()
    .default('false')
    .transform(val => val === 'true')
    .pipe(z.boolean()),
  // Include version history
  include_versions: z
    .string()
    .optional()
    .default('false')
    .transform(val => val === 'true')
    .pipe(z.boolean()),
  // Pagination limit
  limit: z
    .string()
    .optional()
    .default(String(MAX_EXPORT_ITEMS))
    .transform(val => parseInt(val, 10))
    .pipe(z.number().int().min(1).max(MAX_EXPORT_ITEMS)),
});

// Schema for a single exported entity (full data for portability)
export const exportedEntitySchema = z.object({
  id: uuidSchema,
  type_id: typeIdSchema,
  type_name: z.string().optional(), // Resolved type name for readability
  properties: jsonPropertiesSchema,
  version: z.number().int().positive(),
  previous_version_id: uuidSchema.nullable(),
  created_at: timestampSchema,
  created_by: uuidSchema.nullable(),
  is_deleted: z.union([z.literal(0), z.literal(1)]),
  is_latest: z.union([z.literal(0), z.literal(1)]),
});

// Schema for a single exported link (full data for portability)
export const exportedLinkSchema = z.object({
  id: uuidSchema,
  type_id: typeIdSchema,
  type_name: z.string().optional(), // Resolved type name for readability
  source_entity_id: uuidSchema,
  target_entity_id: uuidSchema,
  properties: jsonPropertiesSchema,
  version: z.number().int().positive(),
  previous_version_id: uuidSchema.nullable(),
  created_at: timestampSchema,
  created_by: uuidSchema.nullable(),
  is_deleted: z.union([z.literal(0), z.literal(1)]),
  is_latest: z.union([z.literal(0), z.literal(1)]),
});

// Schema for a single exported type
export const exportedTypeSchema = z.object({
  id: typeIdSchema,
  name: z.string(),
  category: z.enum(['entity', 'link']),
  description: z.string().nullable(),
  json_schema: z.string().nullable(), // JSON schema stored as string
  created_at: timestampSchema,
  created_by: uuidSchema.nullable(),
});

// Schema for export response
export const exportResponseSchema = z.object({
  format_version: z.literal('1.0'),
  exported_at: z.string(), // ISO timestamp
  types: z.array(exportedTypeSchema),
  entities: z.array(exportedEntitySchema),
  links: z.array(exportedLinkSchema),
  metadata: z.object({
    entity_count: z.number().int().min(0),
    link_count: z.number().int().min(0),
    type_count: z.number().int().min(0),
    include_deleted: z.boolean(),
    include_versions: z.boolean(),
  }),
});

// Schema for a single entity in import request (with sanitization for XSS prevention)
export const importEntityItemSchema = z
  .object({
    // Client-provided ID for cross-reference (will be mapped to new IDs)
    client_id: z.string(),
    // Type can be specified by ID (for existing types) or name (for included types)
    type_id: typeIdSchema.optional(),
    type_name: z.string().optional(),
    properties: sanitizedJsonPropertiesSchema.optional().default({}),
  })
  .refine(data => data.type_id || data.type_name, {
    message: 'Either type_id or type_name must be provided',
  });

// Schema for a single link in import request (with sanitization for XSS prevention)
export const importLinkItemSchema = z
  .object({
    // Client-provided ID for cross-reference
    client_id: z.string().optional(),
    // Type can be specified by ID or name
    type_id: typeIdSchema.optional(),
    type_name: z.string().optional(),
    // Source and target can reference client_ids from the import or existing entity IDs
    source_entity_client_id: z.string().optional(),
    source_entity_id: uuidSchema.optional(),
    target_entity_client_id: z.string().optional(),
    target_entity_id: uuidSchema.optional(),
    properties: sanitizedJsonPropertiesSchema.optional().default({}),
  })
  .refine(data => data.type_id || data.type_name, {
    message: 'Either type_id or type_name must be provided',
  })
  .refine(data => data.source_entity_client_id || data.source_entity_id, {
    message: 'Either source_entity_client_id or source_entity_id must be provided',
  })
  .refine(data => data.target_entity_client_id || data.target_entity_id, {
    message: 'Either target_entity_client_id or target_entity_id must be provided',
  });

// Schema for type in import request (with sanitization for XSS prevention)
export const importTypeItemSchema = z.object({
  // Client-provided ID or name for cross-reference
  client_id: z.string().optional(),
  name: z
    .string()
    .min(1)
    .transform(val => escapeHtml(val)),
  category: z.enum(['entity', 'link']),
  description: z
    .string()
    .transform(val => escapeHtml(val))
    .optional(),
  json_schema: z.string().optional(), // JSON schema stored as string
});

// Schema for import request body
export const importRequestSchema = z
  .object({
    // Optional types to create (useful for importing a complete subgraph)
    types: z.array(importTypeItemSchema).optional().default([]),
    // Entities to import
    entities: z
      .array(importEntityItemSchema)
      .min(0)
      .max(MAX_IMPORT_ITEMS, `Maximum ${MAX_IMPORT_ITEMS} entities per import request`),
    // Links to import
    links: z
      .array(importLinkItemSchema)
      .min(0)
      .max(MAX_IMPORT_ITEMS, `Maximum ${MAX_IMPORT_ITEMS} links per import request`),
  })
  .refine(data => data.entities.length > 0 || data.links.length > 0 || data.types.length > 0, {
    message: 'At least one type, entity, or link is required for import',
  });

// Result item for import operations
export const importResultItemSchema = z.object({
  client_id: z.string().optional(),
  success: z.boolean(),
  id: uuidSchema.optional(), // New ID assigned on import
  error: z.string().optional(),
  code: z.string().optional(),
});

// Schema for import response
export const importResponseSchema = z.object({
  type_results: z.array(importResultItemSchema),
  entity_results: z.array(importResultItemSchema),
  link_results: z.array(importResultItemSchema),
  id_mapping: z.object({
    types: z.record(z.string(), uuidSchema), // client_id/name -> new_id
    entities: z.record(z.string(), uuidSchema), // client_id -> new_id
    links: z.record(z.string(), uuidSchema), // client_id -> new_id
  }),
  summary: z.object({
    types: z.object({
      total: z.number().int().min(0),
      successful: z.number().int().min(0),
      failed: z.number().int().min(0),
    }),
    entities: z.object({
      total: z.number().int().min(0),
      successful: z.number().int().min(0),
      failed: z.number().int().min(0),
    }),
    links: z.object({
      total: z.number().int().min(0),
      successful: z.number().int().min(0),
      failed: z.number().int().min(0),
    }),
  }),
});

// Types derived from schemas
export type ExportQuery = z.infer<typeof exportQuerySchema>;
export type ExportedEntity = z.infer<typeof exportedEntitySchema>;
export type ExportedLink = z.infer<typeof exportedLinkSchema>;
export type ExportedType = z.infer<typeof exportedTypeSchema>;
export type ExportResponse = z.infer<typeof exportResponseSchema>;
export type ImportEntityItem = z.infer<typeof importEntityItemSchema>;
export type ImportLinkItem = z.infer<typeof importLinkItemSchema>;
export type ImportTypeItem = z.infer<typeof importTypeItemSchema>;
export type ImportRequest = z.infer<typeof importRequestSchema>;
export type ImportResultItem = z.infer<typeof importResultItemSchema>;
export type ImportResponse = z.infer<typeof importResponseSchema>;
