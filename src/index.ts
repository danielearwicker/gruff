import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { validateJson, validateQuery } from './middleware/validation.js';
import { notFoundHandler } from './middleware/error-handler.js';
import { requestContextMiddleware, getLogger, getRequestId } from './middleware/request-context.js';
import { rateLimit } from './middleware/rate-limit.js';
import {
  createCorsMiddleware,
  createSecurityHeadersMiddleware,
  getDevelopmentSecurityConfig,
  getProductionSecurityConfig,
} from './middleware/security.js';
import { etag } from './middleware/etag.js';
import { responseTime } from './middleware/response-time.js';
import { queryTracking } from './middleware/query-tracking.js';
import { entityQuerySchema, CreateEntity, EntityQuery } from './schemas/index.js';
import * as response from './utils/response.js';
import { createLogger, LogLevel } from './utils/logger.js';
import { validateEnvironment, DEFAULT_ENV_VALIDATION } from './utils/sensitive-data.js';
import { createErrorTracker, AnalyticsEngineDataset } from './utils/error-tracking.js';
import { ZodError } from 'zod';
import typesRouter from './routes/types.js';
import entitiesRouter from './routes/entities.js';
import linksRouter from './routes/links.js';
import authRouter from './routes/auth.js';
import graphRouter from './routes/graph.js';
import searchRouter from './routes/search.js';
import usersRouter from './routes/users.js';
import bulkRouter from './routes/bulk.js';
import exportRouter from './routes/export.js';
import auditRouter from './routes/audit.js';
import docsRouter from './routes/docs.js';
import generatedColumnsRouter from './routes/generated-columns.js';
import queryPlanRouter from './routes/query-plan.js';
import uiRouter from './routes/ui.js';
import groupsRouter from './routes/groups.js';

// Define the environment bindings type
type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  JWT_SECRET: string;
  ENVIRONMENT: string;
  ALLOWED_ORIGINS?: string; // Comma-separated list of allowed origins for CORS (production)
  ANALYTICS?: AnalyticsEngineDataset; // Analytics Engine for error tracking
  // Google OAuth2 configuration
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
  // GitHub OAuth2 configuration
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_REDIRECT_URI?: string;
};

const app = new OpenAPIHono<{ Bindings: Bindings }>();

// Request context middleware - must be first to add requestId and logger to all requests
app.use('*', requestContextMiddleware);

// Environment validation middleware - validates required secrets on first request
// This ensures configuration errors are caught early
let envValidated = false;
app.use('*', async (c, next) => {
  if (!envValidated) {
    const validation = validateEnvironment(
      c.env as Record<string, unknown>,
      DEFAULT_ENV_VALIDATION
    );
    const startupLogger = createLogger({ component: 'startup' }, LogLevel.INFO);

    // Log warnings (non-fatal issues)
    for (const warning of validation.warnings) {
      startupLogger.warn(warning);
    }

    // In production, fail on validation errors
    // In development, log errors but continue
    if (!validation.valid) {
      const isDevelopment = c.env?.ENVIRONMENT === 'development' || !c.env?.ENVIRONMENT;
      if (!isDevelopment) {
        // Production: return error response
        startupLogger.error(
          'Environment validation failed',
          new Error(validation.errors.join('; '))
        );
        return c.json(
          {
            error: 'Server configuration error',
            code: 'CONFIGURATION_ERROR',
            message: 'Required environment variables are missing or invalid',
          },
          500
        );
      } else {
        // Development: log errors and continue
        for (const error of validation.errors) {
          startupLogger.warn(`[DEV MODE] ${error}`);
        }
      }
    }

    envValidated = true;
  }
  await next();
});

// CORS middleware - apply with environment-aware configuration
// This handles OPTIONS preflight requests automatically
app.use('*', async (c, next) => {
  const isDevelopment = c.env?.ENVIRONMENT === 'development' || !c.env?.ENVIRONMENT;
  const securityConfig = isDevelopment
    ? getDevelopmentSecurityConfig()
    : getProductionSecurityConfig(c.env?.ALLOWED_ORIGINS?.split(',') || ['*']);

  const corsMiddleware = createCorsMiddleware(securityConfig);
  return await corsMiddleware(c, next);
});

// Security headers middleware - apply after CORS
app.use('*', async (c, next) => {
  const isDevelopment = c.env?.ENVIRONMENT === 'development' || !c.env?.ENVIRONMENT;
  const securityConfig = isDevelopment
    ? getDevelopmentSecurityConfig()
    : getProductionSecurityConfig(c.env?.ALLOWED_ORIGINS?.split(',') || ['*']);

  const headersMiddleware = createSecurityHeadersMiddleware(securityConfig);
  return await headersMiddleware(c, next);
});

