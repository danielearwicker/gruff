import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import {
  listGeneratedColumnsQuerySchema,
  queryOptimizationInfoSchema,
  dataTypeSchema,
  tableNameSchema,
} from '../schemas/generated-columns.js';
import { ErrorResponseSchema } from '../schemas/openapi-common.js';
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
  JWT_SECRET: string;
  ENVIRONMENT: string;
};

const generatedColumnsRouter = new OpenAPIHono<{ Bindings: Bindings }>();

// ============================================================================
// Response schemas
// ============================================================================

const GeneratedColumnResponseItemSchema = z.object({
  id: z.string().openapi({ example: 'gc_001' }),
  table_name: tableNameSchema.openapi({ example: 'entities' }),
  column_name: z.string().openapi({ example: 'prop_name' }),
  json_path: z.string().openapi({ example: '$.name' }),
  data_type: dataTypeSchema.openapi({ example: 'TEXT' }),
  is_indexed: z.boolean().openapi({ example: true }),
  created_at: z.number().int().openapi({ example: 1704067200 }),
  created_by: z.string().nullable().openapi({ example: null }),
  description: z.string().nullable().openapi({ example: 'Name property column' }),
});

const GeneratedColumnsListResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.array(GeneratedColumnResponseItemSchema).openapi({
      description: 'Array of generated column records',
    }),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('GeneratedColumnsListResponse');

const OptimizationUsageSchema = z.object({
  description: z.string().openapi({
    example: 'These JSON properties have indexed generated columns for optimized queries',
  }),
  example: z.object({
    instead_of: z.string().openapi({ example: "json_extract(properties, '$.name') = 'John'" }),
    use: z.string().openapi({ example: "prop_name = 'John'" }),
    benefit: z
      .string()
      .openapi({ example: 'Uses B-tree index for O(log n) lookup instead of full table scan' }),
  }),
});

