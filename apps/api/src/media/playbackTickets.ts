import crypto from 'node:crypto';

export interface TicketRedisLike {
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
}

export type PlaybackTicketPayload = {
  recordingId: string;
  userId: string;
  issuedAt: number;
};

const TICKET_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

// 短时播放票据：一次性写入 Redis 并带 TTL，只绑定单条录音与单个用户。
// 校验失败（不存在、过期、内容损坏、Redis 故障）一律返回 null，即“拒绝放行”。
export class PlaybackTicketStore {
  private readonly ttlSeconds: number;
  private readonly keyPrefix: string;
  private readonly now: () => number;

  constructor(
    private readonly redis: TicketRedisLike,
    options: { ttlSeconds: number; keyPrefix?: string; now?: () => number },
    private readonly randomToken: () => string = () =>
      crypto.randomBytes(24).toString('base64url'),
  ) {
    this.ttlSeconds = Math.max(5, Math.floor(options.ttlSeconds));
    this.keyPrefix = options.keyPrefix ?? 'playback:ticket:';
    this.now = options.now ?? (() => Date.now());
  }

  get ttl(): number {
    return this.ttlSeconds;
  }

  private key(ticket: string): string {
    return `${this.keyPrefix}${ticket}`;
  }

  async issue(payload: {
    recordingId: string;
    userId: string;
  }): Promise<{ ticket: string; expiresAt: Date }> {
    const ticket = this.randomToken();
    const data: PlaybackTicketPayload = { ...payload, issuedAt: this.now() };
    await this.redis.set(this.key(ticket), JSON.stringify(data), 'EX', this.ttlSeconds);
    return { ticket, expiresAt: new Date(data.issuedAt + this.ttlSeconds * 1000) };
  }

  async verify(ticket: string): Promise<PlaybackTicketPayload | null> {
    if (!TICKET_PATTERN.test(ticket)) return null;

    let raw: string | null;
    try {
      raw = await this.redis.get(this.key(ticket));
    } catch {
      return null;
    }
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw) as Partial<PlaybackTicketPayload>;
      if (
        typeof parsed.recordingId !== 'string' ||
        typeof parsed.userId !== 'string' ||
        !parsed.recordingId ||
        !parsed.userId
      ) {
        return null;
      }
      return {
        recordingId: parsed.recordingId,
        userId: parsed.userId,
        issuedAt: Number(parsed.issuedAt) || 0,
      };
    } catch {
      return null;
    }
  }

  async revoke(ticket: string): Promise<void> {
    try {
      await this.redis.del(this.key(ticket));
    } catch {
      // 撤销失败不影响主流程，票据会随 TTL 自然过期
    }
  }
}
