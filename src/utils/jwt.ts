/**
 * JWT token service using Web Crypto API
 *
 * This module provides JWT creation and validation functions compatible
 * with Cloudflare Workers runtime. Uses HMAC-SHA256 for signing.
 */

import { JwtPayload } from '../schemas/user.js';

// Token expiration times (in seconds)
const ACCESS_TOKEN_EXPIRY = 15 * 60; // 15 minutes
const REFRESH_TOKEN_EXPIRY = 7 * 24 * 60 * 60; // 7 days

/**
 * JWT configuration interface
 */
export interface JwtConfig {
  accessTokenExpiry?: number;
  refreshTokenExpiry?: number;
}

/**
 * Token pair returned by createTokenPair
 */
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/**
 * Custom JWT payload with refresh token flag
 */
interface JwtPayloadInternal extends JwtPayload {
  refresh?: boolean;
}

/**
 * Options for token creation
 */
export interface TokenCreationOptions {
  isAdmin?: boolean;
}

/**
 * Base64 URL encoding (RFC 4648)
 * Converts base64 to URL-safe format
 */
function base64UrlEncode(data: ArrayBuffer | Uint8Array): string {
  const uint8Array = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = '';
  for (let i = 0; i < uint8Array.length; i++) {
    binary += String.fromCharCode(uint8Array[i]);
  }
  const base64 = btoa(binary);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Base64 URL decoding
 * Converts URL-safe base64 back to standard base64 and decodes
 */
function base64UrlDecode(data: string): Uint8Array {
  // Add padding if needed
  const padded = data + '=='.substring(0, (4 - (data.length % 4)) % 4);
  const base64 = padded.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

/**
 * Get or import the JWT signing key from environment
 * Creates a CryptoKey from the JWT_SECRET environment variable
 */
async function getSigningKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);

  return await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

/**
 * Create a JWT token
 *
 * @param payload - JWT payload object
 * @param secret - Secret key for signing
 * @param expiresIn - Token expiration time in seconds
 * @returns Promise<string> - Signed JWT token
 */
async function createToken(
  payload: JwtPayloadInternal,
  secret: string,
  _expiresIn: number
): Promise<string> {
  // Create header
  const header = {
    alg: 'HS256',
    typ: 'JWT',
  };

  // Encode header and payload
  const encoder = new TextEncoder();
  const headerEncoded = base64UrlEncode(encoder.encode(JSON.stringify(header)));
  const payloadEncoded = base64UrlEncode(encoder.encode(JSON.stringify(payload)));

  // Create signature
  const data = `${headerEncoded}.${payloadEncoded}`;
  const signingKey = await getSigningKey(secret);
  const signature = await crypto.subtle.sign('HMAC', signingKey, encoder.encode(data));
  const signatureEncoded = base64UrlEncode(signature);

  return `${data}.${signatureEncoded}`;
}

/**
 * Verify and decode a JWT token (internal function)
 *
 * @param token - JWT token to verify
 * @param secret - Secret key for verification
 * @returns Promise<JwtPayloadInternal | null> - Decoded payload if valid, null otherwise
 */
async function verifyToken(token: string, secret: string): Promise<JwtPayloadInternal | null> {
  try {
    // Split token into parts
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }

    const [headerEncoded, payloadEncoded, signatureEncoded] = parts;

    // Verify signature
    const data = `${headerEncoded}.${payloadEncoded}`;
    const encoder = new TextEncoder();
    const signingKey = await getSigningKey(secret);
    const signature = base64UrlDecode(signatureEncoded);

    const isValid = await crypto.subtle.verify(
      'HMAC',
      signingKey,
      signature.buffer as ArrayBuffer,
      encoder.encode(data)
    );

    if (!isValid) {
      return null;
    }

    // Decode and parse payload
    const payloadData = base64UrlDecode(payloadEncoded);
    const payloadJson = new TextDecoder().decode(payloadData);
    const payload = JSON.parse(payloadJson) as JwtPayloadInternal;

    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return null;
    }

    // Return the full internal payload (including refresh flag)
    return payload;
  } catch {
    return null;
  }
}

/**
 * Create an access token
 *
 * @param userId - User ID
 * @param email - User email
 * @param secret - JWT secret from environment
 * @param config - Optional configuration
 * @param options - Optional token creation options (e.g., isAdmin)
 * @returns Promise<string> - Signed access token
 */
