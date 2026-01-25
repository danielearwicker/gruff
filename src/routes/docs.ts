import { Hono } from 'hono';
import { apiReference } from '@scalar/hono-api-reference';
import { generateOpenApiSpec } from '../openapi/index.js';

const docs = new Hono();

// Serve the OpenAPI spec as JSON
docs.get('/openapi.json', c => {
  const spec = generateOpenApiSpec();
  return c.json(spec);
});

// Serve the OpenAPI spec as YAML (for compatibility)
docs.get('/openapi.yaml', () => {
  const spec = generateOpenApiSpec();
  // Simple JSON to YAML conversion for the spec
  const yamlContent = jsonToYaml(spec);
  return new Response(yamlContent, {
    headers: {
      'Content-Type': 'text/yaml',
    },
  });
});

// Serve the interactive API documentation using Scalar
docs.get(
  '/',
  apiReference({
    spec: {
      url: '/docs/openapi.json',
    },
  } as Parameters<typeof apiReference>[0])
);

// Simple JSON to YAML converter (basic implementation)
function jsonToYaml(obj: unknown, indent = 0): string {
  const spaces = '  '.repeat(indent);
  let yaml = '';

  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (typeof item === 'object' && item !== null) {
        yaml += `${spaces}-\n${jsonToYaml(item, indent + 1)}`;
      } else {
        yaml += `${spaces}- ${formatYamlValue(item)}\n`;
      }
    }
  } else if (typeof obj === 'object' && obj !== null) {
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'object' && value !== null) {
        if (Array.isArray(value) && value.length === 0) {
          yaml += `${spaces}${key}: []\n`;
        } else if (Object.keys(value).length === 0) {
          yaml += `${spaces}${key}: {}\n`;
        } else {
          yaml += `${spaces}${key}:\n${jsonToYaml(value, indent + 1)}`;
        }
      } else {
        yaml += `${spaces}${key}: ${formatYamlValue(value)}\n`;
      }
    }
  }

  return yaml;
}

function formatYamlValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '~';
  if (typeof value === 'string') {
    // Check if string needs quoting
    if (
      value === '' ||
      value.includes('\n') ||
      value.includes(':') ||
      value.includes('#') ||
      value.startsWith(' ') ||
      value.endsWith(' ') ||
      /^[0-9]/.test(value) ||
      ['true', 'false', 'null', 'yes', 'no'].includes(value.toLowerCase())
    ) {
      // Use double quotes and escape special characters
      return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
    }
    return value;
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return String(value);
}

export default docs;
