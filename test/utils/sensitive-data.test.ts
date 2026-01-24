import { describe, it, expect } from 'vitest';
import {
  hashToken,
  verifyTokenHash,
  redactSensitiveData,
  redactHeaders,
  validateEnvironment,
  safeLogContext,
  maskSensitiveValue,
  DEFAULT_ENV_VALIDATION,
  type EnvValidationConfig,
} from '../../src/utils/sensitive-data.js';

describe('Sensitive Data Protection', () => {
  describe('hashToken', () => {
    it('should hash a token to a consistent output', async () => {
      const token = 'my-secret-token-12345';
      const hash1 = await hashToken(token);
      const hash2 = await hashToken(token);

      expect(hash1).toBe(hash2);
      expect(hash1).not.toBe(token);
    });

    it('should produce different hashes for different tokens', async () => {
      const token1 = 'token-1';
      const token2 = 'token-2';

      const hash1 = await hashToken(token1);
      const hash2 = await hashToken(token2);

      expect(hash1).not.toBe(hash2);
    });

    it('should produce a base64-encoded hash', async () => {
      const token = 'test-token';
      const hash = await hashToken(token);

      // Base64 pattern (may contain +, /, and = for padding)
      expect(hash).toMatch(/^[A-Za-z0-9+/]+=*$/);
    });

    it('should handle empty string', async () => {
      const hash = await hashToken('');
      expect(hash).toBeTruthy();
      expect(hash.length).toBeGreaterThan(0);
    });

    it('should handle very long tokens', async () => {
      const longToken = 'a'.repeat(10000);
      const hash = await hashToken(longToken);
      expect(hash).toBeTruthy();
      // SHA-256 always produces 32 bytes = 44 base64 characters (with padding)
      expect(hash.length).toBe(44);
    });

    it('should handle unicode characters', async () => {
      const unicodeToken = '🔐secret-token-πτ';
      const hash = await hashToken(unicodeToken);
      expect(hash).toBeTruthy();
    });
  });

  describe('verifyTokenHash', () => {
    it('should verify a matching token and hash', async () => {
      const token = 'my-secret-token';
      const hash = await hashToken(token);

      const isValid = await verifyTokenHash(token, hash);
      expect(isValid).toBe(true);
    });

    it('should reject a non-matching token', async () => {
      const token = 'my-secret-token';
      const hash = await hashToken(token);

      const isValid = await verifyTokenHash('wrong-token', hash);
      expect(isValid).toBe(false);
    });

    it('should reject an incorrect hash', async () => {
      const token = 'my-secret-token';

      const isValid = await verifyTokenHash(token, 'invalid-hash');
      expect(isValid).toBe(false);
    });

    it('should handle edge cases', async () => {
      const token = 'test';
      const hash = await hashToken(token);

      // Similar tokens should not match
      expect(await verifyTokenHash('tes', hash)).toBe(false);
      expect(await verifyTokenHash('test ', hash)).toBe(false);
      expect(await verifyTokenHash('Test', hash)).toBe(false);
    });
  });

  describe('redactSensitiveData', () => {
    it('should redact password fields', () => {
      const data = {
        username: 'john',
        password: 'secret123',
        email: 'john@example.com',
      };

      const redacted = redactSensitiveData(data);

      expect(redacted.username).toBe('john');
      expect(redacted.password).toBe('[REDACTED]');
      expect(redacted.email).toBe('john@example.com');
    });

    it('should redact token fields', () => {
      const data = {
        userId: '123',
        accessToken: 'eyJhbGc...',
        refreshToken: 'abc123...',
        apiKey: 'key-12345',
      };

      const redacted = redactSensitiveData(data);

      expect(redacted.userId).toBe('123');
      expect(redacted.accessToken).toBe('[REDACTED]');
      expect(redacted.refreshToken).toBe('[REDACTED]');
      expect(redacted.apiKey).toBe('[REDACTED]');
    });

    it('should handle nested objects', () => {
      const data = {
        user: {
          name: 'John',
          credentials: {
            password: 'secret',
            token: 'abc123',
          },
        },
      };

      const redacted = redactSensitiveData(data);

      expect(redacted.user.name).toBe('John');
      expect(redacted.user.credentials.password).toBe('[REDACTED]');
      expect(redacted.user.credentials.token).toBe('[REDACTED]');
    });

    it('should handle arrays', () => {
      const data = {
        users: [
          { name: 'John', password: 'secret1' },
          { name: 'Jane', password: 'secret2' },
        ],
      };

      const redacted = redactSensitiveData(data);

      expect(redacted.users[0].name).toBe('John');
      expect(redacted.users[0].password).toBe('[REDACTED]');
      expect(redacted.users[1].name).toBe('Jane');
      expect(redacted.users[1].password).toBe('[REDACTED]');
    });

    it('should redact JWT-like strings', () => {
      const jwtToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const data = {
        message: 'Here is your token',
        rawToken: jwtToken,
      };

      const redacted = redactSensitiveData(data);

      expect(redacted.message).toBe('Here is your token');
      expect(redacted.rawToken).toBe('[REDACTED]');
    });

    it('should redact Bearer token prefix', () => {
      const data = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

      const redacted = redactSensitiveData(data);

      expect(redacted).toBe('Bearer [REDACTED]');
    });

    it('should handle null and undefined', () => {
      expect(redactSensitiveData(null)).toBeNull();
      expect(redactSensitiveData(undefined)).toBeUndefined();
    });

    it('should handle primitives', () => {
      expect(redactSensitiveData(42)).toBe(42);
      expect(redactSensitiveData('hello')).toBe('hello');
      expect(redactSensitiveData(true)).toBe(true);
    });

    it('should handle case-insensitive key matching', () => {
      const data = {
        PASSWORD: 'secret1',
        Password: 'secret2',
        user_password: 'secret3',
        PasswordHash: 'hash123',
      };

      const redacted = redactSensitiveData(data);

      expect(redacted.PASSWORD).toBe('[REDACTED]');
      expect(redacted.Password).toBe('[REDACTED]');
      expect(redacted.user_password).toBe('[REDACTED]');
      expect(redacted.PasswordHash).toBe('[REDACTED]');
    });

    it('should respect max depth', () => {
      const deepData = {
        level1: {
          level2: {
            level3: {
              password: 'should-be-redacted',
            },
          },
        },
      };

      // With depth of 2, level3 should not be processed
      const redactedShallow = redactSensitiveData(deepData, 2);
      // The shallow redaction should stop at level2
      expect(redactedShallow.level1.level2).toEqual(deepData.level1.level2);

      // With depth of 10, all levels should be processed
      const redactedDeep = redactSensitiveData(deepData, 10);
      expect(redactedDeep.level1.level2.level3.password).toBe('[REDACTED]');
    });
  });

  describe('redactHeaders', () => {
    it('should redact authorization header', () => {
      const headers = {
        'Content-Type': 'application/json',
        Authorization: 'Bearer secret-token',
        'Accept': 'application/json',
      };

      const redacted = redactHeaders(headers);

      expect(redacted['Content-Type']).toBe('application/json');
      expect(redacted['Authorization']).toBe('[REDACTED]');
      expect(redacted['Accept']).toBe('application/json');
    });

    it('should redact cookie headers', () => {
      const headers = {
        'Cookie': 'session=abc123; user=john',
        'Set-Cookie': 'session=xyz789',
      };

      const redacted = redactHeaders(headers);

      expect(redacted['Cookie']).toBe('[REDACTED]');
      expect(redacted['Set-Cookie']).toBe('[REDACTED]');
    });

    it('should redact api key headers', () => {
      const headers = {
        'X-Api-Key': 'secret-api-key',
        'X-Auth-Token': 'auth-token-123',
      };

      const redacted = redactHeaders(headers);

      expect(redacted['X-Api-Key']).toBe('[REDACTED]');
      expect(redacted['X-Auth-Token']).toBe('[REDACTED]');
    });

    it('should handle Headers object', () => {
      const headers = new Headers();
      headers.set('Content-Type', 'application/json');
      headers.set('Authorization', 'Bearer token');

      const redacted = redactHeaders(headers);

      expect(redacted['content-type']).toBe('application/json');
      expect(redacted['authorization']).toBe('[REDACTED]');
    });

    it('should handle Map', () => {
      const headers = new Map<string, string>();
      headers.set('Content-Type', 'application/json');
      headers.set('Authorization', 'Bearer token');

      const redacted = redactHeaders(headers);

      expect(redacted['Content-Type']).toBe('application/json');
      expect(redacted['Authorization']).toBe('[REDACTED]');
    });
  });

  describe('validateEnvironment', () => {
    it('should pass validation with all required vars', () => {
      const env = {
        JWT_SECRET: 'a-long-secret-key-for-testing',
        ENVIRONMENT: 'development',
      };

      const result = validateEnvironment(env, DEFAULT_ENV_VALIDATION);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should fail validation with missing required vars', () => {
      const env = {
        ENVIRONMENT: 'development',
      };

      const result = validateEnvironment(env, DEFAULT_ENV_VALIDATION);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing required environment variable: JWT_SECRET');
    });

    it('should fail validation when secret is too short', () => {
      const env = {
        JWT_SECRET: 'short',
        ENVIRONMENT: 'development',
      };

      const result = validateEnvironment(env, DEFAULT_ENV_VALIDATION);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('at least 16 characters'))).toBe(true);
    });

    it('should fail with dev secret in production', () => {
      const env = {
        JWT_SECRET: 'dev-secret-key-that-is-long-enough',
        ENVIRONMENT: 'production',
      };

      const result = validateEnvironment(env, DEFAULT_ENV_VALIDATION);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('development/test'))).toBe(true);
    });

    it('should fail with short secret in production', () => {
      const env = {
        JWT_SECRET: 'short-but-ok-for-testing',
        ENVIRONMENT: 'production',
      };

      const result = validateEnvironment(env, DEFAULT_ENV_VALIDATION);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('at least 32 characters'))).toBe(true);
    });

    it('should add warning for development mode', () => {
      const env = {
        JWT_SECRET: 'a-valid-secret-key-for-testing',
        ENVIRONMENT: 'development',
      };

      const result = validateEnvironment(env, DEFAULT_ENV_VALIDATION);

      expect(result.warnings.some((w) => w.includes('development mode'))).toBe(true);
    });

    it('should use custom validation config', () => {
      const config: EnvValidationConfig = {
        required: ['CUSTOM_VAR', 'ANOTHER_VAR'],
        minLength: {
          CUSTOM_VAR: 10,
        },
      };

      const env = {
        CUSTOM_VAR: 'too-short',
      };

      const result = validateEnvironment(env, config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing required environment variable: ANOTHER_VAR');
      expect(result.errors.some((e) => e.includes('CUSTOM_VAR') && e.includes('10 characters'))).toBe(true);
    });
  });

  describe('safeLogContext', () => {
    it('should redact sensitive data in log context', () => {
      const context = {
        requestId: '123',
        userId: 'user-456',
        body: {
          username: 'john',
          password: 'secret',
        },
      };

      const safe = safeLogContext(context);

      expect(safe.requestId).toBe('123');
      expect(safe.userId).toBe('user-456');
      expect(safe.body.username).toBe('john');
      expect(safe.body.password).toBe('[REDACTED]');
    });
  });

  describe('maskSensitiveValue', () => {
    it('should mask middle of string', () => {
      const masked = maskSensitiveValue('1234567890abcdef');

      expect(masked).toBe('1234********cdef');
      expect(masked).toHaveLength(16);
    });

    it('should use custom show chars', () => {
      const masked = maskSensitiveValue('1234567890abcdef', 2);

      expect(masked).toBe('12********ef');
    });

    it('should mask entirely if too short', () => {
      const masked = maskSensitiveValue('abc', 4);

      expect(masked).toBe('***');
    });

    it('should handle empty string', () => {
      const masked = maskSensitiveValue('');

      expect(masked).toBe('********');
    });

    it('should handle null/undefined safely', () => {
      // Type coercion tests
      const maskedNull = maskSensitiveValue(null as unknown as string);
      expect(maskedNull).toBe('********');
    });
  });
});
