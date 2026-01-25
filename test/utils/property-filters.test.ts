import { describe, it, expect } from 'vitest';
import {
  parseJsonPath,
  buildPropertyFilter,
  buildPropertyFilters,
  buildFilterExpression,
} from '../../src/utils/property-filters.js';

describe('parseJsonPath', () => {
  describe('simple property paths', () => {
    it('should parse a simple property name', () => {
      const result = parseJsonPath('name');
      expect(result.isValid).toBe(true);
      expect(result.sqlPath).toBe('$.name');
      expect(result.components).toEqual([{ type: 'property', value: 'name' }]);
    });

    it('should parse a property with underscore', () => {
      const result = parseJsonPath('first_name');
      expect(result.isValid).toBe(true);
      expect(result.sqlPath).toBe('$.first_name');
      expect(result.components).toEqual([{ type: 'property', value: 'first_name' }]);
    });

    it('should parse a property starting with underscore', () => {
      const result = parseJsonPath('_private');
      expect(result.isValid).toBe(true);
      expect(result.sqlPath).toBe('$._private');
      expect(result.components).toEqual([{ type: 'property', value: '_private' }]);
    });

    it('should handle paths already starting with $.', () => {
      const result = parseJsonPath('$.name');
      expect(result.isValid).toBe(true);
      expect(result.sqlPath).toBe('$.name');
    });

    it('should handle paths already starting with $', () => {
      const result = parseJsonPath('$name');
      expect(result.isValid).toBe(true);
      expect(result.sqlPath).toBe('$.name');
    });
  });

  describe('nested property paths with dot notation', () => {
    it('should parse two-level nesting', () => {
      const result = parseJsonPath('address.city');
      expect(result.isValid).toBe(true);
      expect(result.sqlPath).toBe('$.address.city');
      expect(result.components).toEqual([
        { type: 'property', value: 'address' },
        { type: 'property', value: 'city' },
      ]);
    });

    it('should parse three-level nesting', () => {
      const result = parseJsonPath('user.profile.name');
      expect(result.isValid).toBe(true);
      expect(result.sqlPath).toBe('$.user.profile.name');
      expect(result.components).toHaveLength(3);
    });

    it('should parse deep nesting (up to max depth)', () => {
      const result = parseJsonPath('a.b.c.d.e.f.g.h.i.j');
      expect(result.isValid).toBe(true);
      expect(result.sqlPath).toBe('$.a.b.c.d.e.f.g.h.i.j');
      expect(result.components).toHaveLength(10);
    });

    it('should reject paths exceeding max depth', () => {
      const result = parseJsonPath('a.b.c.d.e.f.g.h.i.j.k');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('maximum depth');
    });
  });

  describe('array index paths with bracket notation', () => {
    it('should parse simple array index', () => {
      const result = parseJsonPath('tags[0]');
      expect(result.isValid).toBe(true);
      expect(result.sqlPath).toBe('$.tags[0]');
      expect(result.components).toEqual([
        { type: 'property', value: 'tags' },
        { type: 'index', value: 0 },
      ]);
    });

    it('should parse multiple digit array index', () => {
      const result = parseJsonPath('items[123]');
      expect(result.isValid).toBe(true);
      expect(result.sqlPath).toBe('$.items[123]');
      expect(result.components).toEqual([
        { type: 'property', value: 'items' },
        { type: 'index', value: 123 },
      ]);
    });

    it('should parse consecutive array indices', () => {
      const result = parseJsonPath('data[0][1]');
      expect(result.isValid).toBe(true);
      expect(result.sqlPath).toBe('$.data[0][1]');
      expect(result.components).toEqual([
        { type: 'property', value: 'data' },
        { type: 'index', value: 0 },
        { type: 'index', value: 1 },
      ]);
    });
  });

  describe('array index paths with dot notation', () => {
    it('should parse array index with dot notation', () => {
      const result = parseJsonPath('tags.0');
      expect(result.isValid).toBe(true);
      expect(result.sqlPath).toBe('$.tags[0]');
      expect(result.components).toEqual([
        { type: 'property', value: 'tags' },
        { type: 'index', value: 0 },
      ]);
    });

    it('should parse multi-digit array index with dot notation', () => {
      const result = parseJsonPath('items.42');
      expect(result.isValid).toBe(true);
      expect(result.sqlPath).toBe('$.items[42]');
    });
  });

  describe('mixed paths (objects and arrays)', () => {
    it('should parse array index followed by property', () => {
      const result = parseJsonPath('items[0].name');
      expect(result.isValid).toBe(true);
      expect(result.sqlPath).toBe('$.items[0].name');
      expect(result.components).toEqual([
        { type: 'property', value: 'items' },
        { type: 'index', value: 0 },
        { type: 'property', value: 'name' },
      ]);
    });

    it('should parse complex mixed path', () => {
      const result = parseJsonPath('users[0].addresses[1].city');
      expect(result.isValid).toBe(true);
      expect(result.sqlPath).toBe('$.users[0].addresses[1].city');
      expect(result.components).toHaveLength(5);
    });

    it('should parse mixed path with dot notation for array', () => {
      const result = parseJsonPath('orders.0.items.1.price');
      expect(result.isValid).toBe(true);
      expect(result.sqlPath).toBe('$.orders[0].items[1].price');
      expect(result.components).toEqual([
        { type: 'property', value: 'orders' },
        { type: 'index', value: 0 },
        { type: 'property', value: 'items' },
        { type: 'index', value: 1 },
        { type: 'property', value: 'price' },
      ]);
    });
  });

  describe('invalid paths', () => {
    it('should reject empty path', () => {
      const result = parseJsonPath('');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('empty');
    });

    it('should reject whitespace-only path', () => {
      const result = parseJsonPath('   ');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('empty');
    });

    it('should reject paths with special characters', () => {
      const result = parseJsonPath('name; DROP TABLE');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Invalid characters');
    });

    it('should reject paths with SQL injection attempts', () => {
      const result = parseJsonPath("name' OR '1'='1");
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Invalid characters');
    });

    it('should reject nested brackets', () => {
      const result = parseJsonPath('data[[0]]');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('nested brackets');
    });

    it('should reject empty brackets', () => {
      const result = parseJsonPath('data[]');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Array indices must be');
    });

    it('should reject unclosed bracket', () => {
      const result = parseJsonPath('data[0');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('unclosed bracket');
    });

    it('should reject unexpected closing bracket', () => {
      const result = parseJsonPath('data]');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('unexpected closing bracket');
    });

    it('should reject non-numeric array index', () => {
      const result = parseJsonPath('data[abc]');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Array indices must be');
    });

    it('should reject property names starting with digits', () => {
      const result = parseJsonPath('123abc');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Property names must start');
    });

    it('should reject property names with hyphens', () => {
      const result = parseJsonPath('first-name');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Invalid characters');
    });
  });
});

