/**
 * Authentication routes
 *
 * Handles user registration, login, token refresh, logout, and OAuth2 flows
 */

import { Hono } from 'hono';
import { validateJson } from '../middleware/validation.js';
import { requireAuth } from '../middleware/auth.js';
import { createUserSchema, loginSchema, refreshTokenSchema, logoutSchema, oauthCallbackQuerySchema } from '../schemas/index.js';
import { hashPassword } from '../utils/password.js';
import { createTokenPair, verifyRefreshToken, createAccessToken } from '../utils/jwt.js';
import { storeRefreshToken, validateRefreshToken as validateStoredRefreshToken, rotateRefreshToken, invalidateSession } from '../utils/session.js';
import * as response from '../utils/response.js';
import { getLogger } from '../middleware/request-context.js';
import {
  GoogleOAuthConfig,
  generateOAuthState,
  parseOAuthState,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  fetchUserProfile,
  validateGoogleProfile,
} from '../services/google-oauth.js';

type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  JWT_SECRET: string;
  ENVIRONMENT: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
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

/**
 * POST /api/auth/logout
 *
 * Logout by invalidating the refresh token
 */
authRouter.post('/logout', validateJson(logoutSchema), async (c) => {
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
      logger.warn('Logout attempt with invalid or expired refresh token');
      return c.json(
        response.error('Invalid or expired refresh token', 'INVALID_TOKEN'),
        401
      );
    }

    const { user_id } = payload;

    // Invalidate the session in KV store
    await invalidateSession(c.env.KV, user_id);

    logger.info('User logged out successfully', { userId: user_id });

    // Return success response
    return c.json(
      response.success({
        message: 'Logged out successfully',
      })
    );
  } catch (error) {
    logger.error('Error during logout', error as Error);
    return c.json(
      response.error('Failed to logout', 'LOGOUT_FAILED'),
      500
    );
  }
});

/**
 * GET /api/auth/me
 *
 * Get the authenticated user's profile information
 * Requires valid JWT in Authorization header
 */
authRouter.get('/me', requireAuth(), async (c) => {
  const logger = getLogger(c);

  // Get the authenticated user from context (set by requireAuth middleware)
  const user = c.get('user');

  try {
    // Fetch the full user profile from the database
    const userRecord = await c.env.DB.prepare(
      'SELECT id, email, display_name, provider, created_at, updated_at, is_active FROM users WHERE id = ?'
    )
      .bind(user.user_id)
      .first();

    if (!userRecord) {
      logger.warn('User not found in database', { userId: user.user_id });
      return c.json(
        response.error('User not found', 'USER_NOT_FOUND'),
        404
      );
    }

    // Check if account is active
    if (!userRecord.is_active) {
      logger.warn('Inactive user attempted to access profile', { userId: user.user_id });
      return c.json(
        response.error('Account is not active', 'ACCOUNT_INACTIVE'),
        403
      );
    }

    logger.info('User profile retrieved', { userId: user.user_id });

    // Return user profile
    return c.json(
      response.success({
        user: {
          id: userRecord.id,
          email: userRecord.email,
          display_name: userRecord.display_name,
          provider: userRecord.provider,
          created_at: userRecord.created_at,
          updated_at: userRecord.updated_at,
          is_active: !!userRecord.is_active,
        },
      })
    );
  } catch (error) {
    logger.error('Error retrieving user profile', error as Error, { userId: user.user_id });
    return c.json(
      response.error('Failed to retrieve user profile', 'PROFILE_RETRIEVAL_FAILED'),
      500
    );
  }
});

// =============================================================================
// Google OAuth2 Routes
// =============================================================================

// KV key prefix for OAuth state storage
const OAUTH_STATE_PREFIX = 'oauth_state:';
const OAUTH_STATE_TTL = 15 * 60; // 15 minutes

/**
 * GET /api/auth/google
 *
 * Initiates Google OAuth2 sign-in flow
 * Returns authorization URL for redirect
 */