export async function createAccessToken(
  userId: string,
  email: string,
  secret: string,
  config?: JwtConfig,
  options?: TokenCreationOptions
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = config?.accessTokenExpiry ?? ACCESS_TOKEN_EXPIRY;

  // Generate a random jti (JWT ID) to ensure tokens are unique even at the same second
  const jti =
    Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

  const payload: JwtPayloadInternal = {
    user_id: userId,
    email: email,
    is_admin: options?.isAdmin ?? false,
    iat: now,
    exp: now + expiresIn,
    jti,
  };

  return await createToken(payload, secret, expiresIn);
}

/**
 * Create a refresh token
 *
 * @param userId - User ID
 * @param email - User email
 * @param secret - JWT secret from environment
 * @param config - Optional configuration
 * @param options - Optional token creation options (e.g., isAdmin)
 * @returns Promise<string> - Signed refresh token
 */
export async function createRefreshToken(
  userId: string,
  email: string,
  secret: string,
  config?: JwtConfig,
  options?: TokenCreationOptions
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = config?.refreshTokenExpiry ?? REFRESH_TOKEN_EXPIRY;

  const payload: JwtPayloadInternal = {
    user_id: userId,
    email: email,
    is_admin: options?.isAdmin ?? false,
    iat: now,
    exp: now + expiresIn,
    refresh: true, // Mark this as a refresh token
  };

  return await createToken(payload, secret, expiresIn);
}

/**
 * Create both access and refresh tokens
 *
 * @param userId - User ID
 * @param email - User email
 * @param secret - JWT secret from environment
 * @param config - Optional configuration
 * @param options - Optional token creation options (e.g., isAdmin)
 * @returns Promise<TokenPair> - Access and refresh tokens with expiry
 */
export async function createTokenPair(
  userId: string,
  email: string,
  secret: string,
  config?: JwtConfig,
  options?: TokenCreationOptions
): Promise<TokenPair> {
  const [accessToken, refreshToken] = await Promise.all([
    createAccessToken(userId, email, secret, config, options),
    createRefreshToken(userId, email, secret, config, options),
  ]);

  return {
    accessToken,
    refreshToken,
    expiresIn: config?.accessTokenExpiry ?? ACCESS_TOKEN_EXPIRY,
  };
}

/**
 * Verify an access token
 *
 * @param token - JWT token to verify
 * @param secret - JWT secret from environment
 * @returns Promise<JwtPayload | null> - Decoded payload if valid, null otherwise
 */
export async function verifyAccessToken(token: string, secret: string): Promise<JwtPayload | null> {
  const payload = await verifyToken(token, secret);

  // Ensure this is not a refresh token
  if (payload && payload.refresh) {
    return null;
  }

  // Remove the refresh flag before returning
  if (payload) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { refresh, ...publicPayload } = payload;
    return publicPayload as JwtPayload;
  }

  return null;
}

/**
 * Verify a refresh token
 *
 * @param token - JWT token to verify
 * @param secret - JWT secret from environment
 * @returns Promise<JwtPayload | null> - Decoded payload if valid, null otherwise
 */
export async function verifyRefreshToken(
  token: string,
  secret: string
): Promise<JwtPayload | null> {
  const payload = await verifyToken(token, secret);

  // Ensure this is a refresh token
  if (!payload || !payload.refresh) {
    return null;
  }

  // Remove the refresh flag before returning
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { refresh, ...publicPayload } = payload;
  return publicPayload as JwtPayload;
}

/**
 * Decode a JWT token without verification (for debugging purposes only)
 * WARNING: This does not verify the signature or expiration
 *
 * @param token - JWT token to decode
 * @returns JwtPayload | null - Decoded payload if parseable, null otherwise
 */
export function decodeToken(token: string): JwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }

    const payloadData = base64UrlDecode(parts[1]);
    const payloadJson = new TextDecoder().decode(payloadData);
    const payload = JSON.parse(payloadJson) as JwtPayloadInternal;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { refresh, ...publicPayload } = payload;
    return publicPayload as JwtPayload;
  } catch {
    return null;
  }
}

/**
 * Get expiration constants
 */
export const TOKEN_EXPIRY = {
  ACCESS: ACCESS_TOKEN_EXPIRY,
  REFRESH: REFRESH_TOKEN_EXPIRY,
} as const;
