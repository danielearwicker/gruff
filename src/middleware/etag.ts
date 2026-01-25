/**
 * ETag Middleware for Conditional Requests
 *
 * Provides ETag generation and conditional request handling for HTTP caching.
 * ETags are generated based on response content hash using SHA-256 (truncated).
 *
 * Features:
 * - Generates ETag header for GET responses containing data
 * - Supports If-None-Match request header for conditional requests
 * - Returns 304 Not Modified when ETag matches
 * - Uses weak ETags (W/"...") to indicate semantic equivalence
 */

import { MiddlewareHandler, Context, Next } from 'hono';

/**
 * Generate a SHA-256 hash of the content, truncated to 16 characters
 * for use as an ETag value.
 */
async function generateETag(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  // Convert to hex and truncate to 16 characters for a compact ETag
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  return hashHex.substring(0, 16);
}

/**
 * Parse the If-None-Match header to extract ETag values.
 * Supports multiple ETags separated by commas, and the wildcard '*'.
 */
function parseIfNoneMatch(header: string | undefined): string[] {
  if (!header) {
    return [];
  }

  // Handle wildcard
  if (header.trim() === '*') {
    return ['*'];
  }

  // Parse comma-separated ETags
  return header
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
    .map((tag) => {
      // Remove quotes and weak indicator if present
      // Weak ETags look like: W/"abc123"
      // Strong ETags look like: "abc123"
      const weakMatch = tag.match(/^W\/"(.*)"$/);
      if (weakMatch) {
        return weakMatch[1];
      }
      const strongMatch = tag.match(/^"(.*)"$/);
      if (strongMatch) {
        return strongMatch[1];
      }
      // Return as-is if no quotes
      return tag;
    });
}

/**
 * Check if an ETag matches any of the parsed If-None-Match values.
 */
function etagMatches(etag: string, ifNoneMatchValues: string[]): boolean {
  if (ifNoneMatchValues.includes('*')) {
    return true;
  }
  return ifNoneMatchValues.includes(etag);
}

/**
 * Options for the ETag middleware
 */
export interface ETagOptions {
  /**
   * Whether to use weak ETags (W/"...").
   * Weak ETags indicate semantic equivalence rather than byte-for-byte equivalence.
   * Default: true (recommended for JSON APIs)
   */
  weak?: boolean;

  /**
   * Skip ETag generation for responses larger than this size (in bytes).
   * Set to 0 to disable this limit.
   * Default: 1MB (1048576 bytes)
   */
  maxSize?: number;

  /**
   * Skip ETag generation for certain paths.
   * Accepts a function that takes the request path and returns true to skip.
   */
  skip?: (c: Context) => boolean;
}

const DEFAULT_OPTIONS: Required<ETagOptions> = {
  weak: true,
  maxSize: 1048576, // 1MB
  skip: () => false,
};

/**
 * ETag middleware for Hono applications.
 *
 * Adds ETag header to GET responses and handles If-None-Match conditional requests.
 * When the client sends an If-None-Match header with a matching ETag,
 * the middleware returns 304 Not Modified without the response body.
 *
 * Usage:
 * ```typescript
 * // Apply to specific routes
 * app.use('/api/entities/*', etag());
 *
 * // With custom options
 * app.use('/api/*', etag({ weak: true, maxSize: 512000 }));
 * ```
 */
export function etag(options: ETagOptions = {}): MiddlewareHandler {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  return async (c: Context, next: Next) => {
    // Only process GET and HEAD requests
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      return next();
    }

    // Check if we should skip this request
    if (opts.skip(c)) {
      return next();
    }

    // Store the original response
    await next();

    // Get the response
    const response = c.res;

    // Only process successful responses (2xx)
    if (!response || response.status < 200 || response.status >= 300) {
      return;
    }

    // Skip if response already has an ETag
    if (response.headers.has('ETag')) {
      return;
    }

    // Skip if Cache-Control indicates no-store
    const cacheControl = response.headers.get('Cache-Control');
    if (cacheControl && cacheControl.includes('no-store')) {
      return;
    }

    // Get the response body
    const body = await response.clone().text();

    // Skip if body is empty or too large
    if (!body || (opts.maxSize > 0 && body.length > opts.maxSize)) {
      return;
    }

    // Generate ETag
    const hash = await generateETag(body);
    const etagValue = opts.weak ? `W/"${hash}"` : `"${hash}"`;

    // Check If-None-Match header
    const ifNoneMatch = c.req.header('If-None-Match');
    const ifNoneMatchValues = parseIfNoneMatch(ifNoneMatch);

    if (ifNoneMatchValues.length > 0 && etagMatches(hash, ifNoneMatchValues)) {
      // ETag matches - return 304 Not Modified
      c.res = new Response(null, {
        status: 304,
        headers: {
          ETag: etagValue,
          // Preserve cache headers
          ...(cacheControl ? { 'Cache-Control': cacheControl } : {}),
        },
      });
      return;
    }

    // Add ETag header to the response
    const newHeaders = new Headers(response.headers);
    newHeaders.set('ETag', etagValue);

    c.res = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  };
}

export default etag;
