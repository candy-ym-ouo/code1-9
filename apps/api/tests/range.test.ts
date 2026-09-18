import { describe, expect, it } from 'vitest';
import { buildFileEtag, parseByteRange, shouldHonorRange } from '../src/media/range.js';

describe('parseByteRange', () => {
  it('parses an explicit range', () => {
    expect(parseByteRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseByteRange('bytes=500-799', 1000)).toEqual({ start: 500, end: 799 });
  });

  it('parses an open-ended range', () => {
    expect(parseByteRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 });
  });

  it('parses a suffix range', () => {
    expect(parseByteRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
  });

  it('clamps a suffix longer than the file', () => {
    expect(parseByteRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 });
  });

  it('clamps an end beyond the file size', () => {
    expect(parseByteRange('bytes=0-9999', 1000)).toEqual({ start: 0, end: 999 });
  });

  it('accepts a single byte', () => {
    expect(parseByteRange('bytes=0-0', 1000)).toEqual({ start: 0, end: 0 });
    expect(parseByteRange('bytes=999-999', 1000)).toEqual({ start: 999, end: 999 });
  });

  it('rejects malformed ranges', () => {
    expect(parseByteRange('items=0-1', 1000)).toBeNull();
    expect(parseByteRange('bytes=-', 1000)).toBeNull();
    expect(parseByteRange('bytes=', 1000)).toBeNull();
    expect(parseByteRange('bytes=0-1,3-4', 1000)).toBeNull();
    expect(parseByteRange('bytes=abc-def', 1000)).toBeNull();
    expect(parseByteRange('bytes=1.5-2', 1000)).toBeNull();
    expect(parseByteRange('bytes=-0', 1000)).toBeNull();
  });

  it('rejects unsatisfiable ranges', () => {
    expect(parseByteRange('bytes=100-50', 1000)).toBeNull();
    expect(parseByteRange('bytes=1000-1001', 1000)).toBeNull();
    expect(parseByteRange('bytes=99999999999999999999-', 1000)).toBeNull();
  });
});

describe('buildFileEtag', () => {
  it('is deterministic and version-sensitive', () => {
    const a = buildFileEtag({ size: 1000, mtimeMs: 1_700_000_000_000 });
    const b = buildFileEtag({ size: 1000, mtimeMs: 1_700_000_000_000 });
    const c = buildFileEtag({ size: 1001, mtimeMs: 1_700_000_000_000 });
    const d = buildFileEtag({ size: 1000, mtimeMs: 1_700_000_000_001 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
    expect(a).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);
  });
});

describe('shouldHonorRange', () => {
  const etag = buildFileEtag({ size: 1000, mtimeMs: 1_700_000_000_000 });

  it('honors the range when If-Range is absent or empty', () => {
    expect(shouldHonorRange(undefined, etag, 1_700_000_000_000)).toBe(true);
    expect(shouldHonorRange('   ', etag, 1_700_000_000_000)).toBe(true);
  });

  it('honors the range when the etag matches exactly', () => {
    expect(shouldHonorRange(etag, etag, 1_700_000_000_000)).toBe(true);
  });

  it('falls back to full response when the file version changed', () => {
    const stale = buildFileEtag({ size: 900, mtimeMs: 1_600_000_000_000 });
    expect(shouldHonorRange(stale, etag, 1_700_000_000_000)).toBe(false);
  });

  it('never honors weak etags for range requests', () => {
    expect(shouldHonorRange(`W/${etag}`, etag, 1_700_000_000_000)).toBe(false);
  });

  it('compares HTTP dates against mtime at second precision', () => {
    const mtimeMs = 1_700_000_000_500;
    const sameSecond = new Date(1_700_000_000_000).toUTCString();
    const later = new Date(1_700_000_500_000).toUTCString();
    const earlier = new Date(1_699_999_999_000).toUTCString();
    expect(shouldHonorRange(sameSecond, etag, mtimeMs)).toBe(true);
    expect(shouldHonorRange(later, etag, mtimeMs)).toBe(true);
    expect(shouldHonorRange(earlier, etag, mtimeMs)).toBe(false);
  });

  it('rejects garbage values', () => {
    expect(shouldHonorRange('not-a-date', etag, 1_700_000_000_000)).toBe(false);
  });
});
