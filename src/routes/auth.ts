/**
 * Authentication routes
 *
 * Handles user registration, login, token refresh, logout, and OAuth2 flows
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { requireAuth } from '../middleware/auth.js';
import {
  createUserSchema,
  loginSchema,
  refreshTokenSchema,
  logoutSchema,
} from '../schemas/index.js';
import { hashPassword } from '../utils/password.js';
import { createTokenPair, verifyRefreshToken, createAccessToken } from '../utils/jwt.js';
import {
  storeRefreshToken,
  validateRefreshToken as validateStoredRefreshToken,
  invalidateSession,
} from '../utils/session.js';
import * as response from '../utils/response.js';
import { getLogger } from '../middleware/request-context.js';
import {
  GoogleOAuthConfig,
  generateOAuthState as generateGoogleOAuthState,
  parseOAuthState as parseGoogleOAuthState,
  buildAuthorizationUrl as buildGoogleAuthorizationUrl,
  exchangeCodeForTokens as exchangeGoogleCodeForTokens,
  fetchUserProfile as fetchGoogleUserProfile,
  validateGoogleProfile,
} from '../services/google-oauth.js';
import {
  GitHubOAuthConfig,
  generateOAuthState as generateGitHubOAuthState,
  parseOAuthState as parseGitHubOAuthState,
  buildAuthorizationUrl as buildGitHubAuthorizationUrl,
  exchangeCodeForTokens as exchangeGitHubCodeForTokens,
  fetchUserProfile as fetchGitHubUserProfile,
  fetchUserPrimaryEmail as fetchGitHubUserPrimaryEmail,
  validateGitHubProfile,
} from '../services/github-oauth.js';

type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  JWT_SECRET: string;
  ENVIRONMENT: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_REDIRECT_URI?: string;
};

const authRouter = new OpenAPIHono<{ Bindings: Bindings }>();

// =============================================================================
// Response Schemas for Auth Endpoints
// =============================================================================

// User object returned in auth responses
const AuthUserSchema = z
  .object({
    id: z.string().uuid().openapi({ example: '550e8400-e29b-41d4-a716-446655440000' }),
    email: z.string().email().openapi({ example: 'user@example.com' }),
    display_name: z.string().nullable().openapi({ example: 'John Doe' }),
    provider: z
      .enum(['google', 'github', 'local', 'microsoft', 'apple'])
      .openapi({ example: 'local' }),
    created_at: z.number().int().openapi({ example: 1704067200 }),
    updated_at: z.number().int().openapi({ example: 1704067200 }),
    is_active: z.boolean().openapi({ example: true }),
    is_admin: z.boolean().openapi({ example: false }),
  })
  .openapi('AuthUser');

// Success response for registration
const RegisterSuccessResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({
      user: AuthUserSchema,
      access_token: z.string().openapi({ example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' }),
      refresh_token: z.string().openapi({ example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' }),
      expires_in: z
        .number()
        .int()
        .openapi({ example: 900, description: 'Token expiration in seconds' }),
      token_type: z.literal('Bearer'),
    }),
    message: z.string().optional().openapi({ example: 'Resource created successfully' }),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('RegisterSuccessResponse');

// Error response for auth operations
const AuthErrorResponseSchema = z
  .object({
    success: z.literal(false),
    error: z.string().openapi({ example: 'User with this email already exists' }),
    code: z.string().openapi({ example: 'USER_EXISTS' }),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('AuthErrorResponse');

// Success response for login
const LoginSuccessResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({
      user: AuthUserSchema,
      access_token: z.string().openapi({ example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' }),
      refresh_token: z.string().openapi({ example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' }),
      expires_in: z
        .number()
        .int()
        .openapi({ example: 900, description: 'Token expiration in seconds' }),
      token_type: z.literal('Bearer'),
    }),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('LoginSuccessResponse');

// Success response for token refresh
const RefreshSuccessResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({
      access_token: z.string().openapi({ example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' }),
      refresh_token: z.string().openapi({ example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' }),
      expires_in: z
        .number()
        .int()
        .openapi({ example: 900, description: 'Token expiration in seconds' }),
      token_type: z.literal('Bearer'),
    }),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('RefreshSuccessResponse');

// Success response for logout
const LogoutSuccessResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({
      message: z.string().openapi({ example: 'Logged out successfully' }),
    }),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('LogoutSuccessResponse');

// Success response for GET /me
const MeSuccessResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({
      user: AuthUserSchema,
    }),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('MeSuccessResponse');

// =============================================================================
// Route Definitions
// =============================================================================

/**
 * POST /api/auth/register route definition
 */
const registerRoute = createRoute({
  method: 'post',
  path: '/register',
  tags: ['Authentication'],
  summary: 'Register a new user',
  description: 'Register a new user with email and password. Returns user info and JWT tokens.',
  operationId: 'registerUser',
  request: {
    body: {
      content: {
        'application/json': {
          schema: createUserSchema,
        },
      },
      required: true,
    },
  },
  responses: {
    201: {
      description: 'User registered successfully',
      content: {
        'application/json': {
          schema: RegisterSuccessResponseSchema,
        },
      },
    },
    400: {
      description: 'Validation error - missing password, invalid email, or password too short',
      content: {
        'application/json': {
          schema: AuthErrorResponseSchema,
        },
      },
    },
    409: {
      description: 'Conflict - user with this email already exists',
      content: {
        'application/json': {
          schema: AuthErrorResponseSchema,
        },
      },
    },
    500: {
      description: 'Server error',
      content: {
        'application/json': {
          schema: AuthErrorResponseSchema,
        },
      },
    },
  },
});