// Response time tracking middleware - tracks all requests for performance analysis
// Writes metrics to Analytics Engine for performance trend analysis
// Adds X-Response-Time header to all responses
app.use(
  '*',
  responseTime({
    headerName: 'X-Response-Time', // Add response time to response headers
    skipPaths: ['/docs'], // Skip documentation endpoints (static content)
  })
);

// Rate limiting middleware - applied to all /api/* routes
// Automatically categorizes requests based on path and method
// Skip health and version endpoints for operational monitoring
app.use(
  '/api/*',
  rateLimit({
    skip: c => {
      // Skip rate limiting for version endpoint (lightweight, informational)
      if (c.req.path === '/api/version') {
        return true;
      }
      return false;
    },
  })
);

// Query performance tracking middleware - tracks database query execution times
// Writes metrics to Analytics Engine for query performance trend analysis
// Tracks slow queries (configurable threshold, default >100ms)
app.use(
  '/api/*',
  queryTracking({
    slowQueryThreshold: 100, // Mark queries > 100ms as slow
    minDurationMs: 0, // Track all queries (set higher to filter out fast queries)
  })
);

// ETag middleware for conditional requests - applied to data retrieval endpoints
// Generates ETag headers and returns 304 Not Modified for unchanged resources
// Skip paths that don't benefit from caching (auth, bulk operations, exports)
app.use(
  '/api/*',
  etag({
    weak: true, // Use weak ETags for semantic equivalence (appropriate for JSON APIs)
    maxSize: 1048576, // Skip ETag generation for responses > 1MB
    skip: c => {
      const path = c.req.path;
      // Skip auth endpoints (security-sensitive, session-based)
      if (path.startsWith('/api/auth')) {
        return true;
      }
      // Skip bulk operations (typically POST/PUT, dynamic content)
      if (path.startsWith('/api/bulk')) {
        return true;
      }
      // Skip export operations (large payloads, dynamic content)
      if (path.startsWith('/api/export')) {
        return true;
      }
      // Skip audit endpoints (time-sensitive, always fresh)
      if (path.startsWith('/api/audit')) {
        return true;
      }
      // Skip search endpoints (query results should be fresh)
      if (path.startsWith('/api/search')) {
        return true;
      }
      return false;
    },
  })
);

// Register security schemes in OpenAPI registry
app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
  description: 'JWT access token obtained from /api/auth/login or /api/auth/register',
});

// Pre-register schemas so they appear in spec even before routes are converted
// These will be automatically used when routes reference them
import { entityResponseSchema, createEntitySchema } from './schemas/entity.js';
import { linkResponseSchema, createLinkSchema } from './schemas/link.js';
import { userResponseSchema, createUserSchema } from './schemas/user.js';
import { auditLogSchema, auditLogResponseSchema } from './schemas/audit.js';
import { ErrorResponseSchema, SuccessResponseSchema } from './schemas/openapi-common.js';
import { typeSchema, createTypeSchema } from './schemas/type.js';

// Register schemas by referencing them (forces inclusion in OpenAPI spec)
[
  entityResponseSchema,
  createEntitySchema,
  linkResponseSchema,
  createLinkSchema,
  userResponseSchema,
  createUserSchema,
  typeSchema,
  createTypeSchema,
  auditLogSchema,
  auditLogResponseSchema,
  ErrorResponseSchema,
  SuccessResponseSchema,
].forEach(schema => {
  // Schemas with .openapi() will be automatically registered
  void schema._def;
});

// OpenAPI spec generation endpoint
// TEMPORARILY COMMENTED OUT: Will be enabled once all routes are converted
// This conflicts with the existing manual OpenAPI spec in routes/docs.ts
// Once all routes use createRoute(), we'll remove routes/docs.ts and uncomment this
/*
app.doc('/docs/openapi.json', {
  openapi: '3.1.0',
  info: {
    title: 'Gruff API',
    version: '1.0.0',
    description: 'Entity-Relationship Graph Database with Versioning',
  },
  servers: [
    { url: 'http://localhost:8787', description: 'Local development server' },
  ],
  tags: [
    { name: 'Health', description: 'Health check and system status endpoints' },
    { name: 'Authentication', description: 'User registration, login, and token management' },
    { name: 'Types', description: 'Type registry for entities and links' },
    { name: 'Entities', description: 'Entity CRUD operations and versioning' },
    { name: 'Links', description: 'Link CRUD operations and versioning' },
    { name: 'Graph', description: 'Graph traversal and path finding operations' },
    { name: 'Search', description: 'Search and type-ahead suggestions' },
    { name: 'Users', description: 'User profile and management endpoints' },
    { name: 'Groups', description: 'Group management endpoints' },
  ],
});
*/

