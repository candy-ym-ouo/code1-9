import { describe, expect, it } from 'vitest';
import { clipSchema, clipUpdateSchema, playbackTicketCreateSchema } from '../src/index.js';

describe('clipSchema', () => {
  it('applies defaults and accepts a valid range', () => {
    const parsed = clipSchema.parse({
      title: '开场',
      startMs: 100,
      endMs: 1500,
    });

    expect(parsed.summary).toBe('');
    expect(parsed.transcript).toBe('');
  });

  it('rejects an invalid range', () => {
    const parsed = clipSchema.safeParse({
      title: '无效片段',
      startMs: 2000,
      endMs: 2000,
    });

    expect(parsed.success).toBe(false);
  });

  it('allows clearing an optional speaker on update', () => {
    const parsed = clipUpdateSchema.parse({
      version: 1,
      speakerPersonId: null,
    });

    expect(parsed.speakerPersonId).toBeNull();
  });

  it('rejects unknown fields instead of silently ignoring them', () => {
    const parsed = clipUpdateSchema.safeParse({
      version: 1,
      workspaceId: 'other-workspace',
    });

    expect(parsed.success).toBe(false);
  });
});

describe('playbackTicketCreateSchema', () => {
  it('accepts a uuid recording id and rejects everything else', () => {
    expect(
      playbackTicketCreateSchema.safeParse({
        recordingId: '123e4567-e89b-12d3-a456-426614174000',
      }).success,
    ).toBe(true);

    expect(playbackTicketCreateSchema.safeParse({ recordingId: 'nope' }).success).toBe(false);
    expect(
      playbackTicketCreateSchema.safeParse({
        recordingId: '123e4567-e89b-12d3-a456-426614174000',
        ticket: 'attempted-injection',
      }).success,
    ).toBe(false);
  });
});
