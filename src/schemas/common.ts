import { z } from 'zod';

// Common UUID schema
export const uuidSchema = z.string().uuid('Invalid UUID format');

// Common timestamp schema (Unix timestamp in milliseconds)
export const timestampSchema = z.number().int().positive();

// Common boolean schema (SQLite uses 0 or 1)
export const sqliteBooleanSchema = z.union([z.literal(0), z.literal(1)]);

// JSON properties schema (flexible object that can be validated further)
export const jsonPropertiesSchema = z.record(z.string(), z.unknown());

// Pagination schemas
export const paginationQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .default('20')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().min(1).max(100)),
  cursor: z.string().optional(),
  include_deleted: z
    .string()
    .optional()
    .default('false')
    .transform((val) => val === 'true')
    .pipe(z.boolean()),
});

// Generic response wrapper
export const createPaginatedResponseSchema = <T extends z.ZodTypeAny>(itemSchema: T) =>
  z.object({
    items: z.array(itemSchema),
    next_cursor: z.string().nullable(),
    total: z.number().int().optional(),
  });

// Error response schema
export const errorResponseSchema = z.object({
  error: z.string(),
  details: z.unknown().optional(),
});

// Success response schema
export const successResponseSchema = z.object({
  success: z.boolean(),
  message: z.string().optional(),
});
