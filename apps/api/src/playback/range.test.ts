import { describe, expect, it } from 'vitest';
import { parseByteRange, coveringSegments, segmentBounds } from './range.js';

describe('parseByteRange', () => {
  it('parses a normal half-open range and clamps to file size', () => {
    expect(parseByteRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseByteRange('bytes=100-', 1000)).toEqual({ start: 100, end: 999 });
    expect(parseByteRange('bytes=100-5000', 1000)).toEqual({ start: 100, end: 999 });
  });

  it('parses suffix ranges', () => {
    expect(parseByteRange('bytes=-200', 1000)).toEqual({ start: 800, end: 999 });
    expect(parseByteRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 });
  });

  it('rejects multi-range requests (multipart ranges must not be served)', () => {
    expect(parseByteRange('bytes=0-99,200-299', 1000)).toBeNull();
  });

  it('rejects malformed or unsatisfiable ranges', () => {
    expect(parseByteRange('items=0-99', 1000)).toBeNull();
    expect(parseByteRange('bytes=-', 1000)).toBeNull();
    expect(parseByteRange('bytes=1000-', 1000)).toBeNull();
    expect(parseByteRange('bytes=500-100', 1000)).toBeNull();
    expect(parseByteRange('bytes=abc-', 1000)).toBeNull();
    expect(parseByteRange('bytes=-0', 1000)).toBeNull();
  });
});

describe('segment math', () => {
  it('computes covering segment indices and bounds', () => {
    expect(coveringSegments(0, 1, 4)).toEqual({ firstIndex: 0, lastIndex: 0 });
    expect(coveringSegments(3, 4, 4)).toEqual({ firstIndex: 0, lastIndex: 1 });
    expect(coveringSegments(8, 9, 4)).toEqual({ firstIndex: 2, lastIndex: 2 });
    expect(segmentBounds(0, 4, 10)).toEqual({ start: 0, end: 3 });
    expect(segmentBounds(2, 4, 10)).toEqual({ start: 8, end: 9 });
  });
});
