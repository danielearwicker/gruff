/**
 * Rate Limiting Middleware
 *
 * Provides per-user rate limiting on API endpoints using Cloudflare KV
 * for distributed tracking. Supports configurable limits per endpoint category.
 */

import { Context, Next } from 'hono';
import {
  checkRateLimit,
  getRateLimitIdentifier,
  getEndpointCategory,
  RateLimitConfig,
  RateLimitResult,
  DEFAULT_RATE_LIMITS,
} from '../utils/rate-limit.js';
import { getLogger } from './request-context.js';
import * as response from '../utils/response.js';

type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  JWT_SECRET: string;
  ENVIRONMENT: string;
};

/**
 * Rate limit middleware options
 */
export interface RateLimitMiddlewareOptions {
  /** Override the auto-detected category */
  category?: string;
  /** Custom rate limit configuration */
  config?: Partial<RateLimitConfig>;
  /** Skip rate limiting for certain conditions (e.g., admin users) */
  skip?: (c: Context) => boolean | Promise<boolean>;
  /** Custom identifier extractor (defaults to user ID or IP) */
  getIdentifier?: (c: Context) => string | Promise<string>;
}

/**
 * Standard rate limit headers
 */
function setRateLimitHeaders(c: Context, result: RateLimitResult): void {
  c.header('X-RateLimit-Limit', result.limit.toString());
  c.header('X-RateLimit-Remaining', result.remaining.toString());
  c.header('X-RateLimit-Reset', Math.ceil(result.resetAt / 1000).toString());
}

/**
 * Get client IP address from request
 *
 * Attempts to get the real client IP from various headers used by
 * Cloudflare and other proxies.
 */
function getClientIP(c: Context): string {
  // Cloudflare's connecting IP header (most reliable when using CF)
  const cfConnectingIP = c.req.header('CF-Connecting-IP');
  if (cfConnectingIP) {
    return cfConnectingIP;
  }

  // Standard X-Forwarded-For header
  const forwardedFor = c.req.header('X-Forwarded-For');
  if (forwardedFor) {
    // X-Forwarded-For can contain multiple IPs, the first is the client
    const ips = forwardedFor.split(',').map((ip) => ip.trim());
    if (ips.length > 0 && ips[0]) {
      return ips[0];
    }
  }

  // X-Real-IP header (used by some proxies)
  const realIP = c.req.header('X-Real-IP');
  if (realIP) {
    return realIP;
  }

  // Fallback to unknown
  return 'unknown';
}

/**
 * Rate limiting middleware factory
 *
 * Creates middleware that enforces rate limits based on endpoint category.
 * Automatically detects category from request path and method if not specified.
 *
 * @param options - Middleware configuration options
 * @returns Hono middleware function
 *
 * @example
 * // Apply default rate limiting based on endpoint category
 * app.use('/api/*', rateLimit());
 *
 * @example
 * // Apply custom rate limit
 * app.use('/api/expensive-operation', rateLimit({
 *   category: 'bulk',
 *   config: { maxRequests: 10, windowSeconds: 60 }
 * }));
 */
export function rateLimit(options: RateLimitMiddlewareOptions = {}) {
  return async (c: Context<{ Bindings: Bindings }>, next: Next) => {
    const logger = getLogger(c);

    // Check if rate limiting should be skipped
    if (options.skip) {
      const shouldSkip = await options.skip(c);
      if (shouldSkip) {
        await next();
        return;
      }
    }

    // Get identifier (user ID or IP)
    let identifier: string;
    if (options.getIdentifier) {
      identifier = await options.getIdentifier(c);
    } else {
      // Get user ID from context if authenticated
      const user = c.get('user');
      const userId = user?.user_id;
      const ip = getClientIP(c);
      identifier = getRateLimitIdentifier(userId, ip);
    }

    // Determine endpoint category
    const category = options.category || getEndpointCategory(c.req.method, c.req.path);

    // Check rate limit with environment-aware limits
    const result = await checkRateLimit(c.env.KV, identifier, category, options.config, c.env.ENVIRONMENT);

    // Set rate limit headers on all responses
    setRateLimitHeaders(c, result);

    if (!result.allowed) {
      logger.warn('Rate limit exceeded', {
        identifier,
        category,
        limit: result.limit,
        resetAt: new Date(result.resetAt).toISOString(),
      });

      // Add Retry-After header for 429 responses
      c.header('Retry-After', result.retryAfter.toString());

      return c.json(
        response.error(
          'Rate limit exceeded. Please try again later.',
          'RATE_LIMIT_EXCEEDED',
          {
            limit: result.limit,
            remaining: result.remaining,
            resetAt: new Date(result.resetAt).toISOString(),
            retryAfter: result.retryAfter,
          }
        ),
        429
      );
    }

    logger.debug('Rate limit check passed', {
      identifier,
      category,
      remaining: result.remaining,
      limit: result.limit,
    });

    await next();
  };
}

/**
 * Strict rate limiting middleware for sensitive endpoints
 *
 * Pre-configured with stricter limits suitable for authentication
 * endpoints or other sensitive operations.
 *
 * @param config - Optional override configuration
 * @returns Hono middleware function
 */
export function strictRateLimit(config?: Partial<RateLimitConfig>) {
  return rateLimit({
    category: 'auth',
    config: {
      maxRequests: 10,
      windowSeconds: 60,
      ...config,
    },
  });
}

/**
 * Get the default rate limits configuration
 *
 * Useful for documentation or introspection
 */
export function getDefaultRateLimits(): Record<string, RateLimitConfig> {
  return { ...DEFAULT_RATE_LIMITS };
}
