import { z } from '@hono/zod-openapi';

// ============================================================================
// Common Schemas
// ============================================================================

export const UuidSchema = z.string().uuid().openapi({
  example: '550e8400-e29b-41d4-a716-446655440000',
  description: 'UUID v4 format identifier',
});

export const TimestampSchema = z.number().int().positive().openapi({
  example: 1705312200000,
  description: 'Unix timestamp in milliseconds',
});

export const JsonPropertiesSchema = z.record(z.string(), z.unknown()).openapi({
  example: { name: 'Example', tags: ['important', 'new'] },
  description: 'Flexible JSON object for custom properties',
});

// ============================================================================
// Type Schemas
// ============================================================================

export const TypeCategorySchema = z.enum(['entity', 'link']).openapi({
  example: 'entity',
  description: 'Category of the type (entity or link)',
});

export const CreateTypeSchema = z.object({
  name: z.string().min(1).max(255).openapi({
    example: 'Person',
    description: 'Unique name for the type',
  }),
  category: TypeCategorySchema,
  description: z.string().max(1000).optional().openapi({
    example: 'Represents a person in the system',
    description: 'Optional description of the type',
  }),
  json_schema: z.record(z.string(), z.unknown()).optional().openapi({
    example: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    description: 'Optional JSON Schema for validating properties',
  }),
}).openapi('CreateType');

export const UpdateTypeSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).nullable().optional(),
  json_schema: z.record(z.string(), z.unknown()).nullable().optional(),
}).openapi('UpdateType');

export const TypeResponseSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  category: TypeCategorySchema,
  description: z.string().nullable(),
  json_schema: z.string().nullable().openapi({
    description: 'JSON Schema stored as string',
  }),
  created_at: TimestampSchema,
  created_by: UuidSchema,
}).openapi('Type');

// ============================================================================
// Entity Schemas
// ============================================================================

export const CreateEntitySchema = z.object({
  type_id: UuidSchema.openapi({
    description: 'ID of the entity type',
  }),
  properties: JsonPropertiesSchema.optional().default({}),
}).openapi('CreateEntity');

export const UpdateEntitySchema = z.object({
  properties: JsonPropertiesSchema,
}).openapi('UpdateEntity');

export const EntityResponseSchema = z.object({
  id: UuidSchema,
  type_id: UuidSchema,
  properties: JsonPropertiesSchema,
  version: z.number().int().positive().openapi({
    example: 1,
    description: 'Version number (increments on each update)',
  }),
  previous_version_id: UuidSchema.nullable().openapi({
    description: 'ID of the previous version (null for first version)',
  }),
  created_at: TimestampSchema,
  created_by: UuidSchema,
  is_deleted: z.boolean().openapi({
    example: false,
    description: 'Whether the entity is soft-deleted',
  }),
  is_latest: z.boolean().openapi({
    example: true,
    description: 'Whether this is the latest version',
  }),
}).openapi('Entity');

export const EntityQuerySchema = z.object({
  type_id: z.string().uuid().optional().openapi({
    description: 'Filter by entity type ID',
  }),
  created_by: z.string().uuid().optional().openapi({
    description: 'Filter by creator user ID',
  }),
  created_after: z.string().optional().openapi({
    description: 'Filter entities created after this timestamp (Unix ms)',
  }),
  created_before: z.string().optional().openapi({
    description: 'Filter entities created before this timestamp (Unix ms)',
  }),
  limit: z.string().optional(),
  cursor: z.string().optional(),
  include_deleted: z.string().optional(),
}).openapi('EntityQuery');

// ============================================================================
// Link Schemas
// ============================================================================

export const CreateLinkSchema = z.object({
  type_id: UuidSchema.openapi({
    description: 'ID of the link type',
  }),
  source_entity_id: UuidSchema.openapi({
    description: 'ID of the source entity',
  }),
  target_entity_id: UuidSchema.openapi({
    description: 'ID of the target entity',
  }),
  properties: JsonPropertiesSchema.optional().default({}),
}).openapi('CreateLink');

export const UpdateLinkSchema = z.object({
  properties: JsonPropertiesSchema,
}).openapi('UpdateLink');

