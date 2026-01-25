import { z } from 'zod';
import { uuidSchema, timestampSchema, paginationQuerySchema } from './common.js';

// Audit log operation types
export const auditOperationSchema = z.enum(['create', 'update', 'delete', 'restore']);

// Audit log resource types
export const auditResourceTypeSchema = z.enum(['entity', 'link', 'type', 'user']);

// Audit log database model schema
export const auditLogSchema = z.object({
  id: uuidSchema,
  operation: auditOperationSchema,
  resource_type: auditResourceTypeSchema,
  resource_id: uuidSchema,
  user_id: uuidSchema.nullable(),
  timestamp: timestampSchema,
  details: z.string().nullable(), // JSON stored as string
  ip_address: z.string().nullable(),
  user_agent: z.string().nullable(),
});

// Audit log response schema (with parsed details)
export const auditLogResponseSchema = z.object({
  id: uuidSchema,
  operation: auditOperationSchema,
  resource_type: auditResourceTypeSchema,
  resource_id: uuidSchema,
  user_id: uuidSchema.nullable(),
  timestamp: timestampSchema,
  details: z.record(z.string(), z.unknown()).nullable(),
  ip_address: z.string().nullable(),
  user_agent: z.string().nullable(),
});

// Audit log query filters
export const auditLogQuerySchema = paginationQuerySchema.omit({ include_deleted: true }).extend({
  user_id: z.string().uuid().optional(),
  resource_type: auditResourceTypeSchema.optional(),
  resource_id: z.string().uuid().optional(),
  operation: auditOperationSchema.optional(),
  start_date: z
    .string()
    .transform(val => parseInt(val, 10))
    .pipe(z.number().int().positive())
    .optional(),
  end_date: z
    .string()
    .transform(val => parseInt(val, 10))
    .pipe(z.number().int().positive())
    .optional(),
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