/**
 * POST /api/auth/login route definition
 */
const loginRoute = createRoute({
  method: 'post',
  path: '/login',
  tags: ['Authentication'],
  summary: 'Login with email and password',
  description: 'Authenticate with email and password. Returns user info and JWT tokens on success.',
  operationId: 'loginUser',
  request: {
    body: {
      content: {
        'application/json': {
          schema: loginSchema,
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      description: 'Login successful',
      content: {
        'application/json': {
          schema: LoginSuccessResponseSchema,
        },
      },
    },
    400: {
      description: 'Validation error - missing or invalid email/password',
      content: {
        'application/json': {
          schema: AuthErrorResponseSchema,
        },
      },
    },
    401: {
      description: 'Invalid credentials, account inactive, or wrong authentication method',
      content: {
        'application/json': {
          schema: AuthErrorResponseSchema,
        },
      },
    },
    500: {
      description: 'Server error',
      content: {
        'application/json': {
          schema: AuthErrorResponseSchema,
        },
      },
    },
  },
});

/**
 * POST /api/auth/refresh route definition
 */
const refreshRoute = createRoute({
  method: 'post',
  path: '/refresh',
  tags: ['Authentication'],
  summary: 'Refresh access token',
  description: 'Use a valid refresh token to obtain a new access token.',
  operationId: 'refreshToken',
  request: {
    body: {
      content: {
        'application/json': {
          schema: refreshTokenSchema,
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      description: 'Token refreshed successfully',
      content: {
        'application/json': {
          schema: RefreshSuccessResponseSchema,
        },
      },
    },
    400: {
      description: 'Validation error - missing refresh token',
      content: {
        'application/json': {
          schema: AuthErrorResponseSchema,
        },
      },
    },
    401: {
      description: 'Invalid or expired refresh token',
      content: {
        'application/json': {
          schema: AuthErrorResponseSchema,
        },
      },
    },
    500: {
      description: 'Server error',
      content: {
        'application/json': {
          schema: AuthErrorResponseSchema,
        },
      },
    },
  },
});

/**
 * POST /api/auth/logout route definition
 */
const logoutRoute = createRoute({
  method: 'post',
  path: '/logout',
  tags: ['Authentication'],
  summary: 'Logout',
  description: 'Invalidate the refresh token to log out the user.',
  operationId: 'logout',
  request: {
    body: {
      content: {
        'application/json': {
          schema: logoutSchema,
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      description: 'Logged out successfully',
      content: {
        'application/json': {
          schema: LogoutSuccessResponseSchema,
        },
      },
    },
    400: {
      description: 'Validation error - missing refresh token',
      content: {
        'application/json': {
          schema: AuthErrorResponseSchema,
        },
      },
    },
    401: {
      description: 'Invalid or expired refresh token',
      content: {
        'application/json': {
          schema: AuthErrorResponseSchema,
        },
      },
    },
    500: {
      description: 'Server error',
      content: {
        'application/json': {
          schema: AuthErrorResponseSchema,
        },
      },
    },
  },
});

/**
 * GET /api/auth/me route definition
 */
const meRoute = createRoute({
  method: 'get',
  path: '/me',
  tags: ['Authentication'],
  summary: 'Get current user',
  description: 'Get the profile of the currently authenticated user.',
  operationId: 'getCurrentUser',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth()] as const,
  responses: {
    200: {
      description: 'Current user profile',
      content: {
        'application/json': {
          schema: MeSuccessResponseSchema,
        },
      },
    },
    401: {
      description: 'Not authenticated - missing or invalid token',
      content: {
        'application/json': {
          schema: AuthErrorResponseSchema,
        },
      },
    },
    403: {
      description: 'Forbidden - account is not active',
      content: {
        'application/json': {
          schema: AuthErrorResponseSchema,
        },
      },
    },
    404: {
      description: 'User not found in database',
      content: {
        'application/json': {
          schema: AuthErrorResponseSchema,
        },
      },
    },
    500: {
      description: 'Server error',
      content: {
        'application/json': {
          schema: AuthErrorResponseSchema,
        },
      },
    },
  },
});

// =============================================================================
// Route Handlers
// =============================================================================

/**
 * POST /api/auth/register
 *
 * Register a new user with email and password
 */
authRouter.openapi(registerRoute, async c => {
  const logger = getLogger(c);
  const validated = c.req.valid('json');

  // Extract and validate required fields for local auth
  const { email, password, display_name } = validated;

  if (!password) {
    logger.warn('Registration attempt without password', { email });
    return c.json(
      {
        success: false as const,
        error: 'Password is required for local registration',
        code: 'PASSWORD_REQUIRED',
        timestamp: new Date().toISOString(),
      },
      400
    );
  }

  try {
    // Check if user already exists
    const existingUser = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?')
      .bind(email)
      .first();

    if (existingUser) {
      logger.warn('Registration attempt with existing email', { email });
      return c.json(
        {
          success: false as const,
          error: 'User with this email already exists',
          code: 'USER_EXISTS',
          timestamp: new Date().toISOString(),
        },
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
        {
          success: false as const,
          error: 'Server configuration error',
          code: 'CONFIG_ERROR',
          timestamp: new Date().toISOString(),
        },
        500
      );
    }

    // Generate access and refresh tokens (new users are not admins by default)
    const tokens = await createTokenPair(userId, email, jwtSecret, undefined, { isAdmin: false });

    // Store refresh token in KV
    await storeRefreshToken(c.env.KV, userId, email, tokens.refreshToken);

    logger.info('Tokens created and stored', { userId });

    // Return success response with tokens
    return c.json(
      {
        success: true as const,
        data: {
          user: {
            id: userId,
            email,
            display_name: display_name || null,
            provider: 'local' as const,
            created_at: now,
            updated_at: now,
            is_active: true,
            is_admin: false,
          },
          access_token: tokens.accessToken,
          refresh_token: tokens.refreshToken,
          expires_in: tokens.expiresIn,
          token_type: 'Bearer' as const,
        },
        message: 'Resource created successfully',
        timestamp: new Date().toISOString(),
      },
      201
    );
  } catch (error) {
    logger.error('Error during user registration', error as Error, { email });
    return c.json(
      {
        success: false as const,
        error: 'Failed to register user',
        code: 'REGISTRATION_FAILED',
        timestamp: new Date().toISOString(),
      },
      500
    );
  }
});

/**
 * POST /api/auth/login
 *
 * Login with email and password
 */
authRouter.openapi(loginRoute, async c => {
  const logger = getLogger(c);
  const { email, password } = c.req.valid('json');

  try {
    // Find user by email
    const user = await c.env.DB.prepare(
      'SELECT id, email, display_name, provider, password_hash, created_at, updated_at, is_active, is_admin FROM users WHERE email = ?'
    )
      .bind(email)
      .first();

    if (!user) {
      logger.warn('Login attempt with non-existent email', { email });
      return c.json(
        {
          success: false as const,
          error: 'Invalid email or password',
          code: 'INVALID_CREDENTIALS',
          timestamp: new Date().toISOString(),
        },
        401
      );
    }

    // Check if account is active
    if (!user.is_active) {
      logger.warn('Login attempt for inactive account', { email, userId: String(user.id) });
      return c.json(
        {
          success: false as const,
          error: 'Account is not active',
          code: 'ACCOUNT_INACTIVE',
          timestamp: new Date().toISOString(),
        },
        401
      );
    }

    // Verify this is a local account with password
    if (user.provider !== 'local' || typeof user.password_hash !== 'string') {
      logger.warn('Login attempt for non-local account', { email, provider: user.provider });
      return c.json(
        {
          success: false as const,
          error: 'This account uses a different authentication method',
          code: 'INVALID_AUTH_METHOD',
          timestamp: new Date().toISOString(),
        },
        401
      );
    }

    // Verify password using imported function
    const { verifyPassword } = await import('../utils/password.js');
    const isValidPassword = await verifyPassword(password, user.password_hash);

    if (!isValidPassword) {
      logger.warn('Login attempt with incorrect password', { email });
      return c.json(
        {
          success: false as const,
          error: 'Invalid email or password',
          code: 'INVALID_CREDENTIALS',
          timestamp: new Date().toISOString(),
        },
        401
      );
    }

    logger.info('User login successful', { userId: String(user.id), email });

    // Get JWT secret from environment
    const jwtSecret = c.env.JWT_SECRET;
    if (!jwtSecret) {
      logger.error('JWT_SECRET not configured');
      return c.json(
        {
          success: false as const,
          error: 'Server configuration error',
          code: 'CONFIG_ERROR',
          timestamp: new Date().toISOString(),
        },
        500
      );
    }

    // Generate access and refresh tokens with admin flag
    const userId = String(user.id);
    const isAdmin = !!user.is_admin;
    const tokens = await createTokenPair(userId, email, jwtSecret, undefined, { isAdmin });

    // Store refresh token in KV
    await storeRefreshToken(c.env.KV, userId, email, tokens.refreshToken);

    logger.info('Tokens created and stored for login', { userId, isAdmin });

    // Return success response with tokens
    return c.json(
      {
        success: true as const,
        data: {
          user: {
            id: String(user.id),
            email: String(user.email),
            display_name: user.display_name ? String(user.display_name) : null,
            provider: user.provider as 'local' | 'google' | 'github' | 'microsoft' | 'apple',
            created_at: user.created_at as number,
            updated_at: user.updated_at as number,
            is_active: !!user.is_active,
            is_admin: isAdmin,
          },
          access_token: tokens.accessToken,
          refresh_token: tokens.refreshToken,
          expires_in: tokens.expiresIn,
          token_type: 'Bearer' as const,
        },
        timestamp: new Date().toISOString(),
      },
      200
    );
  } catch (error) {
    logger.error('Error during login', error as Error, { email });
    return c.json(
      {
        success: false as const,
        error: 'Failed to login',
        code: 'LOGIN_FAILED',
        timestamp: new Date().toISOString(),
      },
      500
    );
  }
});

/**
 * POST /api/auth/refresh
 *
 * Refresh access token using a valid refresh token
 */
authRouter.openapi(refreshRoute, async c => {
  const logger = getLogger(c);
  const { refresh_token } = c.req.valid('json');

  try {
    // Get JWT secret from environment
    const jwtSecret = c.env.JWT_SECRET;
    if (!jwtSecret) {
      logger.error('JWT_SECRET not configured');
      return c.json(
        {
          success: false as const,
          error: 'Server configuration error',
          code: 'CONFIG_ERROR',
          timestamp: new Date().toISOString(),
        },
        500
      );
    }

    // Verify the refresh token JWT signature and expiration
    const payload = await verifyRefreshToken(refresh_token, jwtSecret);

    if (!payload) {
      logger.warn('Invalid or expired refresh token');
      return c.json(
        {
          success: false as const,
          error: 'Invalid or expired refresh token',
          code: 'INVALID_TOKEN',
          timestamp: new Date().toISOString(),
        },
        401
      );
    }

    const { user_id, email } = payload;

    // Validate that the refresh token exists in KV store
    const isValid = await validateStoredRefreshToken(c.env.KV, user_id, refresh_token);

    if (!isValid) {
      logger.warn('Refresh token not found in session store', { userId: user_id });
      return c.json(
        {
          success: false as const,
          error: 'Refresh token has been revoked',
          code: 'TOKEN_REVOKED',
          timestamp: new Date().toISOString(),
        },
        401
      );
    }

    logger.info('Refresh token validated', { userId: user_id });

    // Fetch current user to get latest admin status from database
    const user = await c.env.DB.prepare('SELECT is_admin FROM users WHERE id = ?')
      .bind(user_id)
      .first();

    const isAdmin = user ? !!user.is_admin : false;

    // Generate a new access token with current admin status
    const newAccessToken = await createAccessToken(user_id, email, jwtSecret, undefined, {
      isAdmin,
    });

    // Optionally rotate the refresh token (best practice for security)
    // For now, we'll keep the same refresh token, but you could rotate it here
    // by generating a new refresh token and updating KV

    logger.info('New access token created', { userId: user_id });

    // Return success response with new access token
    return c.json(
      {
        success: true as const,
        data: {
          access_token: newAccessToken,
          refresh_token: refresh_token, // Return the same refresh token
          expires_in: 15 * 60, // 15 minutes (should match ACCESS_TOKEN_EXPIRY)
          token_type: 'Bearer' as const,
        },
        timestamp: new Date().toISOString(),
      },
      200
    );
  } catch (error) {
    logger.error('Error during token refresh', error as Error);
    return c.json(
      {
        success: false as const,
        error: 'Failed to refresh token',
        code: 'REFRESH_FAILED',
        timestamp: new Date().toISOString(),
      },
      500
    );
  }
});

/**
 * POST /api/auth/logout
 *
 * Logout by invalidating the refresh token
 */
authRouter.openapi(logoutRoute, async c => {
  const logger = getLogger(c);
  const { refresh_token } = c.req.valid('json');

  try {
    // Get JWT secret from environment
    const jwtSecret = c.env.JWT_SECRET;
    if (!jwtSecret) {
      logger.error('JWT_SECRET not configured');
      return c.json(
        {
          success: false as const,
          error: 'Server configuration error',
          code: 'CONFIG_ERROR',
          timestamp: new Date().toISOString(),
        },
        500
      );
    }

    // Verify the refresh token JWT signature and expiration
    const payload = await verifyRefreshToken(refresh_token, jwtSecret);

    if (!payload) {
      logger.warn('Logout attempt with invalid or expired refresh token');
      return c.json(
        {
          success: false as const,
          error: 'Invalid or expired refresh token',
          code: 'INVALID_TOKEN',
          timestamp: new Date().toISOString(),
        },
        401
      );
    }

    const { user_id } = payload;

    // Invalidate the session in KV store
    await invalidateSession(c.env.KV, user_id);

    logger.info('User logged out successfully', { userId: user_id });

    // Return success response
    return c.json(
      {
        success: true as const,
        data: {
          message: 'Logged out successfully',
        },
        timestamp: new Date().toISOString(),
      },
      200
    );
  } catch (error) {
    logger.error('Error during logout', error as Error);
    return c.json(
      {
        success: false as const,
        error: 'Failed to logout',
        code: 'LOGOUT_FAILED',
        timestamp: new Date().toISOString(),
      },
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
authRouter.openapi(meRoute, async c => {
  const logger = getLogger(c);

  // Get the authenticated user from context (set by requireAuth middleware)
  const user = c.get('user');

  try {
    // Fetch the full user profile from the database
    const userRecord = await c.env.DB.prepare(
      'SELECT id, email, display_name, provider, created_at, updated_at, is_active, is_admin FROM users WHERE id = ?'
    )
      .bind(user.user_id)
      .first();

    if (!userRecord) {
      logger.warn('User not found in database', { userId: user.user_id });
      return c.json(
        {
          success: false as const,
          error: 'User not found',
          code: 'USER_NOT_FOUND',
          timestamp: new Date().toISOString(),
        },
        404
      );
    }

    // Check if account is active
    if (!userRecord.is_active) {
      logger.warn('Inactive user attempted to access profile', { userId: user.user_id });
      return c.json(
        {
          success: false as const,
          error: 'Account is not active',
          code: 'ACCOUNT_INACTIVE',
          timestamp: new Date().toISOString(),
        },
        403
      );
    }

    logger.info('User profile retrieved', { userId: user.user_id });

    // Return user profile
    return c.json(
      {
        success: true as const,
        data: {
          user: {
            id: String(userRecord.id),
            email: String(userRecord.email),
            display_name: userRecord.display_name ? String(userRecord.display_name) : null,
            provider: userRecord.provider as 'local' | 'google' | 'github' | 'microsoft' | 'apple',
            created_at: userRecord.created_at as number,
            updated_at: userRecord.updated_at as number,
            is_active: !!userRecord.is_active,
            is_admin: !!userRecord.is_admin,
          },
        },
        timestamp: new Date().toISOString(),
      },
      200
    );
  } catch (error) {
    logger.error('Error retrieving user profile', error as Error, { userId: user.user_id });
    return c.json(
      {
        success: false as const,
        error: 'Failed to retrieve user profile',
        code: 'PROFILE_RETRIEVAL_FAILED',
        timestamp: new Date().toISOString(),
      },
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

// Response schemas for OAuth endpoints
const OAuthInitSuccessResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({
      authorization_url: z
        .string()
        .url()
        .openapi({ example: 'https://accounts.google.com/o/oauth2/v2/auth?...' }),
      state: z.string().openapi({ example: 'abc123' }),
    }),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('OAuthInitSuccessResponse');

const OAuthNotConfiguredResponseSchema = z
  .object({
    success: z.literal(false),
    error: z.string().openapi({ example: 'Google OAuth is not configured' }),
    code: z.string().openapi({ example: 'OAUTH_NOT_CONFIGURED' }),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('OAuthNotConfiguredResponse');

// Query schema for OAuth initiation (optional ui_state for UI flows)
const OAuthInitQuerySchema = z.object({
  ui_state: z
    .string()
    .optional()
    .openapi({
      param: { name: 'ui_state', in: 'query' },
      description:
        'Optional state parameter for UI-initiated OAuth flows. If provided, the endpoint redirects directly to the OAuth provider instead of returning JSON.',
      example: 'login-page',
    }),
});

/**
 * GET /api/auth/google route definition
 */
const googleOAuthInitRoute = createRoute({
  method: 'get',
  path: '/google',
  tags: ['Authentication'],
  summary: 'Initiate Google OAuth',
  description:
    'Initiates Google OAuth2 sign-in flow. Returns authorization URL for redirect. If ui_state query parameter is provided, redirects directly to Google instead of returning JSON.',
  operationId: 'initiateGoogleOAuth',
  request: {
    query: OAuthInitQuerySchema,
  },
  responses: {
    200: {
      description: 'Google OAuth authorization URL',
      content: {
        'application/json': {
          schema: OAuthInitSuccessResponseSchema,
        },
      },
    },
    302: {
      description: 'Redirect to Google OAuth (when ui_state is provided)',
    },
    500: {
      description: 'Server error',
      content: {
        'application/json': {
          schema: AuthErrorResponseSchema,
        },
      },
    },
    501: {
      description: 'Google OAuth is not configured',
      content: {
        'application/json': {
          schema: OAuthNotConfiguredResponseSchema,
        },
      },
    },
  },
});

/**
 * GET /api/auth/google
 *
 * Initiates Google OAuth2 sign-in flow
 * Returns authorization URL for redirect
 */
authRouter.openapi(googleOAuthInitRoute, async c => {
  const logger = getLogger(c);

  // Check if Google OAuth is configured
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_REDIRECT_URI) {
    logger.warn('Google OAuth not configured');
    return c.json(
      {
        success: false as const,
        error: 'Google OAuth is not configured',
        code: 'OAUTH_NOT_CONFIGURED',
        timestamp: new Date().toISOString(),
      },
      501
    );
  }

  // Check if this is a UI-initiated OAuth flow
  const { ui_state: uiState } = c.req.valid('query');

  try {
    const config: GoogleOAuthConfig = {
      clientId: c.env.GOOGLE_CLIENT_ID,
      clientSecret: c.env.GOOGLE_CLIENT_SECRET || '',
      redirectUri: c.env.GOOGLE_REDIRECT_URI,
    };

    // Generate state and PKCE code verifier
    const { state, stateData } = generateGoogleOAuthState();

    // Store state in KV for validation during callback
    // Include ui_state if this is a UI-initiated flow
    const stateToStore = uiState ? { ...stateData, ui_state: uiState } : stateData;
    await c.env.KV.put(`${OAUTH_STATE_PREFIX}${state}`, JSON.stringify(stateToStore), {
      expirationTtl: OAUTH_STATE_TTL,
    });

    // Build authorization URL
    const authUrl = await buildGoogleAuthorizationUrl(config, state, stateData.codeVerifier || '');

    logger.info('Google OAuth authorization URL generated', {
      state: stateData.nonce,
      isUiFlow: !!uiState,
    });

    // If this is a UI flow, redirect directly to Google
    if (uiState) {
      return c.redirect(authUrl);
    }

    return c.json(
      {
        success: true as const,
        data: {
          authorization_url: authUrl,
          state: state,
        },
        timestamp: new Date().toISOString(),
      },
      200
    );
  } catch (error) {
    logger.error('Error generating Google OAuth URL', error as Error);
    if (uiState) {
      return c.redirect(
        `/ui/auth/login?error=${encodeURIComponent('Failed to initiate Google sign-in')}`
      );
    }
    return c.json(
      {
        success: false as const,
        error: 'Failed to initiate Google sign-in',
        code: 'OAUTH_INIT_FAILED',
        timestamp: new Date().toISOString(),
      },
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
authRouter.get('/google/callback', async c => {
  const logger = getLogger(c);

  // Check if Google OAuth is configured
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET || !c.env.GOOGLE_REDIRECT_URI) {
    logger.warn('Google OAuth not fully configured');
    return c.json(response.error('Google OAuth is not configured', 'OAUTH_NOT_CONFIGURED'), 501);
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
      response.error(query.error_description || 'OAuth authentication failed', 'OAUTH_ERROR'),
      400
    );
  }

  // Validate required parameters
  if (!query.code || !query.state) {
    logger.warn('Missing OAuth callback parameters');
    return c.json(response.error('Missing authorization code or state', 'INVALID_CALLBACK'), 400);
  }

  const { code, state } = query;

  try {
    // Retrieve and validate state from KV
    const storedStateJson = await c.env.KV.get(`${OAUTH_STATE_PREFIX}${state}`);
    if (!storedStateJson) {
      logger.warn('OAuth state not found or expired', { state });
      return c.json(response.error('Invalid or expired state parameter', 'INVALID_STATE'), 400);
    }

    // Parse stored state
    const storedState = JSON.parse(storedStateJson);
    const parsedState = parseGoogleOAuthState(state);

    if (!parsedState || !storedState.codeVerifier) {
      logger.warn('Invalid OAuth state data');
      return c.json(response.error('Invalid state data', 'INVALID_STATE'), 400);
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
    const tokenResponse = await exchangeGoogleCodeForTokens(config, code, storedState.codeVerifier);

    // Fetch user profile from Google
    logger.info('Fetching Google user profile');
    const googleProfile = await fetchGoogleUserProfile(tokenResponse.access_token);

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
      'SELECT id, email, display_name, provider, provider_id, created_at, updated_at, is_active, is_admin FROM users WHERE email = ?'
    )
      .bind(googleProfile.email)
      .first();

    let userId: string;
    let displayName: string | null;
    let createdAt: number;
    let updatedAt: number;
    let isNewUser = false;
    let isAdmin = false;

    if (existingUser) {
      // User exists - check if it's already a Google account
      if (existingUser.provider === 'google') {
        // Same provider, just log them in
        logger.info('Existing Google user logging in', { userId: String(existingUser.id) });
      } else {
        // Different provider - link Google account to existing user
        const existingUserId = String(existingUser.id);
        logger.info('Linking Google account to existing user', {
          userId: existingUserId,
          existingProvider: existingUser.provider,
        });

        const now = Math.floor(Date.now() / 1000);
        await c.env.DB.prepare(
          `UPDATE users SET provider = 'google', provider_id = ?, updated_at = ? WHERE id = ?`
        )
          .bind(googleProfile.id, now, existingUserId)
          .run();
      }

      userId = String(existingUser.id);
      displayName = existingUser.display_name ? String(existingUser.display_name) : null;
      createdAt = existingUser.created_at as number;
      updatedAt = Math.floor(Date.now() / 1000);
      isAdmin = !!existingUser.is_admin;

      // Check if account is active
      if (!existingUser.is_active) {
        logger.warn('Google login attempt for inactive account', { email: googleProfile.email });
        return c.json(response.error('Account is not active', 'ACCOUNT_INACTIVE'), 401);
      }
    } else {
      // Create new user (new users are not admins by default)
      userId = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);
      displayName = googleProfile.name || googleProfile.given_name || null;
      createdAt = now;
      updatedAt = now;
      isNewUser = true;
      isAdmin = false;

      await c.env.DB.prepare(
        `INSERT INTO users (id, email, display_name, provider, provider_id, password_hash, created_at, updated_at, is_active, is_admin)
         VALUES (?, ?, ?, 'google', ?, NULL, ?, ?, 1, 0)`
      )
        .bind(userId, googleProfile.email, displayName, googleProfile.id, now, now)
        .run();

      logger.info('New Google user created', { userId, email: googleProfile.email });
    }

    // Get JWT secret from environment
    const jwtSecret = c.env.JWT_SECRET;
    if (!jwtSecret) {
      logger.error('JWT_SECRET not configured');
      return c.json(response.error('Server configuration error', 'CONFIG_ERROR'), 500);
    }

    // Generate access and refresh tokens with admin status
    const tokens = await createTokenPair(userId, googleProfile.email, jwtSecret, undefined, {
      isAdmin,
    });

    // Store refresh token in KV
    await storeRefreshToken(c.env.KV, userId, googleProfile.email, tokens.refreshToken);

    logger.info('Google OAuth login successful', { userId, isNewUser });

    // Check if this is a UI-initiated flow
    const uiState = storedState.ui_state;
    if (uiState) {
      // Redirect to UI callback with tokens
      const callbackUrl = new URL('/ui/auth/oauth/callback', c.req.url);
      callbackUrl.searchParams.set('access_token', tokens.accessToken);
      callbackUrl.searchParams.set('refresh_token', tokens.refreshToken);
      callbackUrl.searchParams.set('provider', 'google');
      callbackUrl.searchParams.set('ui_state', uiState);
      return c.redirect(callbackUrl.toString());
    }

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
        is_admin: isAdmin,
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

    // Check if there's UI state to redirect errors
    const storedStateJson = await c.env.KV.get(`${OAUTH_STATE_PREFIX}${query.state}`);
    if (storedStateJson) {
      try {
        const storedState = JSON.parse(storedStateJson);
        if (storedState.ui_state) {
          return c.redirect(
            `/ui/auth/login?error=${encodeURIComponent('Failed to complete Google sign-in')}`
          );
        }
      } catch {
        // Ignore parsing errors
      }
    }

    return c.json(
      response.error('Failed to complete Google sign-in', 'OAUTH_CALLBACK_FAILED'),
      500
    );
  }
});

// =============================================================================
// GitHub OAuth2 Routes
// =============================================================================

/**
 * GET /api/auth/github
 *
 * Initiates GitHub OAuth2 sign-in flow
 * Returns authorization URL for redirect
 */
authRouter.get('/github', async c => {
  const logger = getLogger(c);

  // Check if GitHub OAuth is configured
  if (!c.env.GITHUB_CLIENT_ID || !c.env.GITHUB_REDIRECT_URI) {
    logger.warn('GitHub OAuth not configured');
    return c.json(response.error('GitHub OAuth is not configured', 'OAUTH_NOT_CONFIGURED'), 501);
  }

  // Check if this is a UI-initiated OAuth flow
  const uiState = c.req.query('ui_state');

  try {
    const config: GitHubOAuthConfig = {
      clientId: c.env.GITHUB_CLIENT_ID,
      clientSecret: c.env.GITHUB_CLIENT_SECRET || '',
      redirectUri: c.env.GITHUB_REDIRECT_URI,
    };

    // Generate state for CSRF protection
    const { state, stateData } = generateGitHubOAuthState();

    // Store state in KV for validation during callback
    // Include ui_state if this is a UI-initiated flow
    const stateToStore = uiState ? { ...stateData, ui_state: uiState } : stateData;
    await c.env.KV.put(`${OAUTH_STATE_PREFIX}github:${state}`, JSON.stringify(stateToStore), {
      expirationTtl: OAUTH_STATE_TTL,
    });

    // Build authorization URL
    const authUrl = buildGitHubAuthorizationUrl(config, state);

    logger.info('GitHub OAuth authorization URL generated', {
      state: stateData.nonce,
      isUiFlow: !!uiState,
    });

    // If this is a UI flow, redirect directly to GitHub
    if (uiState) {
      return c.redirect(authUrl);
    }

    return c.json(
      response.success({
        authorization_url: authUrl,
        state: state,
      })
    );
  } catch (error) {
    logger.error('Error generating GitHub OAuth URL', error as Error);
    if (uiState) {
      return c.redirect(
        `/ui/auth/login?error=${encodeURIComponent('Failed to initiate GitHub sign-in')}`
      );
    }
    return c.json(response.error('Failed to initiate GitHub sign-in', 'OAUTH_INIT_FAILED'), 500);
  }
});

/**
 * GET /api/auth/github/callback
 *
 * Handles GitHub OAuth2 callback with authorization code
 * Creates or links user account and returns tokens
 */
authRouter.get('/github/callback', async c => {
  const logger = getLogger(c);

  // Check if GitHub OAuth is configured
  if (!c.env.GITHUB_CLIENT_ID || !c.env.GITHUB_CLIENT_SECRET || !c.env.GITHUB_REDIRECT_URI) {
    logger.warn('GitHub OAuth not fully configured');
    return c.json(response.error('GitHub OAuth is not configured', 'OAUTH_NOT_CONFIGURED'), 501);
  }

  // Parse query parameters
  const query = c.req.query();

  // Check for OAuth error response
  if (query.error) {
    logger.warn('GitHub OAuth error response', {
      error: query.error,
      description: query.error_description,
    });
    return c.json(
      response.error(query.error_description || 'OAuth authentication failed', 'OAUTH_ERROR'),
      400
    );
  }

  // Validate required parameters
  if (!query.code || !query.state) {
    logger.warn('Missing OAuth callback parameters');
    return c.json(response.error('Missing authorization code or state', 'INVALID_CALLBACK'), 400);
  }

  const { code, state } = query;

  try {
    // Retrieve and validate state from KV
    const storedStateJson = await c.env.KV.get(`${OAUTH_STATE_PREFIX}github:${state}`);
    if (!storedStateJson) {
      logger.warn('OAuth state not found or expired', { state });
      return c.json(response.error('Invalid or expired state parameter', 'INVALID_STATE'), 400);
    }

    // Parse stored state
    const storedState = JSON.parse(storedStateJson);
    const parsedState = parseGitHubOAuthState(state);

    if (!parsedState) {
      logger.warn('Invalid OAuth state data');
      return c.json(response.error('Invalid state data', 'INVALID_STATE'), 400);
    }

    // Delete state from KV (one-time use)
    await c.env.KV.delete(`${OAUTH_STATE_PREFIX}github:${state}`);

    const config: GitHubOAuthConfig = {
      clientId: c.env.GITHUB_CLIENT_ID,
      clientSecret: c.env.GITHUB_CLIENT_SECRET,
      redirectUri: c.env.GITHUB_REDIRECT_URI,
    };

    // Exchange authorization code for tokens
    logger.info('Exchanging authorization code for tokens');
    const tokenResponse = await exchangeGitHubCodeForTokens(config, code);

    // Fetch user profile from GitHub
    logger.info('Fetching GitHub user profile');
    const githubProfile = await fetchGitHubUserProfile(tokenResponse.access_token);

    // Fetch primary email if not in profile
    let email = githubProfile.email;
    if (!email) {
      logger.info('Fetching GitHub user primary email');
      email = await fetchGitHubUserPrimaryEmail(tokenResponse.access_token);
    }

    // Validate GitHub profile
    const profileValidation = validateGitHubProfile(githubProfile, email);
    if (!profileValidation.valid) {
      logger.warn('Invalid GitHub profile', { error: profileValidation.error });
      return c.json(
        response.error(profileValidation.error || 'Invalid profile', 'INVALID_PROFILE'),
        400
      );
    }

    logger.info('GitHub profile retrieved', {
      githubId: githubProfile.id,
      login: githubProfile.login,
      email: email,
    });

    // Check if user already exists by email
    const existingUser = await c.env.DB.prepare(
      'SELECT id, email, display_name, provider, provider_id, created_at, updated_at, is_active, is_admin FROM users WHERE email = ?'
    )
      .bind(email)
      .first();

    let userId: string;
    let displayName: string | null;
    let createdAt: number;
    let updatedAt: number;
    let isNewUser = false;
    let isAdmin = false;

    if (existingUser) {
      // User exists - check if it's already a GitHub account
      if (existingUser.provider === 'github') {
        // Same provider, just log them in
        logger.info('Existing GitHub user logging in', { userId: String(existingUser.id) });
      } else {
        // Different provider - link GitHub account to existing user
        const existingUserId = String(existingUser.id);
        logger.info('Linking GitHub account to existing user', {
          userId: existingUserId,
          existingProvider: existingUser.provider,
        });

        const now = Math.floor(Date.now() / 1000);
        await c.env.DB.prepare(
          `UPDATE users SET provider = 'github', provider_id = ?, updated_at = ? WHERE id = ?`
        )
          .bind(String(githubProfile.id), now, existingUserId)
          .run();
      }

      userId = String(existingUser.id);
      displayName = existingUser.display_name ? String(existingUser.display_name) : null;
      createdAt = existingUser.created_at as number;
      updatedAt = Math.floor(Date.now() / 1000);
      isAdmin = !!existingUser.is_admin;

      // Check if account is active
      if (!existingUser.is_active) {
        logger.warn('GitHub login attempt for inactive account', { email });
        return c.json(response.error('Account is not active', 'ACCOUNT_INACTIVE'), 401);
      }
    } else {
      // Create new user (new users are not admins by default)
      userId = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);
      displayName = githubProfile.name || githubProfile.login || null;
      createdAt = now;
      updatedAt = now;
      isNewUser = true;
      isAdmin = false;

      await c.env.DB.prepare(
        `INSERT INTO users (id, email, display_name, provider, provider_id, password_hash, created_at, updated_at, is_active, is_admin)
         VALUES (?, ?, ?, 'github', ?, NULL, ?, ?, 1, 0)`
      )
        .bind(userId, email, displayName, String(githubProfile.id), now, now)
        .run();

      logger.info('New GitHub user created', { userId, email });
    }

    // Get JWT secret from environment
    const jwtSecret = c.env.JWT_SECRET;
    if (!jwtSecret) {
      logger.error('JWT_SECRET not configured');
      return c.json(response.error('Server configuration error', 'CONFIG_ERROR'), 500);
    }

    // Generate access and refresh tokens with admin status
    const tokens = await createTokenPair(userId, email!, jwtSecret, undefined, { isAdmin });

    // Store refresh token in KV
    await storeRefreshToken(c.env.KV, userId, email!, tokens.refreshToken);

    logger.info('GitHub OAuth login successful', { userId, isNewUser });

    // Check if this is a UI-initiated flow
    const uiState = storedState.ui_state;
    if (uiState) {
      // Redirect to UI callback with tokens
      const callbackUrl = new URL('/ui/auth/oauth/callback', c.req.url);
      callbackUrl.searchParams.set('access_token', tokens.accessToken);
      callbackUrl.searchParams.set('refresh_token', tokens.refreshToken);
      callbackUrl.searchParams.set('provider', 'github');
      callbackUrl.searchParams.set('ui_state', uiState);
      return c.redirect(callbackUrl.toString());
    }

    // Return success response with tokens
    const statusCode = isNewUser ? 201 : 200;
    const responseData = {
      user: {
        id: userId,
        email: email,
        display_name: displayName,
        provider: 'github' as const,
        created_at: createdAt,
        updated_at: updatedAt,
        is_active: true,
        is_admin: isAdmin,
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
    logger.error('Error during GitHub OAuth callback', error as Error);

    // Check if there's UI state to redirect errors
    const storedStateJson = await c.env.KV.get(`${OAUTH_STATE_PREFIX}github:${query.state}`);
    if (storedStateJson) {
      try {
        const storedState = JSON.parse(storedStateJson);
        if (storedState.ui_state) {
          return c.redirect(
            `/ui/auth/login?error=${encodeURIComponent('Failed to complete GitHub sign-in')}`
          );
        }
      } catch {
        // Ignore parsing errors
      }
    }

    return c.json(
      response.error('Failed to complete GitHub sign-in', 'OAUTH_CALLBACK_FAILED'),
      500
    );
  }
});

// =============================================================================
// Auth Providers Discovery Endpoint
// =============================================================================

/**
 * Provider information returned by the providers endpoint
 */
interface AuthProvider {
  id: string;
  name: string;
  type: 'local' | 'oauth2';
  enabled: boolean;
  authorize_url?: string;
}

/**
 * GET /api/auth/providers
 *
 * Returns a list of available authentication providers.
 * This allows clients to discover which auth methods are configured and available.
 */
authRouter.get('/providers', async c => {
  const logger = getLogger(c);

  try {
    const providers: AuthProvider[] = [];

    // Local authentication is always available
    providers.push({
      id: 'local',
      name: 'Email & Password',
      type: 'local',
      enabled: true,
    });

    // Check if Google OAuth is configured
    const googleConfigured = !!(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_REDIRECT_URI);
    providers.push({
      id: 'google',
      name: 'Google',
      type: 'oauth2',
      enabled: googleConfigured,
      authorize_url: googleConfigured ? '/api/auth/google' : undefined,
    });

    // Check if GitHub OAuth is configured
    const githubConfigured = !!(c.env.GITHUB_CLIENT_ID && c.env.GITHUB_REDIRECT_URI);
    providers.push({
      id: 'github',
      name: 'GitHub',
      type: 'oauth2',
      enabled: githubConfigured,
      authorize_url: githubConfigured ? '/api/auth/github' : undefined,
    });

    logger.info('Auth providers retrieved', {
      totalProviders: providers.length,
      enabledProviders: providers.filter(p => p.enabled).length,
    });

    return c.json(
      response.success({
        providers,
      })
    );
  } catch (error) {
    logger.error('Error retrieving auth providers', error as Error);
    return c.json(
      response.error('Failed to retrieve auth providers', 'PROVIDERS_RETRIEVAL_FAILED'),
      500
    );
  }
});

export default authRouter;
