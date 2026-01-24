import { MiddlewareHandler, Context } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';

/**
 * Security Headers Configuration
 *
 * Implements common HTTP security headers to protect against various attacks:
 * - HSTS: Forces HTTPS connections
 * - X-Frame-Options: Prevents clickjacking
 * - X-Content-Type-Options: Prevents MIME type sniffing
 * - Content-Security-Policy: Controls resource loading
 * - X-XSS-Protection: Legacy XSS protection
 * - Referrer-Policy: Controls referrer information
 * - Permissions-Policy: Controls browser feature access
 *
 * Note: Cloudflare provides automatic HTTPS enforcement and DDoS protection
 */

export interface SecurityConfig {
  /**
   * Allowed origins for CORS requests.
   * Can be a string, array of strings, or a function that returns allowed origins.
   * Default: '*' (all origins) - should be restricted in production
   */
  allowedOrigins?: string | string[] | ((origin: string, c: Context) => string | undefined | null);

  /**
   * Allowed HTTP methods for CORS requests.
   * Default: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
   */
  allowedMethods?: string[];

  /**
   * Allowed headers in CORS requests.
   * Default: ['Content-Type', 'Authorization', 'X-Request-ID']
   */
  allowedHeaders?: string[];

  /**
   * Headers exposed to the client in CORS responses.
   * Default: ['X-Request-ID', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset']
   */
  exposedHeaders?: string[];

  /**
   * Whether to allow credentials in CORS requests.
   * Default: true
   */
  allowCredentials?: boolean;

  /**
   * Max age in seconds for CORS preflight cache.
   * Default: 86400 (24 hours)
   */
  maxAge?: number;

  /**
   * Max age in seconds for HSTS header.
   * Default: 31536000 (1 year)
   */
  hstsMaxAge?: number;

  /**
   * Whether to include subdomains in HSTS.
   * Default: true
   */
  hstsIncludeSubdomains?: boolean;

  /**
   * Whether to preload HSTS in browsers.
   * Default: false (requires careful consideration)
   */
  hstsPreload?: boolean;

  /**
   * Content Security Policy directive string.
   * Default: A strict policy suitable for APIs
   */
  contentSecurityPolicy?: string;

  /**
   * Whether to enable frame embedding protection.
   * Default: 'DENY' - prevents all framing
   */
  frameOptions?: 'DENY' | 'SAMEORIGIN';

  /**
   * Referrer policy for the application.
   * Default: 'strict-origin-when-cross-origin'
   */
  referrerPolicy?: string;
}

const DEFAULT_CONFIG: Required<SecurityConfig> = {
  allowedOrigins: '*',
  allowedMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
  exposedHeaders: ['X-Request-ID', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
  allowCredentials: true,
  maxAge: 86400,
  hstsMaxAge: 31536000,
  hstsIncludeSubdomains: true,
  hstsPreload: false,
  contentSecurityPolicy: "default-src 'none'; frame-ancestors 'none'",
  frameOptions: 'DENY',
  referrerPolicy: 'strict-origin-when-cross-origin',
};

/**
 * Creates a CORS middleware with the specified configuration.
 *
 * @param config - Security configuration options
 * @returns Hono middleware handler for CORS
 */
export function createCorsMiddleware(config: SecurityConfig = {}): MiddlewareHandler {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  return cors({
    origin: mergedConfig.allowedOrigins as string | string[],
    allowMethods: mergedConfig.allowedMethods,
    allowHeaders: mergedConfig.allowedHeaders,
    exposeHeaders: mergedConfig.exposedHeaders,
    credentials: mergedConfig.allowCredentials,
    maxAge: mergedConfig.maxAge,
  });
}

/**
 * Creates a security headers middleware using Hono's secureHeaders.
 *
 * This middleware adds various security-related HTTP headers to responses:
 * - Strict-Transport-Security (HSTS)
 * - X-Content-Type-Options
 * - X-Frame-Options
 * - X-XSS-Protection
 * - Content-Security-Policy
 * - Referrer-Policy
 * - Permissions-Policy
 *
 * @param config - Security configuration options
 * @returns Hono middleware handler for security headers
 */
export function createSecurityHeadersMiddleware(config: SecurityConfig = {}): MiddlewareHandler {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  // Build HSTS value
  let hstsValue = `max-age=${mergedConfig.hstsMaxAge}`;
  if (mergedConfig.hstsIncludeSubdomains) {
    hstsValue += '; includeSubDomains';
  }
  if (mergedConfig.hstsPreload) {
    hstsValue += '; preload';
  }

  return secureHeaders({
    strictTransportSecurity: hstsValue,
    xContentTypeOptions: 'nosniff',
    xFrameOptions: mergedConfig.frameOptions,
    xXssProtection: '1; mode=block',
    contentSecurityPolicy: mergedConfig.contentSecurityPolicy,
    referrerPolicy: mergedConfig.referrerPolicy,
    permissionsPolicy: {
      // Restrict browser features for API endpoints
      camera: [],
      microphone: [],
      geolocation: [],
      payment: [],
      usb: [],
      fullscreen: [],
    },
  });
}

/**
 * Combined security middleware that applies both CORS and security headers.
 * This is a convenience function for applying all security middleware at once.
 *
 * @param config - Security configuration options
 * @returns Array of Hono middleware handlers
 */
export function createSecurityMiddleware(config: SecurityConfig = {}): MiddlewareHandler[] {
  return [
    createCorsMiddleware(config),
    createSecurityHeadersMiddleware(config),
  ];
}

/**
 * Production-ready security configuration.
 * Use this for production deployments with stricter settings.
 *
 * Note: You should customize allowedOrigins for your specific domains.
 *
 * @param allowedOrigins - Origins allowed for CORS requests
 * @returns Security configuration for production
 */
export function getProductionSecurityConfig(allowedOrigins: string | string[]): SecurityConfig {
  return {
    allowedOrigins,
    allowCredentials: true,
    hstsMaxAge: 31536000, // 1 year
    hstsIncludeSubdomains: true,
    hstsPreload: true,
    contentSecurityPolicy: "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    frameOptions: 'DENY',
    referrerPolicy: 'strict-origin-when-cross-origin',
  };
}

/**
 * Development-friendly security configuration.
 * Less restrictive settings for local development.
 *
 * @returns Security configuration for development
 */
export function getDevelopmentSecurityConfig(): SecurityConfig {
  return {
    allowedOrigins: '*',
    allowCredentials: true,
    hstsMaxAge: 0, // Disable HSTS in development
    hstsIncludeSubdomains: false,
    hstsPreload: false,
    // More permissive CSP for development with Scalar docs UI
    contentSecurityPolicy: "default-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: https:; frame-ancestors 'self'",
    frameOptions: 'SAMEORIGIN',
    referrerPolicy: 'no-referrer-when-downgrade',
  };
}
