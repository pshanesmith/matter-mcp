import type Database from 'better-sqlite3';

export interface Chunk {
  doc_key: string;
  section: string | null;
  page: number | null;
  content: string;
}

const SPEC_DOCS: Record<string, string> = {
  core: 'Core Spec',
  clusters: 'Application Clusters',
  devices: 'Device Library',
  namespaces: 'Standard Namespaces',
};

const DEBUG = process.env.MATTER_DEBUG === '1';

function log(msg: string): void {
  if (DEBUG) process.stderr.write(`[matter-mcp:search] ${msg}\n`);
}

/** Sanitize a user query for FTS5 MATCH — keep word tokens, preserve stemming */
export function fts5EscapeQuery(query: string): string {
  // Extract alphanumeric tokens; don't quote them so Porter stemming still applies
  const tokens = query.match(/[a-zA-Z0-9]+/g) ?? [];
  if (tokens.length === 0) return '""';
  return tokens.join(' ');
}

/** RFC 2119 normative keywords used to identify compliance requirement statements */
const NORMATIVE_RE =
  /\b(SHALL|SHOULD|MAY|MUST|REQUIRED|OPTIONAL|RECOMMENDED)\b/;

export function fts5Search(
  query: string,
  docFilter: string | null,
  topK: number,
  db: Database.Database,
): Chunk[] {
  const escaped = fts5EscapeQuery(query);
  log(
    `fts5Search query="${query}" escaped="${escaped}" doc=${docFilter ?? 'all'} topK=${topK}`,
  );
  return _fts5Query(escaped, docFilter, topK, db);
}

function _fts5Query(
  ftsQuery: string,
  docFilter: string | null,
  topK: number,
  db: Database.Database,
): Chunk[] {
  try {
    if (docFilter) {
      return db
        .prepare<[string, string, number], Chunk>(
          `SELECT doc_key, section, page, content
         FROM chunks_fts
         WHERE chunks_fts MATCH ? AND doc_key = ?
         -- bm25 weights: doc_key(0), page(0), section(3.0), content(1.0)
         -- Section gets 3x weight so matching a section heading ranks higher.
         -- doc_key and page are UNINDEXED so their weights are ignored (set to 0).
         ORDER BY bm25(chunks_fts, 0.0, 0.0, 3.0, 1.0)
         LIMIT ?`,
        )
        .all(ftsQuery, docFilter, topK);
    } else {
      return db
        .prepare<[string, number], Chunk>(
          `SELECT doc_key, section, page, content
         FROM chunks_fts
         WHERE chunks_fts MATCH ?
         ORDER BY bm25(chunks_fts, 0.0, 0.0, 3.0, 1.0) -- see above for weight rationale
         LIMIT ?`,
        )
        .all(ftsQuery, topK);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[matter-mcp] FTS5 query error: ${msg} (query: "${ftsQuery}")\n`,
    );
    return [];
  }
}

export function normativeSearch(
  query: string,
  docFilter: string | null,
  topK: number,
  db: Database.Database,
): Chunk[] {
  // Fetch extra candidates, then re-rank: normative chunks first
  const candidates = _fts5Query(
    fts5EscapeQuery(query),
    docFilter,
    topK + 5,
    db,
  );
  const strong = candidates.filter((r) => NORMATIVE_RE.test(r.content));
  const weak = candidates.filter((r) => !NORMATIVE_RE.test(r.content));
  return [...strong, ...weak].slice(0, topK);
}

export function formatResults(results: Chunk[], query: string): string {
  if (results.length === 0) {
    return `No results found for: ${query}`;
  }
  const lines: string[] = [];
  results.forEach((r, i) => {
    const docLabel = SPEC_DOCS[r.doc_key] ?? r.doc_key;
    const section = r.section ? ` | ${r.section}` : '';
    const page = r.page != null ? ` | p.${r.page}` : '';
    lines.push(`**[${i + 1}] ${docLabel}${section}${page}**`);
    lines.push(r.content.trim());
    lines.push('');
  });
  return lines.join('\n');
}

export function dbReady(db: Database.Database): boolean {
  try {
    const row = db.prepare('SELECT COUNT(*) as n FROM chunks_fts').get() as {
      n: number;
    };
    return row.n > 0;
  } catch {
    return false;
  }
}