authRouter.get('/google', async (c) => {
  const logger = getLogger(c);

  // Check if Google OAuth is configured
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_REDIRECT_URI) {
    logger.warn('Google OAuth not configured');
    return c.json(
      response.error('Google OAuth is not configured', 'OAUTH_NOT_CONFIGURED'),
      501
    );
  }

  try {
    const config: GoogleOAuthConfig = {
      clientId: c.env.GOOGLE_CLIENT_ID,
      clientSecret: c.env.GOOGLE_CLIENT_SECRET || '',
      redirectUri: c.env.GOOGLE_REDIRECT_URI,
    };

    // Generate state and PKCE code verifier
    const { state, stateData } = generateOAuthState();

    // Store state in KV for validation during callback
    await c.env.KV.put(
      `${OAUTH_STATE_PREFIX}${state}`,
      JSON.stringify(stateData),
      { expirationTtl: OAUTH_STATE_TTL }
    );

    // Build authorization URL
    const authUrl = await buildAuthorizationUrl(
      config,
      state,
      stateData.codeVerifier || ''
    );

    logger.info('Google OAuth authorization URL generated', { state: stateData.nonce });

    return c.json(
      response.success({
        authorization_url: authUrl,
        state: state,
      })
    );
  } catch (error) {
    logger.error('Error generating Google OAuth URL', error as Error);
    return c.json(
      response.error('Failed to initiate Google sign-in', 'OAUTH_INIT_FAILED'),
      500
    );
  }
});

/**
 * GET /api/auth/google/callback
 *
 * Handles Google OAuth2 callback with authorization code
 * Creates or links user account and returns tokens
 */
