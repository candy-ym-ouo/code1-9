import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpError } from '../src/errors.js';
import {
  createFileUserResolver,
  createRecordingFileHandler,
  type RecordingFileInfo,
} from '../src/media/fileRoute.js';
import { PlaybackTicketStore } from '../src/media/playbackTickets.js';
import { SegmentCache } from '../src/media/segmentCache.js';

class FakeRedis {
  readonly store = new Map<string, { value: string; expiresAt: number }>();

  async set(key: string, value: string, ...args: unknown[]): Promise<string> {
    let ttlSeconds: number | undefined;
    for (let index = 0; index < args.length - 1; index += 1) {
      if (String(args[index]).toUpperCase() === 'EX') {
        ttlSeconds = Number(args[index + 1]);
      }
    }
    this.store.set(key, {
      value,
      expiresAt: ttlSeconds === undefined ? Infinity : Date.now() + ttlSeconds * 1000,
    });
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }

  async mget(...keys: string[]): Promise<Array<string | null>> {
    return Promise.all(keys.map((key) => this.get(key)));
  }
}

const SEGMENT = 512;
const SIZE = SEGMENT * 3 + 200; // 3 个完整段 + 1 个尾段，覆盖多段装配
const MEMBERS = new Set(['user-1']);

let dir: string;
let filePath: string;
let content: Buffer;
let redis: FakeRedis;
let tickets: PlaybackTicketStore;
let app: ReturnType<typeof Fastify>;
let recording: RecordingFileInfo;

function buildContent(size: number): Buffer {
  const buffer = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) {
    buffer[index] = (index * 17 + 41) % 256;
  }
  return buffer;
}

