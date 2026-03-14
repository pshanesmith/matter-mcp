import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Chunk,
  dbReady,
  formatResults,
  fts5EscapeQuery,
  fts5Search,
  normativeSearch,
} from '../src/search.js';

// ─── fts5EscapeQuery ──────────────────────────────────────────────────────────

describe('fts5EscapeQuery', () => {
  it('extracts alphanumeric tokens from a normal query', () => {
    expect(fts5EscapeQuery('Door Lock cluster')).toBe('Door Lock cluster');
  });

  it('strips special characters that would break FTS5 MATCH', () => {
    expect(fts5EscapeQuery('on/off "quoted"')).toBe('on off quoted');
  });

  it('returns empty-string literal for empty input', () => {
    expect(fts5EscapeQuery('')).toBe('""');
  });

  it('returns empty-string literal for pure punctuation', () => {
    expect(fts5EscapeQuery('!@#$%')).toBe('""');
  });

  it('preserves numeric tokens', () => {
    expect(fts5EscapeQuery('cluster 0x0006')).toBe('cluster 0x0006');
  });
});

// ─── formatResults ────────────────────────────────────────────────────────────

describe('formatResults', () => {
  it('returns a no-results message for empty array', () => {
    expect(formatResults([], 'test')).toBe('No results found for: test');
  });

  it('formats a single result with section and page', () => {
    const chunks: Chunk[] = [
      {
        doc_key: 'core',
        section: '1.2 Intro',
        page: 5,
        content: 'Hello world',
      },
    ];
    const out = formatResults(chunks, 'q');
    expect(out).toContain('**[1] Core Spec | 1.2 Intro | p.5**');
    expect(out).toContain('Hello world');
  });

  it('handles missing section and page gracefully', () => {
    const chunks: Chunk[] = [
      { doc_key: 'clusters', section: null, page: null, content: 'Some text' },
    ];
    const out = formatResults(chunks, 'q');
    expect(out).toContain('**[1] Application Clusters**');
    expect(out).not.toContain('|');
  });

  it('falls back to raw doc_key for unknown keys', () => {
    const chunks: Chunk[] = [
      { doc_key: 'unknown', section: null, page: 1, content: 'text' },
    ];
    const out = formatResults(chunks, 'q');
    expect(out).toContain('unknown');
  });
});

// ─── Integration tests with in-memory SQLite ────────────────────────────────

describe('FTS5 search (in-memory DB)', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE VIRTUAL TABLE chunks_fts USING fts5(
        doc_key  UNINDEXED,
        page     UNINDEXED,
        section,
        content,
        tokenize = 'porter ascii'
      );
    `);
    const insert = db.prepare(
      'INSERT INTO chunks_fts (doc_key, page, section, content) VALUES (?, ?, ?, ?)',
    );
    insert.run(
      'core',
      10,
      '3.1 Data Model',
      'The data model defines attributes and commands for clusters.',
    );
    insert.run(
      'clusters',
      20,
      '4.3 Door Lock',
      'The Door Lock cluster provides an interface to a generic way to secure a door.',
    );
    insert.run(
      'clusters',
      21,
      '4.3.1 Attributes',
      'LockState attribute SHALL indicate the current lock state.',
    );
    insert.run(
      'devices',
      30,
      '5.1 Dimmable Light',
      'A Dimmable Light is a lighting device that can be switched on or off and dimmed.',
    );
    insert.run(
      'namespaces',
      40,
      '6.1 Common Area',
      'Semantic tags for common areas like kitchen, bedroom, and living room.',
    );
  });

  afterAll(() => {
    db.close();
  });

  it('dbReady returns true for a populated DB', () => {
    expect(dbReady(db)).toBe(true);
  });

  it('dbReady returns false for an empty DB', () => {
    const emptyDb = new Database(':memory:');
    expect(dbReady(emptyDb)).toBe(false);
    emptyDb.close();
  });

  it('fts5Search finds results by keyword', () => {
    const results = fts5Search('Door Lock', null, 5, db);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].doc_key).toBe('clusters');
  });

  it('fts5Search respects doc filter', () => {
    const results = fts5Search('data model', 'core', 5, db);
    expect(results.length).toBe(1);
    expect(results[0].doc_key).toBe('core');
  });

  it('fts5Search respects topK limit', () => {
    const results = fts5Search('cluster', null, 2, db);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('fts5Search returns empty for no matches', () => {
    const results = fts5Search('xyznonexistent', null, 5, db);
    expect(results).toEqual([]);
  });

  it('normativeSearch ranks SHALL/MUST chunks first', () => {
    const results = normativeSearch('lock', null, 5, db);
    // The chunk containing "SHALL" should come first
    const shallIdx = results.findIndex((r) => r.content.includes('SHALL'));
    if (shallIdx >= 0 && results.length > 1) {
      // Normative chunks should be ranked before non-normative ones
      const nonNormIdx = results.findIndex(
        (r) =>
          !r.content.match(
            /\b(SHALL|SHOULD|MAY|MUST|REQUIRED|OPTIONAL|RECOMMENDED)\b/,
          ),
      );
      if (nonNormIdx >= 0) {
        expect(shallIdx).toBeLessThan(nonNormIdx);
      }
    }
  });
});
