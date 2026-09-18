import { open } from 'node:fs/promises';

export interface SegmentRedisLike {
  mget(...keys: string[]): Promise<Array<string | null>>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
}

export type SegmentCacheOptions = {
  segmentBytes: number;
  ttlSeconds: number;
  maxSegmentsPerRequest: number;
  keyPrefix?: string;
};

// 服务端分段缓存：把音频文件按固定大小分段缓存在 Redis。
// 缓存键必须包含文件版本标识（如 recordingId + ETag），
// 文件被替换后旧段永远不会被命中，多段下载/断线续传不会拼错版本。
// 任何异常（缓存缺失、长度不符、Redis 故障）都返回 null，由调用方回退磁盘流，
// 宁可多读盘也绝不返回错位或不完整的内容。
export class SegmentCache {
  private readonly segmentBytes: number;
  private readonly ttlSeconds: number;
  private readonly maxSegments: number;
  private readonly keyPrefix: string;

  constructor(
    private readonly redis: SegmentRedisLike,
    options: SegmentCacheOptions,
  ) {
    this.segmentBytes = Math.max(1, Math.floor(options.segmentBytes));
    this.ttlSeconds = Math.max(1, Math.floor(options.ttlSeconds));
    this.maxSegments = Math.max(1, Math.floor(options.maxSegmentsPerRequest));
    this.keyPrefix = options.keyPrefix ?? 'media-seg:';
  }

  private key(fileKey: string, segmentIndex: number): string {
    return `${this.keyPrefix}${fileKey}:${segmentIndex}`;
  }

  private expectedSegmentLength(segmentIndex: number, size: number): number | null {
    const segmentStart = segmentIndex * this.segmentBytes;
    if (segmentStart < 0 || segmentStart >= size) return null;
    return Math.min(this.segmentBytes, size - segmentStart);
  }

  async readRange(
    fileKey: string,
    filePath: string,
    size: number,
    start: number,
    end: number,
  ): Promise<Buffer | null> {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      start < 0 ||
      end < start ||
      end >= size
    ) {
      return null;
    }

    const firstSegment = Math.floor(start / this.segmentBytes);
    const lastSegment = Math.floor(end / this.segmentBytes);
    const segmentCount = lastSegment - firstSegment + 1;
    if (segmentCount > this.maxSegments) return null;

    const keys: string[] = [];
    for (let index = firstSegment; index <= lastSegment; index += 1) {
      keys.push(this.key(fileKey, index));
    }

    let cached: Array<string | null>;
    try {
      cached = await this.redis.mget(...keys);
    } catch {
      return null;
    }
    if (!Array.isArray(cached) || cached.length !== keys.length) return null;

    const segments: Array<Buffer | null> = cached.map((value) =>
      value === null || value === undefined ? null : Buffer.from(value, 'base64'),
    );

    // 命中缓存的段必须长度精确，否则视为脏数据整体回退
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (!segment) continue;
      const expected = this.expectedSegmentLength(firstSegment + index, size);
      if (expected === null || segment.length !== expected) return null;
    }

    const missing: number[] = [];
    for (let index = 0; index < segments.length; index += 1) {
      if (!segments[index]) missing.push(index);
    }

    if (missing.length > 0) {
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(filePath, 'r');
        for (const index of missing) {
          const segmentIndex = firstSegment + index;
          const expected = this.expectedSegmentLength(segmentIndex, size);
          if (expected === null) return null;
          const buffer = Buffer.allocUnsafe(expected);
          const { bytesRead } = await handle.read(
            buffer,
            0,
            expected,
            segmentIndex * this.segmentBytes,
          );
          if (bytesRead !== expected) return null;
          segments[index] = buffer;
        }
      } catch {
        return null;
      } finally {
        if (handle) await handle.close().catch(() => undefined);
      }

      // 回填缓存是尽力而为，失败不影响本次响应
      await Promise.all(
        missing.map((index) => {
          const segment = segments[index];
          if (!segment) return Promise.resolve();
          return Promise.resolve(
            this.redis.set(keys[index], segment.toString('base64'), 'EX', this.ttlSeconds),
          ).catch(() => undefined);
        }),
      );
    }

    const total = end - start + 1;
    const output = Buffer.allocUnsafe(total);
    let offset = 0;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (!segment) return null;
      const segmentStart = (firstSegment + index) * this.segmentBytes;
      const sliceStart = Math.max(start - segmentStart, 0);
      const sliceEnd = Math.min(end - segmentStart + 1, segment.length);
      if (sliceEnd <= sliceStart) return null;
      segment.copy(output, offset, sliceStart, sliceEnd);
      offset += sliceEnd - sliceStart;
    }
    if (offset !== total) return null;
    return output;
  }
}
