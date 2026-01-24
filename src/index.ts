import { Hono } from 'hono';
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
import { createEntitySchema, entityQuerySchema } from './schemas/index.js';
import * as response from './utils/response.js';
import { createLogger } from './utils/logger.js';
import { z } from 'zod';
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

// Define the environment bindings type
type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  JWT_SECRET: string;
  ENVIRONMENT: string;
  ALLOWED_ORIGINS?: string; // Comma-separated list of allowed origins for CORS (production)
};

const app = new Hono<{ Bindings: Bindings }>();

// Request context middleware - must be first to add requestId and logger to all requests
app.use('*', requestContextMiddleware);

// Security middleware - environment-aware configuration
// In production: strict security headers and CORS
// In development: relaxed settings for local testing
app.use('*', async (c, next) => {
  const isDevelopment = c.env?.ENVIRONMENT === 'development' || !c.env?.ENVIRONMENT;
  const securityConfig = isDevelopment
    ? getDevelopmentSecurityConfig()
    : getProductionSecurityConfig(c.env?.ALLOWED_ORIGINS?.split(',') || ['*']);

  // Apply CORS middleware
  const corsMiddleware = createCorsMiddleware(securityConfig);
  await corsMiddleware(c, async () => {});

  // Apply security headers middleware
  const headersMiddleware = createSecurityHeadersMiddleware(securityConfig);
  await headersMiddleware(c, next);
});

// Rate limiting middleware - applied to all /api/* routes
// Automatically categorizes requests based on path and method
// Skip health and version endpoints for operational monitoring
app.use('/api/*', rateLimit({
  skip: (c) => {
    // Skip rate limiting for version endpoint (lightweight, informational)
    if (c.req.path === '/api/version') {
      return true;
    }
    return false;
  },
}));

// Global error handler using Hono's onError
app.onError((err, c) => {
  // Get request ID and logger from context (set by request context middleware)
  // Fallback to generating new ones if not available (shouldn't happen in normal flow)
  const requestId = getRequestId(c) || crypto.randomUUID();
  const logger = getLogger(c) || createLogger({
    requestId,
    path: c.req.path,
    method: c.req.method,
  });
  let statusCode = 500;
  let errorResponse: any = {
    error: 'Internal server error',
    code: 'INTERNAL_SERVER_ERROR',
    timestamp: new Date().toISOString(),
    path: c.req.path,
    requestId,
  };

  // Handle Zod validation errors
  if (err instanceof ZodError || (err as any)?.name === 'ZodError') {
    const zodError = err as ZodError;
    statusCode = 400;
    errorResponse = {
      error: 'Validation failed',
      code: 'VALIDATION_ERROR',
      details: zodError.issues.map((issue) => ({
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
  logger.error(
    'Request error',
    err instanceof Error ? err : new Error(String(err)),
    {
      statusCode,
      errorCode: errorResponse.code,
    }
  );

  return c.json(errorResponse, statusCode);
});

// Health check endpoint
app.get('/health', async (c) => {
  try {
    // Test D1 connection
    const dbResult = await c.env.DB.prepare('SELECT 1 as test').first();

    // Test KV connection
    await c.env.KV.put('health-check', Date.now().toString(), { expirationTtl: 60 });
    const kvValue = await c.env.KV.get('health-check');

    // Gather Workers runtime status
    const runtimeStatus = {
      platform: 'cloudflare-workers',
      // Check if we're running in local dev mode (Miniflare/Wrangler)
      mode: c.env.ENVIRONMENT === 'development' ? 'local' : 'edge',
      // Request context information
      context: {
        // The colo (data center) where the request is being processed
        // This is available via cf object in production but not in local dev
        colo: (c.req.raw as any).cf?.colo || 'local',
        // Country of request origin
        country: (c.req.raw as any).cf?.country || 'unknown',
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

    return c.json({
      status: 'healthy',
      environment: c.env.ENVIRONMENT,
      database: dbResult ? 'connected' : 'disconnected',
      kv: kvValue ? 'connected' : 'disconnected',
      runtime: runtimeStatus,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return c.json({
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
});

// Version information endpoint
app.get('/api/version', (c) => {
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
app.get('/', (c) => {
  return c.json({
    name: 'Gruff - Graph Database API',
    version: '1.0.0',
    endpoints: {
      health: '/health',
      api: '/api',
      version: '/api/version',
      documentation: '/docs',
      openapi: '/docs/openapi.json',
    },
  });
});

// API routes
app.get('/api', (c) => {
  return c.json({
    message: 'Gruff API - Entity-Relationship Database with Versioning',
  });
});

// Mount authentication routes
app.route('/api/auth', authRouter);

// Mount user management routes
app.route('/api/users', usersRouter);

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

// Mount API documentation routes (OpenAPI spec and Scalar UI)
app.route('/docs', docsRouter);

// Validation demo endpoint - validates JSON body
app.post('/api/validate/entity', validateJson(createEntitySchema), (c) => {
  const validated = c.get('validated_json') as any;
  return c.json({
    success: true,
    message: 'Entity schema validation passed',
    received: validated,
  });
});

// Validation demo endpoint - validates query parameters
app.get('/api/validate/query', validateQuery(entityQuerySchema), (c) => {
  const validated = c.get('validated_query') as any;
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

app.post('/api/validate/test', validateJson(testSchema), (c) => {
  const validated = c.get('validated_json') as any;
  return c.json({
    success: true,
    message: 'Custom validation passed',
    data: validated,
  });
});

// Response formatting demo endpoints
app.get('/api/demo/response/success', (c) => {
  return c.json(response.success({ id: '123', name: 'Example' }, 'Operation successful'));
});

app.get('/api/demo/response/created', (c) => {
  return c.json(response.created({ id: '456', name: 'New Resource' }), 201);
});

app.get('/api/demo/response/updated', (c) => {
  return c.json(response.updated({ id: '789', name: 'Updated Resource' }));
});

app.get('/api/demo/response/deleted', (c) => {
  return c.json(response.deleted());
});

app.get('/api/demo/response/paginated', (c) => {
  const items = [
    { id: '1', name: 'Item 1' },
    { id: '2', name: 'Item 2' },
    { id: '3', name: 'Item 3' },
  ];
  return c.json(response.paginated(items, 10, 1, 3, true));
});

app.get('/api/demo/response/cursor-paginated', (c) => {
  const items = [
    { id: '1', name: 'Item 1' },
    { id: '2', name: 'Item 2' },
  ];
  return c.json(response.cursorPaginated(items, 'next-cursor-token', true, 5));
});

app.get('/api/demo/response/not-found', (c) => {
  return c.json(response.notFound('User'), 404);
});

app.get('/api/demo/response/error', (c) => {
  return c.json(response.error('Something went wrong', 'DEMO_ERROR'), 500);
});

app.get('/api/demo/response/validation-error', (c) => {
  return c.json(response.validationError([
    { field: 'email', message: 'Invalid email format' },
    { field: 'age', message: 'Must be a positive number' },
  ]), 400);
});

app.get('/api/demo/response/unauthorized', (c) => {
  return c.json(response.unauthorized('Invalid credentials'), 401);
});

app.get('/api/demo/response/forbidden', (c) => {
  return c.json(response.forbidden('Access denied'), 403);
});

// 404 handler - must be last
app.notFound(notFoundHandler);

export default app;
