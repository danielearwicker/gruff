import { Hono } from 'hono';
import { validateJson, validateQuery } from './middleware/validation.js';
import { notFoundHandler } from './middleware/error-handler.js';
import { createEntitySchema, entityQuerySchema } from './schemas/index.js';
import { z } from 'zod';
import { ZodError } from 'zod';

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

// Root endpoint
app.get('/', (c) => {
  return c.json({
    name: 'Gruff - Graph Database API',
    version: '1.0.0',
    endpoints: {
      health: '/health',
      api: '/api',
    },
  });
});

// API routes will go here
app.get('/api', (c) => {
  return c.json({
    message: 'Gruff API - Entity-Relationship Database with Versioning',
  });
});

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

// 404 handler - must be last
app.notFound(notFoundHandler);

export default app;
