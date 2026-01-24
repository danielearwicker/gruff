/**
 * Field Selection Utility
 *
 * Provides functionality to filter response objects to include only specified fields.
 * Used for reducing payload size via the `fields` query parameter.
 *
 * Example: GET /api/entities/123?fields=id,type_id,properties
 * Returns only id, type_id, and properties fields in the response.
 */

/**
 * Parses a comma-separated fields string into an array of field names.
 * Trims whitespace and filters out empty strings.
 *
 * @param fieldsParam - Comma-separated string of field names (e.g., "id,name,email")
 * @returns Array of field names
 */
export function parseFields(fieldsParam: string | undefined | null): string[] {
  if (!fieldsParam || typeof fieldsParam !== 'string') {
    return [];
  }

  return fieldsParam
    .split(',')
    .map((field) => field.trim())
    .filter((field) => field.length > 0);
}

/**
 * Validates that all requested fields exist in the allowed fields set.
 * Returns an object with valid status and any invalid fields found.
 *
 * @param requestedFields - Array of field names from the request
 * @param allowedFields - Set of valid field names for the resource
 * @returns Validation result with status and invalid fields
 */
export function validateFields(
  requestedFields: string[],
  allowedFields: Set<string>
): { valid: boolean; invalidFields: string[] } {
  const invalidFields = requestedFields.filter((field) => !allowedFields.has(field));
  return {
    valid: invalidFields.length === 0,
    invalidFields,
  };
}

/**
 * Filters an object to include only the specified fields.
 * If fields array is empty, returns the original object unchanged.
 *
 * @param obj - The object to filter
 * @param fields - Array of field names to include
 * @returns New object with only the specified fields
 */
export function selectFields<T extends Record<string, unknown>>(
  obj: T,
  fields: string[]
): Partial<T> {
  if (fields.length === 0) {
    return obj;
  }

  const result: Partial<T> = {};
  for (const field of fields) {
    if (field in obj) {
      result[field as keyof T] = obj[field as keyof T];
    }
  }
  return result;
}

/**
 * Applies field selection to an array of objects.
 * Useful for list endpoints.
 *
 * @param items - Array of objects to filter
 * @param fields - Array of field names to include
 * @returns New array with filtered objects
 */
export function selectFieldsFromArray<T extends Record<string, unknown>>(
  items: T[],
  fields: string[]
): Partial<T>[] {
  if (fields.length === 0) {
    return items;
  }

  return items.map((item) => selectFields(item, fields));
}

/**
 * Standard allowed fields for entity responses
 */
export const ENTITY_ALLOWED_FIELDS = new Set([
  'id',
  'type_id',
  'properties',
  'version',
  'previous_version_id',
  'created_at',
  'created_by',
  'is_deleted',
  'is_latest',
]);

/**
 * Standard allowed fields for link responses
 */
export const LINK_ALLOWED_FIELDS = new Set([
  'id',
  'type_id',
  'source_entity_id',
  'target_entity_id',
  'properties',
  'version',
  'previous_version_id',
  'created_at',
  'created_by',
  'is_deleted',
  'is_latest',
]);

/**
 * Standard allowed fields for type responses
 */
export const TYPE_ALLOWED_FIELDS = new Set([
  'id',
  'name',
  'category',
  'description',
  'json_schema',
  'created_at',
  'created_by',
]);

/**
 * Standard allowed fields for user responses
 */
export const USER_ALLOWED_FIELDS = new Set([
  'id',
  'email',
  'display_name',
  'provider',
  'created_at',
  'updated_at',
  'is_active',
]);

/**
 * Helper function to apply field selection and validation in one step.
 * Returns null if validation fails, otherwise returns the filtered object.
 *
 * @param obj - The object to filter
 * @param fieldsParam - Comma-separated fields string from query
 * @param allowedFields - Set of valid field names
 * @returns Object with filtered data or error info
 */
export function applyFieldSelection<T extends Record<string, unknown>>(
  obj: T,
  fieldsParam: string | undefined | null,
  allowedFields: Set<string>
): { success: true; data: Partial<T> } | { success: false; invalidFields: string[] } {
  const fields = parseFields(fieldsParam);

  if (fields.length === 0) {
    return { success: true, data: obj };
  }

  const validation = validateFields(fields, allowedFields);
  if (!validation.valid) {
    return { success: false, invalidFields: validation.invalidFields };
  }

  return { success: true, data: selectFields(obj, fields) };
}

/**
 * Helper function to apply field selection to an array with validation.
 *
 * @param items - Array of objects to filter
 * @param fieldsParam - Comma-separated fields string from query
 * @param allowedFields - Set of valid field names
 * @returns Object with filtered array or error info
 */
export function applyFieldSelectionToArray<T extends Record<string, unknown>>(
  items: T[],
  fieldsParam: string | undefined | null,
  allowedFields: Set<string>
): { success: true; data: Partial<T>[] } | { success: false; invalidFields: string[] } {
  const fields = parseFields(fieldsParam);

  if (fields.length === 0) {
    return { success: true, data: items };
  }

  const validation = validateFields(fields, allowedFields);
  if (!validation.valid) {
    return { success: false, invalidFields: validation.invalidFields };
  }

  return { success: true, data: selectFieldsFromArray(items, fields) };
}
