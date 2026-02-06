import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import {
  analyzeQueryPlanBodySchema,
  queryTemplateSchema,
  queryPlanResponseSchema,
  type QueryTemplate,
} from '../schemas/generated-columns.js';
import { ErrorResponseSchema } from '../schemas/openapi-common.js';
import { getLogger } from '../middleware/request-context.js';
import {
  isValidAnalysisQuery,
  generateTemplateSQL,
  executeQueryPlan,
  analyzeQueryPlanSteps,
  generateRecommendations,
  listTemplates,
  getTemplateInfo,
} from '../utils/query-plan.js';

type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  JWT_SECRET: string;
  ENVIRONMENT: string;
};

const queryPlanRouter = new OpenAPIHono<{ Bindings: Bindings }>();

// ============================================================================
// Response schemas
// ============================================================================

const QueryTemplateItemSchema = z.object({
  name: queryTemplateSchema.openapi({ example: 'entity_by_type' }),
  description: z.string().openapi({ example: 'List entities of a specific type' }),
  parameters: z.array(z.string()).openapi({ example: ['type_id'] }),
});

const ListTemplatesResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({
      templates: z.array(QueryTemplateItemSchema),
      usage: z.object({
        description: z.string().openapi({
          example:
            'Use these template names with POST /api/schema/query-plan to analyze query execution plans',
        }),
        example: z.object({
          template: z.string().openapi({ example: 'entity_by_type' }),
          parameters: z.record(z.string(), z.string()).openapi({
            example: { type_id: 'your-type-uuid' },
          }),
        }),
      }),
    }),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('ListQueryTemplatesResponse');

const TemplateDetailResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({
      name: queryTemplateSchema.openapi({ example: 'entity_by_type' }),
      sql: z.string().openapi({
        example:
          'SELECT e.*, t.name as type_name FROM entities e LEFT JOIN types t ON e.type_id = t.id WHERE e.type_id = ? AND e.is_latest = 1 AND e.is_deleted = 0 ORDER BY e.created_at DESC LIMIT 20',
      }),
      description: z.string().openapi({ example: 'List entities of a specific type' }),
      parameters: z.array(z.string()).openapi({ example: ['type_id'] }),
    }),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('QueryTemplateDetailResponse');

