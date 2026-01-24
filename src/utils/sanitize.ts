/**
 * Sanitization utilities for XSS prevention
 *
 * This module provides functions to sanitize user input in JSON properties
 * to prevent Cross-Site Scripting (XSS) attacks. The sanitization is applied
 * to string values within JSON properties to escape HTML special characters.
 */

/**
 * HTML entities to escape for XSS prevention
 */
const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
  '/': '&#x2F;',
  '`': '&#x60;',
  '=': '&#x3D;',
};

/**
 * Regex pattern to match HTML special characters
 */
const HTML_CHARS_PATTERN = /[&<>"'`=/]/g;

/**
 * Escapes HTML special characters in a string to prevent XSS attacks
 *
 * @param str - The string to escape
 * @returns The escaped string with HTML entities
 *
 * @example
 * escapeHtml('<script>alert("xss")</script>')
 * // Returns: '&lt;script&gt;alert(&quot;xss&quot;)&lt;&#x2F;script&gt;'
 */
export function escapeHtml(str: string): string {
  if (typeof str !== 'string') {
    return str;
  }
  return str.replace(HTML_CHARS_PATTERN, (char) => HTML_ENTITIES[char] || char);
}

/**
 * Checks if a string contains potentially dangerous HTML/script content
 *
 * @param str - The string to check
 * @returns True if the string contains potentially dangerous content
 */
export function containsDangerousContent(str: string): boolean {
  if (typeof str !== 'string') {
    return false;
  }

  // Patterns that indicate potential XSS attempts
  const dangerousPatterns = [
    /<script[\s\S]*?>[\s\S]*?<\/script>/gi,
    /javascript:/gi,
    /on\w+\s*=/gi, // onclick=, onerror=, etc.
    /<iframe[\s\S]*?>/gi,
    /<object[\s\S]*?>/gi,
    /<embed[\s\S]*?>/gi,
    /<link[\s\S]*?>/gi,
    /<style[\s\S]*?>[\s\S]*?<\/style>/gi,
    /expression\s*\(/gi, // CSS expression
    /url\s*\(\s*['"]?\s*data:/gi, // data: URLs
    /vbscript:/gi,
  ];

  return dangerousPatterns.some((pattern) => pattern.test(str));
}

/**
 * Recursively sanitizes all string values in an object or array
 *
 * @param value - The value to sanitize (can be any JSON-compatible type)
 * @returns The sanitized value with all strings escaped
 *
 * @example
 * sanitizeValue({ name: '<script>xss</script>' })
 * // Returns: { name: '&lt;script&gt;xss&lt;&#x2F;script&gt;' }
 */
export function sanitizeValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return escapeHtml(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item));
  }

  if (typeof value === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      // Also sanitize the key itself
      const sanitizedKey = escapeHtml(key);
      sanitized[sanitizedKey] = sanitizeValue(val);
    }
    return sanitized;
  }

  // Numbers, booleans, etc. are returned as-is
  return value;
}

/**
 * Sanitizes JSON properties object for safe storage and rendering
 *
 * @param properties - The properties object to sanitize
 * @returns The sanitized properties object
 */
export function sanitizeProperties(
  properties: Record<string, unknown>
): Record<string, unknown> {
  if (!properties || typeof properties !== 'object') {
    return {};
  }

  return sanitizeValue(properties) as Record<string, unknown>;
}

/**
 * Validates and sanitizes user input, returning both the sanitized value
 * and any detected dangerous content
 *
 * @param value - The value to validate and sanitize
 * @returns Object containing sanitized value and any warnings
 */
export function validateAndSanitize(value: unknown): {
  sanitized: unknown;
  hadDangerousContent: boolean;
  dangerousFields: string[];
} {
  const dangerousFields: string[] = [];

  function checkAndCollect(val: unknown, path: string): unknown {
    if (val === null || val === undefined) {
      return val;
    }

    if (typeof val === 'string') {
      if (containsDangerousContent(val)) {
        dangerousFields.push(path || 'root');
      }
      return escapeHtml(val);
    }

    if (Array.isArray(val)) {
      return val.map((item, index) =>
        checkAndCollect(item, path ? `${path}[${index}]` : `[${index}]`)
      );
    }

    if (typeof val === 'object') {
      const sanitized: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(val as Record<string, unknown>)) {
        const sanitizedKey = escapeHtml(key);
        const newPath = path ? `${path}.${key}` : key;
        sanitized[sanitizedKey] = checkAndCollect(v, newPath);
      }
      return sanitized;
    }

    return val;
  }

  const sanitized = checkAndCollect(value, '');

  return {
    sanitized,
    hadDangerousContent: dangerousFields.length > 0,
    dangerousFields,
  };
}

/**
 * Strips HTML tags from a string (more aggressive than escaping)
 *
 * @param str - The string to strip tags from
 * @returns The string with all HTML tags removed
 */
export function stripHtmlTags(str: string): string {
  if (typeof str !== 'string') {
    return str;
  }
  return str.replace(/<[^>]*>/g, '');
}

/**
 * Sanitizes a URL to prevent javascript: and data: protocol attacks
 *
 * @param url - The URL to sanitize
 * @returns The sanitized URL or empty string if dangerous
 */
export function sanitizeUrl(url: string): string {
  if (typeof url !== 'string') {
    return '';
  }

  const trimmed = url.trim().toLowerCase();

  // Block dangerous protocols
  const dangerousProtocols = [
    'javascript:',
    'vbscript:',
    'data:text/html',
    'data:application/javascript',
  ];

  for (const protocol of dangerousProtocols) {
    if (trimmed.startsWith(protocol)) {
      return '';
    }
  }

  // Allow safe protocols
  const safeProtocols = ['http:', 'https:', 'mailto:', 'tel:', 'ftp:'];
  const hasProtocol = safeProtocols.some((p) => trimmed.startsWith(p));

  // If it has a protocol, it must be safe; otherwise allow relative URLs
  if (trimmed.includes(':') && !hasProtocol) {
    return '';
  }

  return url;
}