export const LinkResponseSchema = z.object({
  id: UuidSchema,
  type_id: UuidSchema,
  source_entity_id: UuidSchema,
  target_entity_id: UuidSchema,
  properties: JsonPropertiesSchema,
  version: z.number().int().positive(),
  previous_version_id: UuidSchema.nullable(),
  created_at: TimestampSchema,
  created_by: UuidSchema,
  is_deleted: z.boolean(),
  is_latest: z.boolean(),
}).openapi('Link');

export const LinkQuerySchema = z.object({
  type_id: z.string().uuid().optional(),
  source_entity_id: z.string().uuid().optional(),
  target_entity_id: z.string().uuid().optional(),
  created_by: z.string().uuid().optional(),
  created_after: z.string().optional(),
  created_before: z.string().optional(),
  limit: z.string().optional(),
  cursor: z.string().optional(),
  include_deleted: z.string().optional(),
}).openapi('LinkQuery');

// ============================================================================
// User & Auth Schemas
// ============================================================================

export const ProviderSchema = z.enum(['google', 'github', 'local', 'microsoft', 'apple']).openapi({
  example: 'local',
  description: 'Authentication provider',
});

export const RegisterUserSchema = z.object({
  email: z.string().email().openapi({
    example: 'user@example.com',
    description: 'User email address',
  }),
  password: z.string().min(8).max(128).openapi({
    example: 'securePassword123',
    description: 'Password (8-128 characters)',
  }),
  display_name: z.string().min(1).max(255).optional().openapi({
    example: 'John Doe',
    description: 'Display name for the user',
  }),
}).openapi('RegisterUser');

export const LoginSchema = z.object({
  email: z.string().email().openapi({
    example: 'user@example.com',
  }),
  password: z.string().min(1).openapi({
    example: 'securePassword123',
  }),
}).openapi('Login');

export const RefreshTokenSchema = z.object({
  refresh_token: z.string().min(1).openapi({
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
    description: 'Refresh token from login response',
  }),
}).openapi('RefreshToken');

export const LogoutSchema = z.object({
  refresh_token: z.string().min(1),
}).openapi('Logout');

export const AuthTokensResponseSchema = z.object({
  access_token: z.string().openapi({
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
    description: 'JWT access token (short-lived)',
  }),
  refresh_token: z.string().openapi({
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
    description: 'Refresh token for obtaining new access tokens',
  }),
  token_type: z.literal('Bearer'),
  expires_in: z.number().openapi({
    example: 3600,
    description: 'Access token expiration time in seconds',
  }),
}).openapi('AuthTokens');

export const UserResponseSchema = z.object({
  id: UuidSchema,
  email: z.string().email(),
  display_name: z.string().nullable(),
  provider: ProviderSchema,
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
  is_active: z.boolean(),
}).openapi('User');

export const UpdateUserSchema = z.object({
  display_name: z.string().min(1).max(255).optional(),
  email: z.string().email().optional(),
}).openapi('UpdateUser');

// ============================================================================
// Search Schemas
// ============================================================================

export const PropertyFilterSchema = z.object({
  path: z.string().min(1).openapi({
    example: 'name',
    description: 'JSON path to the property (e.g., "name", "address.city", "tags[0]")',
  }),
  operator: z.enum([
    'eq', 'ne', 'gt', 'lt', 'gte', 'lte',
    'like', 'ilike', 'starts_with', 'ends_with', 'contains',
    'in', 'not_in', 'exists', 'not_exists',
  ]).openapi({
    example: 'eq',
    description: 'Comparison operator',
  }),
  value: z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(z.union([z.string(), z.number(), z.boolean()])),
  ]).optional().openapi({
    example: 'John',
    description: 'Value to compare against (optional for exists/not_exists)',
  }),
}).openapi('PropertyFilter');

export const SearchEntitiesSchema = z.object({
  type_id: UuidSchema.optional(),
  properties: z.record(z.string(), z.unknown()).optional().openapi({
    description: 'Simple equality property filters (deprecated, use property_filters)',
  }),
  property_filters: z.array(PropertyFilterSchema).optional().openapi({
    description: 'Advanced property filters with operators',
  }),
  filter_expression: z.unknown().optional().openapi({
    description: 'Complex filter expression with AND/OR logic',
  }),
  created_after: z.number().optional(),
  created_before: z.number().optional(),
  created_by: UuidSchema.optional(),
  include_deleted: z.boolean().optional().default(false),
  limit: z.number().optional().default(20),
  cursor: z.string().optional(),
}).openapi('SearchEntities');

