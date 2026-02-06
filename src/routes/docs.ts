import { Hono } from 'hono';
import { apiReference } from '@scalar/hono-api-reference';

const docs = new Hono();

// Serve the interactive API documentation using Scalar
docs.get(
  '/',
  apiReference({
    pageTitle: 'Gruff API Documentation',
    spec: {
      url: '/docs/openapi.json',
    },
  } as Parameters<typeof apiReference>[0])
);

export default docs;
