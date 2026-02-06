import { z } from '@hono/zod-openapi';
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
    .openapi({
      param: { name: 'type_ids', in: 'query' },
      description: 'Comma-separated list of type IDs to filter by',
      example: 'Person,Organization',
    })
    .transform(val => (val ? val.split(',').filter(id => id.trim()) : undefined)),
  // Filter by creation date range
  created_after: z
    .string()
    .optional()
    .openapi({
      param: { name: 'created_after', in: 'query' },
      description: 'Unix timestamp - only include items created after this time',
      example: '1700000000',
    })
    .transform(val => (val ? parseInt(val, 10) : undefined))
    .pipe(z.number().int().positive().optional()),
  created_before: z
    .string()
    .optional()
    .openapi({
      param: { name: 'created_before', in: 'query' },
      description: 'Unix timestamp - only include items created before this time',
      example: '1710000000',
    })
    .transform(val => (val ? parseInt(val, 10) : undefined))
    .pipe(z.number().int().positive().optional()),
  // Include soft-deleted items
  include_deleted: z
    .string()
    .optional()
    .default('false')
    .openapi({
      param: { name: 'include_deleted', in: 'query' },
      description: 'Include soft-deleted items in export (default: false)',
      example: 'false',
    })
    .transform(val => val === 'true')
    .pipe(z.boolean()),
  // Include version history
  include_versions: z
    .string()
    .optional()
    .default('false')
    .openapi({
      param: { name: 'include_versions', in: 'query' },
      description: 'Include version history in export (default: false)',
      example: 'false',
    })
    .transform(val => val === 'true')
    .pipe(z.boolean()),
  // Pagination limit
  limit: z
    .string()
    .optional()
    .default(String(MAX_EXPORT_ITEMS))
    .openapi({
      param: { name: 'limit', in: 'query' },
      description: `Maximum number of items to export (1-${MAX_EXPORT_ITEMS}, default: ${MAX_EXPORT_ITEMS})`,
      example: '100',
    })
    .transform(val => parseInt(val, 10))
    .pipe(z.number().int().min(1).max(MAX_EXPORT_ITEMS)),
});

// Schema for a single exported entity (full data for portability)
export const exportedEntitySchema = z
  .object({
    id: uuidSchema.openapi({ example: '550e8400-e29b-41d4-a716-446655440000' }),
    type_id: typeIdSchema.openapi({ example: 'Person' }),
    type_name: z.string().optional().openapi({ example: 'Person' }),
    properties: jsonPropertiesSchema.openapi({ example: { name: 'John Doe', age: 30 } }),
    version: z.number().int().positive().openapi({ example: 1 }),
    previous_version_id: uuidSchema.nullable().openapi({ example: null }),
    created_at: timestampSchema.openapi({ example: 1700000000 }),
    created_by: uuidSchema.nullable().openapi({ example: '550e8400-e29b-41d4-a716-446655440001' }),
    is_deleted: z.union([z.literal(0), z.literal(1)]).openapi({ example: 0 }),
    is_latest: z.union([z.literal(0), z.literal(1)]).openapi({ example: 1 }),
  })
  .openapi('ExportedEntity');

// Schema for a single exported link (full data for portability)
export const exportedLinkSchema = z
  .object({
    id: uuidSchema.openapi({ example: '660e8400-e29b-41d4-a716-446655440000' }),
    type_id: typeIdSchema.openapi({ example: 'knows' }),
    type_name: z.string().optional().openapi({ example: 'knows' }),
    source_entity_id: uuidSchema.openapi({ example: '550e8400-e29b-41d4-a716-446655440000' }),
    target_entity_id: uuidSchema.openapi({ example: '550e8400-e29b-41d4-a716-446655440001' }),
    properties: jsonPropertiesSchema.openapi({ example: { since: '2024-01-01' } }),
    version: z.number().int().positive().openapi({ example: 1 }),
    previous_version_id: uuidSchema.nullable().openapi({ example: null }),
    created_at: timestampSchema.openapi({ example: 1700000000 }),
    created_by: uuidSchema.nullable().openapi({ example: '550e8400-e29b-41d4-a716-446655440001' }),
    is_deleted: z.union([z.literal(0), z.literal(1)]).openapi({ example: 0 }),
    is_latest: z.union([z.literal(0), z.literal(1)]).openapi({ example: 1 }),
  })
  .openapi('ExportedLink');

