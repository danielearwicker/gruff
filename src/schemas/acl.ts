import { z } from '@hono/zod-openapi';
import { uuidSchema } from './common.js';

// Permission type schema
export const permissionSchema = z.enum(['read', 'write']).openapi({ example: 'write' });

// Principal type schema
export const principalTypeSchema = z.enum(['user', 'group']).openapi({ example: 'user' });

// ACL entry schema (single permission grant)
export const aclEntrySchema = z
  .object({
    principal_type: principalTypeSchema.openapi({ example: 'user' }),
    principal_id: uuidSchema.openapi({ example: '550e8400-e29b-41d4-a716-446655440001' }),
    permission: permissionSchema.openapi({ example: 'write' }),
  })
  .openapi('AclEntry');

// ACL database model schema
export const aclSchema = z.object({
  id: z.number().int().positive(),
  hash: z.string().min(64).max(64), // SHA-256 hex string
  created_at: z.number().int().positive(),
});

// ACL entry database model schema
export const aclEntryDbSchema = z.object({
  acl_id: z.number().int().positive(),
  principal_type: principalTypeSchema,
  principal_id: uuidSchema,
  permission: permissionSchema,
});

// Request schema for setting ACL on an entity or link
export const setAclRequestSchema = z
  .object({
    entries: z
      .array(aclEntrySchema)
      .min(0) // Empty array means "make public" (remove ACL)
      .max(100, 'Maximum 100 ACL entries allowed')
      .openapi({ description: 'ACL entries. Empty array removes ACL (makes public).' }),
  })
  .openapi('SetAclRequest');

// Enriched ACL entry with principal details (for responses)
export const enrichedAclEntrySchema = aclEntrySchema
  .extend({
    // Optional enriched fields (populated when fetching ACL with details)
    principal_name: z.string().optional().openapi({ example: 'John Doe' }),
    principal_email: z.string().email().optional().openapi({ example: 'john@example.com' }),
  })
  .openapi('EnrichedAclEntry');

// Response schema for getting ACL on an entity or link
export const aclResponseSchema = z
  .object({
    entries: z.array(enrichedAclEntrySchema).openapi({ description: 'List of ACL entries' }),
    // null if resource has no ACL (public/unrestricted)
    acl_id: z
      .number()
      .int()
      .positive()
      .nullable()
      .openapi({ example: 1, description: 'ACL ID, null if public' }),
  })
  .openapi('AclResponse');

// Types derived from schemas
export type Permission = z.infer<typeof permissionSchema>;
export type PrincipalType = z.infer<typeof principalTypeSchema>;
export type AclEntry = z.infer<typeof aclEntrySchema>;
export type Acl = z.infer<typeof aclSchema>;
export type AclEntryDb = z.infer<typeof aclEntryDbSchema>;
export type SetAclRequest = z.infer<typeof setAclRequestSchema>;
export type AclResponse = z.infer<typeof aclResponseSchema>;

// Enriched ACL entry with principal details
export interface EnrichedAclEntry extends AclEntry {
  principal_name?: string;
  principal_email?: string;
}
