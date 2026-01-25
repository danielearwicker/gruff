/**
 * KV-based session store for managing refresh tokens and user sessions
 *
 * This module provides session management functionality using Cloudflare KV
 * for storing refresh tokens with TTL. Supports token invalidation for logout.
 *
 * SECURITY: Refresh tokens are hashed (SHA-256) before storage to protect
 * against data breaches. The actual token is never stored in plain text.
 */

import { TOKEN_EXPIRY } from './jwt.js';
import { hashToken, verifyTokenHash } from './sensitive-data.js';

/**
 * Session data stored in KV
 * Note: refreshTokenHash stores a SHA-256 hash, not the actual token
 */
export interface SessionData {
  userId: string;
  email: string;
  refreshTokenHash: string; // SHA-256 hash of the refresh token
  createdAt: number;
  expiresAt: number;
}

/**
 * Legacy session data format (for backward compatibility during migration)
 * @deprecated Will be removed in future version
 */
interface LegacySessionData {
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
 * SECURITY: The refresh token is hashed using SHA-256 before storage.
 * The actual token is never stored in plain text, protecting against
 * data breaches. Validation is done by comparing hashes.
 *
 * @param kv - KV namespace binding
 * @param userId - User ID
 * @param email - User email
 * @param refreshToken - Refresh token to store (will be hashed)
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

  // Hash the refresh token for secure storage
  const refreshTokenHash = await hashToken(refreshToken);

  const sessionData: SessionData = {
    userId,
    email,
    refreshTokenHash,
    createdAt: now,
    expiresAt: now + mergedConfig.refreshTokenTtl * 1000,
  };

  const key = getSessionKey(userId, mergedConfig.keyPrefix);

  // Store in KV with TTL
  await kv.put(key, JSON.stringify(sessionData), {
    expirationTtl: mergedConfig.refreshTokenTtl,
  });
}

/**
 * Check if session data is in legacy format (has refreshToken instead of refreshTokenHash)
 */
function isLegacySession(data: unknown): data is LegacySessionData {
  return (
    typeof data === 'object' &&
    data !== null &&
    'refreshToken' in data &&
    !('refreshTokenHash' in data)
  );
}

/**
 * Retrieve a session by user ID
 *
 * Handles both new (hashed) and legacy (plain) session formats for backward
 * compatibility during migration. Legacy sessions will be upgraded on next
 * token rotation.
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
    const parsed = JSON.parse(value);

    // Handle legacy format (plain text refresh token)
    // This provides backward compatibility during migration
    if (isLegacySession(parsed)) {
      // Return a compatible format - the validateRefreshToken function
      // will handle legacy validation appropriately
      return {
        userId: parsed.userId,
        email: parsed.email,
        refreshTokenHash: parsed.refreshToken, // Legacy: this is actually the plain token
        createdAt: parsed.createdAt,
        expiresAt: parsed.expiresAt,
        // Mark as legacy for special handling in validation
        _legacy: true,
      } as SessionData & { _legacy?: boolean };
    }

    const sessionData = parsed as SessionData;

    // Validate that the session hasn't expired (double-check beyond KV TTL)
    const now = Date.now();
    if (sessionData.expiresAt < now) {
      // Session expired, delete it
      await invalidateSession(kv, userId, config);
      return null;
    }

    return sessionData;
  } catch {
    // Invalid JSON, delete the corrupted session
    await invalidateSession(kv, userId, config);
    return null;
  }
}

/**
 * Validate a refresh token against stored session
 *
 * SECURITY: Uses hash-based comparison to validate tokens without storing
 * the actual token. Also supports legacy plain-text comparison for backward
 * compatibility during migration period.
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
  const session = (await getSession(kv, userId, config)) as
    | (SessionData & { _legacy?: boolean })
    | null;

  if (!session) {
    return false;
  }

  // Handle legacy sessions (plain text comparison) for backward compatibility
  if (session._legacy) {
    // For legacy sessions, refreshTokenHash actually contains the plain token
    return timingSafeEqual(session.refreshTokenHash, refreshToken);
  }

  // New format: verify against hash
  return verifyTokenHash(refreshToken, session.refreshTokenHash);
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
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const key = getSessionKey(userId, mergedConfig.keyPrefix);

  // Get session directly from KV without auto-deleting via getSession
  const value = await kv.get(key);
  if (!value) {
    return 0;
  }

  try {
    const sessionData = JSON.parse(value) as SessionData;
    const now = Date.now();

    // Check if session is expired
    if (sessionData.expiresAt < now) {
      await invalidateSession(kv, userId, config);
      return 1;
    }
  } catch {
    // Invalid JSON, delete it
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