const OptimizationInfoResponseSchema = z
  .object({
    success: z.literal(true),
    data: queryOptimizationInfoSchema.extend({
      usage: OptimizationUsageSchema,
    }),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('OptimizationInfoResponse');

const AnalyzeResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({
      table: tableNameSchema.openapi({ example: 'entities' }),
      json_path: z.string().openapi({ example: 'name' }),
      hasGeneratedColumn: z.boolean().openapi({ example: true }),
      hasIndex: z.boolean().openapi({ example: true }),
      columnName: z.string().nullable().openapi({ example: 'prop_name' }),
      dataType: z.string().nullable().openapi({ example: 'TEXT' }),
      recommendation: z.string().openapi({
        example: 'Query will use indexed column prop_name for efficient lookup',
      }),
    }),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('AnalyzeQueryPathResponse');

const MappingItemSchema = z.object({
  json_path: z.string().openapi({ example: '$.name' }),
  column_name: z.string().openapi({ example: 'prop_name' }),
  data_type: z.string().openapi({ example: 'TEXT' }),
});

const MappingsResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({
      entities: z.array(MappingItemSchema).openapi({
        description: 'Entity table column mappings',
      }),
      links: z.array(MappingItemSchema).openapi({
        description: 'Link table column mappings',
      }),
    }),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('GeneratedColumnMappingsResponse');

// ============================================================================
// Query schemas for analyze endpoint
// ============================================================================

const AnalyzeQuerySchema = z.object({
  table: z.string().openapi({
    param: { name: 'table', in: 'query' },
    example: 'entities',
    description: "Table name ('entities' or 'links')",
  }),
  path: z.string().openapi({
    param: { name: 'path', in: 'query' },
    example: 'name',
    description: 'JSON property path to analyze',
  }),
});

// ============================================================================
// Route definitions
// ============================================================================

/**
 * GET /api/schema/generated-columns route definition
 */
const listGeneratedColumnsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Schema'],
  summary: 'List generated columns',
  description: 'List all generated columns with optional filters. Requires admin role.',
  operationId: 'listGeneratedColumns',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth(), requireAdmin()] as const,
  request: {
    query: listGeneratedColumnsQuerySchema,
  },
  responses: {
    200: {
      description: 'List of generated columns',
      content: {
        'application/json': {
          schema: GeneratedColumnsListResponseSchema,
        },
      },
    },
    401: {
      description: 'Authentication required',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    403: {
      description: 'Admin access required',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    500: {
      description: 'Failed to retrieve generated columns',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

/**
 * GET /api/schema/generated-columns/optimization route definition
 */
const getOptimizationInfoRoute = createRoute({
  method: 'get',
  path: '/optimization',
  tags: ['Schema'],
  summary: 'Get query optimization info',
  description:
    'Returns information about which JSON paths have optimized generated columns that can be used for efficient querying. Requires admin role.',
  operationId: 'getQueryOptimizationInfo',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth(), requireAdmin()] as const,
  responses: {
    200: {
      description: 'Query optimization information',
      content: {
        'application/json': {
          schema: OptimizationInfoResponseSchema,
        },
      },
    },
    401: {
      description: 'Authentication required',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    403: {
      description: 'Admin access required',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    500: {
      description: 'Failed to get optimization info',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

/**
 * GET /api/schema/generated-columns/analyze route definition
 */
const analyzeQueryPathRoute = createRoute({
  method: 'get',
  path: '/analyze',
  tags: ['Schema'],
  summary: 'Analyze query path optimization',
  description:
    'Analyze a query path for optimization potential. Returns whether a generated column exists for the given JSON path. Requires admin role.',
  operationId: 'analyzeQueryPath',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth(), requireAdmin()] as const,
  request: {
    query: AnalyzeQuerySchema,
  },
  responses: {
    200: {
      description: 'Query path analysis',
      content: {
        'application/json': {
          schema: AnalyzeResponseSchema,
        },
      },
    },
    400: {
      description: 'Missing or invalid parameters',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    401: {
      description: 'Authentication required',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    403: {
      description: 'Admin access required',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

/**
 * GET /api/schema/generated-columns/mappings route definition
 */
const getMappingsRoute = createRoute({
  method: 'get',
  path: '/mappings',
  tags: ['Schema'],
  summary: 'Get generated column mappings',
  description:
    'Returns the static mapping of JSON paths to generated columns without querying the database. Requires admin role.',
  operationId: 'getGeneratedColumnMappings',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth(), requireAdmin()] as const,
  responses: {
    200: {
      description: 'Generated column mappings',
      content: {
        'application/json': {
          schema: MappingsResponseSchema,
        },
      },
    },
    401: {
      description: 'Authentication required',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    403: {
      description: 'Admin access required',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

// ============================================================================
// Route handlers
// ============================================================================

/**
 * GET /api/schema/generated-columns
 * List all generated columns with optional filters (admin only)
 */
generatedColumnsRouter.openapi(listGeneratedColumnsRoute, async c => {
  const query = c.req.valid('query');
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
      columns = columns.filter(c => c.is_indexed === query.is_indexed);
    }

    // Convert is_indexed to boolean for response
    const formattedColumns = columns.map(c => ({
      ...c,
      is_indexed: c.is_indexed === 1,
    }));

    logger.info('Generated columns retrieved', { count: formattedColumns.length });

    return c.json(
      {
        success: true as const,
        data: formattedColumns,
        timestamp: new Date().toISOString(),
      },
      200
    );
  } catch (error) {
    logger.error('Failed to retrieve generated columns', error as Error);
    return c.json(
      {
        success: false as const,
        error: 'Failed to retrieve generated columns',
        code: 'DATABASE_ERROR',
        timestamp: new Date().toISOString(),
      },
      500
    );
  }
});

/**
 * GET /api/schema/generated-columns/optimization
 * Get query optimization information (admin only)
 */
generatedColumnsRouter.openapi(getOptimizationInfoRoute, async c => {
  const db = c.env.DB;
  const logger = getLogger(c);

  logger.info('Getting query optimization info');

  try {
    const info = await getQueryOptimizationInfo(db);

    logger.info('Query optimization info retrieved', {
      entityColumns: info.entities.length,
      linkColumns: info.links.length,
    });

    return c.json(
      {
        success: true as const,
        data: {
          ...info,
          usage: {
            description:
              'These JSON properties have indexed generated columns for optimized queries',
            example: {
              instead_of: "json_extract(properties, '$.name') = 'John'",
              use: "prop_name = 'John'",
              benefit: 'Uses B-tree index for O(log n) lookup instead of full table scan',
            },
          },
        },
        timestamp: new Date().toISOString(),
      },
      200
    );
  } catch (error) {
    logger.error('Failed to get optimization info', error as Error);
    return c.json(
      {
        success: false as const,
        error: 'Failed to get optimization info',
        code: 'DATABASE_ERROR',
        timestamp: new Date().toISOString(),
      },
      500
    );
  }
});

/**
 * GET /api/schema/generated-columns/analyze
 * Analyze a query path for optimization potential (admin only)
 */
generatedColumnsRouter.openapi(analyzeQueryPathRoute, async c => {
  const { table, path } = c.req.valid('query');
  const logger = getLogger(c);

  if (!table || !path) {
    return c.json(
      {
        success: false as const,
        error: 'Missing required query parameters: table and path',
        code: 'MISSING_PARAMETERS',
        timestamp: new Date().toISOString(),
      },
      400
    );
  }

  if (table !== 'entities' && table !== 'links') {
    return c.json(
      {
        success: false as const,
        error: 'Invalid table name. Must be "entities" or "links"',
        code: 'INVALID_TABLE',
        timestamp: new Date().toISOString(),
      },
      400
    );
  }

  const validTable = table as 'entities' | 'links';
  logger.info('Analyzing query path', { table: validTable, path });

  const analysis = analyzeQueryPath(validTable, path);

  return c.json(
    {
      success: true as const,
      data: {
        table: validTable,
        json_path: path,
        ...analysis,
      },
      timestamp: new Date().toISOString(),
    },
    200
  );
});

/**
 * GET /api/schema/generated-columns/mappings
 * Get the static mapping of JSON paths to generated columns (admin only)
 */
generatedColumnsRouter.openapi(getMappingsRoute, c => {
  const logger = getLogger(c);

  logger.info('Getting generated column mappings');

  return c.json(
    {
      success: true as const,
      data: {
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
      },
      timestamp: new Date().toISOString(),
    },
    200
  );
});

export default generatedColumnsRouter;
