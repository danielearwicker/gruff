import { describe, it, expect } from 'vitest';
import {
  createAccessToken,
  createRefreshToken,
  createTokenPair,
  verifyAccessToken,
  verifyRefreshToken,
  decodeToken,
  TOKEN_EXPIRY,
} from '../../src/utils/jwt.js';

describe('JWT Token Service', () => {
  const TEST_SECRET = 'test-secret-key-for-jwt-signing-minimum-32-chars';
  const TEST_USER_ID = '123e4567-e89b-12d3-a456-426614174000';
  const TEST_EMAIL = 'test@example.com';

  describe('createAccessToken', () => {
    it('should create a valid access token', async () => {
      const token = await createAccessToken(
        TEST_USER_ID,
        TEST_EMAIL,
        TEST_SECRET
      );

      expect(token).toBeTruthy();
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3); // JWT has 3 parts
    });

    it('should include user_id and email in payload', async () => {
      const token = await createAccessToken(
        TEST_USER_ID,
        TEST_EMAIL,
        TEST_SECRET
      );

      const decoded = decodeToken(token);
      expect(decoded).toBeTruthy();
      expect(decoded?.user_id).toBe(TEST_USER_ID);
      expect(decoded?.email).toBe(TEST_EMAIL);
    });

    it('should include iat and exp timestamps', async () => {
      const beforeCreate = Math.floor(Date.now() / 1000);
      const token = await createAccessToken(
        TEST_USER_ID,
        TEST_EMAIL,
        TEST_SECRET
      );
      const afterCreate = Math.floor(Date.now() / 1000);

      const decoded = decodeToken(token);
      expect(decoded).toBeTruthy();
      expect(decoded!.iat).toBeGreaterThanOrEqual(beforeCreate);
      expect(decoded!.iat).toBeLessThanOrEqual(afterCreate);
      expect(decoded!.exp).toBe(decoded!.iat + TOKEN_EXPIRY.ACCESS);
    });

    it('should support custom expiry time', async () => {
      const customExpiry = 3600; // 1 hour
      const token = await createAccessToken(
        TEST_USER_ID,
        TEST_EMAIL,
        TEST_SECRET,
        { accessTokenExpiry: customExpiry }
      );

      const decoded = decodeToken(token);
      expect(decoded).toBeTruthy();
      expect(decoded!.exp).toBe(decoded!.iat + customExpiry);
    });
  });

  describe('createRefreshToken', () => {
    it('should create a valid refresh token', async () => {
      const token = await createRefreshToken(
        TEST_USER_ID,
        TEST_EMAIL,
        TEST_SECRET
      );

      expect(token).toBeTruthy();
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3);
    });

    it('should have longer expiry than access token', async () => {
      const token = await createRefreshToken(
        TEST_USER_ID,
        TEST_EMAIL,
        TEST_SECRET
      );

      const decoded = decodeToken(token);
      expect(decoded).toBeTruthy();
      expect(decoded!.exp).toBe(decoded!.iat + TOKEN_EXPIRY.REFRESH);
      expect(TOKEN_EXPIRY.REFRESH).toBeGreaterThan(TOKEN_EXPIRY.ACCESS);
    });

    it('should support custom expiry time', async () => {
      const customExpiry = 86400; // 1 day
      const token = await createRefreshToken(
        TEST_USER_ID,
        TEST_EMAIL,
        TEST_SECRET,
        { refreshTokenExpiry: customExpiry }
      );

      const decoded = decodeToken(token);
      expect(decoded).toBeTruthy();
      expect(decoded!.exp).toBe(decoded!.iat + customExpiry);
    });
  });

  describe('createTokenPair', () => {
    it('should create both access and refresh tokens', async () => {
      const result = await createTokenPair(
        TEST_USER_ID,
        TEST_EMAIL,
        TEST_SECRET
      );

      expect(result.accessToken).toBeTruthy();
      expect(result.refreshToken).toBeTruthy();
      expect(result.expiresIn).toBe(TOKEN_EXPIRY.ACCESS);
    });

    it('should create different tokens', async () => {
      const result = await createTokenPair(
        TEST_USER_ID,
        TEST_EMAIL,
        TEST_SECRET
      );

      expect(result.accessToken).not.toBe(result.refreshToken);
    });

    it('should include user data in both tokens', async () => {
      const result = await createTokenPair(
        TEST_USER_ID,
        TEST_EMAIL,
        TEST_SECRET
      );

      const accessDecoded = decodeToken(result.accessToken);
      const refreshDecoded = decodeToken(result.refreshToken);

      expect(accessDecoded?.user_id).toBe(TEST_USER_ID);
      expect(refreshDecoded?.user_id).toBe(TEST_USER_ID);
      expect(accessDecoded?.email).toBe(TEST_EMAIL);
      expect(refreshDecoded?.email).toBe(TEST_EMAIL);
    });
  });

  describe('verifyAccessToken', () => {
    it('should verify a valid access token', async () => {
      const token = await createAccessToken(
        TEST_USER_ID,
        TEST_EMAIL,
        TEST_SECRET
      );

      const payload = await verifyAccessToken(token, TEST_SECRET);

      expect(payload).toBeTruthy();
      expect(payload?.user_id).toBe(TEST_USER_ID);
      expect(payload?.email).toBe(TEST_EMAIL);
    });

    it('should reject a token with invalid signature', async () => {
      const token = await createAccessToken(
        TEST_USER_ID,
        TEST_EMAIL,
        TEST_SECRET
      );

      const payload = await verifyAccessToken(token, 'wrong-secret');

      expect(payload).toBeNull();
    });

    it('should reject a malformed token', async () => {
      const payload = await verifyAccessToken('invalid.token', TEST_SECRET);

      expect(payload).toBeNull();
    });

    it('should reject a token with only 2 parts', async () => {
      const payload = await verifyAccessToken('header.payload', TEST_SECRET);

      expect(payload).toBeNull();
    });

    it('should reject a refresh token', async () => {
      const refreshToken = await createRefreshToken(
        TEST_USER_ID,
        TEST_EMAIL,
        TEST_SECRET
      );

      const payload = await verifyAccessToken(refreshToken, TEST_SECRET);

      expect(payload).toBeNull();
    });

    it('should reject an expired token', async () => {
      // Create a token that expires immediately
      const token = await createAccessToken(
        TEST_USER_ID,
        TEST_EMAIL,
        TEST_SECRET,
        { accessTokenExpiry: -1 } // Already expired
      );

      const payload = await verifyAccessToken(token, TEST_SECRET);

      expect(payload).toBeNull();
    });
  });

  describe('verifyRefreshToken', () => {
    it('should verify a valid refresh token', async () => {
      const token = await createRefreshToken(
        TEST_USER_ID,
        TEST_EMAIL,
        TEST_SECRET
      );

      const payload = await verifyRefreshToken(token, TEST_SECRET);

      expect(payload).toBeTruthy();
      expect(payload?.user_id).toBe(TEST_USER_ID);
      expect(payload?.email).toBe(TEST_EMAIL);
    });

    it('should reject an access token', async () => {
      const accessToken = await createAccessToken(
        TEST_USER_ID,
        TEST_EMAIL,
        TEST_SECRET
      );

      const payload = await verifyRefreshToken(accessToken, TEST_SECRET);

      expect(payload).toBeNull();
    });

    it('should reject a token with invalid signature', async () => {
      const token = await createRefreshToken(
        TEST_USER_ID,
        TEST_EMAIL,
        TEST_SECRET
      );

      const payload = await verifyRefreshToken(token, 'wrong-secret');

      expect(payload).toBeNull();
    });

    it('should reject an expired token', async () => {
      const token = await createRefreshToken(
        TEST_USER_ID,
        TEST_EMAIL,
        TEST_SECRET,
        { refreshTokenExpiry: -1 }
      );

      const payload = await verifyRefreshToken(token, TEST_SECRET);

      expect(payload).toBeNull();
    });
  });

  describe('decodeToken', () => {
    it('should decode a token without verification', async () => {
      const token = await createAccessToken(
        TEST_USER_ID,
        TEST_EMAIL,
        TEST_SECRET
      );

      const decoded = decodeToken(token);

      expect(decoded).toBeTruthy();
      expect(decoded?.user_id).toBe(TEST_USER_ID);
      expect(decoded?.email).toBe(TEST_EMAIL);
    });

    it('should decode even with wrong secret (no verification)', async () => {
      const token = await createAccessToken(
        TEST_USER_ID,
        TEST_EMAIL,
        TEST_SECRET
      );

      // decodeToken doesn't need the secret
      const decoded = decodeToken(token);

      expect(decoded).toBeTruthy();
      expect(decoded?.user_id).toBe(TEST_USER_ID);
    });

    it('should return null for malformed token', () => {
      const decoded = decodeToken('invalid.token');

      expect(decoded).toBeNull();
    });

    it('should return null for non-JWT string', () => {
      const decoded = decodeToken('not-a-jwt');

      expect(decoded).toBeNull();
    });
  });

  describe('Token security', () => {
    it('should produce different signatures for different secrets', async () => {
      const token1 = await createAccessToken(
        TEST_USER_ID,
        TEST_EMAIL,
        'secret-one'
      );
      const token2 = await createAccessToken(
        TEST_USER_ID,
        TEST_EMAIL,
        'secret-two'
      );

      // Tokens should have different signatures (3rd part)
      const sig1 = token1.split('.')[2];
      const sig2 = token2.split('.')[2];

      expect(sig1).not.toBe(sig2);
    });

    it('should produce different tokens for same user at different times', async () => {
      const token1 = await createAccessToken(
        TEST_USER_ID,
        TEST_EMAIL,
        TEST_SECRET
      );

      // Wait a moment to ensure different timestamp
      await new Promise((resolve) => setTimeout(resolve, 10));

      const token2 = await createAccessToken(
        TEST_USER_ID,
        TEST_EMAIL,
        TEST_SECRET
      );

      expect(token1).not.toBe(token2);
    });

    it('should not expose the refresh flag in decoded payload', async () => {
      const refreshToken = await createRefreshToken(
        TEST_USER_ID,
        TEST_EMAIL,
        TEST_SECRET
      );

      const payload = decodeToken(refreshToken);

      expect(payload).toBeTruthy();
      expect((payload as Record<string, unknown>).refresh).toBeUndefined();
    });
  });

  describe('Edge cases', () => {
    it('should handle empty string token', async () => {
      const payload = await verifyAccessToken('', TEST_SECRET);

      expect(payload).toBeNull();
    });

    it('should handle token with extra dots', async () => {
      const payload = await verifyAccessToken(
        'header.payload.signature.extra',
        TEST_SECRET
      );

      expect(payload).toBeNull();
    });

    it('should handle very long user IDs and emails', async () => {
      const longUserId = 'a'.repeat(255);
      const longEmail = 'a'.repeat(240) + '@example.com';

      const token = await createAccessToken(longUserId, longEmail, TEST_SECRET);
      const payload = await verifyAccessToken(token, TEST_SECRET);

      expect(payload).toBeTruthy();
      expect(payload?.user_id).toBe(longUserId);
      expect(payload?.email).toBe(longEmail);
    });
  });

  describe('TOKEN_EXPIRY constants', () => {
    it('should export expiry constants', () => {
      expect(TOKEN_EXPIRY.ACCESS).toBe(15 * 60); // 15 minutes
      expect(TOKEN_EXPIRY.REFRESH).toBe(7 * 24 * 60 * 60); // 7 days
    });

    it('should have refresh token expiry greater than access token', () => {
      expect(TOKEN_EXPIRY.REFRESH).toBeGreaterThan(TOKEN_EXPIRY.ACCESS);
    });
  });
});
