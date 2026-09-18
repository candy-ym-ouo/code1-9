import { describe, expect, it, vi } from 'vitest';
import { RedisTicketStore, TicketInvalidError } from './ticket-store.js';
import { HttpError } from '../errors.js';

function createFakeRedis(clock: { now: number }) {
  const data = new Map<string, { value: string; expiresAt: number }>();
  return {
    data,
    redis: {
      set: vi.fn(async (key: string, value: string, _mode: 'EX', ttlSeconds: number) => {
        data.set(key, { value, expiresAt: clock.now + ttlSeconds * 1000 });
        return 'OK';
      }),
      get: vi.fn(async (key: string) => {
        const entry = data.get(key);
        if (!entry || entry.expiresAt <= clock.now) return null;
        return entry.value;
      }),
    },
  };
}

describe('RedisTicketStore', () => {
  it('issues opaque tickets and validates them against the bound recording', async () => {
    const clock = { now: 1_000_000 };
    const { redis } = createFakeRedis(clock);
    const store = new RedisTicketStore(redis as never);

    const ticket = await store.issue('rec-a', 'user-1', 600);
    expect(ticket.ticket).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(ticket.recordingId).toBe('rec-a');

    const consumed = await store.consume(ticket.ticket, 'rec-a');
    expect(consumed.userId).toBe('user-1');

    // 拿 A 的票据请求 B：必须拒绝，不能串内容
    await expect(store.consume(ticket.ticket, 'rec-b')).rejects.toBeInstanceOf(TicketInvalidError);
  });

  it('rejects unknown, malformed and expired tickets', async () => {
    const clock = { now: 2_000_000 };
    const { redis, data } = createFakeRedis(clock);
    const store = new RedisTicketStore(redis as never);

    await expect(store.consume('does-not-exist', 'rec-a')).rejects.toBeInstanceOf(
      TicketInvalidError,
    );
    await expect(store.consume('../etc/passwd', 'rec-a')).rejects.toBeInstanceOf(
      TicketInvalidError,
    );

    const ticket = await store.issue('rec-a', 'user-1', 600);
    const [key] = [...data.keys()];
    clock.now += 601_000;
    await expect(store.consume(ticket.ticket, 'rec-a')).rejects.toBeInstanceOf(
      TicketInvalidError,
    );
    expect(key).toBeTruthy();
  });

  it('fails closed when the ticket store is unavailable', async () => {
    const redis = {
      set: async () => 'OK',
      get: async () => {
        throw new Error('redis down');
      },
    };
    const store = new RedisTicketStore(redis as never);
    await expect(store.consume('x'.repeat(43), 'rec-a')).rejects.toMatchObject({
      statusCode: 503,
      code: 'TICKET_STORE_UNAVAILABLE',
    });
    const error = await store.consume('x'.repeat(43), 'rec-a').catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
  });
});
