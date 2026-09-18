import { Buffer } from 'node:buffer';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import jwt from '@fastify/jwt';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { playbackRoutes } from './routes.js';
import { SegmentCache } from './segment-cache.js';
import { TicketInvalidError } from './ticket-store.js';
import { HttpError } from '../errors.js';

type AuthUser = { id: string; email: string };

const CONTENT = Buffer.from(Array.from({ length: 5000 }, (_, index) => index % 251));

async function buildApp() {
  const dir = await mkdtemp(path.join(tmpdir(), 'playback-routes-'));
  const fileA = path.join(dir, 'a.bin');
  const fileB = path.join(dir, 'b.bin');
  await writeFile(fileA, CONTENT);
  await writeFile(fileB, Buffer.alloc(CONTENT.length, 9));

  const members = new Map<string, Set<string>>([
    ['workspace-a', new Set(['user-member'])],
    ['workspace-b', new Set(['user-other'])],
  ]);

  type RecordingRow = {
    id: string;
    workspaceId: string;
    mimeType: string | null;
    playbackPath: string | null;
    originalPath: string;
  };

  const recordings: Record<string, RecordingRow> = {
    'rec-a': {
      id: 'rec-a',
      workspaceId: 'workspace-a',
      mimeType: 'audio/mpeg',
      playbackPath: null,
      originalPath: fileA,
    },
    'rec-b': {
      id: 'rec-b',
      workspaceId: 'workspace-b',
      mimeType: 'audio/mpeg',
      playbackPath: null,
      originalPath: fileB,
    },
  };

  const app = Fastify({ logger: false });
  await app.register(jwt, { secret: 'test-secret-at-least-32-characters-long' });

  const authenticate = async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      await reply
        .code(401)
        .send({ error: { code: 'UNAUTHENTICATED', message: '请先登录' } });
    }
  };

  const inMemoryTickets = new Map<string, { recordingId: string; userId: string; expiresAt: number }>();

  await app.register(playbackRoutes, {
    findRecording: async (id) => recordings[id] ?? null,
    findMembership: async (workspaceId, userId) =>
      members.get(workspaceId)?.has(userId) ? ({}) : null,
    authenticate,
    authUser: (req) => req.user as AuthUser,
    ticketStore: {
      async issue(recordingId, userId, ttlSeconds) {
        // 测试用简单不透明票据
        const ticket = `ticket-${recordingId}-${userId}-${inMemoryTickets.size}`;
        const expiresAt = Date.now() + ttlSeconds * 1000;
        inMemoryTickets.set(ticket, { recordingId, userId, expiresAt });
        return { ticket, recordingId, userId, expiresAt };
      },
      async consume(ticket, recordingId) {
        const stored = inMemoryTickets.get(ticket);
        if (!stored || stored.expiresAt <= Date.now() || stored.recordingId !== recordingId) {
          return Promise.reject(new TicketInvalidError());
        }
        return { ticket, ...stored };
      },
    },
    cache: new SegmentCache({ segmentSize: 1024, maxBytes: 1024 * 1024 }),
    ticketTtlSeconds: 600,
  });

  app.setErrorHandler((error: Error, req, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message },
        requestId: req.id,
      });
    }
    if (error.name === 'TicketInvalidError') {
      return reply
        .code(401)
        .send({ error: { code: 'INVALID_PLAYBACK_TICKET', message: '播放票据无效或已过期' } });
    }
    return reply.code(500).send({ error: { code: 'INTERNAL', message: error.message } });
  });

  const token = app.jwt.sign({ id: 'user-member', email: 'member@example.com' });
  const otherToken = app.jwt.sign({ id: 'user-outsider', email: 'outsider@example.com' });

  return { app, dir, token, otherToken };
}

