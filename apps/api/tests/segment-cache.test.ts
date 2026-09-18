import { mkdtemp, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SegmentCache } from '../src/media/segmentCache.js';

class FakeRedis {
  readonly store = new Map<string, string>();
  mgetCalls = 0;
  failNext = false;

  async mget(...keys: string[]): Promise<Array<string | null>> {
    this.mgetCalls += 1;
    if (this.failNext) {
      this.failNext = false;
      throw new Error('redis down');
    }
    return keys.map((key) => this.store.get(key) ?? null);
  }

  async set(key: string, value: string): Promise<string> {
    this.store.set(key, value);
    return 'OK';
  }
}

const SEGMENT = 1024;
const SIZE = SEGMENT * 2 + 700; // 两个完整段 + 一个不完整的尾段

function buildContent(size: number, seed: number): Buffer {
  const content = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) {
    content[index] = (index * 31 + seed) % 256;
  }
  return content;
}

let dir: string;
let filePath: string;
let content: Buffer;
let redis: FakeRedis;
let cache: SegmentCache;

const FILE_KEY = 'rec-1:"etag-v1"';

function reference(start: number, end: number): Buffer {
  return content.subarray(start, end + 1);
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'segment-cache-'));
  filePath = path.join(dir, 'audio.bin');
  content = buildContent(SIZE, 7);
  await writeFile(filePath, content);
  redis = new FakeRedis();
  cache = new SegmentCache(redis, {
    segmentBytes: SEGMENT,
    ttlSeconds: 600,
    maxSegmentsPerRequest: 8,
  });
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('SegmentCache alignment', () => {
  it('returns exact bytes for aligned, unaligned and boundary ranges', async () => {
    const ranges: Array<[number, number]> = [
      [0, 0],
      [0, SEGMENT - 1], // 完整第一段
      [SEGMENT, SEGMENT], // 段边界上的单字节
      [SEGMENT, 2 * SEGMENT - 1], // 完整第二段
      [SEGMENT - 5, SEGMENT + 5], // 跨段边界
      [100, 100],
      [1, SIZE - 2],
      [SIZE - 10, SIZE - 1], // 尾段
      [2 * SEGMENT, SIZE - 1], // 不完整尾段整段
      [0, SIZE - 1], // 整个文件
    ];

    for (const [start, end] of ranges) {
      const result = await cache.readRange(FILE_KEY, filePath, SIZE, start, end);
      expect(result, `range ${start}-${end}`).not.toBeNull();
      expect(result?.length).toBe(end - start + 1);
      expect(Buffer.compare(result as Buffer, reference(start, end))).toBe(0);
    }
  });

  it('serves subsequent reads from cache without touching the file', async () => {
    // 上一轮已经缓存了全部段；删除源文件后读取必须仍然正确
    await unlink(filePath);
    const result = await cache.readRange(FILE_KEY, filePath, SIZE, 10, SIZE - 10);
    expect(result).not.toBeNull();
    expect(Buffer.compare(result as Buffer, reference(10, SIZE - 10))).toBe(0);

    // 恢复文件供后续用例使用
    await writeFile(filePath, content);
  });

  it('never mixes segments across file versions', async () => {
    const v2Content = buildContent(SIZE, 99);
    await writeFile(filePath, v2Content);
    try {
      const result = await cache.readRange('rec-1:"etag-v2"', filePath, SIZE, 0, 199);
      expect(result).not.toBeNull();
      expect(Buffer.compare(result as Buffer, v2Content.subarray(0, 200))).toBe(0);
      // v1 的缓存键没有被复用
      expect([...redis.store.keys()].some((key) => key.includes('etag-v2'))).toBe(true);
    } finally {
      await writeFile(filePath, content);
    }
  });

  it('falls back when the range spans too many segments', async () => {
    const keysBefore = redis.store.size;
    const result = await cache.readRange(FILE_KEY, filePath, SIZE, 0, SIZE - 1);
    expect(result).not.toBeNull(); // 3 段，未超过上限

    const small = new SegmentCache(redis, {
      segmentBytes: SEGMENT,
      ttlSeconds: 600,
      maxSegmentsPerRequest: 2,
    });
    const limited = await small.readRange('rec-1:"etag-v3"', filePath, SIZE, 0, SIZE - 1);
    expect(limited).toBeNull();
    expect(redis.store.size).toBe(keysBefore); // 超限时不写缓存
  });

  it('falls back when redis fails instead of serving partial content', async () => {
    redis.failNext = true;
    const result = await cache.readRange('rec-1:"etag-v4"', filePath, SIZE, 0, 99);
    expect(result).toBeNull();
  });

  it('rejects corrupted cache entries by falling back', async () => {
    const key = `media-seg:rec-1:"etag-v5":0`;
    redis.store.set(key, Buffer.from('truncated').toString('base64'));
    const result = await cache.readRange('rec-1:"etag-v5"', filePath, SIZE, 0, 99);
    expect(result).toBeNull();
  });

  it('rejects invalid ranges', async () => {
    expect(await cache.readRange(FILE_KEY, filePath, SIZE, -1, 10)).toBeNull();
    expect(await cache.readRange(FILE_KEY, filePath, SIZE, 10, 5)).toBeNull();
    expect(await cache.readRange(FILE_KEY, filePath, SIZE, 0, SIZE)).toBeNull();
    expect(await cache.readRange(FILE_KEY, filePath, 0, 0, 0)).toBeNull();
  });

  it('populates the cache on a miss and reuses it', async () => {
    const freshRedis = new FakeRedis();
    const freshCache = new SegmentCache(freshRedis, {
      segmentBytes: SEGMENT,
      ttlSeconds: 600,
      maxSegmentsPerRequest: 8,
    });

    const first = await freshCache.readRange('rec-2:"etag"', filePath, SIZE, 0, 99);
    expect(first).not.toBeNull();
    expect(freshRedis.store.size).toBe(1); // 只触达第一段

    const callsBefore = freshRedis.mgetCalls;
    const second = await freshCache.readRange('rec-2:"etag"', filePath, SIZE, 0, 99);
    expect(second).not.toBeNull();
    expect(freshRedis.mgetCalls).toBe(callsBefore + 1);
    expect(freshRedis.store.size).toBe(1); // 命中后不再写入
    expect(Buffer.compare(second as Buffer, reference(0, 99))).toBe(0);
  });
});
