#!/usr/bin/env node

/**
 * build-index.ts
 *
 * One-time script to parse Matter spec PDFs, chunk them by section,
 * and store in a SQLite FTS5 database for fast BM25 search by the MCP server.
 *
 * Usage:
 *   npm run build-index
 *   node dist/build-index.js [--pdf-dir /path/to/pdfs] [--db /path/to/db]
 */

import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse') as (
  buffer: Buffer,
  options?: Record<string, unknown>,
) => Promise<{ numpages: number; text: string }>;

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Config ──────────────────────────────────────────────────────────────────

const CHUNK_SIZE = parseInt(process.env.MATTER_CHUNK_SIZE ?? '1200', 10);
const CHUNK_OVERLAP = parseInt(process.env.MATTER_CHUNK_OVERLAP ?? '200', 10);

const PDF_KEY_PATTERNS: Record<string, string> = {
  core: 'core',
  clusters: 'cluster',
  devices: 'device',
  namespaces: 'namespace',
};

const SECTION_RE = /^(\d+(?:\.\d+){0,4})\s+([A-Z][^\n]{3,80})$/m;

// ─── CLI args ─────────────────────────────────────────────────────────────────

function parseArgs(): { pdfDir: string; dbPath: string } {
  const argv = process.argv.slice(2);
  let pdfDir = join(__dirname, '..', 'pdfs');
  let dbPath = join(__dirname, '..', 'matter_index.db');

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pdf-dir' && argv[i + 1]) pdfDir = resolve(argv[++i]);
    else if (argv[i] === '--db' && argv[i + 1]) dbPath = resolve(argv[++i]);
  }
  return { pdfDir, dbPath };
}

// ─── Database setup ──────────────────────────────────────────────────────────

function initDb(db: Database.Database): void {
  db.exec(`
    DROP TABLE IF EXISTS chunks_fts;
    CREATE VIRTUAL TABLE chunks_fts USING fts5(
      doc_key  UNINDEXED,
      page     UNINDEXED,
      section,
      content,
      tokenize = 'porter ascii'
    );
  `);
}

// ─── PDF parsing ─────────────────────────────────────────────────────────────

interface PageData {
  page: number;
  text: string;
}

async function extractPages(pdfPath: string): Promise<PageData[]> {
  const buffer = readFileSync(pdfPath);
  const pages: PageData[] = [];

  await pdfParse(buffer, {
    // biome-ignore lint/suspicious/noExplicitAny: pdf-parse has no typed callback API
    pagerender: (pageData: any) =>
      // biome-ignore lint/suspicious/noExplicitAny: untyped pdf.js text content
      pageData.getTextContent().then((tc: any) => {
        // biome-ignore lint/suspicious/noExplicitAny: untyped pdf.js text item
        const raw = tc.items.map((item: any) => item.str).join(' ');
        // Normalize whitespace: collapse runs of spaces/tabs, reduce excess newlines
        const text = raw
          .replace(/\n{3,}/g, '\n\n')
          .replace(/[ \t]+/g, ' ')
          .trim();
        pages.push({ page: pageData.pageNumber, text });
        return raw;
      }),
  });

  return pages;
}

export function detectSection(text: string): string | null {
  const match = SECTION_RE.exec(text.slice(0, 300));
  if (match) return `${match[1]} ${match[2].trim()}`;
  return null;
}

export function chunkText(
  text: string,
  chunkSize = CHUNK_SIZE,
  overlap = CHUNK_OVERLAP,
): string[] {
  if (text.length <= chunkSize) return [text];

  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let current = '';

  for (const rawPara of paragraphs) {
    const para = rawPara.trim();
    if (!para) continue;

    if (current.length + para.length + 2 > chunkSize && current) {
      chunks.push(current.trim());
      const overlapText =
        current.length > overlap ? current.slice(-overlap) : current;
      current = `${overlapText}\n\n${para}`;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks.length > 0 ? chunks : [text.slice(0, chunkSize)];
}

// ─── Indexing ─────────────────────────────────────────────────────────────────

async function indexPdf(
  db: Database.Database,
  docKey: string,
  pdfPath: string,
): Promise<number> {
  const filename = pdfPath.split('/').pop() ?? pdfPath;
  console.log(`  Indexing ${filename}...`);

  const pages = await extractPages(pdfPath);
  console.log(`    Extracted ${pages.length} pages`);

  const insert = db.prepare(
    'INSERT INTO chunks_fts (doc_key, page, section, content) VALUES (?, ?, ?, ?)',
  );
  const insertMany = db.transaction(
    (rows: Array<[string, number, string | null, string]>) => {
      for (const row of rows) insert.run(...row);
    },
  );

  let currentSection: string | null = null;
  const rows: Array<[string, number, string | null, string]> = [];

  for (const { page, text } of pages) {
    if (!text.trim()) continue;

    const detected = detectSection(text);
    if (detected) currentSection = detected;

    const chunks = chunkText(text);
    for (const chunk of chunks) {
      if (chunk.trim().length < 50) continue;
      rows.push([docKey, page, currentSection, chunk]);
    }
  }

  insertMany(rows);
  console.log(`    → ${rows.length.toLocaleString()} chunks indexed`);
  return rows.length;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { pdfDir, dbPath } = parseArgs();

  console.log('Matter Spec Indexer');
  console.log(`PDF directory: ${pdfDir}`);
  console.log(`Output DB:     ${dbPath}\n`);

  // Auto-detect PDFs by matching key patterns against filenames
  let allPdfs: string[];
  try {
    allPdfs = readdirSync(pdfDir)
      .filter((f) => f.toLowerCase().endsWith('.pdf'))
      .map((f) => join(pdfDir, f));
  } catch {
    console.error(`ERROR: Cannot read PDF directory: ${pdfDir}`);
    process.exit(1);
  }

  const pdfFiles: Record<string, string> = {};
  for (const [docKey, pattern] of Object.entries(PDF_KEY_PATTERNS)) {
    const match = allPdfs.find((p) => p.toLowerCase().includes(pattern));
    if (match) {
      pdfFiles[docKey] = match;
    } else {
      console.warn(
        `WARNING: No PDF found matching '${pattern}' for doc_key '${docKey}'`,
      );
    }
  }

  if (Object.keys(pdfFiles).length === 0) {
    console.error(`ERROR: No matching PDFs found in ${pdfDir}`);
    console.error(
      'Expected PDFs with filenames containing: ' +
        Object.values(PDF_KEY_PATTERNS).join(', '),
    );
    process.exit(1);
  }

  console.log(`Found ${Object.keys(pdfFiles).length} spec PDF(s):`);
  for (const [key, path] of Object.entries(pdfFiles)) {
    console.log(`  [${key}] ${path.split('/').pop()}`);
  }
  console.log();

  const db = new Database(dbPath);
  initDb(db);

  let grandTotal = 0;
  for (const [docKey, pdfPath] of Object.entries(pdfFiles)) {
    try {
      grandTotal += await indexPdf(db, docKey, pdfPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `ERROR: Failed to index ${pdfPath.split('/').pop()}: ${msg}`,
      );
      console.error('  Skipping this PDF and continuing with remaining files.');
    }
  }

  db.close();
  console.log(
    `\n✅ Done! ${grandTotal.toLocaleString()} chunks indexed across ${Object.keys(pdfFiles).length} document(s) → ${dbPath}`,
  );
  console.log('\nYou can now start the MCP server:');
  console.log('  npm start');
}

// Only run when executed directly, not when imported for testing
if (typeof process.env.VITEST === 'undefined') {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
