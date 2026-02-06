import { z } from '@hono/zod-openapi';
import { uuidSchema, timestampSchema, paginationQuerySchema } from './common.js';

// Audit log operation types
export const auditOperationSchema = z.enum([
  'create',
  'update',
  'delete',
  'restore',
  'admin_role_change',
]);

// Audit log resource types
export const auditResourceTypeSchema = z.enum(['entity', 'link', 'type', 'user']);

// Audit log database model schema
export const auditLogSchema = z
  .object({
    id: uuidSchema.openapi({ example: '550e8400-e29b-41d4-a716-446655440000' }),
    operation: auditOperationSchema.openapi({ example: 'create' }),
    resource_type: auditResourceTypeSchema.openapi({ example: 'entity' }),
    resource_id: uuidSchema.openapi({ example: '550e8400-e29b-41d4-a716-446655440001' }),
    user_id: uuidSchema.nullable().openapi({ example: '550e8400-e29b-41d4-a716-446655440002' }),
    timestamp: timestampSchema.openapi({ example: 1704067200 }),
    details: z.string().nullable().openapi({ description: 'JSON stored as string' }),
    ip_address: z.string().nullable().openapi({ example: '192.168.1.1' }),
    user_agent: z.string().nullable().openapi({ example: 'Mozilla/5.0' }),
  })
  .openapi('AuditLogDb');

// Audit log response schema (with parsed details)
export const auditLogResponseSchema = z
  .object({
    id: uuidSchema.openapi({ example: '550e8400-e29b-41d4-a716-446655440000' }),
    operation: auditOperationSchema.openapi({ example: 'create' }),
    resource_type: auditResourceTypeSchema.openapi({ example: 'entity' }),
    resource_id: uuidSchema.openapi({ example: '550e8400-e29b-41d4-a716-446655440001' }),
    user_id: uuidSchema.nullable().openapi({ example: '550e8400-e29b-41d4-a716-446655440002' }),
    timestamp: timestampSchema.openapi({ example: 1704067200 }),
    details: z
      .record(z.string(), z.unknown())
      .nullable()
      .openapi({ example: { previous: {}, current: { name: 'John' } } }),
    ip_address: z.string().nullable().openapi({ example: '192.168.1.1' }),
    user_agent: z.string().nullable().openapi({ example: 'Mozilla/5.0' }),
  })
  .openapi('AuditLog');

// Audit log query filters
export const auditLogQuerySchema = paginationQuerySchema.omit({ include_deleted: true }).extend({
  user_id: z
    .string()
    .uuid()
    .optional()
    .openapi({
      param: { name: 'user_id', in: 'query' },
      example: '550e8400-e29b-41d4-a716-446655440002',
    }),
  resource_type: auditResourceTypeSchema.optional().openapi({
    param: { name: 'resource_type', in: 'query' },
    example: 'entity',
  }),
  resource_id: z
    .string()
    .uuid()
    .optional()
    .openapi({
      param: { name: 'resource_id', in: 'query' },
      example: '550e8400-e29b-41d4-a716-446655440001',
    }),
  operation: auditOperationSchema.optional().openapi({
    param: { name: 'operation', in: 'query' },
    example: 'create',
  }),
  start_date: z
    .string()
    .transform(val => parseInt(val, 10))
    .pipe(z.number().int().positive())
    .optional()
    .openapi({
      param: { name: 'start_date', in: 'query' },
      example: '1704067200',
    }),
  end_date: z
    .string()
    .transform(val => parseInt(val, 10))
    .pipe(z.number().int().positive())
    .optional()
    .openapi({
      param: { name: 'end_date', in: 'query' },
      example: '1704153600',
    }),
});

// Internal audit log creation (used by the system)
export const createAuditLogSchema = z.object({
  operation: auditOperationSchema,
  resource_type: auditResourceTypeSchema,
  resource_id: uuidSchema,
  user_id: uuidSchema.nullable().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  ip_address: z.string().nullable().optional(),
  user_agent: z.string().nullable().optional(),
});

// Types derived from schemas
export type AuditOperation = z.infer<typeof auditOperationSchema>;
export type AuditResourceType = z.infer<typeof auditResourceTypeSchema>;
export type AuditLog = z.infer<typeof auditLogSchema>;
export type AuditLogResponse = z.infer<typeof auditLogResponseSchema>;
export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;
export type CreateAuditLog = z.infer<typeof createAuditLogSchema>;
