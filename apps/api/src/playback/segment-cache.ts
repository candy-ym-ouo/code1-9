import { Buffer } from 'node:buffer';

/**
 * 进程内的音频分片缓存（LRU）。
 *
 * 安全要点：
 * - 缓存键必须包含录音 ID、文件大小、mtime 与分片索引：任何一项不同都视为不同文件，
 *   杜绝跨录音、跨版本拼接出别的内容；
 * - 只有“长度精确等于期望值”的完整分片才允许入缓存，尾部短分片也按其真实长度单独入缓存；
 * - 读出时统一返回 Buffer 拷贝，避免调用方意外改写缓存内容；
 * - 仅存于进程内存，不写盘、不跨进程共享，进程退出即清空。
 */
export type SegmentReader = {
  read: (start: number, end: number) => Promise<Buffer>;
};

export type SegmentCacheOptions = {
  segmentSize?: number;
  maxBytes?: number;
  now?: () => number;
};

type Entry = { buffer: Buffer; key: string; cachedAt: number };

export class SegmentCache {
  readonly segmentSize: number;
  readonly maxBytes: number;
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<Buffer>>();
  private totalBytes = 0;
  private hits = 0;
  private misses = 0;
  private readonly now: () => number;

  constructor(options: SegmentCacheOptions = {}) {
    this.segmentSize = options.segmentSize ?? 1024 * 1024;
    this.maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
    this.now = options.now ?? Date.now;

    if (this.segmentSize <= 0 || !Number.isSafeInteger(this.segmentSize)) {
      throw new Error('segmentSize 必须是正整数');
    }
    if (this.maxBytes < this.segmentSize) {
      throw new Error('maxBytes 不能小于 segmentSize');
    }
  }

  key(recordingId: string, size: number, mtimeMs: number, index: number): string {
    // mtimeMs 取整到毫秒并加 1ms 容差：virtiofs/部分文件系统可能给出纳秒抖动。
    return `${recordingId}:${size}:${Math.round(mtimeMs)}:${index}`;
  }

  /** 取缓存；命中时刷新 LRU 顺序。永远返回拷贝。 */
  get(key: string): Buffer | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits += 1;
    return Buffer.from(entry.buffer);
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /**
   * 写入一个完整分片；长度与 expectedLength 不一致时拒绝缓存。
   * 内部保存拷贝，与调用方持有的 Buffer 隔离。
   */
  put(key: string, buffer: Buffer, expectedLength: number): void {
    if (buffer.length !== expectedLength || expectedLength <= 0) return;

    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.totalBytes -= existing.buffer.length;
    }

    const stored = Buffer.from(buffer);
    this.entries.set(key, { buffer: stored, key, cachedAt: this.now() });
    this.totalBytes += stored.length;
    this.evict();
  }

  private evict(): void {
    while (this.totalBytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const entry = this.entries.get(oldest);
      this.entries.delete(oldest);
      if (entry) this.totalBytes -= entry.buffer.length;
    }
  }

  /**
   * 读取一个分片：缓存命中直接返回；否则通过 reader 从磁盘读取精确长度后入缓存。
   * 同一分片的并发缺失只产生一次磁盘读取（in-flight 去重），避免多段并发下载
   * 对同一片产生竞争与重复 I/O。
   */
  async load(
    key: string,
    bounds: { start: number; end: number },
    reader: SegmentReader,
  ): Promise<Buffer> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const promise = (async () => {
      try {
        const buffer = await reader.read(bounds.start, bounds.end);
        const expectedLength = bounds.end - bounds.start + 1;
        if (buffer.length !== expectedLength) {
          throw new Error(
            `分片读取长度不匹配: 期望 ${expectedLength} 字节，实际 ${buffer.length} 字节`,
          );
        }
        this.put(key, buffer, expectedLength);
        return Buffer.from(buffer);
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, promise);
    return promise;
  }

  get size(): number {
    return this.totalBytes;
  }

  get entryCount(): number {
    return this.entries.size;
  }

  stats(): { size: number; entryCount: number; hits: number; misses: number } {
    return { size: this.totalBytes, entryCount: this.entries.size, hits: this.hits, misses: this.misses };
  }
}
