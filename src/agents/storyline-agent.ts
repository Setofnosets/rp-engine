import type { BeatDefinition, BeatLedgerState } from '../beats/beat-ledger.js';
import { type ValidationError, validationError } from '../core/errors.js';
import type { ModelGateway } from '../gateway/model-gateway.js';
import type { ChatMessage } from '../gateway/types.js';
import type { PatchBatch, PatchOperation } from '../state/patch.js';
import type { WorldState } from '../state/world-state.js';

export interface RunStorylinePlannerParams {
  state: WorldState;
  ledger: BeatLedgerState;
  beats: readonly BeatDefinition[];
  gateway?: ModelGateway;
  useLlmPass?: boolean;
  recentExchangeText?: string;
  signal?: AbortSignal;
}

export interface RunStorylinePlannerResult {
  proposedBatch: PatchBatch | null;
  strippedInvalidItems: string[];
  warnings: ValidationError[];
}

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const ALLOWED_ROOT_KEYS: ReadonlySet<string> = new Set([
  'threatUpdates',
  'factionUpdates',
  'characterUpdates',
]);
const ALLOWED_THREAT_KEYS: ReadonlySet<string> = new Set(['threatId', 'agenda']);
const ALLOWED_FACTION_KEYS: ReadonlySet<string> = new Set(['factionId', 'goals']);
const ALLOWED_CHARACTER_KEYS: ReadonlySet<string> = new Set(['characterId', 'mood', 'goals']);

