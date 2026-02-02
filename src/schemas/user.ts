import { z } from 'zod';
import { uuidSchema, timestampSchema, sqliteBooleanSchema } from './common.js';
import { escapeHtml } from '../utils/sanitize.js';

// Provider types
export const providerSchema = z.enum(['google', 'github', 'local', 'microsoft', 'apple']);

// User database model schema
export const userSchema = z.object({
  id: uuidSchema,
  email: z.string().email(),
  display_name: z.string().nullable(),
  provider: providerSchema,
  provider_id: z.string().nullable(),
  password_hash: z.string().nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  is_active: sqliteBooleanSchema,
  is_admin: sqliteBooleanSchema.optional().default(0),
});

// User creation schema (for registration) - with sanitization for display_name
export const createUserSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must be at most 128 characters')
    .optional(),
  display_name: z
    .string()
    .min(1)
    .max(255)
    .transform(val => escapeHtml(val))
    .optional(),
  provider: providerSchema.optional().default('local'),
  provider_id: z.string().optional(),
});

// User update schema - with sanitization for display_name
export const updateUserSchema = z.object({
  display_name: z
    .string()
    .min(1)
    .max(255)
    .transform(val => escapeHtml(val))
    .optional(),
  email: z.string().email('Invalid email address').optional(),
  is_active: sqliteBooleanSchema.optional(),
});

// Admin role change schema
export const adminRoleChangeSchema = z.object({
  is_admin: z.boolean(),
});

// User response schema (without sensitive data)
export const userResponseSchema = userSchema
  .omit({
    password_hash: true,
    provider_id: true,
  })
  .extend({
    is_admin: z.boolean().optional(),
  });

// Login schema
export const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

// Token refresh schema
export const refreshTokenSchema = z.object({
  refresh_token: z.string().min(1, 'Refresh token is required'),
});

// Logout schema
export const logoutSchema = z.object({
  refresh_token: z.string().min(1, 'Refresh token is required'),
});

// JWT payload schema
export const jwtPayloadSchema = z.object({
  user_id: uuidSchema,
  email: z.string().email(),
  is_admin: z.boolean().optional(), // Admin role flag
  iat: z.number(),
  exp: z.number(),
  jti: z.string().optional(), // JWT ID for uniqueness
});

// OAuth callback query parameters schema
export const oauthCallbackQuerySchema = z.object({
  code: z.string().min(1, 'Authorization code is required'),
  state: z.string().min(1, 'State parameter is required'),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

// OAuth state stored in KV
export const oauthStateSchema = z.object({
  nonce: z.string(),
  timestamp: z.number(),
  codeVerifier: z.string().optional(),
});

// Types derived from schemas
export type User = z.infer<typeof userSchema>;
export type CreateUser = z.infer<typeof createUserSchema>;
export type UpdateUser = z.infer<typeof updateUserSchema>;
export type AdminRoleChange = z.infer<typeof adminRoleChangeSchema>;
export type UserResponse = z.infer<typeof userResponseSchema>;
export type Login = z.infer<typeof loginSchema>;
export type RefreshToken = z.infer<typeof refreshTokenSchema>;
export type Logout = z.infer<typeof logoutSchema>;
export type JwtPayload = z.infer<typeof jwtPayloadSchema>;
export type Provider = z.infer<typeof providerSchema>;
export type OAuthCallbackQuery = z.infer<typeof oauthCallbackQuerySchema>;
export type OAuthState = z.infer<typeof oauthStateSchema>;
