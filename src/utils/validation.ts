import { z, ZodError } from 'zod';

/**
 * Safe parse utility that returns a result object instead of throwing
 */
export function safeParse<T extends z.ZodTypeAny>(
  schema: T,
  data: unknown
): { success: true; data: z.infer<T> } | { success: false; error: ZodError } {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

/**
 * Validates and throws a formatted error if validation fails
 */
export function validateOrThrow<T extends z.ZodTypeAny>(
  schema: T,
  data: unknown,
  customMessage?: string
): z.infer<T> {
  try {
    return schema.parse(data);
  } catch (error) {
    if (error instanceof ZodError) {
      const message = customMessage || 'Validation failed';
      throw new Error(
        `${message}: ${error.issues.map((e: any) => `${e.path.join('.')}: ${e.message}`).join(', ')}`
      );
    }
    throw error;
  }
}

/**
 * Format Zod errors for user-friendly display
 */
export function formatZodError(error: ZodError): { path: string; message: string; code: string }[] {
  return error.issues.map((err: any) => ({
    path: err.path.join('.'),
    message: err.message,
    code: err.code,
  }));
}

/**
 * Parse JSON string and validate against schema
 */
export function parseJsonAndValidate<T extends z.ZodTypeAny>(
  jsonString: string,
  schema: T
): z.infer<T> {
  try {
    const parsed = JSON.parse(jsonString);
    return schema.parse(parsed);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Coerce SQLite boolean (0 or 1) to JavaScript boolean
 */
export function sqliteBooleanToJs(value: 0 | 1): boolean {
  return value === 1;
}

/**
 * Coerce JavaScript boolean to SQLite boolean (0 or 1)
 */
export function jsBooleanToSqlite(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}
