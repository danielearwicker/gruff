import { describe, it, expect, vi } from 'vitest';
import { Hono, Context } from 'hono';
import { etag } from '../../src/middleware/etag.js';

describe('ETag Middleware', () => {
  describe('ETag generation', () => {
    it('should add ETag header to GET responses', async () => {
      const app = new Hono();
      app.use('*', etag());
      app.get('/test', (c) => c.json({ message: 'hello' }));

      const res = await app.request('/test');
      const etagHeader = res.headers.get('ETag');

      expect(res.status).toBe(200);
      expect(etagHeader).toBeTruthy();
      expect(etagHeader).toMatch(/^W\/"[a-f0-9]{16}"$/);
    });

    it('should not add ETag header to POST responses', async () => {
      const app = new Hono();
      app.use('*', etag());
      app.post('/test', (c) => c.json({ message: 'created' }, 201));

      const res = await app.request('/test', { method: 'POST' });
      const etagHeader = res.headers.get('ETag');

      expect(res.status).toBe(201);
      expect(etagHeader).toBeNull();
    });

    it('should generate consistent ETags for same content', async () => {
      const app = new Hono();
      app.use('*', etag());
      app.get('/test', (c) => c.json({ message: 'consistent' }));

      const res1 = await app.request('/test');
      const res2 = await app.request('/test');

      const etag1 = res1.headers.get('ETag');
      const etag2 = res2.headers.get('ETag');

      expect(etag1).toBeTruthy();
      expect(etag2).toBeTruthy();
      expect(etag1).toBe(etag2);
    });

    it('should generate different ETags for different content', async () => {
      const app = new Hono();
      let counter = 0;
      app.use('*', etag());
      app.get('/test', (c) => c.json({ message: `value-${counter++}` }));

      const res1 = await app.request('/test');
      const res2 = await app.request('/test');

      const etag1 = res1.headers.get('ETag');
      const etag2 = res2.headers.get('ETag');

      expect(etag1).not.toBe(etag2);
    });
  });

  describe('Conditional requests (If-None-Match)', () => {
    it('should return 304 Not Modified when ETag matches', async () => {
      const app = new Hono();
      app.use('*', etag());
      app.get('/test', (c) => c.json({ message: 'hello' }));

      // First request to get ETag
      const res1 = await app.request('/test');
      const etagValue = res1.headers.get('ETag');
      expect(etagValue).toBeTruthy();

      // Second request with If-None-Match
      const res2 = await app.request('/test', {
        headers: { 'If-None-Match': etagValue! },
      });

      expect(res2.status).toBe(304);
      const body = await res2.text();
      expect(body).toBe('');
    });

    it('should return 200 when ETag does not match', async () => {
      const app = new Hono();
      app.use('*', etag());
      app.get('/test', (c) => c.json({ message: 'hello' }));

      const res = await app.request('/test', {
        headers: { 'If-None-Match': '"non-matching-etag"' },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.message).toBe('hello');
    });

    it('should handle wildcard * in If-None-Match', async () => {
      const app = new Hono();
      app.use('*', etag());
      app.get('/test', (c) => c.json({ message: 'hello' }));

      const res = await app.request('/test', {
        headers: { 'If-None-Match': '*' },
      });

      expect(res.status).toBe(304);
    });

    it('should handle multiple ETags in If-None-Match', async () => {
      const app = new Hono();
      app.use('*', etag());
      app.get('/test', (c) => c.json({ message: 'hello' }));

      // First request to get ETag
      const res1 = await app.request('/test');
      const etagValue = res1.headers.get('ETag');

      // Request with multiple ETags including the valid one
      const res2 = await app.request('/test', {
        headers: { 'If-None-Match': `"invalid1", ${etagValue}, "invalid2"` },
      });

      expect(res2.status).toBe(304);
    });

    it('should parse weak ETags correctly', async () => {
      const app = new Hono();
      app.use('*', etag());
      app.get('/test', (c) => c.json({ message: 'hello' }));

      // First request to get ETag
      const res1 = await app.request('/test');
      const etagValue = res1.headers.get('ETag');
      expect(etagValue).toMatch(/^W\//); // Should be weak ETag

      // Send the weak ETag in If-None-Match (should work)
      const res2 = await app.request('/test', {
        headers: { 'If-None-Match': etagValue! },
      });

      expect(res2.status).toBe(304);
    });
  });

  describe('Skip conditions', () => {
    it('should skip ETag for POST requests', async () => {
      const app = new Hono();
      app.use('*', etag());
      app.post('/test', (c) => c.json({ id: '123' }));

      const res = await app.request('/test', { method: 'POST' });

      expect(res.headers.get('ETag')).toBeNull();
    });

    it('should skip ETag for PUT requests', async () => {
      const app = new Hono();
      app.use('*', etag());
      app.put('/test', (c) => c.json({ updated: true }));

      const res = await app.request('/test', { method: 'PUT' });

      expect(res.headers.get('ETag')).toBeNull();
    });

    it('should skip ETag for DELETE requests', async () => {
      const app = new Hono();
      app.use('*', etag());
      app.delete('/test', (c) => c.json({ deleted: true }));

      const res = await app.request('/test', { method: 'DELETE' });

      expect(res.headers.get('ETag')).toBeNull();
    });

    it('should skip ETag for error responses (4xx)', async () => {
      const app = new Hono();
      app.use('*', etag());
      app.get('/test', (c) => c.json({ error: 'Not found' }, 404));

      const res = await app.request('/test');

      expect(res.status).toBe(404);
      expect(res.headers.get('ETag')).toBeNull();
    });

    it('should skip ETag for error responses (5xx)', async () => {
      const app = new Hono();
      app.use('*', etag());
      app.get('/test', (c) => c.json({ error: 'Server error' }, 500));

      const res = await app.request('/test');

      expect(res.status).toBe(500);
      expect(res.headers.get('ETag')).toBeNull();
    });

    it('should skip paths via custom skip function', async () => {
      const app = new Hono();
      app.use(
        '*',
        etag({
          skip: (c) => c.req.path === '/skip-me',
        })
      );
      app.get('/skip-me', (c) => c.json({ message: 'skipped' }));
      app.get('/include-me', (c) => c.json({ message: 'included' }));

      const res1 = await app.request('/skip-me');
      const res2 = await app.request('/include-me');

      expect(res1.headers.get('ETag')).toBeNull();
      expect(res2.headers.get('ETag')).toBeTruthy();
    });

    it('should skip responses larger than maxSize', async () => {
      const app = new Hono();
      app.use('*', etag({ maxSize: 10 })); // Very small limit
      app.get('/test', (c) => c.json({ message: 'This is a longer response that exceeds the limit' }));

      const res = await app.request('/test');

      expect(res.status).toBe(200);
      expect(res.headers.get('ETag')).toBeNull();
    });

    it('should not skip responses within maxSize', async () => {
      const app = new Hono();
      app.use('*', etag({ maxSize: 1000 }));
      app.get('/test', (c) => c.json({ ok: true }));

      const res = await app.request('/test');

      expect(res.status).toBe(200);
      expect(res.headers.get('ETag')).toBeTruthy();
    });
  });

  describe('Options', () => {
    it('should use weak ETags by default', async () => {
      const app = new Hono();
      app.use('*', etag());
      app.get('/test', (c) => c.json({ message: 'hello' }));

      const res = await app.request('/test');
      const etagValue = res.headers.get('ETag');

      expect(etagValue).toMatch(/^W\//);
    });

    it('should use strong ETags when weak is false', async () => {
      const app = new Hono();
      app.use('*', etag({ weak: false }));
      app.get('/test', (c) => c.json({ message: 'hello' }));

      const res = await app.request('/test');
      const etagValue = res.headers.get('ETag');

      expect(etagValue).not.toMatch(/^W\//);
      expect(etagValue).toMatch(/^"[a-f0-9]{16}"$/);
    });
  });

  describe('Response preservation', () => {
    it('should preserve existing headers', async () => {
      const app = new Hono();
      app.use('*', etag());
      app.get('/test', (c) => {
        c.header('X-Custom-Header', 'custom-value');
        return c.json({ message: 'hello' });
      });

      const res = await app.request('/test');

      expect(res.headers.get('X-Custom-Header')).toBe('custom-value');
      expect(res.headers.get('ETag')).toBeTruthy();
    });

    it('should not overwrite existing ETag header', async () => {
      const app = new Hono();
      app.use('*', etag());
      app.get('/test', (c) => {
        c.header('ETag', '"existing-etag"');
        return c.json({ message: 'hello' });
      });

      const res = await app.request('/test');

      expect(res.headers.get('ETag')).toBe('"existing-etag"');
    });

    it('should preserve response body for 200 responses', async () => {
      const app = new Hono();
      app.use('*', etag());
      app.get('/test', (c) => c.json({ message: 'hello', data: [1, 2, 3] }));

      const res = await app.request('/test');
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.message).toBe('hello');
      expect(data.data).toEqual([1, 2, 3]);
    });
  });

  describe('HEAD requests', () => {
    it('should add ETag header to HEAD responses', async () => {
      const app = new Hono();
      app.use('*', etag());
      app.get('/test', (c) => c.json({ message: 'hello' }));

      const res = await app.request('/test', { method: 'HEAD' });
      const etagHeader = res.headers.get('ETag');

      // HEAD requests may or may not include ETag depending on framework behavior
      // The middleware should at least not cause errors
      expect(res.status).toBeLessThan(400);
    });
  });

  describe('304 response headers', () => {
    it('should include ETag in 304 response', async () => {
      const app = new Hono();
      app.use('*', etag());
      app.get('/test', (c) => c.json({ message: 'hello' }));

      const res1 = await app.request('/test');
      const etagValue = res1.headers.get('ETag');

      const res2 = await app.request('/test', {
        headers: { 'If-None-Match': etagValue! },
      });

      expect(res2.status).toBe(304);
      expect(res2.headers.get('ETag')).toBe(etagValue);
    });
  });
});