export const SearchLinksSchema = z.object({
  type_id: UuidSchema.optional(),
  source_entity_id: UuidSchema.optional(),
  target_entity_id: UuidSchema.optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  property_filters: z.array(PropertyFilterSchema).optional(),
  filter_expression: z.unknown().optional(),
  created_after: z.number().optional(),
  created_before: z.number().optional(),
  created_by: UuidSchema.optional(),
  include_deleted: z.boolean().optional().default(false),
  limit: z.number().optional().default(20),
  cursor: z.string().optional(),
}).openapi('SearchLinks');

export const SuggestionsQuerySchema = z.object({
  query: z.string().min(1).max(100).openapi({
    example: 'John',
    description: 'Search query for partial matching',
  }),
  property_path: z.string().optional().openapi({
    example: 'name',
    description: 'Property path to search (default: "name")',
  }),
  type_id: z.string().uuid().optional(),
  limit: z.string().optional().openapi({
    example: '10',
    description: 'Maximum suggestions to return (default: 10, max: 50)',
  }),
}).openapi('SuggestionsQuery');

// ============================================================================
// Graph Schemas
// ============================================================================

export const TraversalRequestSchema = z.object({
  start_entity_id: UuidSchema.openapi({
    description: 'ID of the entity to start traversal from',
  }),
  direction: z.enum(['outbound', 'inbound', 'both']).optional().default('both').openapi({
    example: 'both',
    description: 'Direction of traversal',
  }),
  max_depth: z.number().int().min(1).max(10).optional().default(3).openapi({
    example: 3,
    description: 'Maximum hops from starting entity (1-10)',
  }),
  link_types: z.array(UuidSchema).optional().openapi({
    description: 'Filter by link type IDs',
  }),
  entity_types: z.array(UuidSchema).optional().openapi({
    description: 'Filter results by entity type IDs',
  }),
  include_paths: z.boolean().optional().default(false).openapi({
    description: 'Include the path that led to each entity',
  }),
}).openapi('TraversalRequest');

export const PathQuerySchema = z.object({
  from: z.string().uuid().openapi({
    description: 'Starting entity ID',
  }),
  to: z.string().uuid().openapi({
    description: 'Target entity ID',
  }),
  link_types: z.string().optional().openapi({
    description: 'Comma-separated list of link type IDs to filter by',
  }),
  max_depth: z.string().optional().openapi({
    example: '10',
    description: 'Maximum path length (default: 10)',
  }),
}).openapi('PathQuery');

// ============================================================================
// Bulk Operation Schemas
// ============================================================================

export const BulkCreateEntityItemSchema = z.object({
  type_id: UuidSchema,
  properties: JsonPropertiesSchema.optional().default({}),
  client_id: z.string().optional().openapi({
    description: 'Optional client-provided ID for correlation',
  }),
}).openapi('BulkCreateEntityItem');

export const BulkCreateEntitiesSchema = z.object({
  entities: z.array(BulkCreateEntityItemSchema).min(1).max(100),
}).openapi('BulkCreateEntities');

export const BulkCreateLinkItemSchema = z.object({
  type_id: UuidSchema,
  source_entity_id: UuidSchema,
  target_entity_id: UuidSchema,
  properties: JsonPropertiesSchema.optional().default({}),
  client_id: z.string().optional(),
}).openapi('BulkCreateLinkItem');

export const BulkCreateLinksSchema = z.object({
  links: z.array(BulkCreateLinkItemSchema).min(1).max(100),
}).openapi('BulkCreateLinks');

export const BulkUpdateEntityItemSchema = z.object({
  id: UuidSchema,
  properties: JsonPropertiesSchema,
}).openapi('BulkUpdateEntityItem');

export const BulkUpdateEntitiesSchema = z.object({
  entities: z.array(BulkUpdateEntityItemSchema).min(1).max(100),
}).openapi('BulkUpdateEntities');

export const BulkUpdateLinkItemSchema = z.object({
  id: UuidSchema,
  properties: JsonPropertiesSchema,
}).openapi('BulkUpdateLinkItem');

export const BulkUpdateLinksSchema = z.object({
  links: z.array(BulkUpdateLinkItemSchema).min(1).max(100),
}).openapi('BulkUpdateLinks');

