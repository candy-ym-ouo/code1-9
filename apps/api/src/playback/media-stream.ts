import { Buffer } from 'node:buffer';
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { SegmentCache } from './segment-cache.js';
import { coveringSegments, segmentBounds } from './range.js';

/**
 * 媒体分片读取与响应组装。
 *
 * 多段下载 / 断线重连的正确性保证：
 * - 任何 206 响应都只由“按字节位置切出的分片”按顺序 concat 得到，
 *   Content-Range 与 Content-Length 由同一组 (start,end) 计算，不依赖客户端给的 end；
 * - 每个分片读取都要求长度精确匹配（最后一片按文件真实大小），长度不符直接报错，
 *   宁可中断也不返回错位/截断内容；
 * - 缓存键含录音 ID + size + mtime + 分片索引，文件被替换后旧缓存永不命中；
 * - 打开的 Range（bytes=start-）与整文件走顺序流式读取并顺带预热分片缓存；
 *   预热按文件自身的分片边界对齐，客户端提前断开时不完整的分片不会入缓存。
 */

const READ_CHUNK_BYTES = 64 * 1024;

async function readExact(
  file: FileHandle,
  start: number,
  end: number,
): Promise<Buffer> {
  const length = end - start + 1;
  const chunks: Buffer[] = [];
  let position = start;

  while (position <= end) {
    const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, end - position + 1));
    const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    position += bytesRead;
  }

  const buffer = Buffer.concat(chunks, length);
  if (buffer.length !== length) {
    throw new Error(
      `文件读取长度不匹配: 期望 ${length} 字节 (${start}-${end})，实际 ${buffer.length} 字节`,
    );
  }
  return buffer;
}

export type MediaFile = {
  id: string;
  path: string;
  size: number;
  mtimeMs: number;
};

/**
 * 由分段缓存组装一个有界区间的完整内容。
 * 所有覆盖分片都来自缓存或同一份磁盘读取，拼接顺序严格按字节位置。
 */
export async function readBoundedRange(
  cache: SegmentCache,
  media: MediaFile,
  start: number,
  end: number,
): Promise<Buffer> {
  const { firstIndex, lastIndex } = coveringSegments(start, end, cache.segmentSize);
  const parts: Buffer[] = [];

  const file = await open(media.path, 'r');
  try {
    for (let index = firstIndex; index <= lastIndex; index += 1) {
      const bounds = segmentBounds(index, cache.segmentSize, media.size);
      const key = cache.key(media.id, media.size, media.mtimeMs, index);
      const segment = await cache.load(key, bounds, {
        read: (segStart, segEnd) => readExact(file, segStart, segEnd),
      });

      const sliceStart = index === firstIndex ? start - bounds.start : 0;
      const sliceEnd = index === lastIndex ? end - bounds.start + 1 : segment.length;
      parts.push(segment.subarray(sliceStart, sliceEnd));
    }
  } finally {
    await file.close();
  }

  const expectedLength = end - start + 1;
  const merged = Buffer.concat(parts, expectedLength);
  if (merged.length !== expectedLength) {
    throw new Error('分段组装长度与请求区间不一致');
  }
  return merged;
}

/**
 * 判断一个有界区间是否适合“先整段读入内存、由缓存组装”。
 * 过大的区间（例如一次拉完整张专辑）不进内存，直接顺序流。
 */
export function isRangeCacheable(cache: SegmentCache, start: number, end: number): boolean {
  const length = end - start + 1;
  return length <= cache.segmentSize * 4;
}

/**
 * 顺序流式读取（整文件或打开的 Range），同时把扫过的完整分片写入缓存，
 * 供后续 Range 请求 / 断线重连命中。每次以文件的分片边界对齐读取：
 * 仅把落在 [start,end] 内的字节推给客户端，但完整对齐的整段才会缓存。
 */
export function createMediaStream(
  cache: SegmentCache,
  media: MediaFile,
  start: number,
  end: number,
): Readable {
  const segmentSize = cache.segmentSize;
  const { firstIndex, lastIndex } = coveringSegments(
    Math.min(start, end),
    Math.max(start, end),
    segmentSize,
  );
  let file: FileHandle | null = null;
  let index = firstIndex;

  const closeFile = async () => {
    if (file) {
      await file.close().catch(() => undefined);
      file = null;
    }
  };

  const stream = new Readable({
    highWaterMark: segmentSize,
    async read() {
      try {
        if (!file) file = await open(media.path, 'r');

        if (index > lastIndex) {
          await closeFile();
          this.push(null);
          return;
        }

        const bounds = segmentBounds(index, segmentSize, media.size);
        const segment = await readExact(file, bounds.start, bounds.end);
        if (segment.length !== bounds.end - bounds.start + 1) {
          throw new Error('流式读取分片长度不匹配');
        }

        // 完整对齐分片入缓存（即便这是首个/末个被请求截断的分片，缓存的仍是完整分片）。
        const key = cache.key(media.id, media.size, media.mtimeMs, index);
        if (!cache.has(key)) {
          cache.put(key, segment, bounds.end - bounds.start + 1);
        }

        const sliceStart = Math.max(start, bounds.start) - bounds.start;
        const sliceEnd = Math.min(end, bounds.end) - bounds.start + 1;
        index += 1;
        this.push(segment.subarray(sliceStart, sliceEnd));
      } catch (error) {
        await closeFile();
        this.destroy(error as Error);
      }
    },
  });

  stream.on('error', () => void closeFile());

  return stream;
}
