import { Context, MiddlewareHandler } from 'hono';
import { z } from 'zod';

/**
 * Validation middleware factory for Hono
 * Validates request body, query parameters, or path parameters against a Zod schema
 */
export type ValidationTarget = 'json' | 'query' | 'param';

/**
 * Creates a validation middleware for the specified target and schema
 * @param target - Where to validate: 'json' (body), 'query' (query params), or 'param' (path params)
 * @param schema - Zod schema to validate against
 * @returns Hono middleware handler
 */
export function validate<T extends z.ZodTypeAny>(
  target: ValidationTarget,
  schema: T
): MiddlewareHandler {
  return async (c: Context, next) => {
    let data: unknown;

    switch (target) {
      case 'json':
        data = await c.req.json();
        break;
      case 'query':
        data = c.req.query();
        break;
      case 'param':
        data = c.req.param();
        break;
      default:
        throw new Error(`Unknown validation target: ${target}`);
    }

    // Validate and parse the data
    const parsed = schema.parse(data);

    // Store the validated data in the context for later use
    c.set(`validated_${target}`, parsed);

    await next();
  };
}

/**
 * Shorthand for validating JSON body
 */
export function validateJson<T extends z.ZodTypeAny>(schema: T): MiddlewareHandler {
  return validate('json', schema);
}

/**
 * Shorthand for validating query parameters
 */
export function validateQuery<T extends z.ZodTypeAny>(schema: T): MiddlewareHandler {
  return validate('query', schema);
}

/**
 * Shorthand for validating path parameters
 */
export function validateParam<T extends z.ZodTypeAny>(schema: T): MiddlewareHandler {
  return validate('param', schema);
}

/**
 * Helper to retrieve validated data from context
 */
export function getValidated<T>(c: Context, target: ValidationTarget): T {
  return c.get(`validated_${target}`) as T;
}