describe('buildPropertyFilter', () => {
  describe('nested path support', () => {
    it('should build filter for nested property path', () => {
      const result = buildPropertyFilter(
        { path: 'address.city', operator: 'eq', value: 'NYC' },
        'e'
      );
      expect(result.sql).toBe("json_extract(e.properties, ?) = ?");
      expect(result.bindings).toEqual(['$.address.city', 'NYC']);
    });

    it('should build filter for array index path', () => {
      const result = buildPropertyFilter(
        { path: 'tags[0]', operator: 'eq', value: 'featured' },
        'e'
      );
      expect(result.sql).toBe("json_extract(e.properties, ?) = ?");
      expect(result.bindings).toEqual(['$.tags[0]', 'featured']);
    });

    it('should build filter for dot notation array index', () => {
      const result = buildPropertyFilter(
        { path: 'tags.0', operator: 'eq', value: 'featured' },
        'e'
      );
      expect(result.sql).toBe("json_extract(e.properties, ?) = ?");
      expect(result.bindings).toEqual(['$.tags[0]', 'featured']);
    });

    it('should build filter for mixed path', () => {
      const result = buildPropertyFilter(
        { path: 'items[0].price', operator: 'gt', value: 10 },
        'e'
      );
      expect(result.sql).toBe("CAST(json_extract(e.properties, ?) AS REAL) > ?");
      expect(result.bindings).toEqual(['$.items[0].price', 10]);
    });

    it('should build filter for deeply nested path', () => {
      const result = buildPropertyFilter(
        { path: 'user.profile.settings.theme', operator: 'eq', value: 'dark' },
        'e'
      );
      expect(result.sql).toBe("json_extract(e.properties, ?) = ?");
      expect(result.bindings).toEqual(['$.user.profile.settings.theme', 'dark']);
    });

    it('should build exists filter for nested path', () => {
      const result = buildPropertyFilter(
        { path: 'profile.website', operator: 'exists' },
        'e'
      );
      expect(result.sql).toBe("json_extract(e.properties, ?) IS NOT NULL");
      expect(result.bindings).toEqual(['$.profile.website']);
    });

    it('should throw for invalid nested path', () => {
      expect(() =>
        buildPropertyFilter(
          { path: 'data[[0]]', operator: 'eq', value: 'test' },
          'e'
        )
      ).toThrow('nested brackets');
    });
  });
});