// Intentionally omit `additionalProperties: false` so unauthorized fields/flags proposed by an
// untrusted model pass reach the agent's strict sanitizer and are recorded in `strippedInvalidItems`.
const STORYLINE_PLANNER_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    threatUpdates: {
      type: 'array',
      items: {
        type: 'object',
        required: ['threatId'],
        properties: {
          threatId: { type: 'string' },
          agenda: { type: 'string' },
        },
      },
    },
    factionUpdates: {
      type: 'array',
      items: {
        type: 'object',
        required: ['factionId'],
        properties: {
          factionId: { type: 'string' },
          goals: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    characterUpdates: {
      type: 'array',
      items: {
        type: 'object',
        required: ['characterId'],
        properties: {
          characterId: { type: 'string' },
          mood: { type: 'string' },
          goals: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

function isSafeKey(key: string): boolean {
  return key.length > 0 && !FORBIDDEN_KEYS.has(key);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function getOwn<T>(record: Record<string, T>, key: string): T | undefined {
  if (!isSafeKey(key) || !Object.hasOwn(record, key)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(record, key)?.value as T | undefined;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function buildStorylineMessages(
  state: WorldState,
  ledger: BeatLedgerState,
  beats: readonly BeatDefinition[],
  recentExchangeText?: string
): ChatMessage[] {
  const activeBeatSummaries = beats
    .map((beat) => {
      const rec = getOwn(ledger.records, beat.id);
      const status = rec?.status ?? 'pending';
      return `${beat.id} [${beat.class}, status=${status}]`;
    })
    .slice(0, 20);

  const threatIds = Object.keys(state.entities.threats).filter(isSafeKey).sort();
  const factionIds = Object.keys(state.entities.factions).filter(isSafeKey).sort();
  const characterIds = Object.keys(state.entities.characters).filter(isSafeKey).sort();

  return [
    {
      role: 'system',
      content: [
        'You are the storyline planner micro-agent.',
        'You may ONLY propose threat agenda notes, faction goals, or character mood/goals updates.',
        'Do NOT propose plot flags, route locks, threat progress, or beat transitions.',
        `Beats: ${activeBeatSummaries.join('; ') || 'none'}`,
        `Known threat IDs: ${threatIds.join(', ') || 'none'}`,
        `Known faction IDs: ${factionIds.join(', ') || 'none'}`,
        `Known character IDs: ${characterIds.join(', ') || 'none'}`,
      ].join('\n'),
    },
    {
      role: 'user',
      content: recentExchangeText ?? 'Review narrative pacing and propose soft agenda/goal notes.',
    },
  ];
}

/**
 * Optionally run the storyline_planner LLM pass to propose soft agenda, goal, and mood updates
 * while strictly stripping unknown entity IDs and unauthorized plot-flag or engine-owned edits.
 */
export async function runStorylinePlanner(
  params: RunStorylinePlannerParams
): Promise<RunStorylinePlannerResult> {
  if (!params.state.capabilities.beats || params.useLlmPass !== true || params.gateway === undefined) {
    return {
      proposedBatch: null,
      strippedInvalidItems: [],
      warnings: [],
    };
  }

  const gatewayRes = await params.gateway.generateStructured<unknown>({
    role: 'storyline_planner',
    messages: buildStorylineMessages(
      params.state,
      params.ledger,
      params.beats,
      params.recentExchangeText
    ),
    schema: STORYLINE_PLANNER_SCHEMA,
    schemaName: 'storyline_planner_updates',
    signal: params.signal,
  });

  if (!gatewayRes.ok) {
    return {
      proposedBatch: null,
      strippedInvalidItems: [],
      warnings: [...gatewayRes.error],
    };
  }

  const data = gatewayRes.value.data;
  const warnings: ValidationError[] = [];
  const strippedInvalidItems: string[] = [];

  if (!isPlainRecord(data)) {
    warnings.push(
      validationError('response', 'INVALID_TYPE', 'Storyline planner response was not an object')
    );
    return {
      proposedBatch: null,
      strippedInvalidItems,
      warnings,
    };
  }

  for (const rootKey of Object.keys(data)) {
    if (!ALLOWED_ROOT_KEYS.has(rootKey)) {
      strippedInvalidItems.push(`unauthorized_root:${rootKey}`);
    }
  }

  const operations: PatchOperation[] = [];

  // 1. Threat agenda updates
  const rawThreats = getOwn(data, 'threatUpdates');
  if (Array.isArray(rawThreats)) {
    for (let i = 0; i < rawThreats.length; i += 1) {
      const item = rawThreats[i];
      if (!isPlainRecord(item)) {
        strippedInvalidItems.push(`threat[${i}]:invalid_type`);
        continue;
      }
      const threatId = getOwn(item, 'threatId');
      if (
        typeof threatId !== 'string' ||
        !isSafeKey(threatId) ||
        !Object.hasOwn(params.state.entities.threats, threatId)
      ) {
        strippedInvalidItems.push(`threat:${String(threatId)}:unknown_threat`);
        continue;
      }

      for (const fieldKey of Object.keys(item)) {
        if (!ALLOWED_THREAT_KEYS.has(fieldKey)) {
          strippedInvalidItems.push(`unauthorized_field:threats:${threatId}.${fieldKey}`);
        }
      }

      const agenda = getOwn(item, 'agenda');
      if (typeof agenda === 'string' && agenda.trim().length > 0) {
        operations.push({
          op: 'entity_patch',
          collection: 'threats',
          entityId: threatId,
          patch: { agenda: agenda.trim() },
        });
      }
    }
  }

  // 2. Faction goals updates
  const rawFactions = getOwn(data, 'factionUpdates');
  if (Array.isArray(rawFactions)) {
    for (let i = 0; i < rawFactions.length; i += 1) {
      const item = rawFactions[i];
      if (!isPlainRecord(item)) {
        strippedInvalidItems.push(`faction[${i}]:invalid_type`);
        continue;
      }
      const factionId = getOwn(item, 'factionId');
      if (
        typeof factionId !== 'string' ||
        !isSafeKey(factionId) ||
        !Object.hasOwn(params.state.entities.factions, factionId)
      ) {
        strippedInvalidItems.push(`faction:${String(factionId)}:unknown_faction`);
        continue;
      }

      for (const fieldKey of Object.keys(item)) {
        if (!ALLOWED_FACTION_KEYS.has(fieldKey)) {
          strippedInvalidItems.push(`unauthorized_field:factions:${factionId}.${fieldKey}`);
        }
      }

      const goals = getOwn(item, 'goals');
      if (isStringArray(goals)) {
        operations.push({
          op: 'entity_patch',
          collection: 'factions',
          entityId: factionId,
          patch: { goals: [...goals] },
        });
      }
    }
  }

  // 3. Character mood/goals updates
  const rawCharacters = getOwn(data, 'characterUpdates');
  if (Array.isArray(rawCharacters)) {
    for (let i = 0; i < rawCharacters.length; i += 1) {
      const item = rawCharacters[i];
      if (!isPlainRecord(item)) {
        strippedInvalidItems.push(`character[${i}]:invalid_type`);
        continue;
      }
      const characterId = getOwn(item, 'characterId');
      if (
        typeof characterId !== 'string' ||
        !isSafeKey(characterId) ||
        !Object.hasOwn(params.state.entities.characters, characterId)
      ) {
        strippedInvalidItems.push(`character:${String(characterId)}:unknown_character`);
        continue;
      }

      for (const fieldKey of Object.keys(item)) {
        if (!ALLOWED_CHARACTER_KEYS.has(fieldKey)) {
          strippedInvalidItems.push(`unauthorized_field:characters:${characterId}.${fieldKey}`);
        }
      }

      const patch: Record<string, unknown> = {};
      const mood = getOwn(item, 'mood');
      if (typeof mood === 'string' && mood.trim().length > 0) {
        Object.defineProperty(patch, 'mood', {
          value: mood.trim(),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }

      const goals = getOwn(item, 'goals');
      if (isStringArray(goals)) {
        Object.defineProperty(patch, 'goals', {
          value: [...goals],
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }

      if (Object.keys(patch).length > 0) {
        operations.push({
          op: 'entity_patch',
          collection: 'characters',
          entityId: characterId,
          patch,
        });
      }
    }
  }

  if (operations.length === 0) {
    return {
      proposedBatch: null,
      strippedInvalidItems,
      warnings,
    };
  }

  return {
    proposedBatch: {
      eventId: `storyline-turn-${params.state.meta.turn}`,
      source: 'beat',
      operations,
      reason: 'Storyline planner soft agenda, goal, and mood proposals',
    },
    strippedInvalidItems,
    warnings,
  };
}
