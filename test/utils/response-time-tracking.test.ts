import { describe, it, expect, vi } from 'vitest';
import {
  ResponseTimeTracker,
  createResponseTimeTracker,
  categorizeEndpoint,
  getStatusCategory,
  extractRoutePattern,
  EndpointCategory,
  StatusCategory,
} from '../../src/utils/response-time-tracking.js';
import type { AnalyticsEngineDataset } from '../../src/utils/error-tracking.js';

describe('Response Time Tracking', () => {
  describe('categorizeEndpoint', () => {
    it('should categorize health endpoints', () => {
      expect(categorizeEndpoint('/health', 'GET')).toBe(EndpointCategory.HEALTH);
      expect(categorizeEndpoint('/api/version', 'GET')).toBe(EndpointCategory.HEALTH);
      expect(categorizeEndpoint('/', 'GET')).toBe(EndpointCategory.HEALTH);
    });

    it('should categorize documentation endpoints', () => {
      expect(categorizeEndpoint('/docs', 'GET')).toBe(EndpointCategory.DOCS);
      expect(categorizeEndpoint('/docs/openapi.json', 'GET')).toBe(EndpointCategory.DOCS);
      expect(categorizeEndpoint('/docs/openapi.yaml', 'GET')).toBe(EndpointCategory.DOCS);
    });

    it('should categorize auth endpoints', () => {
      expect(categorizeEndpoint('/api/auth/login', 'POST')).toBe(EndpointCategory.AUTH);
      expect(categorizeEndpoint('/api/auth/register', 'POST')).toBe(EndpointCategory.AUTH);
      expect(categorizeEndpoint('/api/auth/me', 'GET')).toBe(EndpointCategory.AUTH);
      expect(categorizeEndpoint('/api/auth/logout', 'POST')).toBe(EndpointCategory.AUTH);
    });

    it('should categorize search endpoints', () => {
      expect(categorizeEndpoint('/api/search/entities', 'POST')).toBe(EndpointCategory.SEARCH);
      expect(categorizeEndpoint('/api/search/links', 'POST')).toBe(EndpointCategory.SEARCH);
      expect(categorizeEndpoint('/api/search/suggest', 'GET')).toBe(EndpointCategory.SEARCH);
    });

    it('should categorize graph endpoints', () => {
      expect(categorizeEndpoint('/api/graph/traverse', 'POST')).toBe(EndpointCategory.GRAPH);
      expect(categorizeEndpoint('/api/graph/path', 'GET')).toBe(EndpointCategory.GRAPH);
      expect(categorizeEndpoint('/api/entities/123/neighbors', 'GET')).toBe(EndpointCategory.GRAPH);
      expect(categorizeEndpoint('/api/entities/123/inbound', 'GET')).toBe(EndpointCategory.GRAPH);
      expect(categorizeEndpoint('/api/entities/123/outbound', 'GET')).toBe(EndpointCategory.GRAPH);
    });

    it('should categorize bulk endpoints', () => {
      expect(categorizeEndpoint('/api/bulk/entities', 'POST')).toBe(EndpointCategory.BULK);
      expect(categorizeEndpoint('/api/bulk/links', 'PUT')).toBe(EndpointCategory.BULK);
    });

    it('should categorize export endpoints', () => {
      expect(categorizeEndpoint('/api/export', 'GET')).toBe(EndpointCategory.EXPORT);
      expect(categorizeEndpoint('/api/export', 'POST')).toBe(EndpointCategory.EXPORT);
    });

    it('should categorize read operations (GET, HEAD, OPTIONS)', () => {
      expect(categorizeEndpoint('/api/entities', 'GET')).toBe(EndpointCategory.READ);
      expect(categorizeEndpoint('/api/entities/123', 'GET')).toBe(EndpointCategory.READ);
      expect(categorizeEndpoint('/api/links', 'HEAD')).toBe(EndpointCategory.READ);
      expect(categorizeEndpoint('/api/types', 'OPTIONS')).toBe(EndpointCategory.READ);
    });

    it('should categorize write operations (POST, PUT, PATCH, DELETE)', () => {
      expect(categorizeEndpoint('/api/entities', 'POST')).toBe(EndpointCategory.WRITE);
      expect(categorizeEndpoint('/api/entities/123', 'PUT')).toBe(EndpointCategory.WRITE);
      expect(categorizeEndpoint('/api/entities/123', 'PATCH')).toBe(EndpointCategory.WRITE);
      expect(categorizeEndpoint('/api/entities/123', 'DELETE')).toBe(EndpointCategory.WRITE);
    });

    it('should be case-insensitive for paths and methods', () => {
      expect(categorizeEndpoint('/API/AUTH/LOGIN', 'post')).toBe(EndpointCategory.AUTH);
      expect(categorizeEndpoint('/Api/Entities', 'GET')).toBe(EndpointCategory.READ);
    });
  });

  describe('getStatusCategory', () => {
    it('should categorize 2xx as SUCCESS', () => {
      expect(getStatusCategory(200)).toBe(StatusCategory.SUCCESS);
      expect(getStatusCategory(201)).toBe(StatusCategory.SUCCESS);
      expect(getStatusCategory(204)).toBe(StatusCategory.SUCCESS);
      expect(getStatusCategory(299)).toBe(StatusCategory.SUCCESS);
    });

    it('should categorize 3xx as REDIRECT', () => {
      expect(getStatusCategory(301)).toBe(StatusCategory.REDIRECT);
      expect(getStatusCategory(302)).toBe(StatusCategory.REDIRECT);
      expect(getStatusCategory(304)).toBe(StatusCategory.REDIRECT);
    });

    it('should categorize 4xx as CLIENT_ERROR', () => {
      expect(getStatusCategory(400)).toBe(StatusCategory.CLIENT_ERROR);
      expect(getStatusCategory(401)).toBe(StatusCategory.CLIENT_ERROR);
      expect(getStatusCategory(404)).toBe(StatusCategory.CLIENT_ERROR);
      expect(getStatusCategory(429)).toBe(StatusCategory.CLIENT_ERROR);
    });

    it('should categorize 5xx as SERVER_ERROR', () => {
      expect(getStatusCategory(500)).toBe(StatusCategory.SERVER_ERROR);
      expect(getStatusCategory(502)).toBe(StatusCategory.SERVER_ERROR);
      expect(getStatusCategory(503)).toBe(StatusCategory.SERVER_ERROR);
    });

    it('should categorize unexpected codes as SERVER_ERROR', () => {
      expect(getStatusCategory(100)).toBe(StatusCategory.SERVER_ERROR);
      expect(getStatusCategory(600)).toBe(StatusCategory.SERVER_ERROR);
    });
  });

  describe('extractRoutePattern', () => {
    it('should replace UUIDs with :id', () => {
      expect(extractRoutePattern('/api/entities/550e8400-e29b-41d4-a716-446655440000')).toBe(
        '/api/entities/:id'
      );
      expect(extractRoutePattern('/api/links/A1B2C3D4-E5F6-7890-ABCD-EF1234567890')).toBe(
        '/api/links/:id'
      );
    });

    it('should replace numeric IDs with :id', () => {
      expect(extractRoutePattern('/api/entities/123')).toBe('/api/entities/:id');
      expect(extractRoutePattern('/api/users/456/activity')).toBe('/api/users/:id/activity');
    });

    it('should replace version numbers in paths', () => {
      expect(extractRoutePattern('/api/entities/abc123/versions/5')).toBe(
        '/api/entities/abc123/versions/:version'
      );
    });

    it('should handle multiple IDs in path', () => {
      const result = extractRoutePattern(
        '/api/entities/550e8400-e29b-41d4-a716-446655440000/versions/3'
      );
      expect(result).toBe('/api/entities/:id/versions/:version');
    });

    it('should preserve paths without IDs', () => {
      expect(extractRoutePattern('/api/entities')).toBe('/api/entities');
      expect(extractRoutePattern('/api/types')).toBe('/api/types');
      expect(extractRoutePattern('/health')).toBe('/health');
    });
  });

  describe('ResponseTimeTracker', () => {
    describe('track', () => {
      it('should write to Analytics Engine when available', () => {
        const mockAnalytics: AnalyticsEngineDataset = {
          writeDataPoint: vi.fn(),
        };

        const tracker = new ResponseTimeTracker(mockAnalytics);
        tracker.track({
          path: '/api/entities/123',
          method: 'GET',
          statusCode: 200,
          durationMs: 50,
          requestId: 'req-123',
        });

        expect(mockAnalytics.writeDataPoint).toHaveBeenCalledTimes(1);
        const call = (mockAnalytics.writeDataPoint as ReturnType<typeof vi.fn>).mock.calls[0][0];

        // Check blobs structure
        expect(call.blobs[0]).toBe('development'); // environment
        expect(call.blobs[1]).toBe('read'); // category
        expect(call.blobs[2]).toBe('GET'); // method
        expect(call.blobs[3]).toBe('/api/entities/:id'); // route pattern
        expect(call.blobs[4]).toBe('2xx'); // status category
        expect(call.blobs[5]).toBe('anonymous'); // userId
        expect(call.blobs[8]).toBe('req-123'); // requestId

        // Check doubles structure
        expect(call.doubles[0]).toBe(50); // duration
        expect(call.doubles[1]).toBe(200); // status code
      });

      it('should include user ID when provided', () => {
        const mockAnalytics: AnalyticsEngineDataset = {
          writeDataPoint: vi.fn(),
        };

        const tracker = new ResponseTimeTracker(mockAnalytics);
        tracker.track({
          path: '/api/entities',
          method: 'POST',
          statusCode: 201,
          durationMs: 100,
          userId: 'user-456',
        });

        const call = (mockAnalytics.writeDataPoint as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(call.blobs[5]).toBe('user-456');
      });

      it('should include environment in index for partitioning', () => {
        const mockAnalytics: AnalyticsEngineDataset = {
          writeDataPoint: vi.fn(),
        };

        const tracker = new ResponseTimeTracker(mockAnalytics, {
          environment: 'production',
        });
        tracker.track({
          path: '/api/entities',
          method: 'GET',
          statusCode: 200,
          durationMs: 25,
        });

        const call = (mockAnalytics.writeDataPoint as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(call.blobs[0]).toBe('production');
        expect(call.indexes).toContain('production');
      });

      it('should include content length when provided', () => {
        const mockAnalytics: AnalyticsEngineDataset = {
          writeDataPoint: vi.fn(),
        };

        const tracker = new ResponseTimeTracker(mockAnalytics);
        tracker.track({
          path: '/api/entities',
          method: 'GET',
          statusCode: 200,
          durationMs: 30,
          contentLength: 1024,
        });

        const call = (mockAnalytics.writeDataPoint as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(call.doubles[2]).toBe(1024);
      });

      it('should include Cloudflare edge data when provided', () => {
        const mockAnalytics: AnalyticsEngineDataset = {
          writeDataPoint: vi.fn(),
        };

        const tracker = new ResponseTimeTracker(mockAnalytics);
        tracker.track({
          path: '/api/entities',
          method: 'GET',
          statusCode: 200,
          durationMs: 15,
          colo: 'SFO',
          country: 'US',
        });

        const call = (mockAnalytics.writeDataPoint as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(call.blobs[6]).toBe('SFO');
        expect(call.blobs[7]).toBe('US');
      });

      it('should not write when Analytics Engine is disabled', () => {
        const mockAnalytics: AnalyticsEngineDataset = {
          writeDataPoint: vi.fn(),
        };

        const tracker = new ResponseTimeTracker(mockAnalytics, {
          enableAnalytics: false,
        });
        tracker.track({
          path: '/api/entities',
          method: 'GET',
          statusCode: 200,
          durationMs: 20,
        });

        expect(mockAnalytics.writeDataPoint).not.toHaveBeenCalled();
      });

      it('should not write when Analytics Engine is not provided', () => {
        const tracker = new ResponseTimeTracker(undefined);

        // Should not throw
        expect(() =>
          tracker.track({
            path: '/api/entities',
            method: 'GET',
            statusCode: 200,
            durationMs: 20,
          })
        ).not.toThrow();
      });

      it('should handle Analytics Engine write failures gracefully', () => {
        const mockAnalytics: AnalyticsEngineDataset = {
          writeDataPoint: vi.fn().mockImplementation(() => {
            throw new Error('Analytics failure');
          }),
        };

        const tracker = new ResponseTimeTracker(mockAnalytics);

        // Should not throw
        expect(() =>
          tracker.track({
            path: '/api/entities',
            method: 'GET',
            statusCode: 200,
            durationMs: 20,
          })
        ).not.toThrow();
      });

      it('should respect minimum duration threshold', () => {
        const mockAnalytics: AnalyticsEngineDataset = {
          writeDataPoint: vi.fn(),
        };

        const tracker = new ResponseTimeTracker(mockAnalytics, {
          minDurationMs: 50,
        });

        // Below threshold - should not write
        tracker.track({
          path: '/api/entities',
          method: 'GET',
          statusCode: 200,
          durationMs: 30,
        });
        expect(mockAnalytics.writeDataPoint).not.toHaveBeenCalled();

        // At threshold - should write
        tracker.track({
          path: '/api/entities',
          method: 'GET',
          statusCode: 200,
          durationMs: 50,
        });
        expect(mockAnalytics.writeDataPoint).toHaveBeenCalledTimes(1);
      });

      it('should respect skip paths configuration', () => {
        const mockAnalytics: AnalyticsEngineDataset = {
          writeDataPoint: vi.fn(),
        };

        const tracker = new ResponseTimeTracker(mockAnalytics, {
          skipPaths: ['/health', '/docs'],
        });

        // Skipped path
        tracker.track({
          path: '/health',
          method: 'GET',
          statusCode: 200,
          durationMs: 5,
        });
        expect(mockAnalytics.writeDataPoint).not.toHaveBeenCalled();

        // Skipped path (prefix match)
        tracker.track({
          path: '/docs/openapi.json',
          method: 'GET',
          statusCode: 200,
          durationMs: 10,
        });
        expect(mockAnalytics.writeDataPoint).not.toHaveBeenCalled();

        // Non-skipped path
        tracker.track({
          path: '/api/entities',
          method: 'GET',
          statusCode: 200,
          durationMs: 20,
        });
        expect(mockAnalytics.writeDataPoint).toHaveBeenCalledTimes(1);
      });
    });

    describe('startTimer', () => {
      it('should return a function that calculates duration', async () => {
        const tracker = new ResponseTimeTracker();
        const getElapsed = tracker.startTimer();

        // Wait a bit
        await new Promise(resolve => setTimeout(resolve, 10));

        const duration = getElapsed();
        expect(duration).toBeGreaterThanOrEqual(10);
        expect(typeof duration).toBe('number');
      });

      it('should round duration to integer', async () => {
        const tracker = new ResponseTimeTracker();
        const getElapsed = tracker.startTimer();

        await new Promise(resolve => setTimeout(resolve, 5));

        const duration = getElapsed();
        expect(Number.isInteger(duration)).toBe(true);
      });
    });
  });

  describe('createResponseTimeTracker factory', () => {
    it('should create tracker with default config', () => {
      const tracker = createResponseTimeTracker();

      expect(tracker).toBeInstanceOf(ResponseTimeTracker);
    });

    it('should create tracker with custom config', () => {
      const mockAnalytics: AnalyticsEngineDataset = {
        writeDataPoint: vi.fn(),
      };

      const tracker = createResponseTimeTracker(mockAnalytics, {
        environment: 'test',
        minDurationMs: 100,
        skipPaths: ['/health'],
      });

      // Slow request - should track
      tracker.track({
        path: '/api/entities',
        method: 'GET',
        statusCode: 200,
        durationMs: 150,
      });
      expect(mockAnalytics.writeDataPoint).toHaveBeenCalledTimes(1);

      // Verify environment was passed
      const call = (mockAnalytics.writeDataPoint as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.blobs[0]).toBe('test');
    });
  });
});
