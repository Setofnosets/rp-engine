import { describe, expect, it } from 'vitest';
import {
  type AuditEntry,
  appendAuditEntries,
  createAuditLog,
  queryAuditLog,
} from '../../src/state/audit-log.js';

function makeSampleEntries(): AuditEntry[] {
  return [
    {
      turn: 1,
      storyTurn: 1,
      timestampSeq: 1,
      source: 'tracker',
      eventId: 'evt-1',
      op: 'set',
      path: 'flags.met_castellan',
      oldValue: undefined,
      newValue: true,
      status: 'committed',
    },
    {
      turn: 1,
      storyTurn: 1,
      timestampSeq: 2,
      source: 'tracker',
      eventId: 'evt-1',
      op: 'route_lock',
      path: 'flags.route_betrayal',
      oldValue: undefined,
      newValue: true,
      status: 'rejected',
      reason: 'Hard plot guard',
    },
    {
      turn: 2,
      storyTurn: 2,
      timestampSeq: 3,
      source: 'engine',
      eventId: 'evt-2',
      op: 'entity_patch',
      path: 'entities.characters.castellan.status',
      oldValue: 'active',
      newValue: 'captured',
      status: 'committed',
    },
    {
      turn: 2,
      storyTurn: 2,
      timestampSeq: 4,
      source: 'tracker',
      eventId: 'evt-3',
      op: 'custom_field_patch',
      path: 'customFields.sanity',
      oldValue: 80,
      newValue: 65,
      status: 'pending_confirmation',
      reason: 'always_confirm',
    },
  ];
}

describe('AuditLog', () => {
  it('creates an immutable audit log and isolates caller references', () => {
    const seed: AuditEntry[] = [
      {
        turn: 1,
        storyTurn: 1,
        timestampSeq: 1,
        source: 'engine',
        eventId: 'evt-seed',
        op: 'set',
        path: 'customFields.tags',
        oldValue: ['a'],
        newValue: ['a', 'b'],
        status: 'committed',
      },
    ];

    const log = createAuditLog(seed);
    expect(log.entries).toHaveLength(1);

    // Mutate caller input after creation
    (seed[0]!.newValue as string[]).push('mutated');
    seed.push(makeSampleEntries()[1]!);

    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]?.newValue).toEqual(['a', 'b']);
  });

  it('appends entries immutably without modifying earlier log snapshots', () => {
    const samples = makeSampleEntries();
    const log0 = createAuditLog([samples[0]!]);
    const log1 = appendAuditEntries(log0, [samples[1]!, samples[2]!]);
    const log2 = appendAuditEntries(log1, []);

    expect(log0.entries).toHaveLength(1);
    expect(log1.entries).toHaveLength(3);
    expect(log1.entries.map((e) => e.timestampSeq)).toEqual([1, 2, 3]);
    expect(log2).toBe(log1);
  });

  it('queries entries by pathPrefix, source, turn, status, eventId, and combined filters', () => {
    const log = appendAuditEntries(createAuditLog(), makeSampleEntries());

    const byPrefix = queryAuditLog(log, { pathPrefix: 'flags.' });
    expect(byPrefix.map((e) => e.path)).toEqual([
      'flags.met_castellan',
      'flags.route_betrayal',
    ]);

    const byEntityPrefix = queryAuditLog(log, { pathPrefix: 'entities.characters.castellan' });
    expect(byEntityPrefix).toHaveLength(1);
    expect(byEntityPrefix[0]?.newValue).toBe('captured');

    const bySource = queryAuditLog(log, { source: 'tracker' });
    expect(bySource).toHaveLength(3);

    const byTurn = queryAuditLog(log, { turn: 2 });
    expect(byTurn.map((e) => e.timestampSeq)).toEqual([3, 4]);

    const byStatus = queryAuditLog(log, { status: 'pending_confirmation' });
    expect(byStatus).toHaveLength(1);
    expect(byStatus[0]?.path).toBe('customFields.sanity');

    const byRejected = queryAuditLog(log, { status: 'rejected' });
    expect(byRejected).toHaveLength(1);
    expect(byRejected[0]?.reason).toBe('Hard plot guard');

    const combined = queryAuditLog(log, {
      turn: 1,
      source: 'tracker',
      pathPrefix: 'flags.',
      status: 'committed',
      eventId: 'evt-1',
    });
    expect(combined).toHaveLength(1);
    expect(combined[0]?.path).toBe('flags.met_castellan');

    // Mutating returned query item's nested object does not leak back into log
    const sanityQuery = queryAuditLog(
      appendAuditEntries(createAuditLog(), [
        {
          turn: 3,
          storyTurn: 3,
          timestampSeq: 5,
          source: 'script',
          eventId: 'evt-4',
          op: 'set',
          path: 'customFields.meta',
          oldValue: {},
          newValue: { tags: ['x'] },
          status: 'committed',
        },
      ]),
      { eventId: 'evt-4' }
    );
    ((sanityQuery[0]?.newValue as { tags: string[] }).tags).push('leaked');
    const reRead = queryAuditLog(
      appendAuditEntries(createAuditLog(), [
        {
          turn: 3,
          storyTurn: 3,
          timestampSeq: 5,
          source: 'script',
          eventId: 'evt-4',
          op: 'set',
          path: 'customFields.meta',
          oldValue: {},
          newValue: { tags: ['x'] },
          status: 'committed',
        },
      ]),
      { eventId: 'evt-4' }
    );
    expect(reRead[0]?.newValue).toEqual({ tags: ['x'] });
  });
});
