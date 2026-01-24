/**
 * Authentication routes
 *
 * Handles user registration, login, token refresh, and logout
 */

import { Hono } from 'hono';
import { validateJson } from '../middleware/validation.js';
import { createUserSchema, loginSchema, refreshTokenSchema } from '../schemas/index.js';
import { hashPassword } from '../utils/password.js';
import { createTokenPair, verifyRefreshToken, createAccessToken } from '../utils/jwt.js';
import { storeRefreshToken, validateRefreshToken as validateStoredRefreshToken, rotateRefreshToken } from '../utils/session.js';
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

/**
 * POST /api/auth/login
 *
 * Login with email and password
 */
authRouter.post('/login', validateJson(loginSchema), async (c) => {
  const logger = getLogger(c);
  const validated = c.get('validated_json') as any;

  const { email, password } = validated;

  try {
    // Find user by email
    const user = await c.env.DB.prepare(
      'SELECT id, email, display_name, provider, password_hash, created_at, updated_at, is_active FROM users WHERE email = ?'
    )
      .bind(email)
      .first();

    if (!user) {
      logger.warn('Login attempt with non-existent email', { email });
      return c.json(
        response.error('Invalid email or password', 'INVALID_CREDENTIALS'),
        401
      );
    }

    // Check if account is active
    if (!user.is_active) {
      logger.warn('Login attempt for inactive account', { email, userId: user.id });
      return c.json(
        response.error('Account is not active', 'ACCOUNT_INACTIVE'),
        401
      );
    }

    // Verify this is a local account with password
    if (user.provider !== 'local' || !user.password_hash) {
      logger.warn('Login attempt for non-local account', { email, provider: user.provider });
      return c.json(
        response.error('This account uses a different authentication method', 'INVALID_AUTH_METHOD'),
        401
      );
    }

    // Verify password using imported function
    const { verifyPassword } = await import('../utils/password.js');
    const isValidPassword = await verifyPassword(password, user.password_hash as string);

    if (!isValidPassword) {
      logger.warn('Login attempt with incorrect password', { email });
      return c.json(
        response.error('Invalid email or password', 'INVALID_CREDENTIALS'),
        401
      );
    }

    logger.info('User login successful', { userId: user.id, email });

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
    const tokens = await createTokenPair(user.id as string, email, jwtSecret);

    // Store refresh token in KV
    await storeRefreshToken(c.env.KV, user.id as string, email, tokens.refreshToken);

    logger.info('Tokens created and stored for login', { userId: user.id });

    // Return success response with tokens
    return c.json(
      response.success({
        user: {
          id: user.id,
          email: user.email,
          display_name: user.display_name,
          provider: user.provider,
          created_at: user.created_at,
          updated_at: user.updated_at,
          is_active: !!user.is_active,
        },
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expires_in: tokens.expiresIn,
        token_type: 'Bearer',
      })
    );
  } catch (error) {
    logger.error('Error during login', error as Error, { email });
    return c.json(
      response.error('Failed to login', 'LOGIN_FAILED'),
      500
    );
  }
});

/**
 * POST /api/auth/refresh
 *
 * Refresh access token using a valid refresh token
 */
authRouter.post('/refresh', validateJson(refreshTokenSchema), async (c) => {
  const logger = getLogger(c);
  const validated = c.get('validated_json') as any;

  const { refresh_token } = validated;

  try {
    // Get JWT secret from environment
    const jwtSecret = c.env.JWT_SECRET;
    if (!jwtSecret) {
      logger.error('JWT_SECRET not configured');
      return c.json(
        response.error('Server configuration error', 'CONFIG_ERROR'),
        500
      );
    }

    // Verify the refresh token JWT signature and expiration
    const payload = await verifyRefreshToken(refresh_token, jwtSecret);

    if (!payload) {
      logger.warn('Invalid or expired refresh token');
      return c.json(
        response.error('Invalid or expired refresh token', 'INVALID_TOKEN'),
        401
      );
    }

    const { user_id, email } = payload;

    // Validate that the refresh token exists in KV store
    const isValid = await validateStoredRefreshToken(c.env.KV, user_id, refresh_token);

    if (!isValid) {
      logger.warn('Refresh token not found in session store', { userId: user_id });
      return c.json(
        response.error('Refresh token has been revoked', 'TOKEN_REVOKED'),
        401
      );
    }

    logger.info('Refresh token validated', { userId: user_id });

    // Generate a new access token
    const newAccessToken = await createAccessToken(user_id, email, jwtSecret);

    // Optionally rotate the refresh token (best practice for security)
    // For now, we'll keep the same refresh token, but you could rotate it here
    // by generating a new refresh token and updating KV

    logger.info('New access token created', { userId: user_id });

    // Return success response with new access token
    return c.json(
      response.success({
        access_token: newAccessToken,
        refresh_token: refresh_token, // Return the same refresh token
        expires_in: 15 * 60, // 15 minutes (should match ACCESS_TOKEN_EXPIRY)
        token_type: 'Bearer',
      })
    );
  } catch (error) {
    logger.error('Error during token refresh', error as Error);
    return c.json(
      response.error('Failed to refresh token', 'REFRESH_FAILED'),
      500
    );
  }
});

export default authRouter;
