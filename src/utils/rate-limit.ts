/**
 * KV-based Rate Limiting Utility
 *
 * Implements sliding window rate limiting using Cloudflare KV.
 * Supports per-user and per-IP rate limiting with configurable limits
 * per endpoint category.
 */

/**
 * Rate limit configuration for an endpoint category
 */
export interface RateLimitConfig {
  /** Maximum number of requests allowed in the window */
  maxRequests: number;
  /** Time window in seconds */
  windowSeconds: number;
  /** Key prefix for KV storage (defaults to 'ratelimit:') */
  keyPrefix?: string;
}

/**
 * Production rate limit configurations by endpoint category
 */
const PRODUCTION_RATE_LIMITS: Record<string, RateLimitConfig> = {
  // Authentication endpoints - more restrictive to prevent brute force
  auth: {
    maxRequests: 20,
    windowSeconds: 60, // 20 requests per minute
  },
  // Read operations - more lenient
  read: {
    maxRequests: 100,
    windowSeconds: 60, // 100 requests per minute
  },
  // Write operations - moderate limits
  write: {
    maxRequests: 60,
    windowSeconds: 60, // 60 requests per minute
  },
  // Bulk operations - more restrictive
  bulk: {
    maxRequests: 20,
    windowSeconds: 60, // 20 requests per minute
  },
  // Search operations - moderate limits
  search: {
    maxRequests: 60,
    windowSeconds: 60, // 60 requests per minute
  },
  // Graph traversal - more restrictive due to complexity
  graph: {
    maxRequests: 40,
    windowSeconds: 60, // 40 requests per minute
  },
  // Default fallback
  default: {
    maxRequests: 60,
    windowSeconds: 60, // 60 requests per minute
  },
};

/**
 * Development rate limit configurations - more lenient for local testing
 */
const DEVELOPMENT_RATE_LIMITS: Record<string, RateLimitConfig> = {
  auth: {
    maxRequests: 1000,
    windowSeconds: 60, // Very lenient for testing
  },
  read: {
    maxRequests: 1000,
    windowSeconds: 60,
  },
  write: {
    maxRequests: 1000,
    windowSeconds: 60,
  },
  bulk: {
    maxRequests: 1000,
    windowSeconds: 60,
  },
  search: {
    maxRequests: 1000,
    windowSeconds: 60,
  },
  graph: {
    maxRequests: 1000,
    windowSeconds: 60,
  },
  default: {
    maxRequests: 1000,
    windowSeconds: 60,
  },
};

/**
 * Default rate limit configurations by endpoint category
 * Uses production limits by default, can be overridden for development
 */
export const DEFAULT_RATE_LIMITS: Record<string, RateLimitConfig> = PRODUCTION_RATE_LIMITS;

/**
 * Get rate limit configuration based on environment
 *
 * @param environment - Environment name (e.g., 'development', 'production')
 * @returns Rate limit configuration for the environment
 */
export function getRateLimitsForEnvironment(environment?: string): Record<string, RateLimitConfig> {
  if (environment === 'development') {
    return DEVELOPMENT_RATE_LIMITS;
  }
  return PRODUCTION_RATE_LIMITS;
}

/**
 * Rate limit tracking data stored in KV
 */
export interface RateLimitData {
  /** Number of requests in current window */
  count: number;
  /** Window start timestamp (Unix ms) */
  windowStart: number;
}

/**
 * Result of a rate limit check
 */
export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Number of requests remaining in current window */
  remaining: number;
  /** Maximum requests allowed in window */
  limit: number;
  /** Timestamp when the rate limit resets (Unix ms) */
  resetAt: number;
  /** Seconds until reset */
  retryAfter: number;
}

/**
 * Default configuration values
 */
const DEFAULT_KEY_PREFIX = 'ratelimit:';

/**
 * Generate a rate limit key for KV storage
 *
 * @param identifier - User ID or IP address
 * @param category - Endpoint category (e.g., 'auth', 'read', 'write')
 * @param prefix - Optional key prefix
 * @returns Rate limit key for KV storage
 */
function getRateLimitKey(
  identifier: string,
  category: string,
  prefix: string = DEFAULT_KEY_PREFIX
): string {
  return `${prefix}${category}:${identifier}`;
}

/**
 * Check and update rate limit for an identifier
 *
 * Uses sliding window algorithm:
 * - If current time is within the window, increment count
 * - If current time is past the window, reset the window
 *
 * @param kv - KV namespace binding
 * @param identifier - User ID or IP address
 * @param category - Endpoint category
 * @param config - Rate limit configuration (defaults to category config or default)
 * @param environment - Environment name for selecting appropriate limits
 * @returns Rate limit result with allowed status and metadata
 */
