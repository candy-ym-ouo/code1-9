import type { FastifyReply, FastifyRequest } from 'fastify';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { HttpError } from '../errors.js';
import { buildFileEtag, parseByteRange, shouldHonorRange } from './range.js';
import type { PlaybackTicketStore } from './playbackTickets.js';
import type { SegmentCache } from './segmentCache.js';

export type RecordingFileInfo = {
  id: string;
  workspaceId: string;
  mimeType: string | null;
  playbackPath: string | null;
  originalPath: string;
};

export type RecordingFileRouteDeps = {
  findRecording(id: string): Promise<RecordingFileInfo | null>;
  // 返回 null 表示未携带有效身份；票据无效/越权时必须抛出 HttpError(401)
  resolveUser(req: FastifyRequest, recordingId: string): Promise<{ id: string } | null>;
  isMember(workspaceId: string, userId: string): Promise<boolean>;
  segmentCache: SegmentCache;
};

// 音频流鉴权：优先 Bearer JWT，其次短时播放票据（?ticket=）。
// 票据无效/过期/不属于目标录音时抛出 401，调用方不得放行任何字节。
export function createFileUserResolver(deps: {
  verifyJwt(token: string): Promise<{ id: string } | null>;
  tickets: PlaybackTicketStore;
}) {
  return async function resolveFileUser(
    req: FastifyRequest,
    recordingId: string,
  ): Promise<{ id: string } | null> {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      return deps.verifyJwt(header.slice(7));
    }

    const query = req.query as { ticket?: unknown } | undefined;
    if (typeof query?.ticket === 'string' && query.ticket) {
      const payload = await deps.tickets.verify(query.ticket);
      if (!payload || payload.recordingId !== recordingId) {
        throw new HttpError(401, 'PLAYBACK_TICKET_INVALID', '播放票据无效或已过期');
      }
      return { id: payload.userId };
    }

    return null;
  };
}

// GET /v1/recordings/:id/file
// 鉴权（Bearer 或短时票据）→ ETag/If-Range → Range 解析 → 分段缓存 → 磁盘回退。
// 未授权一律 404，不暴露资源是否存在；缓存异常一律回退磁盘，不返回错位字节。
export function createRecordingFileHandler(deps: RecordingFileRouteDeps) {
  return async function recordingFileHandler(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<unknown> {
    const recordingId = (req.params as { id: string }).id;
    const recording = await deps.findRecording(recordingId);
    if (!recording) {
      throw new HttpError(404, 'NOT_FOUND', '录音不存在');
    }

    const user = await deps.resolveUser(req, recording.id);
    if (!user || !(await deps.isMember(recording.workspaceId, user.id))) {
      throw new HttpError(404, 'NOT_FOUND', '录音不存在');
    }

    const filePath = recording.playbackPath || recording.originalPath;
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      throw new HttpError(404, 'FILE_NOT_FOUND', '录音文件不存在');
    }

    const etag = buildFileEtag(fileStat);
    reply
      .type(recording.mimeType || 'application/octet-stream')
      .header('Accept-Ranges', 'bytes')
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('ETag', etag)
      .header('Last-Modified', new Date(fileStat.mtimeMs).toUTCString());

    const ifRangeHeader = req.headers['if-range'];
    const ifRange = Array.isArray(ifRangeHeader) ? ifRangeHeader[0] : ifRangeHeader;
    const rangeHeader = req.headers.range;
    const honorRange = shouldHonorRange(ifRange, etag, fileStat.mtimeMs);
    const range =
      rangeHeader && honorRange ? parseByteRange(rangeHeader, fileStat.size) : null;
    if (rangeHeader && honorRange && !range) {
      return reply
        .code(416)
        .header('Content-Range', `bytes */${fileStat.size}`)
        .send();
    }

    if (!range) {
      return reply
        .header('Content-Length', fileStat.size)
        .send(createReadStream(filePath));
    }

    reply
      .code(206)
      .header('Content-Length', range.end - range.start + 1)
      .header(
        'Content-Range',
        `bytes ${range.start}-${range.end}/${fileStat.size}`,
      );

    // 优先走分段缓存；缓存未命中或异常时回退磁盘流，保证字节不错位
    const cached = await deps.segmentCache.readRange(
      `${recording.id}:${etag}`,
      filePath,
      fileStat.size,
      range.start,
      range.end,
    );
    if (cached) {
      return reply.send(cached);
    }

    return reply.send(createReadStream(filePath, { start: range.start, end: range.end }));
  };
}
