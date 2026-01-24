import { describe, it, expect } from 'vitest';
import {
  parseJsonPath,
  buildPropertyFilter,
  buildPropertyFilters,
  type ParsedJsonPath,
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
