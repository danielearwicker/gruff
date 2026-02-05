import { z } from '@hono/zod-openapi';
import { uuidSchema, timestampSchema } from './common.js';
import { escapeHtml } from '../utils/sanitize.js';

// Member type schema
export const memberTypeSchema = z.enum(['user', 'group']).openapi({ example: 'user' });

// Group database model schema
export const groupSchema = z
  .object({
    id: uuidSchema.openapi({ example: '550e8400-e29b-41d4-a716-446655440000' }),
    name: z.string().min(1).max(255).openapi({ example: 'Engineering' }),
    description: z.string().nullable().openapi({ example: 'Engineering team group' }),
    created_at: timestampSchema.openapi({ example: 1704067200 }),
    created_by: uuidSchema.nullable().openapi({ example: '550e8400-e29b-41d4-a716-446655440001' }),
  })
  .openapi('Group');

// Group creation schema - with sanitization for name and description
export const createGroupSchema = z
  .object({
    name: z
      .string()
      .min(1, 'Group name is required')
      .max(255, 'Group name must be at most 255 characters')
      .transform(val => escapeHtml(val))
      .openapi({ example: 'Engineering' }),
    description: z
      .string()
      .max(1000, 'Description must be at most 1000 characters')
      .transform(val => escapeHtml(val))
      .optional()
      .openapi({ example: 'Engineering team group' }),
  })
  .openapi('CreateGroup');

// Group update schema - with sanitization for name and description
export const updateGroupSchema = z
  .object({
    name: z
      .string()
      .min(1, 'Group name is required')
      .max(255, 'Group name must be at most 255 characters')
      .transform(val => escapeHtml(val))
      .optional()
      .openapi({ example: 'Engineering' }),
    description: z
      .string()
      .max(1000, 'Description must be at most 1000 characters')
      .transform(val => escapeHtml(val))
      .nullable()
      .optional()
      .openapi({ example: 'Engineering team group' }),
  })
  .openapi('UpdateGroup');

// Group response schema (for API responses)
export const groupResponseSchema = groupSchema;

// Group member database model schema
export const groupMemberSchema = z
  .object({
    group_id: uuidSchema.openapi({ example: '550e8400-e29b-41d4-a716-446655440000' }),
    member_type: memberTypeSchema,
    member_id: uuidSchema.openapi({ example: '550e8400-e29b-41d4-a716-446655440002' }),
    created_at: timestampSchema.openapi({ example: 1704067200 }),
    created_by: uuidSchema.nullable().openapi({ example: '550e8400-e29b-41d4-a716-446655440001' }),
  })
  .openapi('GroupMember');

// Add member to group schema
export const addGroupMemberSchema = z
  .object({
    member_type: memberTypeSchema,
    member_id: uuidSchema.openapi({ example: '550e8400-e29b-41d4-a716-446655440002' }),
  })
  .openapi('AddGroupMember');

// Group member response schema (for API responses)
export const groupMemberResponseSchema = z
  .object({
    member_type: memberTypeSchema,
    member_id: uuidSchema.openapi({ example: '550e8400-e29b-41d4-a716-446655440002' }),
    created_at: timestampSchema.openapi({ example: 1704067200 }),
    // Optional enriched fields (populated when fetching members with details)
    name: z.string().optional().openapi({ example: 'John Doe' }), // Display name for user or group name
    email: z.string().email().optional().openapi({ example: 'john@example.com' }), // Email for user members
  })
  .openapi('GroupMemberResponse');

// Types derived from schemas
export type Group = z.infer<typeof groupSchema>;
export type CreateGroup = z.infer<typeof createGroupSchema>;
export type UpdateGroup = z.infer<typeof updateGroupSchema>;
export type GroupResponse = z.infer<typeof groupResponseSchema>;
export type MemberType = z.infer<typeof memberTypeSchema>;
export type GroupMember = z.infer<typeof groupMemberSchema>;
export type AddGroupMember = z.infer<typeof addGroupMemberSchema>;
export type GroupMemberResponse = z.infer<typeof groupMemberResponseSchema>;

// Query schema for listing groups
export const listGroupsQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .transform(val => (val ? parseInt(val, 10) : 20))
    .openapi({
      param: { name: 'limit', in: 'query' },
      example: '20',
    }),
  offset: z
    .string()
    .optional()
    .transform(val => (val ? parseInt(val, 10) : 0))
    .openapi({
      param: { name: 'offset', in: 'query' },
      example: '0',
    }),
  name: z
    .string()
    .optional()
    .openapi({
      param: { name: 'name', in: 'query' },
      example: 'Engineering',
    }), // Filter by name (partial match)
  // Field selection: comma-separated list of fields to include in response
  fields: z
    .string()
    .optional()
    .openapi({
      param: { name: 'fields', in: 'query' },
      example: 'id,name,description',
    }),
});

// Query schema for listing group members
export const listGroupMembersQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .transform(val => (val ? parseInt(val, 10) : 100))
    .openapi({
      param: { name: 'limit', in: 'query' },
      example: '100',
    }),
  offset: z
    .string()
    .optional()
    .transform(val => (val ? parseInt(val, 10) : 0))
    .openapi({
      param: { name: 'offset', in: 'query' },
      example: '0',
    }),
  member_type: memberTypeSchema.optional().openapi({
    param: { name: 'member_type', in: 'query' },
  }), // Filter by member type
});