// Global error handler using Hono's onError
app.onError((err, c) => {
  // Get request ID and logger from context (set by request context middleware)
  // Fallback to generating new ones if not available (shouldn't happen in normal flow)
  const requestId = getRequestId(c) || crypto.randomUUID();
  const logger =
    getLogger(c) ||
    createLogger({
      requestId,
      path: c.req.path,
      method: c.req.method,
    });
  let statusCode = 500;
  let errorResponse: Record<string, unknown> = {
    error: 'Internal server error',
    code: 'INTERNAL_SERVER_ERROR',
    timestamp: new Date().toISOString(),
    path: c.req.path,
    requestId,
  };

  // Handle Zod validation errors
  if (err instanceof ZodError || (err as Error & { name?: string })?.name === 'ZodError') {
    const zodError = err as ZodError;
    statusCode = 400;
    errorResponse = {
      error: 'Validation failed',
      code: 'VALIDATION_ERROR',
      details: zodError.issues.map(issue => ({
        path: issue.path.join('.'),
        message: issue.message,
        code: issue.code,
      })),
      timestamp: new Date().toISOString(),
      path: c.req.path,
      requestId,
    };
  }
  // Handle JSON parse errors
  else if (err instanceof SyntaxError && err.message.includes('JSON')) {
    statusCode = 400;
    errorResponse = {
      error: 'Invalid JSON in request body',
      code: 'INVALID_JSON',
      details: err.message,
      timestamp: new Date().toISOString(),
      path: c.req.path,
      requestId,
    };
  }
  // Handle generic errors
  else if (err instanceof Error) {
    const isDevelopment = c.env?.ENVIRONMENT !== 'production';
    errorResponse = {
      error: isDevelopment ? err.message : 'Internal server error',
      code: 'INTERNAL_SERVER_ERROR',
      details: isDevelopment ? { stack: err.stack } : undefined,
      timestamp: new Date().toISOString(),
      path: c.req.path,
      requestId,
    };
  }

  // Log error details for monitoring
  logger.error('Request error', err instanceof Error ? err : new Error(String(err)), {
    statusCode,
    errorCode: errorResponse.code,
  });

  // Track error in Analytics Engine for monitoring and metrics
  const errorTracker = createErrorTracker(c.env?.ANALYTICS, {
    environment: c.env?.ENVIRONMENT || 'development',
  });
  errorTracker.track(
    err,
    {
      requestId,
      path: c.req.path,
      method: c.req.method,
      statusCode,
      userId: c.get('user')?.user_id,
      userAgent: c.req.header('user-agent'),
      ipAddress: c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for'),
    },
    statusCode
  );

  return c.json(errorResponse, statusCode as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

// Health check endpoint - converted to OpenAPIHono
const healthRoute = createRoute({
  method: 'get',
  path: '/health',
  tags: ['Health'],
  summary: 'Health check',
  description: 'Check the health status of the API, database, and KV store',
  responses: {
    200: {
      description: 'System is healthy',
      content: {
        'application/json': {
          schema: z.object({
            status: z.string().openapi({ example: 'healthy' }),
            environment: z.string().openapi({ example: 'development' }),
            database: z.string().openapi({ example: 'connected' }),
            kv: z.string().openapi({ example: 'connected' }),
            analytics: z.string().openapi({ example: 'available' }),
            runtime: z.object({
              platform: z.string().openapi({ example: 'cloudflare-workers' }),
              mode: z.string().openapi({ example: 'local' }),
              context: z.object({
                colo: z.string().openapi({ example: 'local' }),
                country: z.string().openapi({ example: 'unknown' }),
              }),
              capabilities: z.object({
                crypto: z.boolean(),
                cryptoSubtle: z.boolean(),
                fetch: z.boolean(),
                webSocket: z.boolean(),
              }),
              memory: z.object({
                limit: z.string().openapi({ example: '128MB' }),
                note: z.string(),
              }),
            }),
            timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
          }),
        },
      },
    },
    500: {
      description: 'System is unhealthy',
      content: {
        'application/json': {
          schema: z.object({
            status: z.literal('unhealthy'),
            error: z.string(),
          }),
        },
      },
    },
  },
});

app.openapi(healthRoute, async c => {
  try {
    // Test D1 connection
    const dbResult = await c.env.DB.prepare('SELECT 1 as test').first();

    // Test KV connection - handle gracefully in development if unavailable
    let kvStatus = 'disconnected';
    try {
      await c.env.KV.put('health-check', Date.now().toString(), { expirationTtl: 60 });
      const kvValue = await c.env.KV.get('health-check');
      kvStatus = kvValue ? 'connected' : 'disconnected';
    } catch (kvError) {
      // In development, KV might not be available immediately after server start
      if (c.env.ENVIRONMENT === 'development') {
        kvStatus = 'initializing';
      } else {
        throw kvError;
      }
    }

    // Gather Workers runtime status
    const runtimeStatus = {
      platform: 'cloudflare-workers',
      // Check if we're running in local dev mode (Miniflare/Wrangler)
      mode: c.env.ENVIRONMENT === 'development' ? 'local' : 'edge',
      // Request context information
      context: {
        // The colo (data center) where the request is being processed
        // This is available via cf object in production but not in local dev
        colo: (c.req.raw as Request & { cf?: { colo?: string } }).cf?.colo || 'local',
        // Country of request origin
        country: (c.req.raw as Request & { cf?: { country?: string } }).cf?.country || 'unknown',
      },
      // Runtime capabilities
      capabilities: {
        // Check if Web Crypto API is available
        crypto: typeof crypto !== 'undefined',
        // Check if crypto.subtle is available (for JWT operations, etc.)
        cryptoSubtle: typeof crypto?.subtle !== 'undefined',
        // Check if fetch API is available
        fetch: typeof fetch !== 'undefined',
        // Check if WebSocket API is available (for potential future use)
        webSocket: typeof WebSocket !== 'undefined',
      },
      // Memory usage information (not available in Workers but we can include the check)
      memory: {
        // Workers don't expose memory metrics but we indicate the limit
        limit: '128MB',
        note: 'Workers runtime enforces automatic memory management',
      },
    };

    // Check Analytics Engine availability
    const analyticsAvailable = !!c.env.ANALYTICS;

    return c.json(
      {
        status: 'healthy',
        environment: c.env.ENVIRONMENT,
        database: dbResult ? 'connected' : 'disconnected',
        kv: kvStatus,
        analytics: analyticsAvailable ? 'available' : 'not_configured',
        runtime: runtimeStatus,
        timestamp: new Date().toISOString(),
      },
      200
    );
  } catch (error) {
    return c.json(
      {
        status: 'unhealthy' as const,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      500
    );
  }
});

// Version information endpoint - converted to OpenAPIHono
const versionRoute = createRoute({
  method: 'get',
  path: '/api/version',
  tags: ['Health'],
  summary: 'API version information',
  description: 'Get version and runtime information about the API',
  responses: {
    200: {
      description: 'Version information',
      content: {
        'application/json': {
          schema: z.object({
            version: z.string().openapi({ example: '1.0.0' }),
            name: z.string().openapi({ example: 'gruff' }),
            description: z.string().openapi({
              example: 'Entity-Relationship Graph Database with Versioning',
            }),
            runtime: z.object({
              platform: z.string().openapi({ example: 'cloudflare-workers' }),
              database: z.string().openapi({ example: 'd1' }),
              environment: z.string().openapi({ example: 'development' }),
            }),
            api: z.object({
              version: z.string().openapi({ example: 'v1' }),
              documentation: z.string().openapi({ example: '/docs' }),
              openapi: z.string().openapi({ example: '/docs/openapi.json' }),
            }),
            dependencies: z.object({
              hono: z.string().openapi({ example: '^4.11.5' }),
              zod: z.string().openapi({ example: '^4.3.6' }),
            }),
            timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
          }),
        },
      },
    },
  },
});

app.openapi(versionRoute, c => {
  return c.json({
    version: '1.0.0',
    name: 'gruff',
    description: 'Entity-Relationship Graph Database with Versioning',
    runtime: {
      platform: 'cloudflare-workers',
      database: 'd1',
      environment: c.env.ENVIRONMENT || 'unknown',
    },
    api: {
      version: 'v1',
      documentation: '/docs',
      openapi: '/docs/openapi.json',
    },
    dependencies: {
      hono: '^4.11.5',
      zod: '^4.3.6',
    },
    timestamp: new Date().toISOString(),
  });
});

// Root endpoint
app.get('/', c => {
  return c.json({
    name: 'Gruff - Graph Database API',
    version: '1.0.0',
    endpoints: {
      health: '/health',
      api: '/api',
      version: '/api/version',
      documentation: '/docs',
      openapi: '/docs/openapi.json',
      ui: '/ui',
    },
  });
});

// API routes
app.get('/api', c => {
  return c.json({
    message: 'Gruff API - Entity-Relationship Database with Versioning',
  });
});

// Mount authentication routes
app.route('/api/auth', authRouter);

// Mount user management routes
app.route('/api/users', usersRouter);

// Mount group management routes
app.route('/api/groups', groupsRouter);

// Mount type management routes
app.route('/api/types', typesRouter);

// Mount entity management routes
app.route('/api/entities', entitiesRouter);

// Mount link management routes
app.route('/api/links', linksRouter);

// Mount graph operations routes
app.route('/api/graph', graphRouter);

// Mount search routes
app.route('/api/search', searchRouter);

// Mount bulk operations routes
app.route('/api/bulk', bulkRouter);

// Mount export/import routes
app.route('/api/export', exportRouter);

// Mount audit log routes
app.route('/api/audit', auditRouter);

// Mount schema information routes (generated columns, optimization info, query plan analysis)
app.route('/api/schema/generated-columns', generatedColumnsRouter);
app.route('/api/schema/query-plan', queryPlanRouter);

// Mount API documentation routes (OpenAPI spec and Scalar UI)
app.route('/docs', docsRouter);

// Mount UI routes (server-side rendered web interface)
app.route('/ui', uiRouter);

// Validation demo endpoint - validates JSON body
app.post('/api/validate/entity', validateJson(createEntitySchema), c => {
  const validated = c.get('validated_json') as CreateEntity;
  return c.json({
    success: true,
    message: 'Entity schema validation passed',
    received: validated,
  });
});

// Validation demo endpoint - validates query parameters
app.get('/api/validate/query', validateQuery(entityQuerySchema), c => {
  const validated = c.get('validated_query') as EntityQuery;
  return c.json({
    success: true,
    message: 'Query parameters validation passed',
    received: validated,
  });
});

// Validation demo endpoint - validates with custom schema
const testSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  age: z.number().int().min(0).max(150),
  email: z.string().email(),
});

app.post('/api/validate/test', validateJson(testSchema), c => {
  const validated = c.get('validated_json') as z.infer<typeof testSchema>;
  return c.json({
    success: true,
    message: 'Custom validation passed',
    data: validated,
  });
});

// Response formatting demo endpoints
app.get('/api/demo/response/success', c => {
  return c.json(response.success({ id: '123', name: 'Example' }, 'Operation successful'));
});

app.get('/api/demo/response/created', c => {
  return c.json(response.created({ id: '456', name: 'New Resource' }), 201);
});

app.get('/api/demo/response/updated', c => {
  return c.json(response.updated({ id: '789', name: 'Updated Resource' }));
});

app.get('/api/demo/response/deleted', c => {
  return c.json(response.deleted());
});

app.get('/api/demo/response/paginated', c => {
  const items = [
    { id: '1', name: 'Item 1' },
    { id: '2', name: 'Item 2' },
    { id: '3', name: 'Item 3' },
  ];
  return c.json(response.paginated(items, 10, 1, 3, true));
});

app.get('/api/demo/response/cursor-paginated', c => {
  const items = [
    { id: '1', name: 'Item 1' },
    { id: '2', name: 'Item 2' },
  ];
  return c.json(response.cursorPaginated(items, 'next-cursor-token', true, 5));
});

app.get('/api/demo/response/not-found', c => {
  return c.json(response.notFound('User'), 404);
});

app.get('/api/demo/response/error', c => {
  return c.json(response.error('Something went wrong', 'DEMO_ERROR'), 500);
});

app.get('/api/demo/response/validation-error', c => {
  return c.json(
    response.validationError([
      { field: 'email', message: 'Invalid email format' },
      { field: 'age', message: 'Must be a positive number' },
    ]),
    400
  );
});

app.get('/api/demo/response/unauthorized', c => {
  return c.json(response.unauthorized('Invalid credentials'), 401);
});

app.get('/api/demo/response/forbidden', c => {
  return c.json(response.forbidden('Access denied'), 403);
});

// 404 handler - must be last
app.notFound(notFoundHandler);

export default app;
