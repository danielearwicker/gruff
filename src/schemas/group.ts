import { z } from 'zod';
import { uuidSchema, timestampSchema } from './common.js';
import { escapeHtml } from '../utils/sanitize.js';

// Member type schema
export const memberTypeSchema = z.enum(['user', 'group']);

// Group database model schema
export const groupSchema = z.object({
  id: uuidSchema,
  name: z.string().min(1).max(255),
  description: z.string().nullable(),
  created_at: timestampSchema,
  created_by: uuidSchema.nullable(),
});

// Group creation schema - with sanitization for name and description
export const createGroupSchema = z.object({
  name: z
    .string()
    .min(1, 'Group name is required')
    .max(255, 'Group name must be at most 255 characters')
    .transform(val => escapeHtml(val)),
  description: z
    .string()
    .max(1000, 'Description must be at most 1000 characters')
    .transform(val => escapeHtml(val))
    .optional(),
});

// Group update schema - with sanitization for name and description
export const updateGroupSchema = z.object({
  name: z
    .string()
    .min(1, 'Group name is required')
    .max(255, 'Group name must be at most 255 characters')
    .transform(val => escapeHtml(val))
    .optional(),
  description: z
    .string()
    .max(1000, 'Description must be at most 1000 characters')
    .transform(val => escapeHtml(val))
    .nullable()
    .optional(),
});

// Group response schema (for API responses)
export const groupResponseSchema = groupSchema;

// Group member database model schema
export const groupMemberSchema = z.object({
  group_id: uuidSchema,
  member_type: memberTypeSchema,
  member_id: uuidSchema,
  created_at: timestampSchema,
  created_by: uuidSchema.nullable(),
});

// Add member to group schema
export const addGroupMemberSchema = z.object({
  member_type: memberTypeSchema,
  member_id: uuidSchema,
});

// Group member response schema (for API responses)
export const groupMemberResponseSchema = z.object({
  member_type: memberTypeSchema,
  member_id: uuidSchema,
  created_at: timestampSchema,
  // Optional enriched fields (populated when fetching members with details)
  name: z.string().optional(), // Display name for user or group name
  email: z.string().email().optional(), // Email for user members
});

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
    .transform(val => (val ? parseInt(val, 10) : 20)),
  offset: z
    .string()
    .optional()
    .transform(val => (val ? parseInt(val, 10) : 0)),
  name: z.string().optional(), // Filter by name (partial match)
  // Field selection: comma-separated list of fields to include in response
  fields: z.string().optional(),
});

// Query schema for listing group members
export const listGroupMembersQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .transform(val => (val ? parseInt(val, 10) : 100)),
  offset: z
    .string()
    .optional()
    .transform(val => (val ? parseInt(val, 10) : 0)),
  member_type: memberTypeSchema.optional(), // Filter by member type
});