export const BulkResultItemSchema = z.object({
  index: z.number().int().min(0),
  success: z.boolean(),
  id: UuidSchema.optional(),
  client_id: z.string().optional(),
  version: z.number().optional(),
  error: z.string().optional(),
  code: z.string().optional(),
}).openapi('BulkResultItem');

// ============================================================================
// Audit Log Schemas
// ============================================================================

export const AuditOperationSchema = z.enum(['create', 'update', 'delete', 'restore']).openapi({
  example: 'create',
  description: 'Type of operation performed',
});

export const AuditResourceTypeSchema = z.enum(['entity', 'link', 'type', 'user']).openapi({
  example: 'entity',
  description: 'Type of resource affected',
});

export const AuditLogResponseSchema = z.object({
  id: UuidSchema,
  operation: AuditOperationSchema,
  resource_type: AuditResourceTypeSchema,
  resource_id: UuidSchema,
  user_id: UuidSchema.nullable(),
  timestamp: TimestampSchema,
  details: z.record(z.string(), z.unknown()).nullable(),
  ip_address: z.string().nullable(),
  user_agent: z.string().nullable(),
}).openapi('AuditLog');

export const AuditLogQuerySchema = z.object({
  user_id: z.string().uuid().optional(),
  resource_type: AuditResourceTypeSchema.optional(),
  resource_id: z.string().uuid().optional(),
  operation: AuditOperationSchema.optional(),
  start_date: z.string().optional().openapi({
    description: 'Filter logs after this timestamp (Unix ms)',
  }),
  end_date: z.string().optional().openapi({
    description: 'Filter logs before this timestamp (Unix ms)',
  }),
  limit: z.string().optional(),
  cursor: z.string().optional(),
}).openapi('AuditLogQuery');

// ============================================================================
// Export/Import Schemas
// ============================================================================

export const ExportQuerySchema = z.object({
  type_ids: z.string().optional().openapi({
    description: 'Comma-separated list of type IDs to filter by',
  }),
  created_after: z.string().optional(),
  created_before: z.string().optional(),
  include_deleted: z.string().optional(),
  include_versions: z.string().optional().openapi({
    description: 'Include version history (default: false)',
  }),
  limit: z.string().optional().openapi({
    example: '1000',
    description: 'Maximum items to export (default: 1000)',
  }),
}).openapi('ExportQuery');

export const ImportTypeItemSchema = z.object({
  client_id: z.string().optional(),
  name: z.string().min(1),
  category: TypeCategorySchema,
  description: z.string().optional(),
  json_schema: z.string().optional(),
}).openapi('ImportTypeItem');

export const ImportEntityItemSchema = z.object({
  client_id: z.string(),
  type_id: UuidSchema.optional(),
  type_name: z.string().optional(),
  properties: JsonPropertiesSchema.optional().default({}),
}).openapi('ImportEntityItem');

export const ImportLinkItemSchema = z.object({
  client_id: z.string().optional(),
  type_id: UuidSchema.optional(),
  type_name: z.string().optional(),
  source_entity_client_id: z.string().optional(),
  source_entity_id: UuidSchema.optional(),
  target_entity_client_id: z.string().optional(),
  target_entity_id: UuidSchema.optional(),
  properties: JsonPropertiesSchema.optional().default({}),
}).openapi('ImportLinkItem');

export const ImportRequestSchema = z.object({
  types: z.array(ImportTypeItemSchema).optional().default([]),
  entities: z.array(ImportEntityItemSchema).max(100),
  links: z.array(ImportLinkItemSchema).max(100),
}).openapi('ImportRequest');

// ============================================================================
// Paginated Response Schemas
// ============================================================================

export const PaginatedResponseSchema = <T extends z.ZodTypeAny>(itemSchema: T, name: string) =>
  z.object({
    success: z.literal(true),
    data: z.object({
      items: z.array(itemSchema),
      next_cursor: z.string().nullable(),
      total: z.number().optional(),
    }),
    timestamp: z.string(),
  }).openapi(`Paginated${name}Response`);

export const SingleResponseSchema = <T extends z.ZodTypeAny>(itemSchema: T, name: string) =>
  z.object({
    success: z.literal(true),
    data: itemSchema,
    timestamp: z.string(),
  }).openapi(`${name}Response`);
