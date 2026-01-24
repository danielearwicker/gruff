import { Hono } from 'hono';
import { validateJson, validateQuery } from './middleware/validation.js';
import { notFoundHandler } from './middleware/error-handler.js';
import { createEntitySchema, entityQuerySchema } from './schemas/index.js';
import * as response from './utils/response.js';
import { z } from 'zod';
import { ZodError } from 'zod';
import typesRouter from './routes/types.js';
import entitiesRouter from './routes/entities.js';
import linksRouter from './routes/links.js';

// Define the environment bindings type
type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  ENVIRONMENT: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// Global error handler using Hono's onError
app.onError((err, c) => {
  console.error('[Error Handler] Error occurred:', err);
  console.error('[Error Handler] Error type:', err?.constructor?.name);

  const requestId = crypto.randomUUID();
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

    return c.json({
      status: 'healthy',
      environment: c.env.ENVIRONMENT,
      database: dbResult ? 'connected' : 'disconnected',
      kv: kvValue ? 'connected' : 'disconnected',
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
      documentation: '/api',
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
    },
  });
});

// API routes
app.get('/api', (c) => {
  return c.json({
    message: 'Gruff API - Entity-Relationship Database with Versioning',
  });
});

// Mount type management routes
app.route('/api/types', typesRouter);

// Mount entity management routes
app.route('/api/entities', entitiesRouter);

// Mount link management routes
app.route('/api/links', linksRouter);

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
