import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as response from '../../src/utils/response.js';

describe('Response Utilities', () => {
  // Mock Date.now to have consistent timestamps in tests
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
  });

  describe('success', () => {
    it('should create a success response with data', () => {
      const data = { id: '123', name: 'Test' };
      const result = response.success(data);

      expect(result).toEqual({
        success: true,
        data,
        timestamp: '2024-01-01T00:00:00.000Z',
      });
    });

    it('should include optional message', () => {
      const data = { id: '123' };
      const message = 'Operation completed';
      const result = response.success(data, message);

      expect(result).toMatchObject({
        success: true,
        data,
        message,
      });
    });

    it('should include optional metadata', () => {
      const data = [1, 2, 3];
      const metadata = { page: 1, total: 10 };
      const result = response.success(data, undefined, metadata);

      expect(result).toMatchObject({
        success: true,
        data,
        metadata,
      });
    });
  });

  describe('error', () => {
    it('should create an error response', () => {
      const result = response.error('Something went wrong', 'ERROR_CODE');

      expect(result).toEqual({
        success: false,
        error: 'Something went wrong',
        code: 'ERROR_CODE',
        timestamp: '2024-01-01T00:00:00.000Z',
      });
    });

    it('should use default error code', () => {
      const result = response.error('Error message');

      expect(result.code).toBe('ERROR');
    });

    it('should include optional details', () => {
      const details = { field: 'email', reason: 'invalid format' };
      const result = response.error('Validation failed', 'VALIDATION', details);

      expect(result.data).toEqual(details);
    });
  });

  describe('paginated', () => {
    it('should create a paginated response', () => {
      const items = [1, 2, 3];
      const result = response.paginated(items, 10, 1, 3, true);

      expect(result).toMatchObject({
        success: true,
        data: items,
        metadata: {
          page: 1,
          pageSize: 3,
          total: 10,
          hasMore: true,
        },
      });
    });
  });

  describe('cursorPaginated', () => {
    it('should create a cursor-based paginated response', () => {
      const items = [{ id: 1 }, { id: 2 }];
      const cursor = 'next-cursor-token';
      const result = response.cursorPaginated(items, cursor, true);

      expect(result).toMatchObject({
        success: true,
        data: items,
        metadata: {
          cursor,
          hasMore: true,
        },
      });
    });

    it('should handle null cursor', () => {
      const items = [{ id: 1 }];
      const result = response.cursorPaginated(items, null, false);

      expect(result.metadata?.cursor).toBeUndefined();
      expect(result.metadata?.hasMore).toBe(false);
    });

    it('should include optional total count', () => {
      const items = [{ id: 1 }];
      const result = response.cursorPaginated(items, null, false, 100);

      expect(result.metadata?.total).toBe(100);
    });
  });

  describe('created', () => {
    it('should create a 201 response', () => {
      const data = { id: '123', name: 'New Resource' };
      const result = response.created(data);

      expect(result).toMatchObject({
        success: true,
        data,
        message: 'Resource created successfully',
      });
    });

    it('should allow custom message', () => {
      const data = { id: '123' };
      const result = response.created(data, 'Entity created');

      expect(result.message).toBe('Entity created');
    });
  });

  describe('updated', () => {
    it('should create a 200 update response', () => {
      const data = { id: '123', name: 'Updated Resource' };
      const result = response.updated(data);

      expect(result).toMatchObject({
        success: true,
        data,
        message: 'Resource updated successfully',
      });
    });
  });

  describe('deleted', () => {
    it('should create a delete response', () => {
      const result = response.deleted();

      expect(result).toMatchObject({
        success: true,
        message: 'Resource deleted successfully',
      });
    });

    it('should allow custom message', () => {
      const result = response.deleted('Entity deleted');

      expect(result.message).toBe('Entity deleted');
    });
  });

  describe('noContent', () => {
    it('should create a 204 response', () => {
      const result = response.noContent();

      expect(result).toEqual({
        success: true,
        timestamp: '2024-01-01T00:00:00.000Z',
      });
    });
  });

  describe('notFound', () => {
    it('should create a 404 response', () => {
      const result = response.notFound('Entity');

      expect(result).toMatchObject({
        success: false,
        error: 'Entity not found',
        code: 'NOT_FOUND',
      });
    });

    it('should use default resource name', () => {
      const result = response.notFound();

      expect(result.error).toBe('Resource not found');
    });
  });

  describe('validationError', () => {
    it('should create a validation error response', () => {
      const details = { field: 'email', message: 'Invalid email' };
      const result = response.validationError(details);

      expect(result).toMatchObject({
        success: false,
        error: 'Validation failed',
        code: 'VALIDATION_ERROR',
        data: details,
      });
    });
  });

  describe('unauthorized', () => {
    it('should create a 401 response', () => {
      const result = response.unauthorized();

      expect(result).toMatchObject({
        success: false,
        error: 'Unauthorized',
        code: 'UNAUTHORIZED',
      });
    });

    it('should allow custom message', () => {
      const result = response.unauthorized('Invalid token');

      expect(result.error).toBe('Invalid token');
    });
  });

  describe('forbidden', () => {
    it('should create a 403 response', () => {
      const result = response.forbidden();

      expect(result).toMatchObject({
        success: false,
        error: 'Forbidden',
        code: 'FORBIDDEN',
      });
    });
  });

  describe('conflict', () => {
    it('should create a 409 response', () => {
      const result = response.conflict('Resource already exists');

      expect(result).toMatchObject({
        success: false,
        error: 'Resource already exists',
        code: 'CONFLICT',
      });
    });
  });

  describe('internalError', () => {
    it('should create a 500 response', () => {
      const result = response.internalError();

      expect(result).toMatchObject({
        success: false,
        error: 'Internal server error',
        code: 'INTERNAL_SERVER_ERROR',
      });
    });

    it('should allow custom message', () => {
      const result = response.internalError('Database connection failed');

      expect(result.error).toBe('Database connection failed');
    });
  });

  describe('badRequest', () => {
    it('should create a 400 response', () => {
      const result = response.badRequest('Invalid input');

      expect(result).toMatchObject({
        success: false,
        error: 'Invalid input',
        code: 'BAD_REQUEST',
      });
    });
  });
});
