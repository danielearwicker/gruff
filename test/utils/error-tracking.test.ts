import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ErrorTracker,
  createErrorTracker,
  categorizeError,
  ErrorCategory,
  ErrorSeverity,
  AnalyticsEngineDataset,
} from '../../src/utils/error-tracking.js';

describe('Error Tracking', () => {
  // Mock console methods
  let consoleInfoSpy: any;
  let consoleWarnSpy: any;
  let consoleErrorSpy: any;

  beforeEach(() => {
    consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Mock Date to have consistent timestamps
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('categorizeError', () => {
    it('should categorize validation errors (400)', () => {
      const result = categorizeError(new Error('Validation failed'), 400);
      expect(result.category).toBe(ErrorCategory.VALIDATION);
      expect(result.severity).toBe(ErrorSeverity.LOW);
    });

    it('should categorize ZodError by name', () => {
      const zodError = new Error('Invalid input');
      (zodError as any).name = 'ZodError';
      const result = categorizeError(zodError);
      expect(result.category).toBe(ErrorCategory.VALIDATION);
    });

    it('should categorize authentication errors (401)', () => {
      const result = categorizeError(new Error('Unauthorized'), 401);
      expect(result.category).toBe(ErrorCategory.AUTHENTICATION);
      expect(result.severity).toBe(ErrorSeverity.MEDIUM);
    });

    it('should categorize authentication errors by message', () => {
      const result = categorizeError(new Error('Invalid token'));
      expect(result.category).toBe(ErrorCategory.AUTHENTICATION);
    });

    it('should categorize authorization errors (403)', () => {
      const result = categorizeError(new Error('Forbidden'), 403);
      expect(result.category).toBe(ErrorCategory.AUTHORIZATION);
      expect(result.severity).toBe(ErrorSeverity.MEDIUM);
    });

    it('should categorize not found errors (404)', () => {
      const result = categorizeError(new Error('Not found'), 404);
      expect(result.category).toBe(ErrorCategory.NOT_FOUND);
      expect(result.severity).toBe(ErrorSeverity.LOW);
    });

    it('should categorize rate limit errors (429)', () => {
      const result = categorizeError(new Error('Too many requests'), 429);
      expect(result.category).toBe(ErrorCategory.RATE_LIMIT);
      expect(result.severity).toBe(ErrorSeverity.LOW);
    });

    it('should categorize database errors', () => {
      const result = categorizeError(new Error('D1_ERROR: Database error'));
      expect(result.category).toBe(ErrorCategory.DATABASE);
      expect(result.severity).toBe(ErrorSeverity.HIGH);
    });

    it('should categorize external service errors', () => {
      const result = categorizeError(new Error('Network timeout'));
      expect(result.category).toBe(ErrorCategory.EXTERNAL);
      expect(result.severity).toBe(ErrorSeverity.MEDIUM);
    });

    it('should categorize internal errors (500+)', () => {
      const result = categorizeError(new Error('Something went wrong'), 500);
      expect(result.category).toBe(ErrorCategory.INTERNAL);
      expect(result.severity).toBe(ErrorSeverity.HIGH);
    });

    it('should categorize unknown errors', () => {
      const result = categorizeError(new Error('Unknown issue'));
      expect(result.category).toBe(ErrorCategory.UNKNOWN);
      expect(result.severity).toBe(ErrorSeverity.MEDIUM);
    });

    it('should handle non-Error objects', () => {
      const result = categorizeError('string error', 500);
      expect(result.category).toBe(ErrorCategory.INTERNAL);
    });
  });

  describe('ErrorTracker', () => {
    describe('track', () => {
      it('should track errors and return tracked error object', () => {
        const tracker = new ErrorTracker();
        const error = new Error('Test error');

        const tracked = tracker.track(error, { requestId: 'req-123' }, 500);

        expect(tracked.name).toBe('Error');
        expect(tracked.message).toBe('Test error');
        expect(tracked.category).toBe(ErrorCategory.INTERNAL);
        expect(tracked.severity).toBe(ErrorSeverity.HIGH);
        expect(tracked.context.requestId).toBe('req-123');
        expect(tracked.context.statusCode).toBe(500);
        expect(tracked.timestamp).toBe('2024-01-01T00:00:00.000Z');
      });

      it('should include stack trace for Error objects', () => {
        const tracker = new ErrorTracker();
        const error = new Error('Test error');

        const tracked = tracker.track(error);

        expect(tracked.stack).toBeDefined();
        expect(tracked.stack).toContain('Error');
      });

      it('should include error code if present', () => {
        const tracker = new ErrorTracker();
        const error = new Error('Custom error');
        (error as any).code = 'CUSTOM_ERROR';

        const tracked = tracker.track(error);

        expect(tracked.code).toBe('CUSTOM_ERROR');
      });

      it('should log errors at appropriate level based on severity', () => {
        const tracker = new ErrorTracker();

        // High severity - should use error()
        tracker.track(new Error('Database failed'), {}, 500);
        expect(consoleErrorSpy).toHaveBeenCalled();

        // Medium severity - should use warn()
        tracker.track(new Error('Unauthorized'), {}, 401);
        expect(consoleWarnSpy).toHaveBeenCalled();

        // Low severity - should use info()
        tracker.track(new Error('Not found'), {}, 404);
        expect(consoleInfoSpy).toHaveBeenCalled();
      });

      it('should handle non-Error objects', () => {
        const tracker = new ErrorTracker();

        const tracked = tracker.track('string error', {}, 500);

        expect(tracked.name).toBe('Error');
        expect(tracked.message).toBe('string error');
        expect(tracked.stack).toBeUndefined();
      });

      it('should merge context with status code', () => {
        const tracker = new ErrorTracker();

        const tracked = tracker.track(new Error('Test'), {
          requestId: 'req-123',
          userId: 'user-456',
        }, 404);

        expect(tracked.context).toMatchObject({
          requestId: 'req-123',
          userId: 'user-456',
          statusCode: 404,
        });
      });

      it('should use status code from context if not provided as parameter', () => {
        const tracker = new ErrorTracker();

        const tracked = tracker.track(new Error('Test'), {
          statusCode: 503,
        });

        expect(tracked.context.statusCode).toBe(503);
      });
    });

    describe('convenience methods', () => {
      it('should track validation errors with trackValidation', () => {
        const tracker = new ErrorTracker();

        const tracked = tracker.trackValidation(new Error('Invalid input'));

        expect(tracked.context.statusCode).toBe(400);
        expect(tracked.category).toBe(ErrorCategory.VALIDATION);
      });

      it('should track auth errors with trackAuth', () => {
        const tracker = new ErrorTracker();

        const tracked = tracker.trackAuth(new Error('Invalid credentials'));

        expect(tracked.context.statusCode).toBe(401);
        expect(tracked.category).toBe(ErrorCategory.AUTHENTICATION);
      });

      it('should track database errors with trackDatabase', () => {
        const tracker = new ErrorTracker();

        const tracked = tracker.trackDatabase(new Error('Connection failed'));

        expect(tracked.severity).toBe(ErrorSeverity.HIGH);
        expect(tracked.category).toBe(ErrorCategory.DATABASE);
      });
    });

    describe('Analytics Engine integration', () => {
      it('should write to Analytics Engine when available', () => {
        const mockAnalytics: AnalyticsEngineDataset = {
          writeDataPoint: vi.fn(),
        };

        const tracker = new ErrorTracker(mockAnalytics);
        tracker.track(new Error('Test error'), { requestId: 'req-123' }, 500);

        expect(mockAnalytics.writeDataPoint).toHaveBeenCalledTimes(1);
        const call = (mockAnalytics.writeDataPoint as any).mock.calls[0][0];
        expect(call.blobs).toContain('Error');
        expect(call.blobs).toContain('internal');
        expect(call.blobs).toContain('high');
        expect(call.doubles).toContain(500);
      });

      it('should include environment in index for partitioning', () => {
        const mockAnalytics: AnalyticsEngineDataset = {
          writeDataPoint: vi.fn(),
        };

        const tracker = new ErrorTracker(mockAnalytics, { environment: 'production' });
        tracker.track(new Error('Test error'));

        const call = (mockAnalytics.writeDataPoint as any).mock.calls[0][0];
        expect(call.indexes).toContain('production');
      });

      it('should handle Analytics Engine write failures gracefully', () => {
        const mockAnalytics: AnalyticsEngineDataset = {
          writeDataPoint: vi.fn().mockImplementation(() => {
            throw new Error('Analytics failure');
          }),
        };

        const tracker = new ErrorTracker(mockAnalytics);

        // Should not throw
        expect(() => tracker.track(new Error('Test error'))).not.toThrow();

        // Should log a warning
        expect(consoleWarnSpy).toHaveBeenCalled();
      });

      it('should not write to Analytics Engine when disabled', () => {
        const mockAnalytics: AnalyticsEngineDataset = {
          writeDataPoint: vi.fn(),
        };

        const tracker = new ErrorTracker(mockAnalytics, { enableAnalytics: false });
        tracker.track(new Error('Test error'));

        expect(mockAnalytics.writeDataPoint).not.toHaveBeenCalled();
      });

      it('should not write when Analytics Engine is not provided', () => {
        const tracker = new ErrorTracker(undefined);

        // Should not throw when no analytics engine
        expect(() => tracker.track(new Error('Test error'))).not.toThrow();
      });
    });

    describe('severity threshold', () => {
      it('should respect minimum severity threshold for tracking', () => {
        const mockAnalytics: AnalyticsEngineDataset = {
          writeDataPoint: vi.fn(),
        };

        const tracker = new ErrorTracker(mockAnalytics, {
          minSeverity: ErrorSeverity.HIGH,
        });

        // Low severity - should not write
        tracker.track(new Error('Not found'), {}, 404);
        expect(mockAnalytics.writeDataPoint).not.toHaveBeenCalled();

        // High severity - should write
        tracker.track(new Error('Server error'), {}, 500);
        expect(mockAnalytics.writeDataPoint).toHaveBeenCalledTimes(1);
      });

      it('should still log errors below severity threshold', () => {
        const tracker = new ErrorTracker(undefined, {
          minSeverity: ErrorSeverity.CRITICAL,
        });

        tracker.track(new Error('Not found'), {}, 404);

        // Should still log even if not tracking to analytics
        expect(consoleInfoSpy).toHaveBeenCalled();
      });
    });

    describe('custom categorizer', () => {
      it('should use custom categorizer when provided', () => {
        const customCategorizer = () => ({
          category: ErrorCategory.EXTERNAL,
          severity: ErrorSeverity.CRITICAL,
        });

        const tracker = new ErrorTracker(undefined, {
          categorizer: customCategorizer,
        });

        const tracked = tracker.track(new Error('Test'));

        expect(tracked.category).toBe(ErrorCategory.EXTERNAL);
        expect(tracked.severity).toBe(ErrorSeverity.CRITICAL);
      });
    });

    describe('sensitive data handling', () => {
      it('should redact sensitive data from error messages', () => {
        const tracker = new ErrorTracker();

        const tracked = tracker.track(
          new Error('Password: secret123 failed')
        );

        expect(tracked.message).not.toContain('secret123');
        expect(tracked.message).toContain('[REDACTED]');
      });

      it('should redact sensitive data from stack traces', () => {
        const tracker = new ErrorTracker();
        const error = new Error('Error with token: abc123xyz');
        error.stack = 'Error: token=secret at file.js:10';

        const tracked = tracker.track(error);

        expect(tracked.stack).not.toContain('secret');
      });
    });
  });

  describe('createErrorTracker factory', () => {
    it('should create tracker with default config', () => {
      const tracker = createErrorTracker();

      expect(tracker).toBeInstanceOf(ErrorTracker);
    });

    it('should create tracker with custom config', () => {
      const mockAnalytics: AnalyticsEngineDataset = {
        writeDataPoint: vi.fn(),
      };

      const tracker = createErrorTracker(mockAnalytics, {
        environment: 'test',
        minSeverity: ErrorSeverity.HIGH,
      });

      tracker.track(new Error('High severity'), {}, 500);
      tracker.track(new Error('Low severity'), {}, 404);

      // Only high severity should be tracked
      expect(mockAnalytics.writeDataPoint).toHaveBeenCalledTimes(1);
    });
  });
});
