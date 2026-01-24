import { Hono } from 'hono';
import { validateJson } from '../middleware/validation.js';
import { analyzeQueryPlanSchema, type QueryTemplate } from '../schemas/generated-columns.js';
import * as response from '../utils/response.js';
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
  ENVIRONMENT: string;
};

const queryPlanRouter = new Hono<{ Bindings: Bindings }>();

/**
 * GET /api/schema/query-plan/templates
 * List all available query templates
 *
 * Returns the predefined query templates that can be used for analysis.
 */
queryPlanRouter.get('/templates', (c) => {
  const logger = getLogger(c);

  logger.info('Listing query templates');

  const templates = listTemplates();

  return c.json(
    response.success({
      templates,
      usage: {
        description: 'Use these template names with POST /api/schema/query-plan to analyze query execution plans',
        example: {
          template: 'entity_by_type',
          parameters: { type_id: 'your-type-uuid' },
        },
      },
    })
  );
});

/**
 * GET /api/schema/query-plan/templates/:template
 * Get details about a specific query template
 */
queryPlanRouter.get('/templates/:template', (c) => {
  const templateName = c.req.param('template') as QueryTemplate;
  const logger = getLogger(c);

  logger.info('Getting template details', { template: templateName });

  const info = getTemplateInfo(templateName);

  if (!info) {
    return c.json(
      response.error(`Unknown template: ${templateName}`, 'INVALID_TEMPLATE'),
      400
    );
  }

  return c.json(
    response.success({
      name: templateName,
      ...info,
    })
  );
});

/**
 * POST /api/schema/query-plan
 * Analyze a query execution plan
 *
 * Request body:
 * - template: Name of a predefined query template (e.g., 'entity_by_type')
 * - parameters: Parameters for the template (optional)
 * OR
 * - sql: Custom SQL query to analyze (SELECT statements only)
 *
 * Returns the query execution plan with analysis and recommendations.
 */
queryPlanRouter.post('/', validateJson(analyzeQueryPlanSchema), async (c) => {
  const body = c.get('validated_json') as {
    template?: QueryTemplate;
    parameters?: Record<string, string | number | boolean>;
    sql?: string;
  };
  const db = c.env.DB;
  const logger = getLogger(c);

  logger.info('Analyzing query plan', {
    template: body.template,
    hasCustomSQL: !!body.sql,
  });

  try {
    let sql: string;

    // Generate SQL from template or use custom SQL
    if (body.template) {
      sql = generateTemplateSQL(body.template, body.parameters);
    } else if (body.sql) {
      // Validate custom SQL is safe
      if (!isValidAnalysisQuery(body.sql)) {
        return c.json(
          response.error(
            'Invalid SQL query. Only SELECT statements are allowed for analysis.',
            'INVALID_SQL'
          ),
          400
        );
      }
      sql = body.sql;
    } else {
      // This shouldn't happen due to schema validation, but handle it anyway
      return c.json(
        response.error('Either template or sql must be provided', 'MISSING_QUERY'),
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
      response.success({
        sql: sql.trim().replace(/\s+/g, ' '), // Normalize whitespace
        template: body.template,
        plan: planSteps,
        analysis,
        recommendations,
      })
    );
  } catch (error) {
    logger.error('Failed to analyze query plan', error as Error);

    // Check for SQL syntax errors
    if (error instanceof Error && error.message.includes('SQLITE_ERROR')) {
      return c.json(
        response.error(`SQL error: ${error.message}`, 'SQL_ERROR'),
        400
      );
    }

    return c.json(
      response.error('Failed to analyze query plan', 'DATABASE_ERROR'),
      500
    );
  }
});

export default queryPlanRouter;
