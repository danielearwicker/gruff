import { z } from 'zod';
import { uuidSchema } from './common.js';

// Permission type schema
export const permissionSchema = z.enum(['read', 'write']);

// Principal type schema
export const principalTypeSchema = z.enum(['user', 'group']);

// ACL entry schema (single permission grant)
export const aclEntrySchema = z.object({
  principal_type: principalTypeSchema,
  principal_id: uuidSchema,
  permission: permissionSchema,
});

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
export const setAclRequestSchema = z.object({
  entries: z
    .array(aclEntrySchema)
    .min(0) // Empty array means "make public" (remove ACL)
    .max(100, 'Maximum 100 ACL entries allowed'),
});

// Response schema for getting ACL on an entity or link
export const aclResponseSchema = z.object({
  entries: z.array(
    aclEntrySchema.extend({
      // Optional enriched fields (populated when fetching ACL with details)
      principal_name: z.string().optional(), // Display name for user or group name
      principal_email: z.string().email().optional(), // Email for user principals
    })
  ),
  // null if resource has no ACL (public/unrestricted)
  acl_id: z.number().int().positive().nullable(),
});

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
