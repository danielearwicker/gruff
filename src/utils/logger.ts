/**
 * Structured logging utility for Cloudflare Workers
 * Provides consistent JSON-formatted logs with timestamps, levels, and context
 *
 * SECURITY: Automatic redaction of sensitive data (passwords, tokens, etc.)
 * is enabled by default to prevent accidental exposure in logs.
 */

import { redactSensitiveData, safeLogContext } from './sensitive-data.js';

export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
}

export interface LogContext {
  requestId?: string;
  userId?: string;
  [key: string]: unknown;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: LogContext;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

export interface LoggerOptions {
  /**
   * Enable automatic redaction of sensitive data in log context
   * Default: true
   */
  redactSensitiveData?: boolean;
}

export class Logger {
  private context: LogContext;
  private minLevel: LogLevel;
  private options: Required<LoggerOptions>;

  constructor(
    context: LogContext = {},
    minLevel: LogLevel = LogLevel.INFO,
    options: LoggerOptions = {}
  ) {
    this.context = context;
    this.minLevel = minLevel;
    this.options = {
      redactSensitiveData: options.redactSensitiveData ?? true, // Secure by default
    };
  }

  /**
   * Create a child logger with additional context
   * Inherits redaction settings from parent
   */
  child(additionalContext: LogContext): Logger {
    return new Logger({ ...this.context, ...additionalContext }, this.minLevel, this.options);
  }

  /**
   * Log a debug message
   */
  debug(message: string, context?: LogContext): void {
    this.log(LogLevel.DEBUG, message, context);
  }

  /**
   * Log an info message
   */
  info(message: string, context?: LogContext): void {
    this.log(LogLevel.INFO, message, context);
  }

  /**
   * Log a warning message
   */
  warn(message: string, context?: LogContext): void {
    this.log(LogLevel.WARN, message, context);
  }

  /**
   * Log an error message
   */
  error(message: string, error?: Error | unknown, context?: LogContext): void {
    const errorInfo = this.serializeError(error);
    this.log(LogLevel.ERROR, message, context, errorInfo);
  }

  /**
   * Core logging method
   *
   * SECURITY: Automatically redacts sensitive data from context if enabled.
   * This prevents accidental logging of passwords, tokens, and other secrets.
   */
  private log(
    level: LogLevel,
    message: string,
    context?: LogContext,
    error?: LogEntry['error']
  ): void {
    // Check if this log level should be output
    if (!this.shouldLog(level)) {
      return;
    }

    // Merge contexts
    let mergedContext = { ...this.context, ...context };

    // Apply sensitive data redaction if enabled
    if (this.options.redactSensitiveData) {
      mergedContext = safeLogContext(mergedContext);
    }

    const logEntry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context: mergedContext,
    };

    if (error) {
      // Redact any sensitive data that might appear in error messages
      if (this.options.redactSensitiveData && error.message) {
        logEntry.error = {
          ...error,
          message: redactSensitiveData(error.message),
        };
      } else {
        logEntry.error = error;
      }
    }

    // Output to console based on level
    const output = JSON.stringify(logEntry);
    switch (level) {
      case LogLevel.DEBUG:
        console.debug(output);
        break;
      case LogLevel.INFO:
        console.info(output);
        break;
      case LogLevel.WARN:
        console.warn(output);
        break;
      case LogLevel.ERROR:
        console.error(output);
        break;
    }
  }

  /**
   * Check if a log level should be output based on minimum level
   */
  private shouldLog(level: LogLevel): boolean {
    const levels = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR];
    const currentIndex = levels.indexOf(level);
    const minIndex = levels.indexOf(this.minLevel);
    return currentIndex >= minIndex;
  }

  /**
   * Serialize an error object for logging
   */
  private serializeError(error: Error | unknown): LogEntry['error'] | undefined {
    if (!error) {
      return undefined;
    }

    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    }

    // Handle non-Error objects
    return {
      name: 'Unknown',
      message: String(error),
    };
  }

  /**
   * Set the minimum log level
   */
  setMinLevel(level: LogLevel): void {
    this.minLevel = level;
  }
}

/**
 * Default logger instance with sensitive data redaction enabled
 */
export const logger = new Logger();

/**
 * Create a logger with specific context
 *
 * @param context - Initial context for all log entries
 * @param minLevel - Minimum log level to output
 * @param options - Logger options (e.g., redaction settings)
 */
export function createLogger(
  context: LogContext,
  minLevel?: LogLevel,
  options?: LoggerOptions
): Logger {
  return new Logger(context, minLevel, options);
}

/**
 * Create a logger with sensitive data redaction disabled
 * Use with caution - only for debugging when you need to see actual values
 *
 * WARNING: Never use in production with real user data
 */
export function createUnsafeLogger(context: LogContext, minLevel?: LogLevel): Logger {
  return new Logger(context, minLevel, { redactSensitiveData: false });
}
