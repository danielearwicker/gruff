/**
 * JWT Authentication Middleware
 *
 * Handles extraction and validation of JWT tokens from Authorization headers
 */

import { Context, Next } from 'hono';
import { verifyAccessToken } from '../utils/jwt.js';
import * as response from '../utils/response.js';
import { getLogger } from './request-context.js';
import { JwtPayload } from '../schemas/user.js';

type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  JWT_SECRET: string;
  ENVIRONMENT: string;
};

/**
 * Extend Hono context to include authenticated user
 */
declare module 'hono' {
  interface ContextVariableMap {
    user: JwtPayload;
  }
}

/**
 * Extract JWT token from Authorization header
 * Expects format: "Bearer <token>"
 */
function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) {
    return null;
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return null;
  }

  return parts[1];
}

/**
 * JWT Authentication Middleware
 *
 * Validates JWT from Authorization header and attaches user context to request.
 * Returns 401 if token is missing, invalid, or expired.
 */
export function requireAuth() {
  return async (c: Context<{ Bindings: Bindings }>, next: Next) => {
    const logger = getLogger(c);

    // Extract token from Authorization header
    const authHeader = c.req.header('Authorization');
    const token = extractBearerToken(authHeader);

    if (!token) {
      logger.warn('Missing or invalid Authorization header');
      return c.json(
        response.error('Missing or invalid Authorization header', 'UNAUTHORIZED'),
        401
      );
    }

    // Get JWT secret from environment
    const jwtSecret = c.env.JWT_SECRET;
    if (!jwtSecret) {
      logger.error('JWT_SECRET not configured');
      return c.json(
        response.error('Server configuration error', 'CONFIG_ERROR'),
        500
      );
    }

    // Verify the access token
    const payload = await verifyAccessToken(token, jwtSecret);

    if (!payload) {
      logger.warn('Invalid or expired JWT token');
      return c.json(
        response.error('Invalid or expired token', 'INVALID_TOKEN'),
        401
      );
    }

    // Attach user context to the request
    c.set('user', payload);

    logger.debug('User authenticated', { userId: payload.user_id });

    // Continue to the next handler
    await next();
  };
}

/**
 * Optional JWT Authentication Middleware
 *
 * Similar to requireAuth, but doesn't fail if token is missing.
 * Useful for endpoints that can work with or without authentication.
 */
export function optionalAuth() {
  return async (c: Context<{ Bindings: Bindings }>, next: Next) => {
    const logger = getLogger(c);

    // Extract token from Authorization header
    const authHeader = c.req.header('Authorization');
    const token = extractBearerToken(authHeader);

    if (!token) {
      // No token provided, continue without authentication
      await next();
      return;
    }

    // Get JWT secret from environment
    const jwtSecret = c.env.JWT_SECRET;
    if (!jwtSecret) {
      logger.error('JWT_SECRET not configured');
      // Continue without authentication rather than failing
      await next();
      return;
    }

    // Verify the access token
    const payload = await verifyAccessToken(token, jwtSecret);

    if (payload) {
      // Attach user context to the request
      c.set('user', payload);
      logger.debug('User authenticated (optional)', { userId: payload.user_id });
    } else {
      logger.debug('Invalid token provided for optional auth');
    }

    // Continue to the next handler regardless of token validity
    await next();
  };
}