describe('playback routes', () => {
  let harness: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    harness = await buildApp();
  });

  afterAll(async () => {
    await harness.app.close();
    await rm(harness.dir, { recursive: true, force: true });
  });

  it('issues a short-lived ticket only to workspace members', async () => {
    const ok = await harness.app.inject({
      method: 'POST',
      url: '/v1/recordings/rec-a/playback-ticket',
      headers: { authorization: `Bearer ${harness.token}` },
    });
    expect(ok.statusCode).toBe(201);
    const body = ok.json() as { data: { ticket: string; expiresInSeconds: number } };
    expect(body.data.ticket).toBeTruthy();
    expect(body.data.expiresInSeconds).toBe(600);

    const anon = await harness.app.inject({
      method: 'POST',
      url: '/v1/recordings/rec-a/playback-ticket',
    });
    expect(anon.statusCode).toBe(401);

    const outsider = await harness.app.inject({
      method: 'POST',
      url: '/v1/recordings/rec-a/playback-ticket',
      headers: { authorization: `Bearer ${harness.otherToken}` },
    });
    // 无权限与不存在同样返回 404，不泄露录音存在性
    expect(outsider.statusCode).toBe(404);
  });

  it('rejects unauthenticated file requests without leaking metadata', async () => {
    const res = await harness.app.inject({
      method: 'GET',
      url: '/v1/recordings/rec-a/file',
      headers: { range: 'bytes=0-99' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-range']).toBeUndefined();
  });

  it('serves multi-segment ranges exactly via a valid ticket and keeps headers private', async () => {
    const issued = await harness.app.inject({
      method: 'POST',
      url: '/v1/recordings/rec-a/playback-ticket',
      headers: { authorization: `Bearer ${harness.token}` },
    });
    const ticket = (issued.json() as { data: { ticket: string } }).data.ticket;

    const ranges: Array<[string, number, number]> = [
      ['bytes=0-99', 0, 99],
      ['bytes=1023-1024', 1023, 1024],
      ['bytes=2048-4095', 2048, 4095],
      ['bytes=4500-', 4500, CONTENT.length - 1],
    ];

    for (const [header, start, end] of ranges) {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/v1/recordings/rec-a/file?ticket=${encodeURIComponent(ticket)}`,
        headers: { range: header },
      });
      expect(res.statusCode, `${header} failed`).toBe(206);
      expect(res.headers['content-range']).toBe(
        `bytes ${start}-${end}/${CONTENT.length}`,
      );
      expect(res.headers['cache-control']).toBe('private, no-store');
      const payload = res.rawPayload;
      expect(payload.length).toBe(end - start + 1);
      expect(payload.equals(CONTENT.subarray(start, end + 1))).toBe(true);
    }
  });

  it('refuses a ticket issued for a different recording', async () => {
    const issued = await harness.app.inject({
      method: 'POST',
      url: '/v1/recordings/rec-a/playback-ticket',
      headers: { authorization: `Bearer ${harness.token}` },
    });
    const ticket = (issued.json() as { data: { ticket: string } }).data.ticket;

    // user-member 不属于 workspace-b：即便持有 rec-a 的票据，也不能取 rec-b
    const cross = await harness.app.inject({
      method: 'GET',
      url: `/v1/recordings/rec-b/file?ticket=${encodeURIComponent(ticket)}`,
      headers: { range: 'bytes=0-99' },
    });
    expect(cross.statusCode).toBe(401);
    expect(cross.json()).toMatchObject({
      error: { code: 'INVALID_PLAYBACK_TICKET' },
    });
  });

  it('returns 404 for an unauthorized bearer request even with a Range header', async () => {
    const res = await harness.app.inject({
      method: 'GET',
      url: '/v1/recordings/rec-a/file',
      headers: {
        authorization: `Bearer ${harness.otherToken}`,
        range: 'bytes=0-99',
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-range']).toBeUndefined();
  });

  it('rejects invalid or multi-part Range headers with 416 only after authorization', async () => {
    const issued = await harness.app.inject({
      method: 'POST',
      url: '/v1/recordings/rec-a/playback-ticket',
      headers: { authorization: `Bearer ${harness.token}` },
    });
    const ticket = (issued.json() as { data: { ticket: string } }).data.ticket;

    const bad = await harness.app.inject({
      method: 'GET',
      url: `/v1/recordings/rec-a/file?ticket=${encodeURIComponent(ticket)}`,
      headers: { range: 'bytes=999999-' },
    });
    expect(bad.statusCode).toBe(416);
    expect(bad.headers['content-range']).toBe(`bytes */${CONTENT.length}`);

    const multi = await harness.app.inject({
      method: 'GET',
      url: `/v1/recordings/rec-a/file?ticket=${encodeURIComponent(ticket)}`,
      headers: { range: 'bytes=0-99,200-299' },
    });
    expect(multi.statusCode).toBe(416);
  });

  it('serves the full file without a Range header and supports reconnect-style resume', async () => {
    const issued = await harness.app.inject({
      method: 'POST',
      url: '/v1/recordings/rec-a/playback-ticket',
      headers: { authorization: `Bearer ${harness.token}` },
    });
    const ticket = (issued.json() as { data: { ticket: string } }).data.ticket;

    const full = await harness.app.inject({
      method: 'GET',
      url: `/v1/recordings/rec-a/file?ticket=${encodeURIComponent(ticket)}`,
    });
    expect(full.statusCode).toBe(200);
    expect(full.rawPayload.equals(CONTENT)).toBe(true);

    // 模拟断线重连：从断点继续，拼起来必须与整文件完全一致
    const resume = await harness.app.inject({
      method: 'GET',
      url: `/v1/recordings/rec-a/file?ticket=${encodeURIComponent(ticket)}`,
      headers: { range: 'bytes=3000-' },
    });
    expect(resume.statusCode).toBe(206);
    expect(resume.rawPayload.equals(CONTENT.subarray(3000))).toBe(true);
  });
});
