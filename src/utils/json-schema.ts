/**
 * JSON Schema Validation Utility
 *
 * A lightweight JSON Schema validator for Cloudflare Workers environment.
 * Supports JSON Schema Draft-07 subset commonly used for entity/link property validation.
 */

/**
 * Validation error details
 */
export interface ValidationError {
  path: string;
  message: string;
  keyword: string;
  params?: Record<string, unknown>;
}

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/**
 * JSON Schema type definitions (subset of Draft-07)
 */
export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema | JsonSchema[];
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  enum?: unknown[];
  const?: unknown;
  allOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  not?: JsonSchema;
  if?: JsonSchema;
  then?: JsonSchema;
  else?: JsonSchema;
  $ref?: string;
  definitions?: Record<string, JsonSchema>;
  $defs?: Record<string, JsonSchema>;
  default?: unknown;
  title?: string;
  description?: string;
}

/**
 * Validates data against a JSON Schema
 */
export function validateJsonSchema(
  data: unknown,
  schema: JsonSchema,
  rootSchema?: JsonSchema,
  path: string = ''
): ValidationResult {
  const errors: ValidationError[] = [];
  const root = rootSchema || schema;

  // Handle $ref
  if (schema.$ref) {
    const refSchema = resolveRef(schema.$ref, root);
    if (!refSchema) {
      errors.push({
        path,
        message: `Unable to resolve $ref: ${schema.$ref}`,
        keyword: '$ref',
        params: { ref: schema.$ref },
      });
      return { valid: false, errors };
    }
    return validateJsonSchema(data, refSchema, root, path);
  }

  // Handle allOf
  if (schema.allOf) {
    for (const subSchema of schema.allOf) {
      const result = validateJsonSchema(data, subSchema, root, path);
      errors.push(...result.errors);
    }
  }

  // Handle anyOf
  if (schema.anyOf) {
    const anyOfResults = schema.anyOf.map(subSchema =>
      validateJsonSchema(data, subSchema, root, path)
    );
    const anyValid = anyOfResults.some(r => r.valid);
    if (!anyValid) {
      errors.push({
        path,
        message: 'Value does not match any of the allowed schemas',
        keyword: 'anyOf',
      });
    }
  }

  // Handle oneOf
  if (schema.oneOf) {
    const oneOfResults = schema.oneOf.map(subSchema =>
      validateJsonSchema(data, subSchema, root, path)
    );
    const validCount = oneOfResults.filter(r => r.valid).length;
    if (validCount !== 1) {
      errors.push({
        path,
        message: `Value must match exactly one schema, but matched ${validCount}`,
        keyword: 'oneOf',
        params: { matchedCount: validCount },
      });
    }
  }

  // Handle not
  if (schema.not) {
    const notResult = validateJsonSchema(data, schema.not, root, path);
    if (notResult.valid) {
      errors.push({
        path,
        message: 'Value must not match the schema',
        keyword: 'not',
      });
    }
  }

  // Handle if/then/else
  if (schema.if) {
    const ifResult = validateJsonSchema(data, schema.if, root, path);
    if (ifResult.valid && schema.then) {
      const thenResult = validateJsonSchema(data, schema.then, root, path);
      errors.push(...thenResult.errors);
    } else if (!ifResult.valid && schema.else) {
      const elseResult = validateJsonSchema(data, schema.else, root, path);
      errors.push(...elseResult.errors);
    }
  }

  // Handle const
  if (schema.const !== undefined) {
    if (!deepEqual(data, schema.const)) {
      errors.push({
        path,
        message: `Value must be equal to constant: ${JSON.stringify(schema.const)}`,
        keyword: 'const',
        params: { allowedValue: schema.const },
      });
    }
  }

  // Handle enum
  if (schema.enum) {
    const matchesEnum = schema.enum.some(enumValue => deepEqual(data, enumValue));
    if (!matchesEnum) {
      errors.push({
        path,
        message: `Value must be one of: ${schema.enum.map(v => JSON.stringify(v)).join(', ')}`,
        keyword: 'enum',
        params: { allowedValues: schema.enum },
      });
    }
  }

  // Handle type validation
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actualType = getJsonType(data);

    if (!types.includes(actualType)) {
      // Special case: 'integer' type
      if (types.includes('integer') && actualType === 'number' && Number.isInteger(data)) {
        // Valid integer
      } else {
        errors.push({
          path,
          message: `Expected type ${types.join(' or ')}, got ${actualType}`,
          keyword: 'type',
          params: { expectedType: types, actualType },
        });
        // If type doesn't match, skip further validation for this schema
        return { valid: errors.length === 0, errors };
      }
    }
  }

  // Type-specific validations
  const actualType = getJsonType(data);

  // String validations
  if (actualType === 'string' && typeof data === 'string') {
    if (schema.minLength !== undefined && data.length < schema.minLength) {
      errors.push({
        path,
        message: `String must be at least ${schema.minLength} characters`,
        keyword: 'minLength',
        params: { limit: schema.minLength, actual: data.length },
      });
    }
    if (schema.maxLength !== undefined && data.length > schema.maxLength) {
      errors.push({
        path,
        message: `String must be at most ${schema.maxLength} characters`,
        keyword: 'maxLength',
        params: { limit: schema.maxLength, actual: data.length },
      });
    }
    if (schema.pattern) {
      const regex = new RegExp(schema.pattern);
      if (!regex.test(data)) {
        errors.push({
          path,
          message: `String must match pattern: ${schema.pattern}`,
          keyword: 'pattern',
          params: { pattern: schema.pattern },
        });
      }
    }
    if (schema.format) {
      const formatError = validateFormat(data, schema.format, path);
      if (formatError) {
        errors.push(formatError);
      }
    }
  }

  // Number validations
  if ((actualType === 'number' || actualType === 'integer') && typeof data === 'number') {
    if (schema.minimum !== undefined && data < schema.minimum) {
      errors.push({
        path,
        message: `Value must be >= ${schema.minimum}`,
        keyword: 'minimum',
        params: { limit: schema.minimum, actual: data },
      });
    }
    if (schema.maximum !== undefined && data > schema.maximum) {
      errors.push({
        path,
        message: `Value must be <= ${schema.maximum}`,
        keyword: 'maximum',
        params: { limit: schema.maximum, actual: data },
      });
    }
    if (schema.exclusiveMinimum !== undefined && data <= schema.exclusiveMinimum) {
      errors.push({
        path,
        message: `Value must be > ${schema.exclusiveMinimum}`,
        keyword: 'exclusiveMinimum',
        params: { limit: schema.exclusiveMinimum, actual: data },
      });
    }
    if (schema.exclusiveMaximum !== undefined && data >= schema.exclusiveMaximum) {
      errors.push({
        path,
        message: `Value must be < ${schema.exclusiveMaximum}`,
        keyword: 'exclusiveMaximum',
        params: { limit: schema.exclusiveMaximum, actual: data },
      });
    }
  }

  // Array validations
  if (actualType === 'array' && Array.isArray(data)) {
    if (schema.minItems !== undefined && data.length < schema.minItems) {
      errors.push({
        path,
        message: `Array must have at least ${schema.minItems} items`,
        keyword: 'minItems',
        params: { limit: schema.minItems, actual: data.length },
      });
    }
    if (schema.maxItems !== undefined && data.length > schema.maxItems) {
      errors.push({
        path,
        message: `Array must have at most ${schema.maxItems} items`,
        keyword: 'maxItems',
        params: { limit: schema.maxItems, actual: data.length },
      });
    }
    if (schema.uniqueItems) {
      const seen = new Set();
      for (let i = 0; i < data.length; i++) {
        const serialized = JSON.stringify(data[i]);
        if (seen.has(serialized)) {
          errors.push({
            path,
            message: 'Array items must be unique',
            keyword: 'uniqueItems',
            params: { index: i },
          });
          break;
        }
        seen.add(serialized);
      }
    }
    if (schema.items) {
      if (Array.isArray(schema.items)) {
        // Tuple validation
        for (let i = 0; i < data.length; i++) {
          const itemSchema = schema.items[i];
          if (itemSchema) {
            const itemPath = path ? `${path}[${i}]` : `[${i}]`;
            const result = validateJsonSchema(data[i], itemSchema, root, itemPath);
            errors.push(...result.errors);
          }
        }
      } else {
        // All items must match schema
        for (let i = 0; i < data.length; i++) {
          const itemPath = path ? `${path}[${i}]` : `[${i}]`;
          const result = validateJsonSchema(data[i], schema.items, root, itemPath);
          errors.push(...result.errors);
        }
      }
    }
  }

  // Object validations
  if (actualType === 'object' && data !== null && typeof data === 'object' && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;

    // Required properties
    if (schema.required) {
      for (const requiredProp of schema.required) {
        if (!(requiredProp in obj)) {
          const propPath = path ? `${path}.${requiredProp}` : requiredProp;
          errors.push({
            path: propPath,
            message: `Required property '${requiredProp}' is missing`,
            keyword: 'required',
            params: { missingProperty: requiredProp },
          });
        }
      }
    }

    // Property validations
    if (schema.properties) {
      for (const [propName, propSchema] of Object.entries(schema.properties)) {
        if (propName in obj) {
          const propPath = path ? `${path}.${propName}` : propName;
          const result = validateJsonSchema(obj[propName], propSchema, root, propPath);
          errors.push(...result.errors);
        }
      }
    }

    // Additional properties
    if (schema.additionalProperties !== undefined) {
      const definedProps = new Set(Object.keys(schema.properties || {}));
      for (const propName of Object.keys(obj)) {
        if (!definedProps.has(propName)) {
          if (schema.additionalProperties === false) {
            const propPath = path ? `${path}.${propName}` : propName;
            errors.push({
              path: propPath,
              message: `Additional property '${propName}' is not allowed`,
              keyword: 'additionalProperties',
              params: { additionalProperty: propName },
            });
          } else if (typeof schema.additionalProperties === 'object') {
            const propPath = path ? `${path}.${propName}` : propName;
            const result = validateJsonSchema(
              obj[propName],
              schema.additionalProperties,
              root,
              propPath
            );
            errors.push(...result.errors);
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Get the JSON type of a value
 */
function getJsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'number';
  }
  return typeof value;
}

/**
 * Deep equality check for JSON values
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return a === b;

  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }

  const keysA = Object.keys(a as object);
  const keysB = Object.keys(b as object);
  if (keysA.length !== keysB.length) return false;

  return keysA.every(key =>
    key in (b as object) && deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
  );
}

/**
 * Resolve a $ref pointer
 */
function resolveRef(ref: string, schema: JsonSchema): JsonSchema | undefined {
  if (!ref.startsWith('#/')) {
    // External refs not supported
    return undefined;
  }

  const path = ref.slice(2).split('/');
  let current: unknown = schema;

  for (const segment of path) {
    const decodedSegment = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (current && typeof current === 'object' && decodedSegment in current) {
      current = (current as Record<string, unknown>)[decodedSegment];
    } else {
      return undefined;
    }
  }

  return current as JsonSchema;
}

/**
 * Validate string format
 */
function validateFormat(value: string, format: string, path: string): ValidationError | null {
  switch (format) {
    case 'email': {
      // Simple email validation
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(value)) {
        return {
          path,
          message: 'Invalid email format',
          keyword: 'format',
          params: { format: 'email' },
        };
      }
      break;
    }
    case 'uri':
    case 'url': {
      try {
        new URL(value);
      } catch {
        return {
          path,
          message: 'Invalid URI format',
          keyword: 'format',
          params: { format },
        };
      }
      break;
    }
    case 'date': {
      // ISO 8601 date (YYYY-MM-DD)
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(value) || isNaN(Date.parse(value))) {
        return {
          path,
          message: 'Invalid date format (expected YYYY-MM-DD)',
          keyword: 'format',
          params: { format: 'date' },
        };
      }
      break;
    }
    case 'date-time': {
      // ISO 8601 date-time
      if (isNaN(Date.parse(value))) {
        return {
          path,
          message: 'Invalid date-time format',
          keyword: 'format',
          params: { format: 'date-time' },
        };
      }
      break;
    }
    case 'time': {
      // ISO 8601 time (HH:MM:SS or HH:MM:SS.sss)
      const timeRegex = /^\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;
      if (!timeRegex.test(value)) {
        return {
          path,
          message: 'Invalid time format (expected HH:MM:SS)',
          keyword: 'format',
          params: { format: 'time' },
        };
      }
      break;
    }
    case 'uuid': {
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(value)) {
        return {
          path,
          message: 'Invalid UUID format',
          keyword: 'format',
          params: { format: 'uuid' },
        };
      }
      break;
    }
    case 'ipv4': {
      const ipv4Regex = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$/;
      if (!ipv4Regex.test(value)) {
        return {
          path,
          message: 'Invalid IPv4 format',
          keyword: 'format',
          params: { format: 'ipv4' },
        };
      }
      break;
    }
    case 'ipv6': {
      // Simplified IPv6 validation
      const ipv6Regex = /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^::$|^([0-9a-fA-F]{1,4}:){1,7}:$|^::(ffff:)?([0-9]{1,3}\.){3}[0-9]{1,3}$/i;
      if (!ipv6Regex.test(value)) {
        return {
          path,
          message: 'Invalid IPv6 format',
          keyword: 'format',
          params: { format: 'ipv6' },
        };
      }
      break;
    }
    // Unknown formats are ignored (as per JSON Schema spec)
    default:
      break;
  }
  return null;
}

