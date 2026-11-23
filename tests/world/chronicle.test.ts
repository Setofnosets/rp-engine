import { describe, expect, it } from 'vitest';
import { isErr, isOk } from '../../src/core/result.js';
import { STOCK_LIVING_WORLD_PACK, STOCK_SLICE_OF_LIFE_PACK } from '../../src/schema/stock-system-packs.js';
import { type ChronicleEntry, createWorldState } from '../../src/state/world-state.js';
import {
  getRelevantChronicleEntries,
  upsertChronicleEntry,
  validateChronicleEntryInput,
} from '../../src/world/chronicle.js';

describe('validateChronicleEntryInput', () => {
  it('validates incoming chronicle payloads and rejects invalid entries', () => {
    const valid = validateChronicleEntryInput({
      turn: 5,
      day: 2,
      date: '2026-06-02',
      title: 'The Harbor Pact',
      category: 'quest',
      summary: 'Agreed to search Pier 4.',
      locationId: 'harbor',
      involvedEntityIds: ['marcus'],
      keywords: ['pier', 'pact'],
    });
    expect(isOk(valid)).toBe(true);

    const invalid = validateChronicleEntryInput({
      turn: -1,
      day: 1,
      date: null,
      title: '   ',
      category: 'event',
      summary: 'Bad turn and empty title.',
      locationId: null,
      involvedEntityIds: [],
      keywords: [],
    });
    expect(isErr(invalid)).toBe(true);
    if (!invalid.ok) {
      expect(invalid.error.map((e) => e.path)).toEqual(['chronicleEntry.title', 'chronicleEntry.turn']);
    }
  });
});

describe('upsertChronicleEntry', () => {
  it('accumulates into existing entry when title matches case-insensitively and preserves immutability', () => {
    const initial: ChronicleEntry[] = [
      {
        id: 'chr-smuggling',
        turn: 10,
        day: 3,
        date: '2026-06-03',
        title: 'The Harbor Smuggling Ring',
        category: 'quest',
        summary: 'Found forged manifests at Pier 4.',
        locationId: 'harbor',
        involvedEntityIds: ['dockmaster'],
        keywords: ['Smuggling', 'Pier 4'],
      },
    ];

    const updated = upsertChronicleEntry(initial, {
      turn: 18,
      day: 5,
      date: '2026-06-05',
      title: '  the harbor smuggling ring ',
      category: 'quest',
      summary: 'Traced shipments to Obsidian Syndicate warehouse.',
      locationId: 'warehouse',
      involvedEntityIds: ['dockmaster', 'kestrel'],
      keywords: ['smuggling', 'Syndicate'],
    });

    // Accumulated into single entry preserving original id
    expect(updated).toHaveLength(1);
    expect(updated[0]?.id).toBe('chr-smuggling');
    expect(updated[0]?.turn).toBe(18);
    expect(updated[0]?.day).toBe(5);
    expect(updated[0]?.date).toBe('2026-06-05');
    expect(updated[0]?.title).toBe('The Harbor Smuggling Ring');
    expect(updated[0]?.locationId).toBe('warehouse');
    expect(updated[0]?.summary).toBe(
      'Found forged manifests at Pier 4.\nTraced shipments to Obsidian Syndicate warehouse.'
    );
    expect(updated[0]?.involvedEntityIds).toEqual(['dockmaster', 'kestrel']);
    expect(updated[0]?.keywords).toEqual(['Smuggling', 'Pier 4', 'Syndicate']);

    // Duplicate summary text is not repeated
    const repeatSummary = upsertChronicleEntry(updated, {
      turn: 19,
      day: 5,
      date: '2026-06-05',
      title: 'THE HARBOR SMUGGLING RING',
      category: 'quest',
      summary: 'Traced shipments to Obsidian Syndicate warehouse.',
      locationId: null,
      involvedEntityIds: ['kestrel'],
      keywords: ['syndicate'],
    });
    expect(repeatSummary).toHaveLength(1);
    expect(repeatSummary[0]?.summary).toBe(
      'Found forged manifests at Pier 4.\nTraced shipments to Obsidian Syndicate warehouse.'
    );
    expect(repeatSummary[0]?.locationId).toBe('warehouse');

    // Non-matching title appends a new entry with deterministic unique id
    const appended = upsertChronicleEntry(repeatSummary, {
      turn: 20,
      day: 6,
      date: '2026-06-06',
      title: 'Council Vote',
      category: 'world',
      summary: 'Council declared martial curfew.',
      locationId: 'citadel',
      involvedEntityIds: ['chancellor'],
      keywords: ['curfew'],
    });
    expect(appended).toHaveLength(2);
    expect(appended[1]?.id).toBe('chronicle-20-council-vote');

    // Input array and original object remain untouched
    expect(initial).toHaveLength(1);
    expect(initial[0]?.involvedEntityIds).toEqual(['dockmaster']);
    expect(initial[0]?.summary).toBe('Found forged manifests at Pier 4.');
  });
});