// Schema for a single exported type
export const exportedTypeSchema = z
  .object({
    id: typeIdSchema.openapi({ example: 'Person' }),
    name: z.string().openapi({ example: 'Person' }),
    category: z.enum(['entity', 'link']).openapi({ example: 'entity' }),
    description: z.string().nullable().openapi({ example: 'A person entity type' }),
    json_schema: z.string().nullable().openapi({ example: null }),
    created_at: timestampSchema.openapi({ example: 1700000000 }),
    created_by: uuidSchema.nullable().openapi({ example: '550e8400-e29b-41d4-a716-446655440001' }),
  })
  .openapi('ExportedType');

// Schema for export metadata
export const exportMetadataSchema = z
  .object({
    entity_count: z.number().int().min(0).openapi({ example: 10 }),
    link_count: z.number().int().min(0).openapi({ example: 5 }),
    type_count: z.number().int().min(0).openapi({ example: 3 }),
    include_deleted: z.boolean().openapi({ example: false }),
    include_versions: z.boolean().openapi({ example: false }),
  })
  .openapi('ExportMetadata');

// Schema for export response
export const exportResponseSchema = z
  .object({
    format_version: z.literal('1.0').openapi({ example: '1.0' }),
    exported_at: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
    types: z.array(exportedTypeSchema),
    entities: z.array(exportedEntitySchema),
    links: z.array(exportedLinkSchema),
    metadata: exportMetadataSchema,
  })
  .openapi('ExportResponse');

// Schema for a single entity in import request (with sanitization for XSS prevention)
export const importEntityItemSchema = z
  .object({
    // Client-provided ID for cross-reference (will be mapped to new IDs)
    client_id: z.string().openapi({
      description: 'Client-provided ID for cross-reference (mapped to new server IDs)',
      example: 'entity-1',
    }),
    // Type can be specified by ID (for existing types) or name (for included types)
    type_id: typeIdSchema.optional().openapi({ example: 'Person' }),
    type_name: z.string().optional().openapi({ example: 'Person' }),
    properties: sanitizedJsonPropertiesSchema
      .optional()
      .default({})
      .openapi({ example: { name: 'John Doe', age: 30 } }),
  })
  .refine(data => data.type_id || data.type_name, {
    message: 'Either type_id or type_name must be provided',
  });

