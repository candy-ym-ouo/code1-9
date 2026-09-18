import { Buffer } from 'node:buffer';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SegmentCache } from './segment-cache.js';
import { createMediaStream, readBoundedRange } from './media-stream.js';
import type { MediaFile } from './media-stream.js';

async function drain(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe('segmented media assembly', () => {
  let dir: string;
  let media: MediaFile;
  const content = Buffer.from(
    Array.from({ length: 10_000 }, (_, index) => index % 251),
  );

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'playback-'));
    const filePath = path.join(dir, 'audio.bin');
    await writeFile(filePath, content);
    const stats = await (await import('node:fs/promises')).stat(filePath);
    media = { id: 'rec-1', path: filePath, size: content.length, mtimeMs: stats.mtimeMs };
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('assembles arbitrary ranges across multiple segments with exact bytes', async () => {
    const cache = new SegmentCache({ segmentSize: 1024, maxBytes: 1024 * 1024 });

    const cases: Array<[number, number]> = [
      [0, 0],
      [1023, 1024],
      [10, 4095],
      [4096, 8191],
      [7000, 9999],
      [1, 9998],
    ];

    for (const [start, end] of cases) {
      const body = await readBoundedRange(cache, media, start, end);
      expect(body.length).toBe(end - start + 1);
      expect(body.equals(content.subarray(start, end + 1))).toBe(true);
    }
  });

  it('streams full file and open ranges byte-exact while warming the cache', async () => {
    const cache = new SegmentCache({ segmentSize: 1024, maxBytes: 1024 * 1024 });

    const full = await drain(createMediaStream(cache, media, 0, content.length - 1));
    expect(full.equals(content)).toBe(true);
    expect(cache.entryCount).toBe(10);

    const tail = await drain(createMediaStream(cache, media, 9500, content.length - 1));
    expect(tail.equals(content.subarray(9500))).toBe(true);

    // 预热后这些字节应从缓存精确取出
    const cached = await readBoundedRange(cache, media, 9501, 9700);
    expect(cached.equals(content.subarray(9501, 9701))).toBe(true);
  });

  it('does not leak another recording when the file is replaced (new size/mtime key)', async () => {
    const cache = new SegmentCache({ segmentSize: 1024, maxBytes: 1024 * 1024 });
    await readBoundedRange(cache, media, 0, 1023);

    const replacedPath = path.join(dir, 'audio-replaced.bin');
    const replaced = Buffer.alloc(content.length, 7);
    await writeFile(replacedPath, replaced);
    // 模拟同一录音文件被覆盖：新的 mtime（size 相同也必须失效）
    const replacedMedia: MediaFile = {
      id: media.id,
      path: replacedPath,
      size: replaced.length,
      mtimeMs: media.mtimeMs + 5_000,
    };

    const body = await readBoundedRange(cache, replacedMedia, 0, 1023);
    expect(body.every((byte) => byte === 7)).toBe(true);
    expect(body.equals(content.subarray(0, 1024))).toBe(false);
  });

  it('only caches whole aligned segments after a mid-stream disconnect', async () => {
    const cache = new SegmentCache({ segmentSize: 1024, maxBytes: 1024 * 1024 });

    // 只读取第一片（1024 字节）后立刻销毁：后续在途分片不允许半截入缓存。
    const stream = createMediaStream(cache, media, 0, content.length - 1);
    stream.pause();
    const first = (await new Promise<Buffer>((resolve, reject) => {
      stream.once('readable', () => resolve(stream.read() as Buffer));
      stream.once('error', reject);
    })) as Buffer;
    expect(first.length).toBe(1024);
    stream.destroy();
    await new Promise((resolve) => stream.on('close', resolve));

    const key0 = cache.key(media.id, media.size, media.mtimeMs, 0);
    const key1 = cache.key(media.id, media.size, media.mtimeMs, 1);
    const cached1 = cache.get(key1);
    expect(cache.has(key0)).toBe(true);
    expect(cached1 === undefined || cached1.length === 1024).toBe(true);

    // 断线重连从断点续读：内容必须与源文件字节一致
    const resumed = await drain(createMediaStream(cache, media, 1024, 3000));
    expect(resumed.equals(content.subarray(1024, 3001))).toBe(true);
  });
});
