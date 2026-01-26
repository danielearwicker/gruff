#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import os from 'os';
import { watch } from 'fs';

const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');
const filePositions = new Map(); // Track last position in each file

function getFirstNWords(text: string, n: number) {
  const words = text.split(/\s+/);
  return words.slice(0, n).join(' ') + (words.length > n ? '...' : '');
}

function extractTextFromContent(content: unknown) {
  if (!Array.isArray(content)) return null;

  // Find all text entries
  const textParts = content
    .filter(item => item.type === 'text')
    .map(item => item.text)
    .join(' ');

  return textParts || null;
}

function formatTimestamp(isoString: string) {
  const date = new Date(isoString);
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function processNewEntries(filePath: string) {
  try {
    const stats = fs.statSync(filePath);
    const lastPosition = filePositions.get(filePath) || 0;

    // Only read if file has grown
    if (stats.size <= lastPosition) {
      return;
    }

    // Read from last position to end
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(stats.size - lastPosition);
    fs.readSync(fd, buffer, 0, buffer.length, lastPosition);
    fs.closeSync(fd);

    // Update position
    filePositions.set(filePath, stats.size);

    // Parse new lines
    const lines = buffer
      .toString('utf-8')
      .split('\n')
      .filter(line => line.trim());

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);

        // Extract relevant info
        const role = entry.message?.role || entry.type;
        const timestamp = entry.timestamp;
        const content = entry.message?.content;

        if (!content) continue;

        const text = extractTextFromContent(content);
        if (text) {
          const preview = getFirstNWords(text, 100);
          const projectName = path.basename(path.dirname(filePath));
          const fileName = path.basename(filePath);

          console.log('\n' + '='.repeat(80));
          console.log(`[${formatTimestamp(timestamp)}] ${projectName} / ${fileName}`);
          console.log(`Role: ${role}`);
          console.log('-'.repeat(80));
          console.log(preview);
          console.log('='.repeat(80));
        }
      } catch (_) {
        // Skip malformed JSON lines
      }
    }
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code !== 'ENOENT') {
      console.error(`Error processing ${filePath}:`, 'message' in err ? err.message : err);
    }
  }
}

function initializeFilePosition(filePath: string) {
  try {
    const stats = fs.statSync(filePath);
    filePositions.set(filePath, stats.size); // Start from end of file
  } catch (_) {
    // File might not exist yet
  }
}

function watchDirectory(dirPath: string) {
  try {
    // Initialize positions for existing files
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const filePath = path.join(dirPath, entry.name);
        initializeFilePosition(filePath);
      }
    }

    // Watch for changes
    watch(dirPath, { recursive: false }, (_, filename) => {
      if (filename && filename.endsWith('.jsonl')) {
        const filePath = path.join(dirPath, filename);
        processNewEntries(filePath);
      }
    });
  } catch (err) {
    // Directory might not exist or be accessible
  }
}

function main() {
  console.log('Monitoring Claude Code activity...');
  console.log(`Watching: ${CLAUDE_DIR}\n`);

  if (!fs.existsSync(CLAUDE_DIR)) {
    console.error(`Directory not found: ${CLAUDE_DIR}`);
    process.exit(1);
  }

  // Watch all project directories
  const projectDirs = fs
    .readdirSync(CLAUDE_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(CLAUDE_DIR, entry.name));

  for (const dir of projectDirs) {
    watchDirectory(dir);
  }

  // Also watch the main directory for new project folders
  watch(CLAUDE_DIR, { recursive: false }, (eventType, filename) => {
    if (filename && eventType === 'rename') {
      const newDir = path.join(CLAUDE_DIR, filename);
      try {
        if (fs.statSync(newDir).isDirectory()) {
          console.log(`\nDetected new project: ${filename}`);
          watchDirectory(newDir);
        }
      } catch (err) {
        // Might be a deletion or temporary file
      }
    }
  });

  console.log('Press Ctrl+C to stop monitoring\n');
}

main();
