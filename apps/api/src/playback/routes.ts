import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { stat } from 'node:fs/promises';
import { SegmentCache } from './segment-cache.js';
import { TicketInvalidError, TicketStore } from './ticket-store.js';
import {
  createMediaStream,
  isRangeCacheable,
  readBoundedRange,
  type MediaFile,
} from './media-stream.js';
import { parseByteRange } from './range.js';
import { HttpError } from '../errors.js';

type AuthUser = { id: string; email: string };

type PlaybackRecording = {
  id: string;
  workspaceId: string;
  mimeType: string | null;
  playbackPath: string | null;
  originalPath: string;
};

export type PlaybackDeps = {
  findRecording: (id: string) => Promise<PlaybackRecording | null>;
  findMembership: (workspaceId: string, userId: string) => Promise<unknown>;
  authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  authUser: (req: FastifyRequest) => AuthUser;
  ticketStore: TicketStore;
  cache?: SegmentCache;
  ticketTtlSeconds?: number;
};

const DEFAULT_TICKET_TTL_SECONDS = 600;

/**
 * 音频播放相关路由：
 * - POST /v1/recordings/:id/playback-ticket 已登录成员换取短时票据
 * - GET  /v1/recordings/:id/file             票据（或 Authorization）+ Range 流式读取
 *
 * 鉴权顺序：先确认调用方有权访问该录音，再解析 Range。越权请求（包括拿着别人的票据
 * 试探 Range）一律 404/401，绝不返回文件大小等任何内容线索。
 */
export const playbackRoutes: FastifyPluginAsync<PlaybackDeps> = async (app, deps) => {
  const cache = deps.cache ?? new SegmentCache();
  const ticketTtlSeconds = deps.ticketTtlSeconds ?? DEFAULT_TICKET_TTL_SECONDS;

  // 票据失效属于本插件的正常鉴权失败，不能冒泡成 500。
  app.setErrorHandler((error: Error, req, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details },
        requestId: req.id,
      });
    }
    if (error.name === 'TicketInvalidError') {
      return reply.code(401).send({
        error: { code: 'INVALID_PLAYBACK_TICKET', message: '播放票据无效或已过期' },
        requestId: req.id,
      });
    }
    req.log.error({ err: error }, 'playback request failed');
    return reply.code(500).send({
      error: { code: 'INTERNAL_SERVER_ERROR', message: '服务器内部错误' },
      requestId: req.id,
    });
  });

  async function resolveRecordingForRequest(
    req: FastifyRequest,
    reply: FastifyReply,
    recordingId: string,
  ): Promise<{ recording: PlaybackRecording; userId: string }> {
    const queryTicket = readTicketQuery(req);

    if (queryTicket) {
      // 票据内部再次校验 recordingId：A 录音的票据不能用于 B 录音。
      const ticket = await deps.ticketStore.consume(queryTicket, recordingId);
      const recording = await deps.findRecording(recordingId);
      if (!recording) throw new HttpError(404, 'NOT_FOUND', '录音不存在');
      // 票据换取时已校验过成员身份；票据短时效，期间不重复查库。
      return { recording, userId: ticket.userId };
    }

    // 兼容开发期直接带 Authorization 头的客户端；URL 上的 JWT 不再被接受。
    await deps.authenticate(req, reply);
    const user = deps.authUser(req);
    const recording = await deps.findRecording(recordingId);
    if (!recording) throw new HttpError(404, 'NOT_FOUND', '录音不存在');
    if (!(await deps.findMembership(recording.workspaceId, user.id))) {
      throw new HttpError(404, 'NOT_FOUND', '录音不存在');
    }
    return { recording, userId: user.id };
  }

  app.post(
    '/v1/recordings/:id/playback-ticket',
    { preHandler: deps.authenticate },
    async (req, reply) => {
      const recordingId = (req.params as { id: string }).id;
      const recording = await deps.findRecording(recordingId);
      if (!recording) throw new HttpError(404, 'NOT_FOUND', '录音不存在');

      const user = deps.authUser(req);
      if (!(await deps.findMembership(recording.workspaceId, user.id))) {
        // 与既有接口一致：不存在/无权限都返回 404，避免泄露录音是否存在。
        throw new HttpError(404, 'NOT_FOUND', '录音不存在');
      }

      const ticket = await deps.ticketStore.issue(recording.id, user.id, ticketTtlSeconds);
      return reply.code(201).send({
        data: {
          ticket: ticket.ticket,
          expiresAt: new Date(ticket.expiresAt).toISOString(),
          expiresInSeconds: ticketTtlSeconds,
        },
      });
    },
  );

  app.get('/v1/recordings/:id/file', async (req, reply) => {
    const recordingId = (req.params as { id: string }).id;
    const { recording } = await resolveRecordingForRequest(req, reply, recordingId);

    const filePath = recording.playbackPath || recording.originalPath;
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      throw new HttpError(404, 'FILE_NOT_FOUND', '录音文件不存在');
    }
    if (!fileStat.isFile()) {
      throw new HttpError(404, 'FILE_NOT_FOUND', '录音文件不存在');
    }

    const media: MediaFile = {
      id: recording.id,
      path: filePath,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
    };

    const rangeHeader = req.headers.range;
    const range = rangeHeader ? parseByteRange(rangeHeader, fileStat.size) : null;
    if (rangeHeader && !range) {
      // 越权 / 非法 Range：通过鉴权后才走到这里；范围本身不合法返回标准 416。
      return reply
        .code(416)
        .header('Content-Range', `bytes */${fileStat.size}`)
        .send();
    }

    reply
      .type(recording.mimeType || 'application/octet-stream')
      .header('Accept-Ranges', 'bytes')
      // 内容仍为私密数据：任何中间层/浏览器磁盘缓存都不得保存；分段缓存只存在于服务端内存。
      .header('Cache-Control', 'private, no-store')
      // 避免浏览器在跨站跳转时把带票据的 URL 放进 Referer。
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Content-Type-Options', 'nosniff');

    if (!range) {
      return reply
        .header('Content-Length', fileStat.size)
        .send(createMediaStream(cache, media, 0, fileStat.size - 1));
    }

    if (isRangeCacheable(cache, range.start, range.end)) {
      const body = await readBoundedRange(cache, media, range.start, range.end);
      return reply
        .code(206)
        .header('Content-Length', body.length)
        .header('Content-Range', `bytes ${range.start}-${range.end}/${fileStat.size}`)
        .send(body);
    }

    return reply
      .code(206)
      .header('Content-Length', range.end - range.start + 1)
      .header('Content-Range', `bytes ${range.start}-${range.end}/${fileStat.size}`)
      .send(createMediaStream(cache, media, range.start, range.end));
  });
};

function readTicketQuery(req: FastifyRequest): string | undefined {
  const query = req.query as { ticket?: unknown } | undefined;
  return typeof query?.ticket === 'string' && query.ticket.length > 0
    ? query.ticket
    : undefined;
}
