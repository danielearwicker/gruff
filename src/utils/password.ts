/**
 * Password hashing utilities using Web Crypto API (PBKDF2)
 *
 * This module provides secure password hashing and verification functions
 * compatible with Cloudflare Workers runtime.
 */

const PBKDF2_ITERATIONS = 100000; // OWASP recommended minimum
const SALT_LENGTH = 16; // 128 bits
const KEY_LENGTH = 32; // 256 bits

/**
 * Hash a password using PBKDF2
 *
 * @param password - Plain text password to hash
 * @returns Promise<string> - Hash in format: salt:hash (both base64 encoded)
 */
export async function hashPassword(password: string): Promise<string> {
  // Generate a random salt
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));

  // Import password as a key
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );

  // Derive key using PBKDF2
  const hashBuffer = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    passwordKey,
    KEY_LENGTH * 8 // Convert bytes to bits
  );

  // Convert to base64 for storage
  const saltBase64 = btoa(String.fromCharCode(...salt));
  const hashBase64 = btoa(String.fromCharCode(...new Uint8Array(hashBuffer)));

  // Store as salt:hash
  return `${saltBase64}:${hashBase64}`;
}

/**
 * Verify a password against a stored hash
 *
 * @param password - Plain text password to verify
 * @param storedHash - Hash in format: salt:hash (both base64 encoded)
 * @returns Promise<boolean> - True if password matches, false otherwise
 */
export async function verifyPassword(
  password: string,
  storedHash: string
): Promise<boolean> {
  try {
    // Parse the stored hash
    const [saltBase64, hashBase64] = storedHash.split(':');
    if (!saltBase64 || !hashBase64) {
      return false;
    }

    // Decode salt from base64
    const salt = Uint8Array.from(atob(saltBase64), (c) => c.charCodeAt(0));

    // Import password as a key
    const passwordKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(password),
      { name: 'PBKDF2' },
      false,
      ['deriveBits']
    );

    // Derive key using PBKDF2 with the stored salt
    const hashBuffer = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: salt,
        iterations: PBKDF2_ITERATIONS,
        hash: 'SHA-256',
      },
      passwordKey,
      KEY_LENGTH * 8
    );

    // Convert to base64 for comparison
    const computedHashBase64 = btoa(
      String.fromCharCode(...new Uint8Array(hashBuffer))
    );

    // Constant-time comparison to prevent timing attacks
    return timingSafeEqual(computedHashBase64, hashBase64);
  } catch (error) {
    // If any error occurs during verification, return false
    return false;
  }
}

/**
 * Timing-safe string comparison
 * Prevents timing attacks by ensuring comparison takes constant time
 *
 * @param a - First string
 * @param b - Second string
 * @returns boolean - True if strings are equal
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}
