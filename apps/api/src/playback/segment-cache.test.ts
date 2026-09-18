import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { SegmentCache } from './segment-cache.js';

describe('SegmentCache', () => {
  it('stores complete segments, serves copies and warms inflight only once', async () => {
    const cache = new SegmentCache({ segmentSize: 4, maxBytes: 1024 });
    const file = Buffer.from('abcdefghij');
    let reads = 0;

    const reader = {
      read: async (start: number, end: number) => {
        reads += 1;
        return file.subarray(start, end + 1);
      },
    };

    const first = await cache.load(
      cache.key('rec-a', file.length, 1000, 1),
      { start: 4, end: 7 },
      reader,
    );
    expect(first.toString()).toBe('efgh');

    // 并发同片只产生一次磁盘读取
    const results = await Promise.all([
      cache.load(cache.key('rec-a', file.length, 1000, 1), { start: 4, end: 7 }, reader),
      cache.load(cache.key('rec-a', file.length, 1000, 1), { start: 4, end: 7 }, reader),
    ]);
    expect(reads).toBe(1);
    expect(results.every((chunk) => chunk.toString() === 'efgh')).toBe(true);

    // 返回的是拷贝，改写不得污染缓存
    const probe = await cache.load(
      cache.key('rec-a', file.length, 1000, 1),
      { start: 4, end: 7 },
      reader,
    );
    probe.fill(0);
    const again = cache.get(cache.key('rec-a', file.length, 1000, 1));
    expect(again?.toString()).toBe('efgh');
  });

  it('never mixes content across recordings, sizes or mtimes', () => {
    const cache = new SegmentCache({ segmentSize: 4, maxBytes: 1024 });
    cache.put(cache.key('rec-a', 10, 1000, 0), Buffer.from('abcd'), 4);

    expect(cache.get(cache.key('rec-b', 10, 1000, 0))).toBeUndefined();
    expect(cache.get(cache.key('rec-a', 11, 1000, 0))).toBeUndefined();
    expect(cache.get(cache.key('rec-a', 10, 2000, 0))).toBeUndefined();
    expect(cache.get(cache.key('rec-a', 10, 1000, 1))).toBeUndefined();
    expect(cache.get(cache.key('rec-a', 10, 1000, 0))?.toString()).toBe('abcd');
  });

  it('refuses segments whose length does not match the expected length', () => {
    const cache = new SegmentCache({ segmentSize: 4, maxBytes: 1024 });
    const key = cache.key('rec-a', 10, 1000, 2);
    cache.put(key, Buffer.from('xyz'), 4);
    expect(cache.get(key)).toBeUndefined();
  });

  it('evicts oldest entries when over budget', () => {
    const cache = new SegmentCache({ segmentSize: 4, maxBytes: 8 });
    cache.put(cache.key('r', 100, 1, 0), Buffer.from('aaaa'), 4);
    cache.put(cache.key('r', 100, 1, 1), Buffer.from('bbbb'), 4);
    expect(cache.entryCount).toBe(2);
    cache.put(cache.key('r', 100, 1, 2), Buffer.from('cccc'), 4);
    expect(cache.entryCount).toBe(2);
    expect(cache.get(cache.key('r', 100, 1, 0))).toBeUndefined();
    expect(cache.get(cache.key('r', 100, 1, 2))?.toString()).toBe('cccc');
  });

  it('fails loudly on a short disk read instead of caching it', async () => {
    const cache = new SegmentCache({ segmentSize: 4, maxBytes: 1024 });
    const key = cache.key('r', 10, 1, 0);
    const reader = { read: async () => Buffer.from('ab') };
    await expect(cache.load(key, { start: 0, end: 3 }, reader)).rejects.toThrow(/长度不匹配/);
    expect(cache.get(key)).toBeUndefined();
  });
});