/**
 * Parse a JSON Schema from a string
 * Returns null if the string is not valid JSON or not a valid schema object
 */
export function parseJsonSchema(schemaString: string): JsonSchema | null {
  try {
    const parsed = JSON.parse(schemaString);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    return parsed as JsonSchema;
  } catch {
    return null;
  }
}

/**
 * Validates properties against a type's JSON schema
 * Returns a ValidationResult with any errors found
 *
 * @param properties - The properties object to validate
 * @param jsonSchemaString - The JSON schema as a string (from the type's json_schema field)
 * @returns ValidationResult with valid flag and any errors
 */
export function validatePropertiesAgainstSchema(
  properties: Record<string, unknown>,
  jsonSchemaString: string | null | undefined
): ValidationResult {
  // If no schema is defined, validation passes
  if (!jsonSchemaString) {
    return { valid: true, errors: [] };
  }

  const schema = parseJsonSchema(jsonSchemaString);
  if (!schema) {
    return {
      valid: false,
      errors: [{
        path: '',
        message: 'Type has invalid JSON schema',
        keyword: 'schema',
      }],
    };
  }

  return validateJsonSchema(properties, schema);
}

/**
 * Format validation errors into a human-readable message
 */
export function formatValidationErrors(errors: ValidationError[]): string {
  if (errors.length === 0) {
    return '';
  }

  return errors
    .map(err => err.path ? `${err.path}: ${err.message}` : err.message)
    .join('; ');
}
