import { type ValidationError, validationError } from '../core/errors.js';
import type { ModelGateway } from '../gateway/model-gateway.js';
import type { ChatMessage } from '../gateway/types.js';
import type { FormDefinition } from '../state/forms.js';
import type { PatchBatch, PatchOperation } from '../state/patch.js';
import type { CharacterEntity, CharacterStatus, WorldState } from '../state/world-state.js';
import { type CastPresenceResult, computeLocationCast } from '../world/cast-presence.js';

export interface RunCastDirectorParams {
  state: WorldState;
  formDefinitions?: readonly FormDefinition[];
  gateway?: ModelGateway;
  useLlmPass?: boolean;
  recentExchangeText?: string;
  signal?: AbortSignal;
}

export interface RunCastDirectorResult {
  presence: CastPresenceResult;
  proposedBatch: PatchBatch | null;
  strippedInvalidItems: string[];
  warnings: ValidationError[];
}

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const NON_ACTIVE_CHARACTER_STATUSES: ReadonlySet<CharacterStatus> = new Set([
  'dead',
  'captured',
  'imprisoned',
  'missing',
  'retired',
  'lost',
]);

const CAST_DIRECTOR_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    arrivals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['characterId'],
        properties: {
          characterId: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
    departures: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['characterId'],
        properties: {
          characterId: { type: 'string' },
          destinationLocationId: { type: ['string', 'null'] },
          reason: { type: 'string' },
        },
      },
    },
    offscreenMoves: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['characterId', 'locationId'],
        properties: {
          characterId: { type: 'string' },
          locationId: { type: 'string' },
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

function resolveCharacterFormGroup(
  character: CharacterEntity,
  formDefinitions?: readonly FormDefinition[]
): string | null {
  if (formDefinitions !== undefined) {
    if (character.formId !== null) {
      for (const form of formDefinitions) {
        if (form.id === character.formId) {
          return form.formGroup;
        }
      }
    }
    const matchingGroups = new Set<string>();
    for (const form of formDefinitions) {
      if (form.characterId === character.id) {
        matchingGroups.add(form.formGroup);
      }
    }
    if (matchingGroups.size === 1) {
      return [...matchingGroups][0] ?? null;
    }
  }
  return character.formGroup;
}

function isLocationValidForSpatialMode(state: WorldState, locationId: string): boolean {
  if (!isSafeKey(locationId) || locationId.trim().length === 0) {
    return false;
  }
  if (state.capabilities.spatialMode === 'authored_graph') {
    return Object.hasOwn(state.entities.locations, locationId);
  }
  return true;
}

function buildCastDirectorMessages(
  state: WorldState,
  presence: CastPresenceResult,
  recentExchangeText?: string
): ChatMessage[] {
  const knownCharacters = Object.keys(state.entities.characters)
    .filter(isSafeKey)
    .sort()
    .map((id) => {
      const c = getOwn(state.entities.characters, id);
      return c ? `${c.id} (${c.name}, status=${c.status}, loc=${c.locationId ?? 'none'})` : id;
    });
  const knownLocations = Object.keys(state.entities.locations).filter(isSafeKey).sort();

  return [
    {
      role: 'system',
      content: [
        'You are the cast director micro-agent. Propose scene arrivals, departures, and offscreen NPC moves.',
        'Respond ONLY with JSON matching the schema. Never move the player character or dead/captured NPCs.',
        `Spatial mode: ${state.capabilities.spatialMode}`,
        `Current location: ${state.scene.location} (id=${state.scene.locationId ?? 'none'})`,
        `Player characterId: ${state.player.characterId ?? 'none'}`,
        `Currently present IDs: ${presence.presentCharacterIds.join(', ') || 'none'}`,
        `Known characters: ${knownCharacters.join('; ') || 'none'}`,
        `Known locations: ${knownLocations.join(', ') || 'none'}`,
      ].join('\n'),
    },
    {
      role: 'user',
      content: recentExchangeText ?? 'Evaluate scene cast transitions for the current turn.',
    },
  ];
}

/**
 * Compute deterministic scene cast presence first, then optionally run the cast_director LLM
 * pass while strictly stripping invalid IDs, forbidden statuses, unknown Tier 2 locations,
 * player-character moves, and formGroup duplicates.
 */
export async function runCastDirector(
  params: RunCastDirectorParams
): Promise<RunCastDirectorResult> {
  const presence = computeLocationCast(params.state, params.formDefinitions);

  if (params.useLlmPass !== true || params.gateway === undefined) {
    return {
      presence,
      proposedBatch: null,
      strippedInvalidItems: [],
      warnings: [],
    };
  }

  const gatewayRes = await params.gateway.generateStructured<unknown>({
    role: 'cast_director',
    messages: buildCastDirectorMessages(params.state, presence, params.recentExchangeText),
    schema: CAST_DIRECTOR_SCHEMA,
    schemaName: 'cast_director_transitions',
    signal: params.signal,
  });

  if (!gatewayRes.ok) {
    return {
      presence,
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
      validationError('response', 'INVALID_TYPE', 'Cast director response was not an object')
    );
    return {
      presence,
      proposedBatch: null,
      strippedInvalidItems,
      warnings,
    };
  }

  const operations: PatchOperation[] = [];
  const nextPresentSet = new Set<string>(presence.presentCharacterIds);
  const occupiedFormGroups = new Set<string>();
  for (const char of presence.presentCharacters) {
    const group = resolveCharacterFormGroup(char, params.formDefinitions);
    if (group !== null) {
      occupiedFormGroups.add(group);
    }
  }

  const playerCharId = params.state.player.characterId;
  const seenMutations = new Set<string>();

  // 1. Validate departures first (freeing formGroups if departing? Only after checking validity)
  const rawDepartures = getOwn(data, 'departures');
  if (Array.isArray(rawDepartures)) {
    for (let i = 0; i < rawDepartures.length; i += 1) {
      const item = rawDepartures[i];
      const charId = isPlainRecord(item) ? getOwn(item, 'characterId') : undefined;
      if (typeof charId !== 'string' || !isSafeKey(charId)) {
        strippedInvalidItems.push(`departure:${String(charId)}:invalid_id`);
        continue;
      }
      if (playerCharId !== null && charId === playerCharId) {
        strippedInvalidItems.push(`departure:${charId}:player_character`);
        continue;
      }
      const char = getOwn(params.state.entities.characters, charId);
      if (char === undefined) {
        strippedInvalidItems.push(`departure:${charId}:unknown_character`);
        continue;
      }
      if (NON_ACTIVE_CHARACTER_STATUSES.has(char.status)) {
        strippedInvalidItems.push(`departure:${charId}:invalid_status_${char.status}`);
        continue;
      }

      const destLoc = isPlainRecord(item) ? getOwn(item, 'destinationLocationId') : undefined;
      if (destLoc !== undefined && destLoc !== null) {
        if (typeof destLoc !== 'string' || !isLocationValidForSpatialMode(params.state, destLoc)) {
          strippedInvalidItems.push(`departure:${charId}:unknown_location_${String(destLoc)}`);
          continue;
        }
      }

      const patch: Record<string, unknown> = { presentInScene: false };
      if (destLoc !== undefined) {
        Object.defineProperty(patch, 'locationId', {
          value: destLoc,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }

      operations.push({
        op: 'entity_patch',
        collection: 'characters',
        entityId: charId,
        patch,
      });
      nextPresentSet.delete(charId);
      seenMutations.add(charId);

      const group = resolveCharacterFormGroup(char, params.formDefinitions);
      if (group !== null) {
        occupiedFormGroups.delete(group);
      }
    }
  }

  // 2. Validate arrivals
  const rawArrivals = getOwn(data, 'arrivals');
  if (Array.isArray(rawArrivals)) {
    for (let i = 0; i < rawArrivals.length; i += 1) {
      const item = rawArrivals[i];
      const charId = isPlainRecord(item) ? getOwn(item, 'characterId') : undefined;
      if (typeof charId !== 'string' || !isSafeKey(charId)) {
        strippedInvalidItems.push(`arrival:${String(charId)}:invalid_id`);
        continue;
      }
      if (playerCharId !== null && charId === playerCharId) {
        strippedInvalidItems.push(`arrival:${charId}:player_character`);
        continue;
      }
      const char = getOwn(params.state.entities.characters, charId);
      if (char === undefined) {
        strippedInvalidItems.push(`arrival:${charId}:unknown_character`);
        continue;
      }
      if (NON_ACTIVE_CHARACTER_STATUSES.has(char.status)) {
        strippedInvalidItems.push(`arrival:${charId}:invalid_status_${char.status}`);
        continue;
      }

      const group = resolveCharacterFormGroup(char, params.formDefinitions);
      if (group !== null && occupiedFormGroups.has(group)) {
        strippedInvalidItems.push(`arrival:${charId}:duplicate_form_group_${group}`);
        continue;
      }

      if (group !== null) {
        occupiedFormGroups.add(group);
      }

      const patch: Record<string, unknown> = {
        presentInScene: true,
        status: 'active',
      };
      if (
        params.state.capabilities.spatialMode !== 'scene_only' &&
        params.state.scene.locationId !== null
      ) {
        Object.defineProperty(patch, 'locationId', {
          value: params.state.scene.locationId,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }

      operations.push({
        op: 'entity_patch',
        collection: 'characters',
        entityId: charId,
        patch,
      });
      nextPresentSet.add(charId);
      seenMutations.add(charId);
    }
  }

  // 3. Validate offscreenMoves
  const rawOffscreenMoves = getOwn(data, 'offscreenMoves');
  if (Array.isArray(rawOffscreenMoves)) {
    for (let i = 0; i < rawOffscreenMoves.length; i += 1) {
      const item = rawOffscreenMoves[i];
      const charId = isPlainRecord(item) ? getOwn(item, 'characterId') : undefined;
      const locId = isPlainRecord(item) ? getOwn(item, 'locationId') : undefined;
      if (typeof charId !== 'string' || !isSafeKey(charId)) {
        strippedInvalidItems.push(`offscreenMove:${String(charId)}:invalid_id`);
        continue;
      }
      if (playerCharId !== null && charId === playerCharId) {
        strippedInvalidItems.push(`offscreenMove:${charId}:player_character`);
        continue;
      }
      const char = getOwn(params.state.entities.characters, charId);
      if (char === undefined) {
        strippedInvalidItems.push(`offscreenMove:${charId}:unknown_character`);
        continue;
      }
      if (NON_ACTIVE_CHARACTER_STATUSES.has(char.status)) {
        strippedInvalidItems.push(`offscreenMove:${charId}:invalid_status_${char.status}`);
        continue;
      }
      if (typeof locId !== 'string' || !isLocationValidForSpatialMode(params.state, locId)) {
        strippedInvalidItems.push(`offscreenMove:${charId}:unknown_location_${String(locId)}`);
        continue;
      }

      const movingIntoScene =
        params.state.scene.locationId !== null && locId === params.state.scene.locationId;
      if (movingIntoScene) {
        const group = resolveCharacterFormGroup(char, params.formDefinitions);
        if (group !== null && occupiedFormGroups.has(group) && !nextPresentSet.has(charId)) {
          strippedInvalidItems.push(`offscreenMove:${charId}:duplicate_form_group_${group}`);
          continue;
        }
        if (group !== null) {
          occupiedFormGroups.add(group);
        }
        nextPresentSet.add(charId);
      } else {
        nextPresentSet.delete(charId);
      }

      operations.push({
        op: 'entity_patch',
        collection: 'characters',
        entityId: charId,
        patch: {
          locationId: locId,
          presentInScene: movingIntoScene,
        },
      });
      seenMutations.add(charId);
    }
  }

  if (seenMutations.size > 0) {
    operations.push({
      op: 'set',
      path: 'scene.presentCharacterIds',
      value: [...nextPresentSet].sort(),
    });
  }

  if (operations.length === 0) {
    return {
      presence,
      proposedBatch: null,
      strippedInvalidItems,
      warnings,
    };
  }

  return {
    presence,
    proposedBatch: {
      eventId: `cast-director-turn-${params.state.meta.turn}`,
      source: 'agenda',
      operations,
      reason: 'Cast director scene presence and offscreen transition proposals',
    },
    strippedInvalidItems,
    warnings,
  };
}
