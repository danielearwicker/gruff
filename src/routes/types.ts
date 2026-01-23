import { Hono } from 'hono';
import { validateJson, validateQuery } from '../middleware/validation.js';
import { createTypeSchema, updateTypeSchema, typeQuerySchema } from '../schemas/index.js';
import * as response from '../utils/response.js';

type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  ENVIRONMENT: string;
};

const types = new Hono<{ Bindings: Bindings }>();

// Helper function to generate UUID
function generateUUID(): string {
  return crypto.randomUUID();
}

// Helper function to get current timestamp
function getCurrentTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * POST /api/types
 * Create a new type
 */
types.post('/', validateJson(createTypeSchema), async (c) => {
  const data = c.get('validated_json') as any;
  const db = c.env.DB;

  const id = generateUUID();
  const now = getCurrentTimestamp();

  // For now, we'll use the test user ID from seed data. In the future, this will come from auth middleware
  const systemUserId = 'test-user-001';

  try {
    // Check if type name already exists
    const existing = await db.prepare('SELECT id FROM types WHERE name = ?')
      .bind(data.name)
      .first();

    if (existing) {
      return c.json(response.error('Type name already exists', 'DUPLICATE_NAME'), 409);
    }

    // Convert json_schema to string if provided
    const jsonSchemaString = data.json_schema ? JSON.stringify(data.json_schema) : null;

    // Insert the new type
    await db.prepare(`
      INSERT INTO types (id, name, category, description, json_schema, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      data.name,
      data.category,
      data.description || null,
      jsonSchemaString,
      now,
      systemUserId
    ).run();

    // Fetch the created type
    const created = await db.prepare('SELECT * FROM types WHERE id = ?')
      .bind(id)
      .first();

    // Parse json_schema back to object if it exists
    const result = {
      ...created,
      json_schema: created?.json_schema ? JSON.parse(created.json_schema as string) : null,
    };

    return c.json(response.created(result), 201);
  } catch (error) {
    console.error('[Types] Error creating type:', error);
    throw error;
  }
});

/**
 * GET /api/types
 * List all types with optional filtering
 */
types.get('/', validateQuery(typeQuerySchema), async (c) => {
  const query = c.get('validated_query') as any;
  const db = c.env.DB;

  try {
    let sql = 'SELECT * FROM types WHERE 1=1';
    const bindings: any[] = [];

    // Apply filters
    if (query.category) {
      sql += ' AND category = ?';
      bindings.push(query.category);
    }

    if (query.name) {
      sql += ' AND name LIKE ?';
      bindings.push(`%${query.name}%`);
    }

    sql += ' ORDER BY created_at DESC';

    const { results } = await db.prepare(sql).bind(...bindings).all();

    // Parse json_schema for each type
    const types = results.map(type => ({
      ...type,
      json_schema: type.json_schema ? JSON.parse(type.json_schema as string) : null,
    }));

    return c.json(response.success(types));
  } catch (error) {
    console.error('[Types] Error listing types:', error);
    throw error;
  }
});

/**
 * GET /api/types/:id
 * Get a specific type by ID
 */
types.get('/:id', async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;

  try {
    const type = await db.prepare('SELECT * FROM types WHERE id = ?')
      .bind(id)
      .first();

    if (!type) {
      return c.json(response.notFound('Type'), 404);
    }

    // Parse json_schema back to object if it exists
    const result = {
      ...type,
      json_schema: type.json_schema ? JSON.parse(type.json_schema as string) : null,
    };

    return c.json(response.success(result));
  } catch (error) {
    console.error('[Types] Error fetching type:', error);
    throw error;
  }
});

/**
 * PUT /api/types/:id
 * Update a type's metadata
 */
types.put('/:id', validateJson(updateTypeSchema), async (c) => {
  const id = c.req.param('id');
  const data = c.get('validated_json') as any;
  const db = c.env.DB;

  try {
    // Check if type exists
    const existing = await db.prepare('SELECT * FROM types WHERE id = ?')
      .bind(id)
      .first();

    if (!existing) {
      return c.json(response.notFound('Type'), 404);
    }

    // Build update query dynamically based on provided fields
    const updates: string[] = [];
    const bindings: any[] = [];

    if (data.name !== undefined) {
      // Check if new name already exists (for different type)
      const nameCheck = await db.prepare('SELECT id FROM types WHERE name = ? AND id != ?')
        .bind(data.name, id)
        .first();

      if (nameCheck) {
        return c.json(response.error('Type name already exists', 'DUPLICATE_NAME'), 409);
      }

      updates.push('name = ?');
      bindings.push(data.name);
    }

    if (data.description !== undefined) {
      updates.push('description = ?');
      bindings.push(data.description);
    }

    if (data.json_schema !== undefined) {
      const jsonSchemaString = data.json_schema ? JSON.stringify(data.json_schema) : null;
      updates.push('json_schema = ?');
      bindings.push(jsonSchemaString);
    }

    if (updates.length === 0) {
      // No updates provided, return current state
      const result = {
        ...existing,
        json_schema: existing.json_schema ? JSON.parse(existing.json_schema as string) : null,
      };
      return c.json(response.success(result));
    }

    // Execute update
    bindings.push(id);
    await db.prepare(`UPDATE types SET ${updates.join(', ')} WHERE id = ?`)
      .bind(...bindings)
      .run();

    // Fetch updated type
    const updated = await db.prepare('SELECT * FROM types WHERE id = ?')
      .bind(id)
      .first();

    const result = {
      ...updated,
      json_schema: updated?.json_schema ? JSON.parse(updated.json_schema as string) : null,
    };

    return c.json(response.updated(result));
  } catch (error) {
    console.error('[Types] Error updating type:', error);
    throw error;
  }
});

/**
 * DELETE /api/types/:id
 * Delete a type (only if not in use)
 */
types.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;

  try {
    // Check if type exists
    const existing = await db.prepare('SELECT * FROM types WHERE id = ?')
      .bind(id)
      .first();

    if (!existing) {
      return c.json(response.notFound('Type'), 404);
    }

    // Check if type is in use by entities
    const entityCount = await db.prepare('SELECT COUNT(*) as count FROM entities WHERE type_id = ?')
      .bind(id)
      .first();

    if (entityCount && (entityCount.count as number) > 0) {
      return c.json(
        response.error('Cannot delete type that is in use by entities', 'TYPE_IN_USE'),
        409
      );
    }

    // Check if type is in use by links
    const linkCount = await db.prepare('SELECT COUNT(*) as count FROM links WHERE type_id = ?')
      .bind(id)
      .first();

    if (linkCount && (linkCount.count as number) > 0) {
      return c.json(
        response.error('Cannot delete type that is in use by links', 'TYPE_IN_USE'),
        409
      );
    }

    // Delete the type
    await db.prepare('DELETE FROM types WHERE id = ?')
      .bind(id)
      .run();

    return c.json(response.deleted());
  } catch (error) {
    console.error('[Types] Error deleting type:', error);
    throw error;
  }
});

export default types;