// Schema for a single link in import request (with sanitization for XSS prevention)
export const importLinkItemSchema = z
  .object({
    // Client-provided ID for cross-reference
    client_id: z.string().optional().openapi({
      description: 'Client-provided ID for cross-reference',
      example: 'link-1',
    }),
    // Type can be specified by ID or name
    type_id: typeIdSchema.optional().openapi({ example: 'knows' }),
    type_name: z.string().optional().openapi({ example: 'knows' }),
    // Source and target can reference client_ids from the import or existing entity IDs
    source_entity_client_id: z.string().optional().openapi({
      description: 'Client ID of source entity from this import batch',
      example: 'entity-1',
    }),
    source_entity_id: uuidSchema.optional().openapi({
      description: 'UUID of an existing source entity',
      example: '550e8400-e29b-41d4-a716-446655440000',
    }),
    target_entity_client_id: z.string().optional().openapi({
      description: 'Client ID of target entity from this import batch',
      example: 'entity-2',
    }),
    target_entity_id: uuidSchema.optional().openapi({
      description: 'UUID of an existing target entity',
      example: '550e8400-e29b-41d4-a716-446655440001',
    }),
    properties: sanitizedJsonPropertiesSchema
      .optional()
      .default({})
      .openapi({ example: { since: '2024-01-01' } }),
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
export const importTypeItemSchema = z
  .object({
    // Client-provided ID or name for cross-reference
    client_id: z.string().optional().openapi({
      description: 'Client-provided ID for cross-reference',
      example: 'type-1',
    }),
    name: z
      .string()
      .min(1)
      .openapi({ example: 'Person' })
      .transform(val => escapeHtml(val)),
    category: z.enum(['entity', 'link']).openapi({ example: 'entity' }),
    description: z
      .string()
      .openapi({ example: 'A person entity type' })
      .transform(val => escapeHtml(val))
      .optional(),
    json_schema: z.string().optional().openapi({
      description: 'JSON schema stored as string for property validation',
      example: null,
    }),
  })
  .openapi('ImportTypeItem');

// Schema for import request body
export const importRequestSchema = z
  .object({
    // Optional types to create (useful for importing a complete subgraph)
    types: z
      .array(importTypeItemSchema)
      .optional()
      .default([])
      .openapi({ description: 'Types to create (optional, for importing complete subgraphs)' }),
    // Entities to import
    entities: z
      .array(importEntityItemSchema)
      .min(0)
      .max(MAX_IMPORT_ITEMS, `Maximum ${MAX_IMPORT_ITEMS} entities per import request`)
      .openapi({ description: `Entities to import (0-${MAX_IMPORT_ITEMS})` }),
    // Links to import
    links: z
      .array(importLinkItemSchema)
      .min(0)
      .max(MAX_IMPORT_ITEMS, `Maximum ${MAX_IMPORT_ITEMS} links per import request`)
      .openapi({ description: `Links to import (0-${MAX_IMPORT_ITEMS})` }),
  })
  .refine(data => data.entities.length > 0 || data.links.length > 0 || data.types.length > 0, {
    message: 'At least one type, entity, or link is required for import',
  });

// Result item for import operations
export const importResultItemSchema = z
  .object({
    client_id: z.string().optional().openapi({ example: 'entity-1' }),
    success: z.boolean().openapi({ example: true }),
    id: uuidSchema.optional().openapi({ example: '550e8400-e29b-41d4-a716-446655440000' }),
    error: z.string().optional().openapi({ example: 'Type not found' }),
    code: z.string().optional().openapi({ example: 'TYPE_NOT_FOUND' }),
  })
  .openapi('ImportResultItem');

// Schema for import summary category
export const importSummaryCategorySchema = z
  .object({
    total: z.number().int().min(0).openapi({ example: 5 }),
    successful: z.number().int().min(0).openapi({ example: 4 }),
    failed: z.number().int().min(0).openapi({ example: 1 }),
  })
  .openapi('ImportSummaryCategory');

// Schema for import response
export const importResponseSchema = z
  .object({
    type_results: z.array(importResultItemSchema),
    entity_results: z.array(importResultItemSchema),
    link_results: z.array(importResultItemSchema),
    id_mapping: z.object({
      types: z.record(z.string(), uuidSchema).openapi({
        description: 'Mapping of client IDs/names to new server-assigned type IDs',
      }),
      entities: z.record(z.string(), uuidSchema).openapi({
        description: 'Mapping of client IDs to new server-assigned entity IDs',
      }),
      links: z.record(z.string(), uuidSchema).openapi({
        description: 'Mapping of client IDs to new server-assigned link IDs',
      }),
    }),
    summary: z.object({
      types: importSummaryCategorySchema,
      entities: importSummaryCategorySchema,
      links: importSummaryCategorySchema,
    }),
  })
  .openapi('ImportResponse');

// Types derived from schemas
export type ExportQuery = z.infer<typeof exportQuerySchema>;
export type ExportedEntity = z.infer<typeof exportedEntitySchema>;
export type ExportedLink = z.infer<typeof exportedLinkSchema>;
export type ExportedType = z.infer<typeof exportedTypeSchema>;
export type ExportMetadata = z.infer<typeof exportMetadataSchema>;
export type ExportResponse = z.infer<typeof exportResponseSchema>;
export type ImportEntityItem = z.infer<typeof importEntityItemSchema>;
export type ImportLinkItem = z.infer<typeof importLinkItemSchema>;
export type ImportTypeItem = z.infer<typeof importTypeItemSchema>;
export type ImportRequest = z.infer<typeof importRequestSchema>;
export type ImportResultItem = z.infer<typeof importResultItemSchema>;
export type ImportSummaryCategory = z.infer<typeof importSummaryCategorySchema>;
export type ImportResponse = z.infer<typeof importResponseSchema>;