async function issueTicket(recordingId: string, userId: string): Promise<string> {
  const { ticket } = await tickets.issue({ recordingId, userId });
  return ticket;
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'file-route-'));
  filePath = path.join(dir, 'interview.mp3');
  content = buildContent(SIZE);
  await writeFile(filePath, content);

  redis = new FakeRedis();
  tickets = new PlaybackTicketStore(redis, { ttlSeconds: 120 });
  const segmentCache = new SegmentCache(redis, {
    segmentBytes: SEGMENT,
    ttlSeconds: 600,
    maxSegmentsPerRequest: 16,
  });

  recording = {
    id: 'rec-1',
    workspaceId: 'ws-1',
    mimeType: 'audio/mpeg',
    playbackPath: null,
    originalPath: filePath,
  };

  const resolveUser = createFileUserResolver({
    verifyJwt: async (token) => (token === 'valid-jwt' ? { id: 'user-1' } : null),
    tickets,
  });

  app = Fastify({ logger: false });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof HttpError) {
      return reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message } });
    }
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'boom' } });
  });
  app.get(
    '/v1/recordings/:id/file',
    createRecordingFileHandler({
      findRecording: async (id) => (id === recording.id ? recording : null),
      resolveUser,
      isMember: async (_workspaceId, userId) => MEMBERS.has(userId),
      segmentCache,
    }),
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe('recording file route authorization', () => {
  it('rejects requests without credentials', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/recordings/rec-1/file' });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('rec-1');
  });

  it('rejects range requests without credentials too', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/recordings/rec-1/file',
      headers: { range: 'bytes=0-99' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.rawPayload.length).toBeLessThan(200);
  });

  it('rejects a ticket issued for a different recording', async () => {
    const ticket = await issueTicket('rec-other', 'user-1');
    const res = await app.inject({
      method: 'GET',
      url: `/v1/recordings/rec-1/file?ticket=${ticket}`,
      headers: { range: 'bytes=0-99' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('PLAYBACK_TICKET_INVALID');
  });

  it('rejects unknown and garbage tickets', async () => {
    for (const bad of ['n'.repeat(32), '!!!', '']) {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/recordings/rec-1/file?ticket=${bad}`,
      });
      expect([401, 404]).toContain(res.statusCode);
      expect(res.statusCode).not.toBe(200);
    }
  });

  it('rejects a ticket whose user lost membership', async () => {
    const ticket = await issueTicket('rec-1', 'user-outsider');
    const res = await app.inject({
      method: 'GET',
      url: `/v1/recordings/rec-1/file?ticket=${ticket}`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects an expired ticket', async () => {
    const shortLived = new PlaybackTicketStore(redis, { ttlSeconds: 5 });
    const { ticket } = await shortLived.issue({ recordingId: 'rec-1', userId: 'user-1' });
    const key = `playback:ticket:${ticket}`;
    const entry = redis.store.get(key);
    if (entry) entry.expiresAt = Date.now() - 1; // 强制过期
    const res = await app.inject({
      method: 'GET',
      url: `/v1/recordings/rec-1/file?ticket=${ticket}`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 for unknown recordings even with a valid ticket', async () => {
    const ticket = await issueTicket('rec-1', 'user-1');
    const res = await app.inject({
      method: 'GET',
      url: `/v1/recordings/rec-missing/file?ticket=${ticket}`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('accepts a bearer JWT', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/recordings/rec-1/file',
      headers: { authorization: 'Bearer valid-jwt', range: 'bytes=0-9' },
    });
    expect(res.statusCode).toBe(206);
    expect(res.rawPayload).toEqual(content.subarray(0, 10));
  });
});

describe('recording file route streaming', () => {
  it('serves the full file with caching headers and etag', async () => {
    const ticket = await issueTicket('rec-1', 'user-1');
    const res = await app.inject({
      method: 'GET',
      url: `/v1/recordings/rec-1/file?ticket=${ticket}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-length']).toBe(String(SIZE));
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers.etag).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-type']).toContain('audio/mpeg');
    expect(res.rawPayload).toEqual(content);
  });

  it('serves a single range with 206 and exact bytes', async () => {
    const ticket = await issueTicket('rec-1', 'user-1');
    const res = await app.inject({
      method: 'GET',
      url: `/v1/recordings/rec-1/file?ticket=${ticket}`,
      headers: { range: 'bytes=100-199' },
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 100-199/${SIZE}`);
    expect(res.headers['content-length']).toBe('100');
    expect(res.rawPayload).toEqual(content.subarray(100, 200));
  });

  it('rejects unsatisfiable ranges with 416', async () => {
    const ticket = await issueTicket('rec-1', 'user-1');
    const res = await app.inject({
      method: 'GET',
      url: `/v1/recordings/rec-1/file?ticket=${ticket}`,
      headers: { range: `bytes=${SIZE + 100}-` },
    });
    expect(res.statusCode).toBe(416);
    expect(res.headers['content-range']).toBe(`bytes */${SIZE}`);
  });

  it('reassembles a multi-segment download without misalignment', async () => {
    const ticket = await issueTicket('rec-1', 'user-1');
    const chunks: Buffer[] = [];
    const step = 300; // 故意不对齐段边界
    for (let start = 0; start < SIZE; start += step) {
      const end = Math.min(start + step - 1, SIZE - 1);
      const res = await app.inject({
        method: 'GET',
        url: `/v1/recordings/rec-1/file?ticket=${ticket}`,
        headers: { range: `bytes=${start}-${end}` },
      });
      expect(res.statusCode).toBe(206);
      expect(res.headers['content-range']).toBe(`bytes ${start}-${end}/${SIZE}`);
      chunks.push(res.rawPayload);
    }
    expect(Buffer.concat(chunks)).toEqual(content);
    // 确认确实走了缓存（段键已写入）
    expect([...redis.store.keys()].some((key) => key.startsWith('media-seg:rec-1:'))).toBe(
      true,
    );
  });

  it('resumes an interrupted download with If-Range and stays aligned', async () => {
    const ticket = await issueTicket('rec-1', 'user-1');
    const first = await app.inject({
      method: 'GET',
      url: `/v1/recordings/rec-1/file?ticket=${ticket}`,
      headers: { range: 'bytes=0-499' },
    });
    expect(first.statusCode).toBe(206);
    const etag = first.headers.etag as string;

    // 断线重连：带上 If-Range 继续下载剩余部分
    const rest = await app.inject({
      method: 'GET',
      url: `/v1/recordings/rec-1/file?ticket=${ticket}`,
      headers: { range: 'bytes=500-', 'if-range': etag },
    });
    expect(rest.statusCode).toBe(206);
    expect(rest.headers['content-range']).toBe(`bytes 500-${SIZE - 1}/${SIZE}`);
    expect(Buffer.concat([first.rawPayload, rest.rawPayload])).toEqual(content);
  });

  it('falls back to 200 full content when If-Range is stale', async () => {
    const ticket = await issueTicket('rec-1', 'user-1');
    const res = await app.inject({
      method: 'GET',
      url: `/v1/recordings/rec-1/file?ticket=${ticket}`,
      headers: { range: 'bytes=500-', 'if-range': '"deadbeef-0"' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload).toEqual(content);
  });

  it('serves correct bytes even when a cached segment is corrupted', async () => {
    const ticket = await issueTicket('rec-1', 'user-1');
    // 先正常请求一次让段进入缓存
    const warm = await app.inject({
      method: 'GET',
      url: `/v1/recordings/rec-1/file?ticket=${ticket}`,
      headers: { range: 'bytes=0-99' },
    });
    expect(warm.statusCode).toBe(206);

    // 找到该录音的段缓存键并破坏内容
    const segmentKey = [...redis.store.keys()].find((key) =>
      key.startsWith('media-seg:rec-1:'),
    );
    expect(segmentKey).toBeDefined();
    redis.store.set(segmentKey as string, {
      value: Buffer.from('corrupted').toString('base64'),
      expiresAt: Infinity,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/recordings/rec-1/file?ticket=${ticket}`,
      headers: { range: 'bytes=0-99' },
    });
    expect(res.statusCode).toBe(206);
    expect(res.rawPayload).toEqual(content.subarray(0, 100));
  });
});