export async function checkRateLimit(
  kv: KVNamespace,
  identifier: string,
  category: string,
  config?: Partial<RateLimitConfig>,
  environment?: string
): Promise<RateLimitResult> {
  // Get environment-specific rate limits
  const envLimits = getRateLimitsForEnvironment(environment);
  const categoryConfig = envLimits[category] || envLimits.default;

  const mergedConfig: RateLimitConfig = {
    ...categoryConfig,
    ...config,
    keyPrefix: config?.keyPrefix ?? DEFAULT_KEY_PREFIX,
  };

  const key = getRateLimitKey(identifier, category, mergedConfig.keyPrefix);
  const now = Date.now();
  const windowMs = mergedConfig.windowSeconds * 1000;

  // Get current rate limit data
  const value = await kv.get(key);
  let data: RateLimitData;

  if (!value) {
    // First request - initialize new window
    data = {
      count: 0,
      windowStart: now,
    };
  } else {
    try {
      data = JSON.parse(value) as RateLimitData;
    } catch {
      // Invalid data - reset
      data = {
        count: 0,
        windowStart: now,
      };
    }
  }

  // Check if we're still in the same window
  const windowEnd = data.windowStart + windowMs;

  if (now >= windowEnd) {
    // Window expired - reset
    data = {
      count: 0,
      windowStart: now,
    };
  }

  // Calculate reset time
  const resetAt = data.windowStart + windowMs;
  const retryAfter = Math.max(0, Math.ceil((resetAt - now) / 1000));

  // Check if request is allowed
  const allowed = data.count < mergedConfig.maxRequests;
  const remaining = Math.max(0, mergedConfig.maxRequests - data.count - (allowed ? 1 : 0));

  if (allowed) {
    // Increment count
    data.count += 1;

    // Calculate TTL - time until window expires plus small buffer
    const ttl = Math.ceil((resetAt - now) / 1000) + 5;

    // Store updated data
    // Cloudflare KV requires minimum 60 second TTL
    await kv.put(key, JSON.stringify(data), {
      expirationTtl: Math.max(ttl, 60),
    });
  }

  return {
    allowed,
    remaining,
    limit: mergedConfig.maxRequests,
    resetAt,
    retryAfter,
  };
}

/**
 * Get current rate limit status without incrementing
 *
 * @param kv - KV namespace binding
 * @param identifier - User ID or IP address
 * @param category - Endpoint category
 * @param config - Rate limit configuration
 * @returns Current rate limit status
 */
export async function getRateLimitStatus(
  kv: KVNamespace,
  identifier: string,
  category: string,
  config?: Partial<RateLimitConfig>
): Promise<RateLimitResult> {
  const categoryConfig = DEFAULT_RATE_LIMITS[category] || DEFAULT_RATE_LIMITS.default;
  const mergedConfig: RateLimitConfig = {
    ...categoryConfig,
    ...config,
    keyPrefix: config?.keyPrefix ?? DEFAULT_KEY_PREFIX,
  };

  const key = getRateLimitKey(identifier, category, mergedConfig.keyPrefix);
  const now = Date.now();
  const windowMs = mergedConfig.windowSeconds * 1000;

  const value = await kv.get(key);

  if (!value) {
    // No rate limit data - full quota available
    return {
      allowed: true,
      remaining: mergedConfig.maxRequests,
      limit: mergedConfig.maxRequests,
      resetAt: now + windowMs,
      retryAfter: mergedConfig.windowSeconds,
    };
  }

  try {
    const data = JSON.parse(value) as RateLimitData;
    const windowEnd = data.windowStart + windowMs;

    if (now >= windowEnd) {
      // Window expired - full quota available
      return {
        allowed: true,
        remaining: mergedConfig.maxRequests,
        limit: mergedConfig.maxRequests,
        resetAt: now + windowMs,
        retryAfter: mergedConfig.windowSeconds,
      };
    }

    const remaining = Math.max(0, mergedConfig.maxRequests - data.count);
    const retryAfter = Math.max(0, Math.ceil((windowEnd - now) / 1000));

    return {
      allowed: remaining > 0,
      remaining,
      limit: mergedConfig.maxRequests,
      resetAt: windowEnd,
      retryAfter,
    };
  } catch {
    // Invalid data - full quota available
    return {
      allowed: true,
      remaining: mergedConfig.maxRequests,
      limit: mergedConfig.maxRequests,
      resetAt: now + windowMs,
      retryAfter: mergedConfig.windowSeconds,
    };
  }
}

/**
 * Reset rate limit for an identifier
 *
 * @param kv - KV namespace binding
 * @param identifier - User ID or IP address
 * @param category - Endpoint category
 * @param prefix - Optional key prefix
 */
export async function resetRateLimit(
  kv: KVNamespace,
  identifier: string,
  category: string,
  prefix: string = DEFAULT_KEY_PREFIX
): Promise<void> {
  const key = getRateLimitKey(identifier, category, prefix);
  await kv.delete(key);
}

/**
 * Get the identifier for rate limiting from request context
 *
 * Prioritizes user ID if authenticated, falls back to IP address
 *
 * @param userId - Authenticated user ID (optional)
 * @param ip - Client IP address
 * @returns Identifier string for rate limiting
 */
export function getRateLimitIdentifier(userId?: string, ip?: string): string {
  if (userId) {
    return `user:${userId}`;
  }

  // Fallback to IP address
  if (ip) {
    return `ip:${ip}`;
  }

  // Last resort - use unknown identifier
  return 'ip:unknown';
}

/**
 * Determine endpoint category from request path and method
 *
 * @param method - HTTP method
 * @param path - Request path
 * @returns Endpoint category for rate limiting
 */
export function getEndpointCategory(method: string, path: string): string {
  // Authentication endpoints
  if (path.startsWith('/api/auth')) {
    return 'auth';
  }

  // Bulk operations
  if (path.startsWith('/api/bulk')) {
    return 'bulk';
  }

  // Search operations
  if (path.startsWith('/api/search')) {
    return 'search';
  }

  // Graph operations
  if (path.startsWith('/api/graph')) {
    return 'graph';
  }

  // Export/Import operations (treat like bulk)
  if (path.startsWith('/api/export')) {
    return method === 'GET' ? 'read' : 'bulk';
  }

  // Read operations (GET, HEAD, OPTIONS)
  if (['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) {
    return 'read';
  }

  // Write operations (POST, PUT, PATCH, DELETE)
  return 'write';
}
