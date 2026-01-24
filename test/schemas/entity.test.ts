import { describe, it, expect } from 'vitest';
import { createEntitySchema, updateEntitySchema, entityQuerySchema } from '../../src/schemas/entity.js';

describe('Entity Schemas', () => {
  describe('createEntitySchema', () => {
    it('should validate a valid entity creation request', () => {
      const validData = {
        type_id: '550e8400-e29b-41d4-a716-446655440000',
        properties: { name: 'Test Entity', value: 42 },
      };

      const result = createEntitySchema.safeParse(validData);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(validData);
      }
    });

    it('should accept minimal valid data with default properties', () => {
      const minimalData = {
        type_id: '550e8400-e29b-41d4-a716-446655440000',
      };

      const result = createEntitySchema.safeParse(minimalData);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.properties).toEqual({});
      }
    });

    it('should reject invalid UUID for type_id', () => {
      const invalidData = {
        type_id: 'not-a-uuid',
        properties: {},
      };

      const result = createEntitySchema.safeParse(invalidData);
      expect(result.success).toBe(false);
    });

    it('should reject missing type_id', () => {
      const invalidData = {
        properties: { name: 'Test' },
      };

      const result = createEntitySchema.safeParse(invalidData);
      expect(result.success).toBe(false);
    });

    it('should accept empty properties object', () => {
      const validData = {
        type_id: '550e8400-e29b-41d4-a716-446655440000',
        properties: {},
      };

      const result = createEntitySchema.safeParse(validData);
      expect(result.success).toBe(true);
    });

    it('should accept nested properties', () => {
      const validData = {
        type_id: '550e8400-e29b-41d4-a716-446655440000',
        properties: {
          address: {
            street: '123 Main St',
            city: 'Springfield',
          },
          tags: ['important', 'urgent'],
        },
      };

      const result = createEntitySchema.safeParse(validData);
      expect(result.success).toBe(true);
    });
  });

  describe('updateEntitySchema', () => {
    it('should validate a valid entity update request', () => {
      const validData = {
        properties: { name: 'Updated Entity', value: 100 },
      };

      const result = updateEntitySchema.safeParse(validData);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(validData);
      }
    });

    it('should reject missing properties', () => {
      const invalidData = {};

      const result = updateEntitySchema.safeParse(invalidData);
      expect(result.success).toBe(false);
    });

    it('should accept empty properties object', () => {
      const validData = {
        properties: {},
      };

      const result = updateEntitySchema.safeParse(validData);
      expect(result.success).toBe(true);
    });

    it('should accept properties with various types', () => {
      const validData = {
        properties: {
          string: 'text',
          number: 42,
          boolean: true,
          null: null,
          array: [1, 2, 3],
          object: { nested: 'value' },
        },
      };

      const result = updateEntitySchema.safeParse(validData);
      expect(result.success).toBe(true);
    });
  });

  describe('entityQuerySchema', () => {
    it('should validate a basic query with cursor and limit', () => {
      const validQuery = {
        cursor: '1234567890:some-uuid',
        limit: '20',
        include_deleted: 'false',
      };

      const result = entityQuerySchema.safeParse(validQuery);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(20);
        expect(result.data.include_deleted).toBe(false);
      }
    });

    it('should validate query with type filter', () => {
      const validQuery = {
        type_id: '550e8400-e29b-41d4-a716-446655440000',
      };

      const result = entityQuerySchema.safeParse(validQuery);
      expect(result.success).toBe(true);
    });

    it('should validate query with user filter', () => {
      const validQuery = {
        created_by: '550e8400-e29b-41d4-a716-446655440000',
      };

      const result = entityQuerySchema.safeParse(validQuery);
      expect(result.success).toBe(true);
    });

    it('should validate query with date range filters', () => {
      const validQuery = {
        created_after: '1609459200',
        created_before: '1640995200',
      };

      const result = entityQuerySchema.safeParse(validQuery);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.created_after).toBe(1609459200);
        expect(result.data.created_before).toBe(1640995200);
      }
    });

    it('should reject invalid UUID in type_id', () => {
      const invalidQuery = {
        type_id: 'not-a-uuid',
      };

      const result = entityQuerySchema.safeParse(invalidQuery);
      expect(result.success).toBe(false);
    });

    it('should reject invalid timestamp format', () => {
      const invalidQuery = {
        created_after: 'not-a-timestamp',
      };

      const result = entityQuerySchema.safeParse(invalidQuery);
      expect(result.success).toBe(false);
    });

    it('should enforce maximum limit', () => {
      const queryWithLargeLimit = {
        limit: '200',
      };

      const result = entityQuerySchema.safeParse(queryWithLargeLimit);
      expect(result.success).toBe(true);
      if (result.success) {
        // Should be capped at 100
        expect(result.data.limit).toBeLessThanOrEqual(100);
      }
    });

    it('should handle include_deleted flag', () => {
      const queryWithDeleted = {
        include_deleted: 'true',
      };

      const result = entityQuerySchema.safeParse(queryWithDeleted);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.include_deleted).toBe(true);
      }
    });

    it('should allow empty query', () => {
      const emptyQuery = {};

      const result = entityQuerySchema.safeParse(emptyQuery);
      expect(result.success).toBe(true);
    });
  });
});
