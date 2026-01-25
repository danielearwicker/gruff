import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { responseTime } from '../../src/middleware/response-time.js';
import type { AnalyticsEngineDataset } from '../../src/utils/error-tracking.js';

describe('Response Time Middleware', () => {
  let mockAnalytics: AnalyticsEngineDataset;

  beforeEach(() => {
    mockAnalytics = {
      writeDataPoint: vi.fn(),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('X-Response-Time header', () => {
    it('should add X-Response-Time header to responses', async () => {
      const app = new Hono();
      app.use('*', responseTime());
      app.get('/test', c => c.json({ message: 'hello' }));

      const res = await app.request('/test');
      const responseTimeHeader = res.headers.get('X-Response-Time');

      expect(res.status).toBe(200);
      expect(responseTimeHeader).toBeTruthy();
      expect(responseTimeHeader).toMatch(/^\d+ms$/);
    });

    it('should add header with custom name', async () => {
      const app = new Hono();
      app.use('*', responseTime({ headerName: 'X-Custom-Time' }));
      app.get('/test', c => c.json({ message: 'hello' }));

      const res = await app.request('/test');

      expect(res.headers.get('X-Response-Time')).toBeNull();
      expect(res.headers.get('X-Custom-Time')).toMatch(/^\d+ms$/);
    });

    it('should not add header when headerName is null', async () => {
      const app = new Hono();
      app.use('*', responseTime({ headerName: null }));
      app.get('/test', c => c.json({ message: 'hello' }));

      const res = await app.request('/test');

      expect(res.headers.get('X-Response-Time')).toBeNull();
    });

    it('should add header to all HTTP methods', async () => {
      const app = new Hono();
      app.use('*', responseTime());
      app.get('/test', c => c.json({ message: 'get' }));
      app.post('/test', c => c.json({ message: 'post' }));
      app.put('/test', c => c.json({ message: 'put' }));
      app.delete('/test', c => c.json({ message: 'delete' }));

      const resGet = await app.request('/test', { method: 'GET' });
      const resPost = await app.request('/test', { method: 'POST' });
      const resPut = await app.request('/test', { method: 'PUT' });
      const resDelete = await app.request('/test', { method: 'DELETE' });

      expect(resGet.headers.get('X-Response-Time')).toMatch(/^\d+ms$/);
      expect(resPost.headers.get('X-Response-Time')).toMatch(/^\d+ms$/);
      expect(resPut.headers.get('X-Response-Time')).toMatch(/^\d+ms$/);
      expect(resDelete.headers.get('X-Response-Time')).toMatch(/^\d+ms$/);
    });

    it('should add header to error responses', async () => {
      const app = new Hono();
      app.use('*', responseTime());
      app.get('/test', c => c.json({ error: 'Not found' }, 404));

      const res = await app.request('/test');

      expect(res.status).toBe(404);
      expect(res.headers.get('X-Response-Time')).toMatch(/^\d+ms$/);
    });
  });

  describe('Analytics Engine integration', () => {
    it('should write metrics to Analytics Engine when available', async () => {
      const app = new Hono<{
        Bindings: { ANALYTICS: AnalyticsEngineDataset; ENVIRONMENT: string };
      }>();

      app.use('*', responseTime());
      app.get('/api/entities', c => c.json({ data: [] }));

      // Create a mock request with env bindings
      const req = new Request('http://localhost/api/entities');
      const env = { ANALYTICS: mockAnalytics, ENVIRONMENT: 'test' };
      const res = await app.fetch(req, env);

      expect(res.status).toBe(200);
      expect(mockAnalytics.writeDataPoint).toHaveBeenCalledTimes(1);

      const call = (mockAnalytics.writeDataPoint as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.blobs[1]).toBe('read'); // category
      expect(call.blobs[2]).toBe('GET'); // method
      expect(call.blobs[3]).toBe('/api/entities'); // route pattern
      expect(call.doubles[1]).toBe(200); // status code
    });

    it('should correctly categorize write operations', async () => {
      const app = new Hono<{
        Bindings: { ANALYTICS: AnalyticsEngineDataset; ENVIRONMENT: string };
      }>();

      app.use('*', responseTime());
      app.post('/api/entities', c => c.json({ data: { id: '123' } }, 201));

      const req = new Request('http://localhost/api/entities', { method: 'POST' });
      const env = { ANALYTICS: mockAnalytics, ENVIRONMENT: 'test' };
      await app.fetch(req, env);

      const call = (mockAnalytics.writeDataPoint as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.blobs[1]).toBe('write'); // category
      expect(call.blobs[2]).toBe('POST'); // method
      expect(call.doubles[1]).toBe(201); // status code
    });

    it('should categorize different endpoint types correctly', async () => {
      const app = new Hono<{
        Bindings: { ANALYTICS: AnalyticsEngineDataset; ENVIRONMENT: string };
      }>();

      app.use('*', responseTime());
      app.get('/api/search/entities', c => c.json({ results: [] }));
      app.get('/api/graph/path', c => c.json({ path: [] }));
      app.post('/api/auth/login', c => c.json({ token: 'abc' }));

      const env = { ANALYTICS: mockAnalytics, ENVIRONMENT: 'test' };

      // Search endpoint
      await app.fetch(new Request('http://localhost/api/search/entities'), env);
      let call = (mockAnalytics.writeDataPoint as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.blobs[1]).toBe('search');

      // Graph endpoint
      await app.fetch(new Request('http://localhost/api/graph/path'), env);
      call = (mockAnalytics.writeDataPoint as ReturnType<typeof vi.fn>).mock.calls[1][0];
      expect(call.blobs[1]).toBe('graph');

      // Auth endpoint
      await app.fetch(new Request('http://localhost/api/auth/login', { method: 'POST' }), env);
      call = (mockAnalytics.writeDataPoint as ReturnType<typeof vi.fn>).mock.calls[2][0];
      expect(call.blobs[1]).toBe('auth');
    });

    it('should include environment in metrics', async () => {
      const app = new Hono<{
        Bindings: { ANALYTICS: AnalyticsEngineDataset; ENVIRONMENT: string };
      }>();

      app.use('*', responseTime({ environment: 'production' }));
      app.get('/test', c => c.json({ ok: true }));

      const req = new Request('http://localhost/test');
      const env = { ANALYTICS: mockAnalytics, ENVIRONMENT: 'production' };
      await app.fetch(req, env);

      const call = (mockAnalytics.writeDataPoint as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.blobs[0]).toBe('production');
      expect(call.indexes[0]).toBe('production');
    });

    it('should extract route pattern from path with IDs', async () => {
      const app = new Hono<{
        Bindings: { ANALYTICS: AnalyticsEngineDataset; ENVIRONMENT: string };
      }>();

      app.use('*', responseTime());
      app.get('/api/entities/:id', c => c.json({ id: c.req.param('id') }));

      const req = new Request('http://localhost/api/entities/550e8400-e29b-41d4-a716-446655440000');
      const env = { ANALYTICS: mockAnalytics, ENVIRONMENT: 'test' };
      await app.fetch(req, env);

      const call = (mockAnalytics.writeDataPoint as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.blobs[3]).toBe('/api/entities/:id');
    });
  });

  describe('Skip conditions', () => {
    it('should skip requests via custom skip function', async () => {
      const app = new Hono<{
        Bindings: { ANALYTICS: AnalyticsEngineDataset; ENVIRONMENT: string };
      }>();

      app.use(
        '*',
        responseTime({
          skip: c => c.req.path === '/skip-me',
        })
      );
      app.get('/skip-me', c => c.json({ skipped: true }));
      app.get('/include-me', c => c.json({ included: true }));

      const env = { ANALYTICS: mockAnalytics, ENVIRONMENT: 'test' };

      // Skipped request - no header
      const res1 = await app.fetch(new Request('http://localhost/skip-me'), env);
      expect(res1.headers.get('X-Response-Time')).toBeNull();
      expect(mockAnalytics.writeDataPoint).not.toHaveBeenCalled();

      // Included request - has header
      const res2 = await app.fetch(new Request('http://localhost/include-me'), env);
      expect(res2.headers.get('X-Response-Time')).toMatch(/^\d+ms$/);
      expect(mockAnalytics.writeDataPoint).toHaveBeenCalledTimes(1);
    });

    it('should skip paths via skipPaths config', async () => {
      const app = new Hono<{
        Bindings: { ANALYTICS: AnalyticsEngineDataset; ENVIRONMENT: string };
      }>();

      app.use(
        '*',
        responseTime({
          skipPaths: ['/docs'],
        })
      );
      app.get('/docs', c => c.text('Documentation'));
      app.get('/docs/openapi.json', c => c.json({ openapi: '3.0.0' }));
      app.get('/api/test', c => c.json({ ok: true }));

      const env = { ANALYTICS: mockAnalytics, ENVIRONMENT: 'test' };

      // Skipped paths (prefix match)
      await app.fetch(new Request('http://localhost/docs'), env);
      expect(mockAnalytics.writeDataPoint).not.toHaveBeenCalled();

      await app.fetch(new Request('http://localhost/docs/openapi.json'), env);
      expect(mockAnalytics.writeDataPoint).not.toHaveBeenCalled();

      // Non-skipped path
      await app.fetch(new Request('http://localhost/api/test'), env);
      expect(mockAnalytics.writeDataPoint).toHaveBeenCalledTimes(1);
    });

    it('should not track requests below minDurationMs', async () => {
      const app = new Hono<{
        Bindings: { ANALYTICS: AnalyticsEngineDataset; ENVIRONMENT: string };
      }>();

      app.use('*', responseTime({ minDurationMs: 1000 })); // Very high threshold
      app.get('/test', c => c.json({ fast: true }));

      const env = { ANALYTICS: mockAnalytics, ENVIRONMENT: 'test' };
      await app.fetch(new Request('http://localhost/test'), env);

      // Response should still have header
      // But analytics should not be written (request is too fast)
      expect(mockAnalytics.writeDataPoint).not.toHaveBeenCalled();
    });
  });

  describe('Response preservation', () => {
    it('should preserve response body', async () => {
      const app = new Hono();
      app.use('*', responseTime());
      app.get('/test', c => c.json({ message: 'hello', data: [1, 2, 3] }));

      const res = await app.request('/test');
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.message).toBe('hello');
      expect(data.data).toEqual([1, 2, 3]);
    });

    it('should preserve existing headers', async () => {
      const app = new Hono();
      app.use('*', responseTime());
      app.get('/test', c => {
        c.header('X-Custom-Header', 'custom-value');
        return c.json({ message: 'hello' });
      });

      const res = await app.request('/test');

      expect(res.headers.get('X-Custom-Header')).toBe('custom-value');
      expect(res.headers.get('X-Response-Time')).toBeTruthy();
    });

    it('should preserve error responses', async () => {
      const app = new Hono();
      app.use('*', responseTime());
      app.get('/test', c => {
        return c.json({ error: 'Something went wrong' }, 500);
      });

      const res = await app.request('/test');
      const data = await res.json();

      expect(res.status).toBe(500);
      expect(data.error).toBe('Something went wrong');
      expect(res.headers.get('X-Response-Time')).toBeTruthy();
    });
  });

  describe('Analytics failure handling', () => {
    it('should not fail request when Analytics Engine fails', async () => {
      const failingAnalytics: AnalyticsEngineDataset = {
        writeDataPoint: vi.fn().mockImplementation(() => {
          throw new Error('Analytics failure');
        }),
      };

      const app = new Hono<{
        Bindings: { ANALYTICS: AnalyticsEngineDataset; ENVIRONMENT: string };
      }>();

      app.use('*', responseTime());
      app.get('/test', c => c.json({ message: 'success' }));

      const req = new Request('http://localhost/test');
      const env = { ANALYTICS: failingAnalytics, ENVIRONMENT: 'test' };

      // Should not throw
      const res = await app.fetch(req, env);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.message).toBe('success');
      expect(res.headers.get('X-Response-Time')).toBeTruthy();
    });

    it('should work when Analytics Engine is not configured', async () => {
      const app = new Hono<{
        Bindings: { ENVIRONMENT: string };
      }>();

      app.use('*', responseTime());
      app.get('/test', c => c.json({ message: 'no analytics' }));

      const req = new Request('http://localhost/test');
      const env = { ENVIRONMENT: 'test' };

      // Should not throw
      const res = await app.fetch(req, env as { ENVIRONMENT: string });
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.message).toBe('no analytics');
      expect(res.headers.get('X-Response-Time')).toBeTruthy();
    });
  });
});