describe('buildPropertyFilters', () => {
  it('should combine multiple nested path filters with AND', () => {
    const result = buildPropertyFilters(
      [
        { path: 'address.city', operator: 'eq', value: 'NYC' },
        { path: 'profile.age', operator: 'gt', value: 18 },
      ],
      'e'
    );
    expect(result.sql).toContain(' AND ');
    expect(result.bindings).toEqual(['$.address.city', 'NYC', '$.profile.age', 18]);
  });
});

describe('buildFilterExpression', () => {
  describe('simple property filters', () => {
    it('should handle a simple property filter', () => {
      const result = buildFilterExpression(
        { path: 'name', operator: 'eq', value: 'John' },
        'e'
      );
      expect(result.sql).toBe('json_extract(e.properties, ?) = ?');
      expect(result.bindings).toEqual(['$.name', 'John']);
    });

    it('should handle different operators', () => {
      const result = buildFilterExpression(
        { path: 'age', operator: 'gt', value: 18 },
        'e'
      );
      expect(result.sql).toBe('CAST(json_extract(e.properties, ?) AS REAL) > ?');
      expect(result.bindings).toEqual(['$.age', 18]);
    });
  });

  describe('AND groups', () => {
    it('should combine filters with AND', () => {
      const result = buildFilterExpression(
        {
          and: [
            { path: 'status', operator: 'eq', value: 'active' },
            { path: 'age', operator: 'gte', value: 18 },
          ],
        },
        'e'
      );
      expect(result.sql).toBe(
        '(json_extract(e.properties, ?) = ?) AND (CAST(json_extract(e.properties, ?) AS REAL) >= ?)'
      );
      expect(result.bindings).toEqual(['$.status', 'active', '$.age', 18]);
    });

    it('should handle single item AND group', () => {
      const result = buildFilterExpression(
        {
          and: [{ path: 'name', operator: 'eq', value: 'John' }],
        },
        'e'
      );
      expect(result.sql).toBe('json_extract(e.properties, ?) = ?');
      expect(result.bindings).toEqual(['$.name', 'John']);
    });

    it('should handle empty AND group', () => {
      const result = buildFilterExpression(
        { and: [] },
        'e'
      );
      expect(result.sql).toBe('');
      expect(result.bindings).toEqual([]);
    });
  });

  describe('OR groups', () => {
    it('should combine filters with OR', () => {
      const result = buildFilterExpression(
        {
          or: [
            { path: 'role', operator: 'eq', value: 'admin' },
            { path: 'role', operator: 'eq', value: 'moderator' },
          ],
        },
        'e'
      );
      expect(result.sql).toBe(
        '(json_extract(e.properties, ?) = ?) OR (json_extract(e.properties, ?) = ?)'
      );
      expect(result.bindings).toEqual(['$.role', 'admin', '$.role', 'moderator']);
    });

    it('should handle single item OR group', () => {
      const result = buildFilterExpression(
        {
          or: [{ path: 'name', operator: 'eq', value: 'John' }],
        },
        'e'
      );
      expect(result.sql).toBe('json_extract(e.properties, ?) = ?');
      expect(result.bindings).toEqual(['$.name', 'John']);
    });

    it('should handle empty OR group', () => {
      const result = buildFilterExpression(
        { or: [] },
        'e'
      );
      expect(result.sql).toBe('');
      expect(result.bindings).toEqual([]);
    });
  });

  describe('nested groups', () => {
    it('should handle OR inside AND', () => {
      // status = 'active' AND (role = 'admin' OR role = 'moderator')
      const result = buildFilterExpression(
        {
          and: [
            { path: 'status', operator: 'eq', value: 'active' },
            {
              or: [
                { path: 'role', operator: 'eq', value: 'admin' },
                { path: 'role', operator: 'eq', value: 'moderator' },
              ],
            },
          ],
        },
        'e'
      );
      expect(result.sql).toBe(
        '(json_extract(e.properties, ?) = ?) AND ((json_extract(e.properties, ?) = ?) OR (json_extract(e.properties, ?) = ?))'
      );
      expect(result.bindings).toEqual([
        '$.status',
        'active',
        '$.role',
        'admin',
        '$.role',
        'moderator',
      ]);
    });

    it('should handle AND inside OR', () => {
      // (status = 'active' AND age >= 18) OR (status = 'vip')
      const result = buildFilterExpression(
        {
          or: [
            {
              and: [
                { path: 'status', operator: 'eq', value: 'active' },
                { path: 'age', operator: 'gte', value: 18 },
              ],
            },
            { path: 'status', operator: 'eq', value: 'vip' },
          ],
        },
        'e'
      );
      expect(result.sql).toBe(
        '((json_extract(e.properties, ?) = ?) AND (CAST(json_extract(e.properties, ?) AS REAL) >= ?)) OR (json_extract(e.properties, ?) = ?)'
      );
      expect(result.bindings).toEqual([
        '$.status',
        'active',
        '$.age',
        18,
        '$.status',
        'vip',
      ]);
    });

    it('should handle deeply nested groups', () => {
      // (a = 1 AND (b = 2 OR (c = 3 AND d = 4)))
      const result = buildFilterExpression(
        {
          and: [
            { path: 'a', operator: 'eq', value: 1 },
            {
              or: [
                { path: 'b', operator: 'eq', value: 2 },
                {
                  and: [
                    { path: 'c', operator: 'eq', value: 3 },
                    { path: 'd', operator: 'eq', value: 4 },
                  ],
                },
              ],
            },
          ],
        },
        'e'
      );
      expect(result.sql).toContain(' AND ');
      expect(result.sql).toContain(' OR ');
      expect(result.bindings).toEqual([
        '$.a',
        1,
        '$.b',
        2,
        '$.c',
        3,
        '$.d',
        4,
      ]);
    });
  });

  describe('table alias', () => {
    it('should use custom table alias', () => {
      const result = buildFilterExpression(
        { path: 'name', operator: 'eq', value: 'John' },
        'l'
      );
      expect(result.sql).toBe('json_extract(l.properties, ?) = ?');
    });

    it('should use custom table alias in nested groups', () => {
      const result = buildFilterExpression(
        {
          or: [
            { path: 'a', operator: 'eq', value: 'x' },
            { path: 'b', operator: 'eq', value: 'y' },
          ],
        },
        'links'
      );
      expect(result.sql).toContain('json_extract(links.properties, ?)');
    });
  });

  describe('error handling', () => {
    it('should throw for invalid path in nested expression', () => {
      expect(() =>
        buildFilterExpression(
          {
            and: [
              { path: 'name', operator: 'eq', value: 'John' },
              { path: 'data[[0]]', operator: 'eq', value: 'test' },
            ],
          },
          'e'
        )
      ).toThrow('nested brackets');
    });

    it('should throw for exceeding maximum depth', () => {
      // Create a deeply nested structure (6 levels)
      const deeplyNested: { and?: unknown[]; or?: unknown[] } = {
        and: [
          {
            or: [
              {
                and: [
                  {
                    or: [
                      {
                        and: [
                          {
                            or: [{ path: 'a', operator: 'eq', value: 1 }],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };

      expect(() => buildFilterExpression(deeplyNested, 'e')).toThrow(
        'maximum nesting depth'
      );
    });
  });

  describe('complex real-world examples', () => {
    it('should handle user search with role and status filters', () => {
      // Find active users who are either admins or have premium subscription
      const result = buildFilterExpression(
        {
          and: [
            { path: 'status', operator: 'eq', value: 'active' },
            { path: 'email_verified', operator: 'eq', value: true },
            {
              or: [
                { path: 'role', operator: 'eq', value: 'admin' },
                { path: 'subscription.type', operator: 'eq', value: 'premium' },
              ],
            },
          ],
        },
        'e'
      );
      expect(result.sql).toContain(' AND ');
      expect(result.sql).toContain(' OR ');
      expect(result.bindings).toHaveLength(6);
    });

    it('should handle product search with multiple criteria', () => {
      // Find products: (in_stock AND price < 100) OR (featured)
      const result = buildFilterExpression(
        {
          or: [
            {
              and: [
                { path: 'inventory.in_stock', operator: 'eq', value: true },
                { path: 'price', operator: 'lt', value: 100 },
              ],
            },
            { path: 'featured', operator: 'eq', value: true },
          ],
        },
        'e'
      );
      expect(result.sql).toContain(' AND ');
      expect(result.sql).toContain(' OR ');
    });

    it('should handle search with existence checks', () => {
      // Find entities that have a profile AND (name exists OR nickname exists)
      const result = buildFilterExpression(
        {
          and: [
            { path: 'profile', operator: 'exists' },
            {
              or: [
                { path: 'name', operator: 'exists' },
                { path: 'nickname', operator: 'exists' },
              ],
            },
          ],
        },
        'e'
      );
      expect(result.sql).toContain('IS NOT NULL');
      expect(result.sql).toContain(' AND ');
      expect(result.sql).toContain(' OR ');
    });
  });
});
