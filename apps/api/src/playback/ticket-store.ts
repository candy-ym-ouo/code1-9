import crypto from 'node:crypto';
import type { Redis } from 'ioredis';
import { HttpError } from '../errors.js';

/**
 * 短时播放票据。
 *
 * 设计目标：让 <audio src> 这类无法携带 Authorization 头的请求，不再把 2 小时有效的
 * 登录 JWT 拼在 URL 上（会进入日志、浏览器历史、Referer）。票据是不透明随机串，
 * - 只能由已登录成员通过 POST 接口换取；
 * - 绑定具体录音与授权用户，服务端存储（Redis）可即时失效；
 * - 有效期很短（默认 10 分钟，覆盖一次连续播放/若干次 Range 与断线重连）；
 * - 票据本身不携带任何用户信息，无法被改写或伪造。
 */
export type PlaybackTicket = {
  ticket: string;
  recordingId: string;
  userId: string;
  expiresAt: number;
};

export type TicketStore = {
  issue(recordingId: string, userId: string, ttlSeconds: number): Promise<PlaybackTicket>;
  consume(ticket: string, recordingId: string): Promise<PlaybackTicket>;
};

export class TicketInvalidError extends Error {
  constructor(message = '播放票据无效或已过期') {
    super(message);
    this.name = 'TicketInvalidError';
  }
}

export class RedisTicketStore implements TicketStore {
  constructor(private readonly redis: Redis) {}

  async issue(recordingId: string, userId: string, ttlSeconds: number): Promise<PlaybackTicket> {
    const ticket = crypto.randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + ttlSeconds * 1000;
    const payload: PlaybackTicket = { ticket, recordingId, userId, expiresAt };

    await this.redis.set(
      ticketKey(ticket),
      JSON.stringify({ recordingId, userId, expiresAt }),
      'EX',
      ttlSeconds,
    );

    return payload;
  }

  async consume(rawTicket: string, recordingId: string): Promise<PlaybackTicket> {
    // 票据长度固定（32 字节 base64url），先做廉价的格式拒绝。
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(rawTicket)) {
      throw new TicketInvalidError();
    }

    let raw: string | null;
    try {
      raw = await this.redis.get(ticketKey(rawTicket));
    } catch (error) {
      // fail-closed：Redis 不可用时宁可拒绝播放，也不能放行。
      throw new HttpError(503, 'TICKET_STORE_UNAVAILABLE', '播放服务暂不可用，请稍后重试');
    }

    if (!raw) throw new TicketInvalidError();

    let stored: { recordingId?: unknown; userId?: unknown; expiresAt?: unknown };
    try {
      stored = JSON.parse(raw);
    } catch {
      throw new TicketInvalidError();
    }

    if (
      typeof stored.recordingId !== 'string' ||
      typeof stored.userId !== 'string' ||
      typeof stored.expiresAt !== 'number' ||
      stored.expiresAt <= Date.now() ||
      // 关键：票据绑定到具体录音，拿 A 录音的票据请求 B 录音必须失败。
      stored.recordingId !== recordingId
    ) {
      throw new TicketInvalidError();
    }

    return {
      ticket: rawTicket,
      recordingId: stored.recordingId,
      userId: stored.userId,
      expiresAt: stored.expiresAt,
    };
  }
}

function ticketKey(ticket: string): string {
  return `playback:ticket:${ticket}`;
}
