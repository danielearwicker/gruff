/**
 * KV-based session store for managing refresh tokens and user sessions
 *
 * This module provides session management functionality using Cloudflare KV
 * for storing refresh tokens with TTL. Supports token invalidation for logout.
 */

import { TOKEN_EXPIRY } from './jwt.js';

/**
 * Session data stored in KV
 */
export interface SessionData {
  userId: string;
  email: string;
  refreshToken: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * Session store configuration
 */
export interface SessionConfig {
  refreshTokenTtl?: number; // TTL in seconds, defaults to REFRESH_TOKEN_EXPIRY
  keyPrefix?: string; // Prefix for KV keys, defaults to 'session:'
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Required<SessionConfig> = {
  refreshTokenTtl: TOKEN_EXPIRY.REFRESH,
  keyPrefix: 'session:',
};

/**
 * Generate a session key from user ID
 *
 * @param userId - User ID
 * @param prefix - Optional key prefix
 * @returns Session key for KV storage
 */
function getSessionKey(userId: string, prefix: string = DEFAULT_CONFIG.keyPrefix): string {
  return `${prefix}${userId}`;
}

/**
 * Store a refresh token in KV
 *
 * @param kv - KV namespace binding
 * @param userId - User ID
 * @param email - User email
 * @param refreshToken - Refresh token to store
 * @param config - Optional configuration
 * @returns Promise<void>
 */
export async function storeRefreshToken(
  kv: KVNamespace,
  userId: string,
  email: string,
  refreshToken: string,
  config?: SessionConfig
): Promise<void> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const now = Date.now();

  const sessionData: SessionData = {
    userId,
    email,
    refreshToken,
    createdAt: now,
    expiresAt: now + (mergedConfig.refreshTokenTtl * 1000),
  };

  const key = getSessionKey(userId, mergedConfig.keyPrefix);

  // Store in KV with TTL
  await kv.put(key, JSON.stringify(sessionData), {
    expirationTtl: mergedConfig.refreshTokenTtl,
  });
}

/**
 * Retrieve a session by user ID
 *
 * @param kv - KV namespace binding
 * @param userId - User ID
 * @param config - Optional configuration
 * @returns Promise<SessionData | null> - Session data if found and valid, null otherwise
 */
export async function getSession(
  kv: KVNamespace,
  userId: string,
  config?: SessionConfig
): Promise<SessionData | null> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const key = getSessionKey(userId, mergedConfig.keyPrefix);

  const value = await kv.get(key);

  if (!value) {
    return null;
  }

  try {
    const sessionData = JSON.parse(value) as SessionData;

    // Validate that the session hasn't expired (double-check beyond KV TTL)
    const now = Date.now();
    if (sessionData.expiresAt < now) {
      // Session expired, delete it
      await invalidateSession(kv, userId, config);
      return null;
    }

    return sessionData;
  } catch (error) {
    // Invalid JSON, delete the corrupted session
    await invalidateSession(kv, userId, config);
    return null;
  }
}

/**
 * Validate a refresh token against stored session
 *
 * @param kv - KV namespace binding
 * @param userId - User ID
 * @param refreshToken - Refresh token to validate
 * @param config - Optional configuration
 * @returns Promise<boolean> - True if token is valid, false otherwise
 */
export async function validateRefreshToken(
  kv: KVNamespace,
  userId: string,
  refreshToken: string,
  config?: SessionConfig
): Promise<boolean> {
  const session = await getSession(kv, userId, config);

  if (!session) {
    return false;
  }

  // Timing-safe comparison to prevent timing attacks
  return timingSafeEqual(session.refreshToken, refreshToken);
}

/**
 * Invalidate a session (logout)
 *
 * @param kv - KV namespace binding
 * @param userId - User ID
 * @param config - Optional configuration
 * @returns Promise<void>
 */
export async function invalidateSession(
  kv: KVNamespace,
  userId: string,
  config?: SessionConfig
): Promise<void> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const key = getSessionKey(userId, mergedConfig.keyPrefix);

  await kv.delete(key);
}

/**
 * Update a session with a new refresh token (token rotation)
 *
 * @param kv - KV namespace binding
 * @param userId - User ID
 * @param newRefreshToken - New refresh token to store
 * @param config - Optional configuration
 * @returns Promise<boolean> - True if session was updated, false if session not found
 */
export async function rotateRefreshToken(
  kv: KVNamespace,
  userId: string,
  newRefreshToken: string,
  config?: SessionConfig
): Promise<boolean> {
  const session = await getSession(kv, userId, config);

  if (!session) {
    return false;
  }

  // Update the session with new token
  await storeRefreshToken(kv, session.userId, session.email, newRefreshToken, config);

  return true;
}

/**
 * List all active sessions for a user (in case of multiple devices/sessions)
 * Note: This is a simplified version. For multi-device support, you'd need
 * to modify the key structure to support multiple sessions per user.
 *
 * @param kv - KV namespace binding
 * @param userId - User ID
 * @param config - Optional configuration
 * @returns Promise<SessionData[]> - Array of active sessions
 */
export async function getUserSessions(
  kv: KVNamespace,
  userId: string,
  config?: SessionConfig
): Promise<SessionData[]> {
  const session = await getSession(kv, userId, config);

  return session ? [session] : [];
}

/**
 * Clean up expired sessions (manual cleanup function)
 * Note: KV automatically handles expiration via TTL, so this is mainly
 * for administrative purposes or edge cases.
 *
 * @param kv - KV namespace binding
 * @param userId - User ID
 * @param config - Optional configuration
 * @returns Promise<number> - Number of sessions cleaned up
 */
export async function cleanupExpiredSessions(
  kv: KVNamespace,
  userId: string,
  config?: SessionConfig
): Promise<number> {
  const session = await getSession(kv, userId, config);

  if (!session) {
    return 0;
  }

  const now = Date.now();
  if (session.expiresAt < now) {
    await invalidateSession(kv, userId, config);
    return 1;
  }

  return 0;
}

/**
 * Timing-safe string comparison to prevent timing attacks
 * Uses crypto.subtle.timingSafeEqual if available, otherwise falls back
 * to a constant-time comparison.
 *
 * @param a - First string
 * @param b - Second string
 * @returns boolean - True if strings are equal
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  // Convert strings to Uint8Arrays for comparison
  const encoder = new TextEncoder();
  const bufferA = encoder.encode(a);
  const bufferB = encoder.encode(b);

  // XOR all bytes and check if result is 0
  let result = 0;
  for (let i = 0; i < bufferA.length; i++) {
    result |= bufferA[i] ^ bufferB[i];
  }

  return result === 0;
}
