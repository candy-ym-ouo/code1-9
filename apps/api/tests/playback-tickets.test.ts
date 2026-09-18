import { describe, expect, it } from 'vitest';
import { PlaybackTicketStore } from '../src/media/playbackTickets.js';

class FakeRedis {
  private readonly store = new Map<string, { value: string; expiresAt: number }>();

  constructor(private readonly now: () => number) {}

  async set(key: string, value: string, ...args: unknown[]): Promise<string> {
    let ttlSeconds: number | undefined;
    for (let index = 0; index < args.length - 1; index += 1) {
      if (String(args[index]).toUpperCase() === 'EX') {
        ttlSeconds = Number(args[index + 1]);
      }
    }
    this.store.set(key, {
      value,
      expiresAt: ttlSeconds === undefined ? Infinity : this.now() + ttlSeconds * 1000,
    });
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }

  corrupt(key: string, value: string): void {
    this.store.set(key, { value, expiresAt: Infinity });
  }

  lastKey(): string {
    return [...this.store.keys()].at(-1) || '';
  }
}

const recording = { recordingId: 'rec-1', userId: 'user-1' };

describe('PlaybackTicketStore', () => {
  it('issues and verifies a ticket bound to recording and user', async () => {
    const redis = new FakeRedis(() => 1_000);
    const store = new PlaybackTicketStore(redis, { ttlSeconds: 120, now: () => 1_000 });

    const { ticket, expiresAt } = await store.issue(recording);
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(expiresAt.getTime()).toBe(1_000 + 120_000);

    const payload = await store.verify(ticket);
    expect(payload).toMatchObject(recording);
  });

  it('rejects a ticket after it expires', async () => {
    let now = 1_000;
    const redis = new FakeRedis(() => now);
    const store = new PlaybackTicketStore(redis, { ttlSeconds: 120 });

    const { ticket } = await store.issue(recording);
    now = 1_000 + 119_999;
    expect(await store.verify(ticket)).not.toBeNull();
    now = 1_000 + 120_000;
    expect(await store.verify(ticket)).toBeNull();
  });

  it('rejects unknown and malformed tickets without touching redis', async () => {
    const redis = new FakeRedis(() => 1_000);
    const store = new PlaybackTicketStore(redis, { ttlSeconds: 120 });

    expect(await store.verify('does-not-exist-0000000000')).toBeNull();
    expect(await store.verify('short')).toBeNull();
    expect(await store.verify('a'.repeat(200))).toBeNull();
    expect(await store.verify('bad ticket with spaces!')).toBeNull();
  });

  it('rejects corrupted payloads', async () => {
    const redis = new FakeRedis(() => 1_000);
    const store = new PlaybackTicketStore(redis, { ttlSeconds: 120 });

    const { ticket } = await store.issue(recording);
    redis.corrupt(`playback:ticket:${ticket}`, '{"recordingId":123}');
    expect(await store.verify(ticket)).toBeNull();

    redis.corrupt(`playback:ticket:${ticket}`, 'not-json');
    expect(await store.verify(ticket)).toBeNull();
  });

  it('fails closed when redis is unavailable', async () => {
    const broken = {
      set: async () => {
        throw new Error('redis down');
      },
      get: async () => {
        throw new Error('redis down');
      },
      del: async () => {
        throw new Error('redis down');
      },
    };
    const store = new PlaybackTicketStore(broken, { ttlSeconds: 120 });
    await expect(store.issue(recording)).rejects.toThrow('redis down');
    expect(await store.verify('a'.repeat(32))).toBeNull();
    await expect(store.revoke('a'.repeat(32))).resolves.toBeUndefined();
  });

  it('revokes a ticket', async () => {
    const redis = new FakeRedis(() => 1_000);
    const store = new PlaybackTicketStore(redis, { ttlSeconds: 120 });

    const { ticket } = await store.issue(recording);
    await store.revoke(ticket);
    expect(await store.verify(ticket)).toBeNull();
  });

  it('stores tickets under the configured prefix', async () => {
    const redis = new FakeRedis(() => 1_000);
    const store = new PlaybackTicketStore(redis, {
      ttlSeconds: 120,
      keyPrefix: 'test:ticket:',
    });
    await store.issue(recording);
    expect(redis.lastKey().startsWith('test:ticket:')).toBe(true);
  });
});