const AnalyzeQueryPlanResponseSchema = z
  .object({
    success: z.literal(true),
    data: queryPlanResponseSchema,
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('AnalyzeQueryPlanResponse');

// ============================================================================
// Path parameter schemas
// ============================================================================

const TemplateParamsSchema = z.object({
  template: z.string().openapi({
    param: { name: 'template', in: 'path' },
    example: 'entity_by_type',
    description: 'Name of the query template',
  }),
});

// ============================================================================
// Route definitions
// ============================================================================

/**
 * GET /api/schema/query-plan/templates
 */
const listTemplatesRoute = createRoute({
  method: 'get',
  path: '/templates',
  tags: ['Schema'],
  summary: 'List query templates',
  description:
    'List all available predefined query templates that can be used for query plan analysis. Requires admin role.',
  operationId: 'listQueryTemplates',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth(), requireAdmin()] as const,
  responses: {
    200: {
      description: 'List of available query templates',
      content: {
        'application/json': {
          schema: ListTemplatesResponseSchema,
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
 * GET /api/schema/query-plan/templates/:template
 */
const getTemplateRoute = createRoute({
  method: 'get',
  path: '/templates/{template}',
  tags: ['Schema'],
  summary: 'Get query template details',
  description:
    'Get details about a specific query template including its SQL and parameters. Requires admin role.',
  operationId: 'getQueryTemplate',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth(), requireAdmin()] as const,
  request: {
    params: TemplateParamsSchema,
  },
  responses: {
    200: {
      description: 'Query template details',
      content: {
        'application/json': {
          schema: TemplateDetailResponseSchema,
        },
      },
    },
    400: {
      description: 'Unknown template name',
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
 * POST /api/schema/query-plan
 */
const analyzeQueryPlanRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Schema'],
  summary: 'Analyze query execution plan',
  description:
    'Analyze a query execution plan using a predefined template or custom SQL. Returns the execution plan with analysis and optimization recommendations. Requires admin role.',
  operationId: 'analyzeQueryPlan',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth(), requireAdmin()] as const,
  request: {
    body: {
      content: {
        'application/json': {
          schema: analyzeQueryPlanBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Query plan analysis results',
      content: {
        'application/json': {
          schema: AnalyzeQueryPlanResponseSchema,
        },
      },
    },
    400: {
      description: 'Invalid request (missing query, invalid SQL, or SQL error)',
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
    500: {
      description: 'Database error during query plan analysis',
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
 * GET /api/schema/query-plan/templates
 * List all available query templates (admin only)
 */
queryPlanRouter.openapi(listTemplatesRoute, c => {
  const logger = getLogger(c);

  logger.info('Listing query templates');

  const templates = listTemplates();

  return c.json(
    {
      success: true as const,
      data: {
        templates,
        usage: {
          description:
            'Use these template names with POST /api/schema/query-plan to analyze query execution plans',
          example: {
            template: 'entity_by_type',
            parameters: { type_id: 'your-type-uuid' },
          },
        },
      },
      timestamp: new Date().toISOString(),
    },
    200
  );
});

/**
 * GET /api/schema/query-plan/templates/:template
 * Get details about a specific query template (admin only)
 */
queryPlanRouter.openapi(getTemplateRoute, c => {
  const { template } = c.req.valid('param');
  const templateName = template as QueryTemplate;
  const logger = getLogger(c);

  logger.info('Getting template details', { template: templateName });

  const info = getTemplateInfo(templateName);

  if (!info) {
    return c.json(
      {
        success: false as const,
        error: `Unknown template: ${templateName}`,
        code: 'INVALID_TEMPLATE',
        timestamp: new Date().toISOString(),
      },
      400
    );
  }

  return c.json(
    {
      success: true as const,
      data: {
        name: templateName,
        ...info,
      },
      timestamp: new Date().toISOString(),
    },
    200
  );
});

/**
 * POST /api/schema/query-plan
 * Analyze a query execution plan (admin only)
 */
queryPlanRouter.openapi(analyzeQueryPlanRoute, async c => {
  const body = c.req.valid('json');
  const db = c.env.DB;
  const logger = getLogger(c);

  logger.info('Analyzing query plan', {
    template: body.template,
    hasCustomSQL: !!body.sql,
  });

  // Validate: either template or sql must be provided (but not both)
  if (!body.template && !body.sql) {
    return c.json(
      {
        success: false as const,
        error: 'Either template or sql must be provided',
        code: 'MISSING_QUERY',
        timestamp: new Date().toISOString(),
      },
      400
    );
  }

  if (body.template && body.sql) {
    return c.json(
      {
        success: false as const,
        error: 'Cannot provide both template and sql',
        code: 'INVALID_REQUEST',
        timestamp: new Date().toISOString(),
      },
      400
    );
  }

  try {
    let sql: string;

    // Generate SQL from template or use custom SQL
    if (body.template) {
      sql = generateTemplateSQL(body.template, body.parameters);
    } else if (body.sql) {
      // Validate custom SQL is safe
      if (!isValidAnalysisQuery(body.sql)) {
        return c.json(
          {
            success: false as const,
            error: 'Invalid SQL query. Only SELECT statements are allowed for analysis.',
            code: 'INVALID_SQL',
            timestamp: new Date().toISOString(),
          },
          400
        );
      }
      sql = body.sql;
    } else {
      return c.json(
        {
          success: false as const,
          error: 'Either template or sql must be provided',
          code: 'MISSING_QUERY',
          timestamp: new Date().toISOString(),
        },
        400
      );
    }

    // Execute EXPLAIN QUERY PLAN
    const planSteps = await executeQueryPlan(db, sql);

    // Analyze the query plan
    const analysis = analyzeQueryPlanSteps(planSteps);

    // Generate recommendations
    const recommendations = generateRecommendations(analysis, sql);

    logger.info('Query plan analyzed', {
      template: body.template,
      uses_index: analysis.uses_index,
      has_table_scan: analysis.has_table_scan,
      indexes_used: analysis.indexes_used.length,
    });

    return c.json(
      {
        success: true as const,
        data: {
          sql: sql.trim().replace(/\s+/g, ' '), // Normalize whitespace
          template: body.template,
          plan: planSteps,
          analysis,
          recommendations,
        },
        timestamp: new Date().toISOString(),
      },
      200
    );
  } catch (error) {
    logger.error('Failed to analyze query plan', error as Error);

    // Check for SQL syntax errors
    if (error instanceof Error && error.message.includes('SQLITE_ERROR')) {
      return c.json(
        {
          success: false as const,
          error: `SQL error: ${error.message}`,
          code: 'SQL_ERROR',
          timestamp: new Date().toISOString(),
        },
        400
      );
    }

    return c.json(
      {
        success: false as const,
        error: 'Failed to analyze query plan',
        code: 'DATABASE_ERROR',
        timestamp: new Date().toISOString(),
      },
      500
    );
  }
});

export default queryPlanRouter;
