# @hono/zod-openapi Quick Reference

Practical guide for refactoring routes to use `@hono/zod-openapi`.

## Installation

```bash
npm i hono zod @hono/zod-openapi
```

## Basic Setup Pattern

```typescript
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'

// Create app instance
const app = new OpenAPIHono()

// Define route
const route = createRoute({
  method: 'get',
  path: '/users/{id}',
  request: { /* validation schemas */ },
  responses: { /* response schemas */ }
})

// Register handler
app.openapi(route, (c) => {
  // Handler implementation
  return c.json({ /* response */ }, 200)
})

// Expose OpenAPI docs
app.doc('/doc', {
  openapi: '3.0.0',
  info: {
    version: '1.0.0',
    title: 'My API'
  }
})
```

## Schema Annotations with .openapi()

**Import z from @hono/zod-openapi** (not from standard zod):

```typescript
import { z } from '@hono/zod-openapi'
```

**Add metadata to schemas:**

```typescript
// Simple field annotation
const UserSchema = z.object({
  id: z.string().openapi({ example: '123' }),
  name: z.string().openapi({ example: 'John Doe' }),
  age: z.number().openapi({ example: 42 })
})

// Register as reusable component (creates #/components/schemas/User)
const UserSchema = z.object({
  id: z.string().openapi({ example: '123' }),
  name: z.string().openapi({ example: 'John Doe' })
}).openapi('User')
```

## Request Validation Patterns

### Path Parameters

```typescript
const ParamsSchema = z.object({
  id: z.string().min(3).openapi({
    param: { name: 'id', in: 'path' },
    example: '1212121'
  })
})

const route = createRoute({
  method: 'get',
  path: '/users/{id}',
  request: {
    params: ParamsSchema
  },
  responses: { /* ... */ }
})
```

**Access in handler:**
```typescript
app.openapi(route, (c) => {
  const { id } = c.req.valid('param')
  // ...
})
```

### Query Parameters

```typescript
const QuerySchema = z.object({
  page: z.string().optional().openapi({
    param: { name: 'page', in: 'query' },
    example: '1'
  }),
  limit: z.string().optional().openapi({
    param: { name: 'limit', in: 'query' },
    example: '10'
  })
})

const route = createRoute({
  method: 'get',
  path: '/users',
  request: {
    query: QuerySchema
  },
  responses: { /* ... */ }
})
```

**Access in handler:**
```typescript
app.openapi(route, (c) => {
  const { page, limit } = c.req.valid('query')
  // ...
})
```

### Request Body

```typescript
const CreateUserSchema = z.object({
  name: z.string().openapi({ example: 'John Doe' }),
  email: z.string().email().openapi({ example: 'john@example.com' })
})

const route = createRoute({
  method: 'post',
  path: '/users',
  request: {
    body: {
      content: {
        'application/json': {
          schema: CreateUserSchema,
          required: true  // Force validation even without Content-Type
        }
      }
    }
  },
  responses: { /* ... */ }
})
```

**Important:** Request must have proper `Content-Type` header for validation. Use `required: true` to enforce validation regardless.

**Access in handler:**
```typescript
app.openapi(route, (c) => {
  const body = c.req.valid('json')
  // ...
})
```

## Response Definitions

```typescript
const route = createRoute({
  method: 'get',
  path: '/users/{id}',
  request: { /* ... */ },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: UserSchema
        }
      },
      description: 'Successfully retrieved user'
    },
    404: {
      content: {
        'application/json': {
          schema: z.object({
            error: z.string().openapi({ example: 'User not found' })
          })
        }
      },
      description: 'User not found'
    }
  }
})
```

**Handler must specify status code explicitly:**
```typescript
app.openapi(route, (c) => {
  return c.json({ id: '123', name: 'John' }, 200)  // Must include 200
})
```

## Error Response Patterns

### Per-Route Error Hook

```typescript
app.openapi(
  route,
  (c) => {
    // Normal handler
    return c.json({ /* ... */ }, 200)
  },
  (result, c) => {
    // Validation error hook
    if (!result.success) {
      return c.json({
        code: 400,
        message: 'Validation Error',
        errors: result.error.errors
      }, 400)
    }
  }
)
```

### Default Error Handler

```typescript
const app = new OpenAPIHono({
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json({
        ok: false,
        errors: result.error.errors.map(err => ({
          path: err.path.join('.'),
          message: err.message
        }))
      }, 422)
    }
  }
})
```

**Note:** Route-level hooks override the default handler.

### Common Error Response Schema

```typescript
const ErrorSchema = z.object({
  error: z.string(),
  details: z.array(z.object({
    path: z.string(),
    message: z.string()
  })).optional()
}).openapi('Error')

// Use in route responses
responses: {
  400: {
    content: {
      'application/json': { schema: ErrorSchema }
    },
    description: 'Bad request'
  },
  404: {
    content: {
      'application/json': { schema: ErrorSchema }
    },
    description: 'Not found'
  }
}
```

## Security Schemes

### Setup (in app initialization)

```typescript
// Register security scheme in registry
app.openAPIRegistry.registerComponent('securitySchemes', 'Bearer', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT'
})
```

### Apply to Routes

```typescript
const route = createRoute({
  method: 'get',
  path: '/protected',
  security: [
    {
      Bearer: []
    }
  ],
  request: { /* ... */ },
  responses: { /* ... */ }
})
```

## Complete Example

```typescript
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'

const app = new OpenAPIHono()

// Define schemas
const ParamsSchema = z.object({
  id: z.string().openapi({
    param: { name: 'id', in: 'path' },
    example: '123'
  })
})

const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email()
}).openapi('User')

const ErrorSchema = z.object({
  error: z.string()
}).openapi('Error')

// Create route
const getUserRoute = createRoute({
  method: 'get',
  path: '/users/{id}',
  request: {
    params: ParamsSchema
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: UserSchema
        }
      },
      description: 'Retrieve user'
    },
    404: {
      content: {
        'application/json': {
          schema: ErrorSchema
        }
      },
      description: 'User not found'
    }
  }
})

// Register handler
app.openapi(getUserRoute, (c) => {
  const { id } = c.req.valid('param')

  // Your logic here
  const user = findUser(id)

  if (!user) {
    return c.json({ error: 'User not found' }, 404)
  }

  return c.json(user, 200)
})

// Expose docs
app.doc('/doc', {
  openapi: '3.0.0',
  info: {
    version: '1.0.0',
    title: 'My API'
  }
})

export default app
```

## Key Points to Remember

1. **Always import `z` from `@hono/zod-openapi`**, not from standard zod
2. **Use `.openapi('Name')` on schemas** to register them as reusable components
3. **Status codes must be explicit** in responses (e.g., `return c.json(data, 200)`)
4. **Content-Type headers matter** for request body validation
5. **Use `c.req.valid('param')`, `c.req.valid('query')`, `c.req.valid('json')`** to access validated data
6. **Route-level error hooks override default hooks**
7. **Header keys must be lowercase** in schemas

## Migration Tips

When refactoring existing routes:

1. Start with route definition using `createRoute()`
2. Move request validation to `request` property (params, query, body)
3. Define response schemas in `responses` property
4. Register route with `app.openapi()` instead of `app.get()`/`app.post()`
5. Update handler to use `c.req.valid()` for validated data
6. Ensure all responses include explicit status codes
