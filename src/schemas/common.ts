import { z } from 'zod';
import { sanitizeProperties, validateAndSanitize } from '../utils/sanitize.js';

// Common UUID schema
export const uuidSchema = z.string().uuid('Invalid UUID format');

// Common timestamp schema (Unix timestamp in milliseconds)
export const timestampSchema = z.number().int().positive();

// Common boolean schema (SQLite uses 0 or 1)
export const sqliteBooleanSchema = z.union([z.literal(0), z.literal(1)]);

// JSON properties schema (flexible object that can be validated further)
export const jsonPropertiesSchema = z.record(z.string(), z.unknown());

/**
 * Sanitized JSON properties schema
 * This schema automatically sanitizes all string values to prevent XSS attacks
 * by escaping HTML special characters.
 */
export const sanitizedJsonPropertiesSchema = z
  .record(z.string(), z.unknown())
  .transform(props => sanitizeProperties(props));

/**
 * JSON properties schema with dangerous content detection
 * This schema sanitizes values and warns if dangerous content was detected
 */
export const jsonPropertiesWithValidationSchema = z
  .record(z.string(), z.unknown())
  .transform(props => {
    const result = validateAndSanitize(props);
    return {
      properties: result.sanitized as Record<string, unknown>,
      hadDangerousContent: result.hadDangerousContent,
      dangerousFields: result.dangerousFields,
    };
  });

// Pagination schemas
export const paginationQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .default('20')
    .transform(val => {
      const parsed = parseInt(val, 10);
      // Cap the limit at 100 instead of rejecting
      return Math.min(Math.max(parsed, 1), 100);
    })
    .pipe(z.number().int()),
  cursor: z.string().optional(),
  include_deleted: z
    .string()
    .optional()
    .default('false')
    .transform(val => val === 'true')
    .pipe(z.boolean()),
  // Field selection: comma-separated list of fields to include in response
  // Example: fields=id,type_id,properties
  fields: z.string().optional(),
  // JSON property filters in format: property_<key>=<value>
  // Example: property_name=John or property_age=25
  // This will be parsed dynamically in the route handlers
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
