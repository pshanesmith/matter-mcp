import { describe, expect, it } from 'vitest';
import { chunkText, detectSection } from './build-index.js';

// ─── detectSection ────────────────────────────────────────────────────────────

describe('detectSection', () => {
  it('detects a standard section heading', () => {
    expect(detectSection('1.2 Introduction\nSome body text')).toBe(
      '1.2 Introduction',
    );
  });

  it('detects multi-level section numbers', () => {
    expect(detectSection('4.3.1.2 Lock State\nDetails here')).toBe(
      '4.3.1.2 Lock State',
    );
  });

  it('returns null when no section heading is present', () => {
    expect(detectSection('just some regular paragraph text')).toBeNull();
  });

  it('returns null for lowercase headings', () => {
    expect(detectSection('1.2 introduction details')).toBeNull();
  });

  it('only looks at the first 300 characters', () => {
    const longPrefix = 'A'.repeat(301);
    expect(detectSection(`${longPrefix}\n1.1 Heading`)).toBeNull();
  });
});

// ─── chunkText ────────────────────────────────────────────────────────────────

describe('chunkText', () => {
  it('returns a single chunk for short text', () => {
    const chunks = chunkText('Short text.', 100, 20);
    expect(chunks).toEqual(['Short text.']);
  });

  it('splits long text into multiple chunks', () => {
    const para1 = 'A'.repeat(80);
    const para2 = 'B'.repeat(80);
    const para3 = 'C'.repeat(80);
    const text = `${para1}\n\n${para2}\n\n${para3}`;
    const chunks = chunkText(text, 100, 20);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('respects chunk size limit', () => {
    const paragraphs = Array.from(
      { length: 10 },
      (_, i) => `Paragraph ${i}: ${'x'.repeat(50)}`,
    ).join('\n\n');
    const chunks = chunkText(paragraphs, 200, 40);
    // Each chunk (except possibly overlap) should be at most ~chunkSize
    for (const chunk of chunks) {
      // Allow some overshoot from overlap carry-over
      expect(chunk.length).toBeLessThan(400);
    }
  });

  it('includes overlap between chunks', () => {
    const para1 = 'Alpha '.repeat(20).trim();
    const para2 = 'Beta '.repeat(20).trim();
    const para3 = 'Gamma '.repeat(20).trim();
    const text = `${para1}\n\n${para2}\n\n${para3}`;
    const chunks = chunkText(text, 150, 40);
    if (chunks.length >= 2) {
      // The end of chunk N should overlap with the start of chunk N+1
      const endOfFirst = chunks[0].slice(-30);
      expect(chunks[1]).toContain(endOfFirst);
    }
  });

  it('returns fallback slice for text with no paragraph breaks', () => {
    const text = 'x'.repeat(200);
    const chunks = chunkText(text, 100, 20);
    // Single paragraph > chunkSize with no break points
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  it('treats multiple blank lines as a single paragraph break', () => {
    const text = 'Hello\n\n\n\n\n\nWorld';
    const chunks = chunkText(text, 1000, 20);
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toContain('Hello');
    expect(chunks[0]).toContain('World');
  });
});
