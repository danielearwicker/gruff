import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger, LogLevel, createLogger } from '../../src/utils/logger.js';

describe('Logger', () => {
  // Mock console methods
  let consoleDebugSpy: any;
  let consoleInfoSpy: any;
  let consoleWarnSpy: any;
  let consoleErrorSpy: any;

  beforeEach(() => {
    consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
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

  describe('Basic logging', () => {
    it('should log debug messages', () => {
      const logger = new Logger({}, LogLevel.DEBUG);
      logger.debug('Debug message');

      expect(consoleDebugSpy).toHaveBeenCalledOnce();
      const logEntry = JSON.parse(consoleDebugSpy.mock.calls[0][0]);
      expect(logEntry).toMatchObject({
        level: 'debug',
        message: 'Debug message',
        timestamp: '2024-01-01T00:00:00.000Z',
      });
    });

    it('should log info messages', () => {
      const logger = new Logger();
      logger.info('Info message');

      expect(consoleInfoSpy).toHaveBeenCalledOnce();
      const logEntry = JSON.parse(consoleInfoSpy.mock.calls[0][0]);
      expect(logEntry).toMatchObject({
        level: 'info',
        message: 'Info message',
      });
    });

    it('should log warn messages', () => {
      const logger = new Logger();
      logger.warn('Warning message');

      expect(consoleWarnSpy).toHaveBeenCalledOnce();
      const logEntry = JSON.parse(consoleWarnSpy.mock.calls[0][0]);
      expect(logEntry).toMatchObject({
        level: 'warn',
        message: 'Warning message',
      });
    });

    it('should log error messages', () => {
      const logger = new Logger();
      logger.error('Error message');

      expect(consoleErrorSpy).toHaveBeenCalledOnce();
      const logEntry = JSON.parse(consoleErrorSpy.mock.calls[0][0]);
      expect(logEntry).toMatchObject({
        level: 'error',
        message: 'Error message',
      });
    });
  });

  describe('Log level filtering', () => {
    it('should respect minimum log level', () => {
      const logger = new Logger({}, LogLevel.WARN);

      logger.debug('Debug message');
      logger.info('Info message');
      logger.warn('Warning message');
      logger.error('Error message');

      expect(consoleDebugSpy).not.toHaveBeenCalled();
      expect(consoleInfoSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).toHaveBeenCalledOnce();
      expect(consoleErrorSpy).toHaveBeenCalledOnce();
    });

    it('should allow changing minimum log level', () => {
      const logger = new Logger({}, LogLevel.ERROR);

      logger.info('Info message');
      expect(consoleInfoSpy).not.toHaveBeenCalled();

      logger.setMinLevel(LogLevel.INFO);
      logger.info('Info message 2');
      expect(consoleInfoSpy).toHaveBeenCalledOnce();
    });

    it('should default to INFO level', () => {
      const logger = new Logger();

      logger.debug('Debug message');
      logger.info('Info message');

      expect(consoleDebugSpy).not.toHaveBeenCalled();
      expect(consoleInfoSpy).toHaveBeenCalledOnce();
    });
  });

  describe('Context handling', () => {
    it('should include context in log entries', () => {
      const logger = new Logger({ requestId: 'req-123', userId: 'user-456' });
      logger.info('Message with context');

      const logEntry = JSON.parse(consoleInfoSpy.mock.calls[0][0]);
      expect(logEntry.context).toEqual({
        requestId: 'req-123',
        userId: 'user-456',
      });
    });

    it('should merge context from log call with logger context', () => {
      const logger = new Logger({ requestId: 'req-123' });
      logger.info('Message', { operation: 'create' });

      const logEntry = JSON.parse(consoleInfoSpy.mock.calls[0][0]);
      expect(logEntry.context).toEqual({
        requestId: 'req-123',
        operation: 'create',
      });
    });

    it('should allow call context to override logger context', () => {
      const logger = new Logger({ requestId: 'req-123', env: 'dev' });
      logger.info('Message', { env: 'prod' });

      const logEntry = JSON.parse(consoleInfoSpy.mock.calls[0][0]);
      expect(logEntry.context.env).toBe('prod');
    });
  });

  describe('Child loggers', () => {
    it('should create child logger with merged context', () => {
      const parentLogger = new Logger({ requestId: 'req-123' });
      const childLogger = parentLogger.child({ userId: 'user-456' });

      childLogger.info('Child message');

      const logEntry = JSON.parse(consoleInfoSpy.mock.calls[0][0]);
      expect(logEntry.context).toEqual({
        requestId: 'req-123',
        userId: 'user-456',
      });
    });

    it('should inherit minimum log level', () => {
      const parentLogger = new Logger({}, LogLevel.WARN);
      const childLogger = parentLogger.child({ module: 'auth' });

      childLogger.info('Info message');
      childLogger.warn('Warning message');

      expect(consoleInfoSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).toHaveBeenCalledOnce();
    });

    it('should not modify parent logger context', () => {
      const parentLogger = new Logger({ requestId: 'req-123' });
      const childLogger = parentLogger.child({ userId: 'user-456' });

      parentLogger.info('Parent message');
      childLogger.info('Child message');

      const parentLog = JSON.parse(consoleInfoSpy.mock.calls[0][0]);
      const childLog = JSON.parse(consoleInfoSpy.mock.calls[1][0]);

      expect(parentLog.context).toEqual({ requestId: 'req-123' });
      expect(childLog.context).toEqual({ requestId: 'req-123', userId: 'user-456' });
    });
  });

  describe('Error handling', () => {
    it('should serialize Error objects', () => {
      const logger = new Logger();
      const error = new Error('Test error');

      logger.error('Error occurred', error);

      const logEntry = JSON.parse(consoleErrorSpy.mock.calls[0][0]);
      expect(logEntry.error).toMatchObject({
        name: 'Error',
        message: 'Test error',
      });
      expect(logEntry.error.stack).toBeDefined();
    });

    it('should handle custom Error types', () => {
      const logger = new Logger();

      class CustomError extends Error {
        constructor(message: string) {
          super(message);
          this.name = 'CustomError';
        }
      }

      const error = new CustomError('Custom error message');
      logger.error('Custom error occurred', error);

      const logEntry = JSON.parse(consoleErrorSpy.mock.calls[0][0]);
      expect(logEntry.error).toMatchObject({
        name: 'CustomError',
        message: 'Custom error message',
      });
    });

    it('should handle non-Error objects', () => {
      const logger = new Logger();
      logger.error('Error occurred', 'Simple string error');

      const logEntry = JSON.parse(consoleErrorSpy.mock.calls[0][0]);
      expect(logEntry.error).toMatchObject({
        name: 'Unknown',
        message: 'Simple string error',
      });
    });

    it('should handle errors with additional context', () => {
      const logger = new Logger();
      const error = new Error('Test error');

      logger.error('Error occurred', error, { operation: 'database-query' });

      const logEntry = JSON.parse(consoleErrorSpy.mock.calls[0][0]);
      expect(logEntry.context).toEqual({ operation: 'database-query' });
      expect(logEntry.error).toBeDefined();
    });

    it('should handle error logging without Error object', () => {
      const logger = new Logger();
      logger.error('Simple error message');

      const logEntry = JSON.parse(consoleErrorSpy.mock.calls[0][0]);
      expect(logEntry.message).toBe('Simple error message');
      expect(logEntry.error).toBeUndefined();
    });
  });

  describe('createLogger factory', () => {
    it('should create logger with context', () => {
      const logger = createLogger({ service: 'api' });
      logger.info('Factory created logger');

      const logEntry = JSON.parse(consoleInfoSpy.mock.calls[0][0]);
      expect(logEntry.context).toEqual({ service: 'api' });
    });

    it('should create logger with custom min level', () => {
      const logger = createLogger({ service: 'api' }, LogLevel.DEBUG);
      logger.debug('Debug message');

      expect(consoleDebugSpy).toHaveBeenCalledOnce();
    });
  });

  describe('JSON structure', () => {
    it('should produce valid JSON output', () => {
      const logger = new Logger({ requestId: 'req-123' });
      logger.info('Test message', { extra: 'data' });

      const output = consoleInfoSpy.mock.calls[0][0];
      expect(() => JSON.parse(output)).not.toThrow();
    });

    it('should include all required fields', () => {
      const logger = new Logger();
      logger.info('Test message');

      const logEntry = JSON.parse(consoleInfoSpy.mock.calls[0][0]);
      expect(logEntry).toHaveProperty('timestamp');
      expect(logEntry).toHaveProperty('level');
      expect(logEntry).toHaveProperty('message');
      expect(logEntry).toHaveProperty('context');
    });
  });
});
