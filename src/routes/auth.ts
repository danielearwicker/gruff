/**
 * Authentication routes
 *
 * Handles user registration, login, token refresh, and logout
 */

import { Hono } from 'hono';
import { validateJson } from '../middleware/validation.js';
import { createUserSchema, loginSchema } from '../schemas/index.js';
import { hashPassword } from '../utils/password.js';
import { createTokenPair } from '../utils/jwt.js';
import { storeRefreshToken } from '../utils/session.js';
import * as response from '../utils/response.js';
import { getLogger } from '../middleware/request-context.js';

type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  JWT_SECRET: string;
  ENVIRONMENT: string;
};

const authRouter = new Hono<{ Bindings: Bindings }>();

/**
 * POST /api/auth/register
 *
 * Register a new user with email and password
 */
authRouter.post('/register', validateJson(createUserSchema), async (c) => {
  const logger = getLogger(c);
  const validated = c.get('validated_json') as any;

  // Extract and validate required fields for local auth
  const { email, password, display_name } = validated;

  if (!password) {
    logger.warn('Registration attempt without password', { email });
    return c.json(
      response.error('Password is required for local registration', 'PASSWORD_REQUIRED'),
      400
    );
  }

  try {
    // Check if user already exists
    const existingUser = await c.env.DB.prepare(
      'SELECT id FROM users WHERE email = ?'
    )
      .bind(email)
      .first();

    if (existingUser) {
      logger.warn('Registration attempt with existing email', { email });
      return c.json(
        response.error('User with this email already exists', 'USER_EXISTS'),
        409
      );
    }

    // Hash the password
    const passwordHash = await hashPassword(password);

    // Generate user ID
    const userId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);

    // Create user record
    await c.env.DB.prepare(
      `INSERT INTO users (id, email, display_name, provider, provider_id, password_hash, created_at, updated_at, is_active)
       VALUES (?, ?, ?, 'local', NULL, ?, ?, ?, 1)`
    )
      .bind(userId, email, display_name || null, passwordHash, now, now)
      .run();

    logger.info('User registered successfully', { userId, email });

    // Get JWT secret from environment
    const jwtSecret = c.env.JWT_SECRET;
    if (!jwtSecret) {
      logger.error('JWT_SECRET not configured');
      return c.json(
        response.error('Server configuration error', 'CONFIG_ERROR'),
        500
      );
    }

    // Generate access and refresh tokens
    const tokens = await createTokenPair(userId, email, jwtSecret);

    // Store refresh token in KV
    await storeRefreshToken(c.env.KV, userId, email, tokens.refreshToken);

    logger.info('Tokens created and stored', { userId });

    // Return success response with tokens
    return c.json(
      response.created({
        user: {
          id: userId,
          email,
          display_name: display_name || null,
          provider: 'local',
          created_at: now,
          updated_at: now,
          is_active: true,
        },
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expires_in: tokens.expiresIn,
        token_type: 'Bearer',
      }),
      201
    );
  } catch (error) {
    logger.error('Error during user registration', error as Error, { email });
    return c.json(
      response.error('Failed to register user', 'REGISTRATION_FAILED'),
      500
    );
  }
});

export default authRouter;
