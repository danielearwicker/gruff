/**
 * Sensitive Data Protection Utilities
 *
 * This module provides utilities for protecting sensitive data:
 * - Token hashing for secure storage
 * - Sensitive data redaction for logging
 * - Environment secrets validation
 */

/**
 * List of keys that should be considered sensitive and redacted from logs
 * Case-insensitive matching is used
 */
const SENSITIVE_KEYS = [
  'password',
  'password_hash',
  'passwordHash',
  'secret',
  'token',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'jwt',
  'apiKey',
  'api_key',
  'apiSecret',
  'api_secret',
  'authorization',
  'auth',
  'credential',
  'credentials',
  'private',
  'privateKey',
  'private_key',
  'ssn',
  'social_security',
  'credit_card',
  'creditCard',
  'cvv',
  'pin',
];

/**
 * Redacted value placeholder
 */
const REDACTED = '[REDACTED]';

/**
 * Hash a token for secure storage using SHA-256
 * This creates a one-way hash that can be used for comparison but not reversed
 *
 * @param token - The token to hash
 * @returns Promise<string> - Base64-encoded hash of the token
 */
export async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);

  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);

  // Convert to base64 for storage
  return btoa(String.fromCharCode(...hashArray));
}

/**
 * Verify a token against a stored hash
 *
 * @param token - The token to verify
 * @param storedHash - The stored hash to compare against
 * @returns Promise<boolean> - True if the token matches the hash
 */
export async function verifyTokenHash(token: string, storedHash: string): Promise<boolean> {
  const computedHash = await hashToken(token);

  // Timing-safe comparison to prevent timing attacks
  return timingSafeEqual(computedHash, storedHash);
}

/**
 * Check if a key name suggests sensitive data
 *
 * @param key - The key name to check
 * @returns boolean - True if the key is likely sensitive
 */
function isSensitiveKey(key: string): boolean {
  const lowerKey = key.toLowerCase();
  return SENSITIVE_KEYS.some((sensitiveKey) => lowerKey.includes(sensitiveKey.toLowerCase()));
}

/**
 * Redact sensitive data from an object for safe logging
 * This recursively processes objects and arrays, replacing sensitive values
 *
 * @param data - The data to redact
 * @param maxDepth - Maximum recursion depth (default: 10)
 * @returns The data with sensitive values redacted
 */
export function redactSensitiveData<T>(data: T, maxDepth: number = 10): T {
  if (maxDepth <= 0) {
    return data;
  }

  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === 'string') {
    // Check if the string looks like a JWT (three base64 parts separated by dots)
    if (isJwtLike(data)) {
      return REDACTED as T;
    }
    // Check if the string looks like a bearer token
    if (data.toLowerCase().startsWith('bearer ')) {
      return `Bearer ${REDACTED}` as T;
    }
    return data;
  }

  if (typeof data !== 'object') {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => redactSensitiveData(item, maxDepth - 1)) as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      // Redact sensitive values but preserve type info
      if (typeof value === 'string') {
        result[key] = REDACTED;
      } else if (value !== null && value !== undefined) {
        result[key] = REDACTED;
      } else {
        result[key] = value;
      }
    } else {
      result[key] = redactSensitiveData(value, maxDepth - 1);
    }
  }

  return result as T;
}

/**
 * Check if a string looks like a JWT token
 *
 * @param str - The string to check
 * @returns boolean - True if the string looks like a JWT
 */
function isJwtLike(str: string): boolean {
  // JWT format: header.payload.signature (three base64url parts)
  const parts = str.split('.');
  if (parts.length !== 3) {
    return false;
  }

  // Check if all parts look like base64url
  const base64UrlRegex = /^[A-Za-z0-9_-]+$/;
  return parts.every((part) => part.length > 0 && base64UrlRegex.test(part));
}

/**
 * Redact sensitive headers from request/response objects
 *
 * @param headers - Headers object or map
 * @returns Redacted headers object
 */