describe('getRelevantChronicleEntries', () => {
  it('retrieves turn-4 and turn-7 memories at turn 120 when old NPC, location, or keyword resurfaces', () => {
    // Build 120 turns of chronicle history (turns 1..120)
    const fillerEvents: ChronicleEntry[] = [];
    for (let turn = 1; turn <= 120; turn += 1) {
      if (turn === 4) {
        fillerEvents.push({
          id: 'chr-turn-4-sera',
          turn: 4,
          day: 1,
          date: '2026-01-01',
          title: 'Oath at Frostwatch Keep',
          category: 'event',
          summary: 'Lady Sera entrusted the fractured ember seal before vanishing north.',
          locationId: 'frostwatch-keep',
          involvedEntityIds: ['lady_sera'],
          keywords: ['ember seal', 'oath', 'art'],
        });
        continue;
      }
      if (turn === 7) {
        fillerEvents.push({
          id: 'chr-turn-7-vault',
          turn: 7,
          day: 2,
          date: '2026-01-02',
          title: 'Whispering Vault Discovery',
          category: 'world',
          summary: 'Uncovered obsidian runes beneath the sunken shrine.',
          locationId: 'sunken-shrine',
          involvedEntityIds: ['archivist_corin'],
          keywords: ['obsidian runes'],
        });
        continue;
      }
      fillerEvents.push({
        id: `chr-filler-${String(turn).padStart(3, '0')}`,
        turn,
        day: Math.floor(turn / 3) + 1,
        date: null,
        title: `Capital Routine ${turn}`,
        category: 'event',
        summary: 'Patrols walked the central boulevard.',
        locationId: 'capital-boulevard',
        involvedEntityIds: ['city_guard'],
        keywords: ['patrol', 'market'],
      });
    }

    const state = createWorldState({
      sessionId: 'turn-120-recall',
      turn: 120,
      capabilities: STOCK_LIVING_WORLD_PACK.capabilities,
      locations: [
        {
          id: 'capital-boulevard',
          name: 'Capital Boulevard',
          kind: 'district',
          status: 'normal',
          controllingFactionId: null,
          connectedLocations: ['frostwatch-keep'],
          discovered: true,
          tags: [],
          notes: '',
        },
        {
          id: 'frostwatch-keep',
          name: 'Frostwatch Keep',
          kind: 'fortress',
          status: 'normal',
          controllingFactionId: null,
          connectedLocations: ['capital-boulevard'],
          discovered: true,
          tags: [],
          notes: '',
        },
        {
          id: 'sunken-shrine',
          name: 'Sunken Shrine',
          kind: 'ruin',
          status: 'normal',
          controllingFactionId: null,
          connectedLocations: [],
          discovered: true,
          tags: [],
          notes: '',
        },
      ],
      characters: [
        {
          id: 'lady_sera',
          name: 'Lady Sera',
          status: 'active',
          presentInScene: false,
          locationId: 'capital-boulevard',
          formId: null,
          formGroup: null,
          sections: {},
          customFields: {},
          abilities: [],
          goals: [],
          agenda: '',
          allegiance: 'hero',
          mood: 'solemn',
          traits: [],
        },
      ],
      scene: {
        location: 'Capital Boulevard',
        locationId: 'capital-boulevard',
      },
      chronicleEvents: fillerEvents,
    });

    // 1. Turn-120 retrieval when old NPC re-appears at an unrelated location
    const npcRecall = getRelevantChronicleEntries(state, {
      presentCharacterIds: ['lady_sera'],
      currentLocationId: 'sunken-shrine',
      recentTranscriptLines: ['We started walking toward the altar.'], // 'started' must NOT false-match keyword 'art'
      maxEntries: 3,
    });
    expect(npcRecall.map((r) => r.entry.id)).toEqual(['chr-turn-4-sera', 'chr-turn-7-vault']);
    expect(npcRecall[0]!.score).toBe(4); // involvedEntityId match (+4), NOT keyword 'art'
    expect(npcRecall[1]!.score).toBe(3); // locationId 'sunken-shrine' match (+3)

    // 2. Turn-120 retrieval when old location is revisited
    const locRecall = getRelevantChronicleEntries(state, {
      presentCharacterIds: [],
      currentLocationId: 'frostwatch-keep',
      recentTranscriptLines: ['The snow swirls across the empty battlements.'],
    });
    expect(locRecall.map((r) => r.entry.id)).toEqual(['chr-turn-4-sera']);
    expect(locRecall[0]!.score).toBe(3);

    // 3. Turn-120 retrieval when old keyword is mentioned in transcript lines
    const keywordRecall = getRelevantChronicleEntries(state, {
      presentCharacterIds: [],
      currentLocationId: null,
      currentLocationName: '',
      recentTranscriptLines: [
        'Elena inspected the table.',
        'Someone whispered about the broken Ember Seal!',
      ],
    });
    expect(keywordRecall.map((r) => r.entry.id)).toEqual(['chr-turn-4-sera']);
    expect(keywordRecall[0]!.score).toBe(2);

    // 4. Transcript mention of NPC display name ('Lady Sera') also recalls turn-4 memory
    const nameMentionRecall = getRelevantChronicleEntries(state, {
      presentCharacterIds: [],
      currentLocationId: null,
      currentLocationName: '',
      recentTranscriptLines: ['Have you seen Lady Sera since winter?'],
    });
    expect(nameMentionRecall.map((r) => r.entry.id)).toEqual(['chr-turn-4-sera']);
    expect(nameMentionRecall[0]!.score).toBe(2);
  });

  it('orders ties deterministically by score desc, then turn desc, then id asc, and works in Tier 0', () => {
    const state = createWorldState({
      sessionId: 'tier0-chronicle-sort',
      capabilities: STOCK_SLICE_OF_LIFE_PACK.capabilities,
      scene: {
        location: 'Corner Coffee Shop',
        locationId: null,
      },
      chronicleEvents: [
        {
          id: 'b-same-turn',
          turn: 12,
          day: 3,
          date: null,
          title: 'Morning Rush',
          category: 'event',
          summary: 'Served espresso at Corner Coffee Shop.',
          locationId: null,
          involvedEntityIds: ['marcus'],
          keywords: ['espresso'],
        },
        {
          id: 'a-same-turn',
          turn: 12,
          day: 3,
          date: null,
          title: 'Early Delivery',
          category: 'event',
          summary: 'Unloaded beans at Corner Coffee Shop.',
          locationId: null,
          involvedEntityIds: ['marcus'],
          keywords: ['beans'],
        },
        {
          id: 'newer-turn',
          turn: 20,
          day: 5,
          date: null,
          title: 'Evening Closing',
          category: 'event',
          summary: 'Locked doors at Corner Coffee Shop.',
          locationId: null,
          involvedEntityIds: ['marcus'],
          keywords: ['closing'],
        },
        {
          id: 'highest-score',
          turn: 2,
          day: 1,
          date: null,
          title: 'First Shift',
          category: 'event',
          summary: 'Met at Corner Coffee Shop.',
          locationId: null,
          involvedEntityIds: ['marcus'],
          keywords: ['latte'],
        },
      ],
    });

    const ranked = getRelevantChronicleEntries(state, {
      presentCharacterIds: ['marcus'],
      recentTranscriptLines: ['Could I get a latte?'],
    });

    expect(ranked.map((item) => item.entry.id)).toEqual([
      'highest-score', // score: 4 (entity) + 2 (Tier 0 location name) + 2 (keyword 'latte') = 8
      'newer-turn', // score: 4 + 2 = 6, turn 20
      'a-same-turn', // score: 6, turn 12, id 'a-same-turn'
      'b-same-turn', // score: 6, turn 12, id 'b-same-turn'
    ]);

    expect(
      getRelevantChronicleEntries(state, {
        presentCharacterIds: ['marcus'],
        maxEntries: 2,
      }).map((i) => i.entry.id)
    ).toEqual(['newer-turn', 'a-same-turn']);

    expect(
      getRelevantChronicleEntries(state, {
        presentCharacterIds: ['marcus'],
        maxEntries: 0,
      })
    ).toEqual([]);
  });
});