authRouter.get('/google/callback', async (c) => {
  const logger = getLogger(c);

  // Check if Google OAuth is configured
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET || !c.env.GOOGLE_REDIRECT_URI) {
    logger.warn('Google OAuth not fully configured');
    return c.json(
      response.error('Google OAuth is not configured', 'OAUTH_NOT_CONFIGURED'),
      501
    );
  }

  // Parse query parameters
  const query = c.req.query();

  // Check for OAuth error response
  if (query.error) {
    logger.warn('Google OAuth error response', {
      error: query.error,
      description: query.error_description,
    });
    return c.json(
      response.error(
        query.error_description || 'OAuth authentication failed',
        'OAUTH_ERROR'
      ),
      400
    );
  }

  // Validate required parameters
  if (!query.code || !query.state) {
    logger.warn('Missing OAuth callback parameters');
    return c.json(
      response.error('Missing authorization code or state', 'INVALID_CALLBACK'),
      400
    );
  }

  const { code, state } = query;

  try {
    // Retrieve and validate state from KV
    const storedStateJson = await c.env.KV.get(`${OAUTH_STATE_PREFIX}${state}`);
    if (!storedStateJson) {
      logger.warn('OAuth state not found or expired', { state });
      return c.json(
        response.error('Invalid or expired state parameter', 'INVALID_STATE'),
        400
      );
    }

    // Parse stored state
    const storedState = JSON.parse(storedStateJson);
    const parsedState = parseOAuthState(state);

    if (!parsedState || !storedState.codeVerifier) {
      logger.warn('Invalid OAuth state data');
      return c.json(
        response.error('Invalid state data', 'INVALID_STATE'),
        400
      );
    }

    // Delete state from KV (one-time use)
    await c.env.KV.delete(`${OAUTH_STATE_PREFIX}${state}`);

    const config: GoogleOAuthConfig = {
      clientId: c.env.GOOGLE_CLIENT_ID,
      clientSecret: c.env.GOOGLE_CLIENT_SECRET,
      redirectUri: c.env.GOOGLE_REDIRECT_URI,
    };

    // Exchange authorization code for tokens
    logger.info('Exchanging authorization code for tokens');
    const tokenResponse = await exchangeCodeForTokens(
      config,
      code,
      storedState.codeVerifier
    );

    // Fetch user profile from Google
    logger.info('Fetching Google user profile');
    const googleProfile = await fetchUserProfile(tokenResponse.access_token);

    // Validate Google profile
    const profileValidation = validateGoogleProfile(googleProfile);
    if (!profileValidation.valid) {
      logger.warn('Invalid Google profile', { error: profileValidation.error });
      return c.json(
        response.error(profileValidation.error || 'Invalid profile', 'INVALID_PROFILE'),
        400
      );
    }

    logger.info('Google profile retrieved', {
      googleId: googleProfile.id,
      email: googleProfile.email,
    });

    // Check if user already exists by email
    const existingUser = await c.env.DB.prepare(
      'SELECT id, email, display_name, provider, provider_id, created_at, updated_at, is_active FROM users WHERE email = ?'
    )
      .bind(googleProfile.email)
      .first();

    let userId: string;
    let displayName: string | null;
    let createdAt: number;
    let updatedAt: number;
    let isNewUser = false;

    if (existingUser) {
      // User exists - check if it's already a Google account
      if (existingUser.provider === 'google') {
        // Same provider, just log them in
        logger.info('Existing Google user logging in', { userId: existingUser.id });
      } else {
        // Different provider - link Google account to existing user
        logger.info('Linking Google account to existing user', {
          userId: existingUser.id,
          existingProvider: existingUser.provider,
        });

        const now = Math.floor(Date.now() / 1000);
        await c.env.DB.prepare(
          `UPDATE users SET provider = 'google', provider_id = ?, updated_at = ? WHERE id = ?`
        )
          .bind(googleProfile.id, now, existingUser.id)
          .run();
      }

      userId = existingUser.id as string;
      displayName = existingUser.display_name as string | null;
      createdAt = existingUser.created_at as number;
      updatedAt = Math.floor(Date.now() / 1000);

      // Check if account is active
      if (!existingUser.is_active) {
        logger.warn('Google login attempt for inactive account', { email: googleProfile.email });
        return c.json(
          response.error('Account is not active', 'ACCOUNT_INACTIVE'),
          401
        );
      }
    } else {
      // Create new user
      userId = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);
      displayName = googleProfile.name || googleProfile.given_name || null;
      createdAt = now;
      updatedAt = now;
      isNewUser = true;

      await c.env.DB.prepare(
        `INSERT INTO users (id, email, display_name, provider, provider_id, password_hash, created_at, updated_at, is_active)
         VALUES (?, ?, ?, 'google', ?, NULL, ?, ?, 1)`
      )
        .bind(userId, googleProfile.email, displayName, googleProfile.id, now, now)
        .run();

      logger.info('New Google user created', { userId, email: googleProfile.email });
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

    // Generate access and refresh tokens
    const tokens = await createTokenPair(userId, googleProfile.email, jwtSecret);

    // Store refresh token in KV
    await storeRefreshToken(c.env.KV, userId, googleProfile.email, tokens.refreshToken);

    logger.info('Google OAuth login successful', { userId, isNewUser });

    // Return success response with tokens
    const statusCode = isNewUser ? 201 : 200;
    const responseData = {
      user: {
        id: userId,
        email: googleProfile.email,
        display_name: displayName,
        provider: 'google' as const,
        created_at: createdAt,
        updated_at: updatedAt,
        is_active: true,
      },
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      expires_in: tokens.expiresIn,
      token_type: 'Bearer',
      is_new_user: isNewUser,
    };

    if (isNewUser) {
      return c.json(response.created(responseData), statusCode);
    }
    return c.json(response.success(responseData), statusCode);
  } catch (error) {
    logger.error('Error during Google OAuth callback', error as Error);
    return c.json(
      response.error('Failed to complete Google sign-in', 'OAUTH_CALLBACK_FAILED'),
      500
    );
  }
});

export default authRouter;
