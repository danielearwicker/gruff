import { Hono } from 'hono';
import { validateQuery } from '../middleware/validation.js';
import { listGeneratedColumnsQuerySchema } from '../schemas/generated-columns.js';
import * as response from '../utils/response.js';
import { getLogger } from '../middleware/request-context.js';
import {
  getGeneratedColumns,
  getGeneratedColumnsForTable,
  getQueryOptimizationInfo,
  analyzeQueryPath,
  GENERATED_COLUMNS,
} from '../utils/generated-columns.js';

type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  ENVIRONMENT: string;
};

const generatedColumnsRouter = new Hono<{ Bindings: Bindings }>();

/**
 * GET /api/schema/generated-columns
 * List all generated columns with optional filters
 *
 * Query parameters:
 * - table_name: Filter by table ('entities' or 'links')
 * - is_indexed: Filter by indexed status ('true' or 'false')
 */
generatedColumnsRouter.get('/', validateQuery(listGeneratedColumnsQuerySchema), async (c) => {
  const query = c.get('validated_query') as { table_name?: string; is_indexed?: number };
  const db = c.env.DB;
  const logger = getLogger(c);

  logger.info('Listing generated columns', { query });

  try {
    let columns;
    if (query.table_name) {
      columns = await getGeneratedColumnsForTable(db, query.table_name as 'entities' | 'links');
    } else {
      columns = await getGeneratedColumns(db);
    }

    // Apply is_indexed filter if specified
    if (query.is_indexed !== undefined) {
      columns = columns.filter((c) => c.is_indexed === query.is_indexed);
    }

    // Convert is_indexed to boolean for response
    const formattedColumns = columns.map((c) => ({
      ...c,
      is_indexed: c.is_indexed === 1,
    }));

    logger.info('Generated columns retrieved', { count: formattedColumns.length });

    return c.json(response.success(formattedColumns));
  } catch (error) {
    logger.error('Failed to retrieve generated columns', error as Error);
    return c.json(response.error('Failed to retrieve generated columns', 'DATABASE_ERROR'), 500);
  }
});

/**
 * GET /api/schema/generated-columns/optimization
 * Get query optimization information
 *
 * Returns information about which JSON paths have optimized generated columns
 * that can be used for efficient querying.
 */
generatedColumnsRouter.get('/optimization', async (c) => {
  const db = c.env.DB;
  const logger = getLogger(c);

  logger.info('Getting query optimization info');

  try {
    const info = await getQueryOptimizationInfo(db);

    logger.info('Query optimization info retrieved', {
      entityColumns: info.entities.length,
      linkColumns: info.links.length,
    });

    return c.json(response.success({
      ...info,
      usage: {
        description: 'These JSON properties have indexed generated columns for optimized queries',
        example: {
          instead_of: "json_extract(properties, '$.name') = 'John'",
          use: "prop_name = 'John'",
          benefit: 'Uses B-tree index for O(log n) lookup instead of full table scan',
        },
      },
    }));
  } catch (error) {
    logger.error('Failed to get optimization info', error as Error);
    return c.json(response.error('Failed to get optimization info', 'DATABASE_ERROR'), 500);
  }
});

/**
 * GET /api/schema/generated-columns/analyze
 * Analyze a query path for optimization potential
 *
 * Query parameters:
 * - table: The table name ('entities' or 'links')
 * - path: The JSON property path to analyze
 */
generatedColumnsRouter.get('/analyze', async (c) => {
  const table = c.req.query('table');
  const path = c.req.query('path');
  const logger = getLogger(c);

  if (!table || !path) {
    return c.json(response.error('Missing required query parameters: table and path', 'MISSING_PARAMETERS'), 400);
  }

  if (table !== 'entities' && table !== 'links') {
    return c.json(response.error('Invalid table name. Must be "entities" or "links"', 'INVALID_TABLE'), 400);
  }

  logger.info('Analyzing query path', { table, path });

  const analysis = analyzeQueryPath(table, path);

  return c.json(response.success({
    table,
    json_path: path,
    ...analysis,
  }));
});

/**
 * GET /api/schema/generated-columns/mappings
 * Get the static mapping of JSON paths to generated columns
 *
 * This returns the compile-time constant mappings without
 * querying the database.
 */
generatedColumnsRouter.get('/mappings', (c) => {
  const logger = getLogger(c);

  logger.info('Getting generated column mappings');

  return c.json(response.success({
    entities: Object.entries(GENERATED_COLUMNS.entities).map(([path, info]) => ({
      json_path: `$.${path}`,
      column_name: info.columnName,
      data_type: info.dataType,
    })),
    links: Object.entries(GENERATED_COLUMNS.links).map(([path, info]) => ({
      json_path: `$.${path}`,
      column_name: info.columnName,
      data_type: info.dataType,
    })),
  }));
});

export default generatedColumnsRouter;