export function redactHeaders(
  headers: Headers | Record<string, string> | Map<string, string>
): Record<string, string> {
  const sensitiveHeaders = ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token'];

  const result: Record<string, string> = {};

  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      if (sensitiveHeaders.includes(key.toLowerCase())) {
        result[key] = REDACTED;
      } else {
        result[key] = value;
      }
    });
  } else if (headers instanceof Map) {
    headers.forEach((value, key) => {
      if (sensitiveHeaders.includes(key.toLowerCase())) {
        result[key] = REDACTED;
      } else {
        result[key] = value;
      }
    });
  } else {
    for (const [key, value] of Object.entries(headers)) {
      if (sensitiveHeaders.includes(key.toLowerCase())) {
        result[key] = REDACTED;
      } else {
        result[key] = value;
      }
    }
  }

  return result;
}

/**
 * Environment variable validation configuration
 */
export interface EnvValidationConfig {
  required: string[];
  optional?: string[];
  minLength?: Record<string, number>;
}

/**
 * Environment validation result
 */
export interface EnvValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate required environment variables at startup
 * This helps catch configuration errors early
 *
 * @param env - Environment bindings object
 * @param config - Validation configuration
 * @returns Validation result with errors and warnings
 */
export function validateEnvironment(
  env: Record<string, unknown>,
  config: EnvValidationConfig
): EnvValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check required variables
  for (const key of config.required) {
    if (env[key] === undefined || env[key] === null || env[key] === '') {
      errors.push(`Missing required environment variable: ${key}`);
    }
  }

  // Check minimum length requirements
  if (config.minLength) {
    for (const [key, minLen] of Object.entries(config.minLength)) {
      const value = env[key];
      if (typeof value === 'string' && value.length < minLen) {
        errors.push(`Environment variable ${key} must be at least ${minLen} characters`);
      }
    }
  }

  // Check for potentially insecure development values in production
  const environment = env['ENVIRONMENT'] as string | undefined;
  if (environment === 'production') {
    // Check JWT_SECRET for weak values
    const jwtSecret = env['JWT_SECRET'] as string | undefined;
    if (jwtSecret) {
      if (jwtSecret.includes('dev') || jwtSecret.includes('test') || jwtSecret.includes('local')) {
        errors.push('JWT_SECRET appears to contain development/test values in production');
      }
      if (jwtSecret.length < 32) {
        errors.push('JWT_SECRET should be at least 32 characters in production');
      }
    }
  }

  // Check for common configuration warnings
  if (env['ENVIRONMENT'] === 'development' || !env['ENVIRONMENT']) {
    warnings.push('Running in development mode - ensure this is intentional');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Default environment validation configuration for the Gruff API
 */
export const DEFAULT_ENV_VALIDATION: EnvValidationConfig = {
  required: ['JWT_SECRET'],
  optional: ['ENVIRONMENT', 'ALLOWED_ORIGINS'],
  minLength: {
    JWT_SECRET: 16,
  },
};

/**
 * Timing-safe string comparison to prevent timing attacks
 *
 * @param a - First string
 * @param b - Second string
 * @returns boolean - True if strings are equal
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  const encoder = new TextEncoder();
  const bufferA = encoder.encode(a);
  const bufferB = encoder.encode(b);

  let result = 0;
  for (let i = 0; i < bufferA.length; i++) {
    result |= bufferA[i] ^ bufferB[i];
  }

  return result === 0;
}

/**
 * Create a safe log context by redacting sensitive data
 * Use this when passing user data or request data to logger
 *
 * @param context - The context object to make safe
 * @returns A new object with sensitive data redacted
 */
export function safeLogContext<T extends Record<string, unknown>>(context: T): T {
  return redactSensitiveData(context);
}

/**
 * Mask a sensitive string for display purposes
 * Shows first and last few characters with asterisks in between
 *
 * @param value - The value to mask
 * @param showChars - Number of characters to show at start and end (default: 4)
 * @returns Masked string
 */
export function maskSensitiveValue(value: string, showChars: number = 4): string {
  if (!value || value.length <= showChars * 2) {
    return '*'.repeat(value?.length || 8);
  }

  const start = value.slice(0, showChars);
  const end = value.slice(-showChars);
  const middle = '*'.repeat(Math.min(value.length - showChars * 2, 8));

  return `${start}${middle}${end}`;
}
