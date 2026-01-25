import { describe, it, expect } from 'vitest';
import {
  escapeHtml,
  containsDangerousContent,
  sanitizeValue,
  sanitizeProperties,
  validateAndSanitize,
  stripHtmlTags,
  sanitizeUrl,
} from '../../src/utils/sanitize.js';

describe('sanitize utilities', () => {
  describe('escapeHtml', () => {
    it('should escape HTML special characters', () => {
      expect(escapeHtml('<script>alert("xss")</script>')).toBe(
        '&lt;script&gt;alert(&quot;xss&quot;)&lt;&#x2F;script&gt;'
      );
    });

    it('should escape ampersands', () => {
      expect(escapeHtml('Tom & Jerry')).toBe('Tom &amp; Jerry');
    });

    it('should escape quotes', () => {
      expect(escapeHtml('He said "Hello"')).toBe('He said &quot;Hello&quot;');
      expect(escapeHtml("It's fine")).toBe('It&#x27;s fine');
    });

    it('should escape backticks and equals', () => {
      expect(escapeHtml('`code`')).toBe('&#x60;code&#x60;');
      expect(escapeHtml('a=b')).toBe('a&#x3D;b');
    });

    it('should handle empty strings', () => {
      expect(escapeHtml('')).toBe('');
    });

    it('should return non-strings unchanged', () => {
      expect(escapeHtml(null as unknown as string)).toBe(null);
      expect(escapeHtml(undefined as unknown as string)).toBe(undefined);
      expect(escapeHtml(123 as unknown as string)).toBe(123);
    });

    it('should handle strings without special characters', () => {
      expect(escapeHtml('Hello World')).toBe('Hello World');
    });

    it('should escape forward slashes', () => {
      expect(escapeHtml('</script>')).toBe('&lt;&#x2F;script&gt;');
    });
  });

  describe('containsDangerousContent', () => {
    it('should detect script tags', () => {
      expect(containsDangerousContent('<script>alert(1)</script>')).toBe(true);
      expect(containsDangerousContent('<SCRIPT>alert(1)</SCRIPT>')).toBe(true);
    });

    it('should detect javascript: protocol', () => {
      expect(containsDangerousContent('javascript:alert(1)')).toBe(true);
      expect(containsDangerousContent('JAVASCRIPT:alert(1)')).toBe(true);
    });

    it('should detect event handlers', () => {
      expect(containsDangerousContent('<img onerror=alert(1)>')).toBe(true);
      expect(containsDangerousContent('<div onclick=alert(1)>')).toBe(true);
      expect(containsDangerousContent('onmouseover=alert(1)')).toBe(true);
    });

    it('should detect iframe tags', () => {
      expect(containsDangerousContent('<iframe src="evil.com"></iframe>')).toBe(true);
    });

    it('should detect object and embed tags', () => {
      expect(containsDangerousContent('<object data="evil.swf">')).toBe(true);
      expect(containsDangerousContent('<embed src="evil.swf">')).toBe(true);
    });

    it('should detect style tags', () => {
      expect(containsDangerousContent('<style>body{background:url(evil)}</style>')).toBe(true);
    });

    it('should detect CSS expressions', () => {
      expect(containsDangerousContent('expression(alert(1))')).toBe(true);
    });

    it('should detect data URLs in CSS', () => {
      expect(containsDangerousContent('url("data:text/html,<script>alert(1)</script>")')).toBe(true);
    });

    it('should detect vbscript protocol', () => {
      expect(containsDangerousContent('vbscript:msgbox(1)')).toBe(true);
    });

    it('should return false for safe content', () => {
      expect(containsDangerousContent('Hello World')).toBe(false);
      expect(containsDangerousContent('This is a <b>bold</b> statement')).toBe(false);
      expect(containsDangerousContent('Contact us at email@example.com')).toBe(false);
    });

    it('should return false for non-strings', () => {
      expect(containsDangerousContent(null as unknown as string)).toBe(false);
      expect(containsDangerousContent(undefined as unknown as string)).toBe(false);
      expect(containsDangerousContent(123 as unknown as string)).toBe(false);
    });
  });

  describe('sanitizeValue', () => {
    it('should sanitize strings', () => {
      expect(sanitizeValue('<script>xss</script>')).toBe(
        '&lt;script&gt;xss&lt;&#x2F;script&gt;'
      );
    });

    it('should handle null and undefined', () => {
      expect(sanitizeValue(null)).toBe(null);
      expect(sanitizeValue(undefined)).toBe(undefined);
    });

    it('should preserve numbers and booleans', () => {
      expect(sanitizeValue(42)).toBe(42);
      expect(sanitizeValue(true)).toBe(true);
      expect(sanitizeValue(false)).toBe(false);
    });

    it('should sanitize arrays recursively', () => {
      const input = ['<script>', 'safe', '<img onerror=x>'];
      const output = sanitizeValue(input);
      expect(output).toEqual([
        '&lt;script&gt;',
        'safe',
        '&lt;img onerror&#x3D;x&gt;',
      ]);
    });

    it('should sanitize objects recursively', () => {
      const input = {
        name: '<b>John</b>',
        nested: {
          value: '<script>alert(1)</script>',
        },
      };
      const output = sanitizeValue(input);
      expect(output).toEqual({
        name: '&lt;b&gt;John&lt;&#x2F;b&gt;',
        nested: {
          value: '&lt;script&gt;alert(1)&lt;&#x2F;script&gt;',
        },
      });
    });

    it('should sanitize object keys', () => {
      const input = {
        '<script>': 'value',
      };
      const output = sanitizeValue(input);
      expect(output).toEqual({
        '&lt;script&gt;': 'value',
      });
    });

    it('should handle mixed arrays', () => {
      const input = ['text', 123, true, null, { key: '<div>' }];
      const output = sanitizeValue(input);
      expect(output).toEqual([
        'text',
        123,
        true,
        null,
        { key: '&lt;div&gt;' },
      ]);
    });
  });

  describe('sanitizeProperties', () => {
    it('should sanitize all string properties', () => {
      const input = {
        title: '<h1>Test</h1>',
        description: 'Normal text',
        count: 42,
      };
      const output = sanitizeProperties(input);
      expect(output).toEqual({
        title: '&lt;h1&gt;Test&lt;&#x2F;h1&gt;',
        description: 'Normal text',
        count: 42,
      });
    });

    it('should handle empty objects', () => {
      expect(sanitizeProperties({})).toEqual({});
    });

    it('should handle null/undefined input', () => {
      expect(sanitizeProperties(null as unknown as Record<string, unknown>)).toEqual({});
      expect(sanitizeProperties(undefined as unknown as Record<string, unknown>)).toEqual({});
    });
  });

  describe('validateAndSanitize', () => {
    it('should sanitize content and detect dangerous fields', () => {
      const input = {
        safe: 'Hello World',
        dangerous: '<script>alert(1)</script>',
      };
      const result = validateAndSanitize(input);

      expect(result.hadDangerousContent).toBe(true);
      expect(result.dangerousFields).toContain('dangerous');
      expect((result.sanitized as Record<string, unknown>).dangerous).toBe(
        '&lt;script&gt;alert(1)&lt;&#x2F;script&gt;'
      );
    });

    it('should report no dangerous content for safe input', () => {
      const input = {
        name: 'John Doe',
        age: 30,
      };
      const result = validateAndSanitize(input);

      expect(result.hadDangerousContent).toBe(false);
      expect(result.dangerousFields).toHaveLength(0);
    });

    it('should detect dangerous content in nested objects', () => {
      const input = {
        user: {
          bio: '<script>hack()</script>',
        },
      };
      const result = validateAndSanitize(input);

      expect(result.hadDangerousContent).toBe(true);
      expect(result.dangerousFields).toContain('user.bio');
    });

    it('should detect dangerous content in arrays', () => {
      const input = {
        tags: ['safe', '<script>xss</script>', 'also safe'],
      };
      const result = validateAndSanitize(input);

      expect(result.hadDangerousContent).toBe(true);
      expect(result.dangerousFields).toContain('tags[1]');
    });
  });

  describe('stripHtmlTags', () => {
    it('should remove all HTML tags', () => {
      expect(stripHtmlTags('<p>Hello <b>World</b></p>')).toBe('Hello World');
    });

    it('should handle self-closing tags', () => {
      expect(stripHtmlTags('Line1<br/>Line2')).toBe('Line1Line2');
    });

    it('should handle empty strings', () => {
      expect(stripHtmlTags('')).toBe('');
    });

    it('should return non-strings unchanged', () => {
      expect(stripHtmlTags(null as unknown as string)).toBe(null);
      expect(stripHtmlTags(123 as unknown as string)).toBe(123);
    });

    it('should handle strings without tags', () => {
      expect(stripHtmlTags('Plain text')).toBe('Plain text');
    });
  });

  describe('sanitizeUrl', () => {
    it('should allow http URLs', () => {
      expect(sanitizeUrl('http://example.com')).toBe('http://example.com');
    });

    it('should allow https URLs', () => {
      expect(sanitizeUrl('https://example.com/path?query=1')).toBe(
        'https://example.com/path?query=1'
      );
    });

    it('should allow mailto URLs', () => {
      expect(sanitizeUrl('mailto:user@example.com')).toBe('mailto:user@example.com');
    });

    it('should allow tel URLs', () => {
      expect(sanitizeUrl('tel:+1234567890')).toBe('tel:+1234567890');
    });

    it('should allow ftp URLs', () => {
      expect(sanitizeUrl('ftp://files.example.com')).toBe('ftp://files.example.com');
    });

    it('should allow relative URLs', () => {
      expect(sanitizeUrl('/path/to/resource')).toBe('/path/to/resource');
      expect(sanitizeUrl('path/to/resource')).toBe('path/to/resource');
    });

    it('should block javascript: URLs', () => {
      expect(sanitizeUrl('javascript:alert(1)')).toBe('');
      expect(sanitizeUrl('JAVASCRIPT:alert(1)')).toBe('');
      expect(sanitizeUrl('  javascript:alert(1)')).toBe('');
    });

    it('should block vbscript: URLs', () => {
      expect(sanitizeUrl('vbscript:msgbox(1)')).toBe('');
    });

    it('should block data: text/html URLs', () => {
      expect(sanitizeUrl('data:text/html,<script>alert(1)</script>')).toBe('');
    });

    it('should block data: application/javascript URLs', () => {
      expect(sanitizeUrl('data:application/javascript,alert(1)')).toBe('');
    });

    it('should block unknown protocols', () => {
      expect(sanitizeUrl('custom:protocol')).toBe('');
    });

    it('should handle empty strings', () => {
      expect(sanitizeUrl('')).toBe('');
    });

    it('should handle non-strings', () => {
      expect(sanitizeUrl(null as unknown as string)).toBe('');
      expect(sanitizeUrl(undefined as unknown as string)).toBe('');
      expect(sanitizeUrl(123 as unknown as string)).toBe('');
    });
  });
});
