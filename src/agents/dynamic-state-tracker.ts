import { type ValidationError, validationError } from '../core/errors.js';
import type { ModelGateway } from '../gateway/model-gateway.js';
import type { ChatMessage } from '../gateway/types.js';
import type { ResolvedControlRoomConfig } from '../config/control-room-config.js';
import {
  type CadenceContext,
  type CompiledFieldPolicy,
  type CompiledTrackerSchema,
  type TrackerCompileContext,
  compileActiveTrackerSchema,
} from '../schema/dynamic-schema-compiler.js';
import type { PatchBatch, PatchOperation } from '../state/patch.js';
import type { CharacterEntity, WorldState } from '../state/world-state.js';

export interface RunTrackerParams {
  state: WorldState;
  config: ResolvedControlRoomConfig;
  gateway: ModelGateway;
  turnContext: CadenceContext;
  recentExchangeText: string;
  latestNarratorReply: string;
  signal?: AbortSignal;
  autoRegisterEmergentNpcs?: boolean;
}

export type RunDynamicStateTrackerParams = RunTrackerParams;

export interface RunTrackerResult {
  skippedByCadence: boolean;
  proposedBatch: PatchBatch | null;
  compiledSchema: CompiledTrackerSchema;
  rawResponse?: string;
  warnings: ValidationError[];
}

const MAX_EMERGENT_NPCS_PER_TURN = 5;
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const LOCATION_NATIVE_FIELDS: ReadonlySet<string> = new Set([
  'name',
  'kind',
  'status',
  'controllingFactionId',
  'connectedLocations',
  'discovered',
  'tags',
  'notes',
]);

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

function getOwn(record: Record<string, unknown>, key: string): unknown {
  if (!isSafeKey(key) || !Object.hasOwn(record, key)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(record, key)?.value;
}

function setOwn<T extends object>(obj: T, key: string, value: unknown): void {
  Object.defineProperty(obj, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function sanitizeCharacterId(rawId: string): string {
  return rawId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function lookupNpcSectionPolicy(
  compiledSchema: CompiledTrackerSchema | undefined,
  characterId: string,
  sectionId: string
): CompiledFieldPolicy | undefined {
  if (!compiledSchema) {
    return undefined;
  }
  return (
    compiledSchema.fieldPolicyMap.get(`entities.characters.${characterId}.sections.${sectionId}`) ??
    compiledSchema.fieldPolicyMap.get(`entities.characters.*.sections.${sectionId}`)
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isValidCharacterOrPlayerRef(
  state: WorldState,
  id: string,
  knownCharacterIds: ReadonlySet<string>
): boolean {
  if (!isSafeKey(id)) {
    return false;
  }
  return (
    id === 'player' ||
    id === state.player.id ||
    (state.player.characterId !== null && id === state.player.characterId) ||
    knownCharacterIds.has(id)
  );
}

function buildTrackerMessages(
  state: WorldState,
  compiled: CompiledTrackerSchema,
  recentExchangeText: string,
  latestNarratorReply: string
): ChatMessage[] {
  const instructions =
    compiled.activeTrackerInstructions.length > 0
      ? compiled.activeTrackerInstructions.join('\n')
      : 'Extract only state changes clearly supported by the latest exchange.';

  const knownCharacterIds = Object.keys(state.entities.characters)
    .filter(isSafeKey)
    .sort()
    .join(', ');
  const knownLocationIds = Object.keys(state.entities.locations)
    .filter(isSafeKey)
    .sort()
    .join(', ');

  return [
    {
      role: 'system',
      content: [
        'You are the state tracker micro-agent. Respond ONLY with JSON matching the provided schema.',
        `Spatial mode: ${state.capabilities.spatialMode}`,
        `Current location: ${state.scene.location} (locationId: ${state.scene.locationId ?? 'none'})`,
        `Known character IDs: ${knownCharacterIds || 'none'}`,
        `Known location IDs: ${knownLocationIds || 'none'}`,
        `Module instructions:\n${instructions}`,
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        'Recent exchange:',
        recentExchangeText,
        '',
        'Latest narrator reply:',
        latestNarratorReply,
      ].join('\n'),
    },
  ];
}

function normalizeSceneBucket(
  rawScene: unknown,
  state: WorldState,
  operations: PatchOperation[]
): void {
  if (!isPlainRecord(rawScene)) {
    return;
  }
  for (const fieldKey of Object.keys(rawScene)) {
    if (!isSafeKey(fieldKey)) {
      continue;
    }
    const val = getOwn(rawScene, fieldKey);
    if (val === undefined) {
      continue;
    }
    if (
      fieldKey === 'location' &&
      state.capabilities.spatialMode === 'emergent' &&
      typeof val === 'string' &&
      val.trim().length > 0
    ) {
      operations.push({
        op: 'emergent_location_visit',
        locationName: val.trim(),
      });
      continue;
    }
    if (Object.hasOwn(state.scene, fieldKey)) {
      operations.push({
        op: 'set',
        path: `scene.${fieldKey}`,
        value: val,
      });
    } else {
      operations.push({
        op: 'custom_field_patch',
        target: 'global',
        fieldId: fieldKey,
        value: val,
      });
    }
  }
}

function normalizeCustomFieldsBucket(
  rawBucket: unknown,
  target: 'global' | 'player',
  operations: PatchOperation[]
): void {
  if (!isPlainRecord(rawBucket)) {
    return;
  }
  for (const fieldId of Object.keys(rawBucket)) {
    if (!isSafeKey(fieldId)) {
      continue;
    }
    const val = getOwn(rawBucket, fieldId);
    if (val === undefined) {
      continue;
    }
    operations.push({
      op: 'custom_field_patch',
      target,
      fieldId,
      value: val,
    });
  }
}

function normalizeNewCharactersBucket(
  rawList: unknown,
  state: WorldState,
  compiledSchema: CompiledTrackerSchema | undefined,
  knownCharacterIds: Set<string>,
  operations: PatchOperation[],
  warnings: ValidationError[]
): void {
  if (!Array.isArray(rawList)) {
    return;
  }

  const divertedSectionOps: PatchOperation[] = [];
  let registeredCount = 0;

  for (let i = 0; i < rawList.length; i += 1) {
    const item = rawList[i];
    if (!isPlainRecord(item)) {
      continue;
    }
    if (registeredCount >= MAX_EMERGENT_NPCS_PER_TURN) {
      warnings.push(
        validationError(
          'new_characters',
          'MAX_EMERGENT_NPCS_EXCEEDED',
          `Capped emergent NPC registration at ${MAX_EMERGENT_NPCS_PER_TURN} per turn`
        )
      );
      break;
    }

    const rawId = getOwn(item, 'id');
    const rawName = getOwn(item, 'name');

    if (typeof rawId !== 'string' || rawId.trim().length === 0) {
      warnings.push(
        validationError(
          `new_characters[${i}].id`,
          'INVALID_CHARACTER_ID',
          'Ignored new_characters entry with missing or non-string id'
        )
      );
      continue;
    }

    const trimmedRawId = rawId.trim();
    if (!isSafeKey(trimmedRawId) || FORBIDDEN_KEYS.has(trimmedRawId.toLowerCase())) {
      warnings.push(
        validationError(
          `new_characters[${i}].id`,
          'UNSAFE_KEY',
          `Rejected unsafe character id "${trimmedRawId}"`
        )
      );
      continue;
    }

    const characterId = sanitizeCharacterId(trimmedRawId);
    if (!isSafeKey(characterId)) {
      warnings.push(
        validationError(
          `new_characters[${i}].id`,
          'INVALID_CHARACTER_ID',
          `Rejected invalid character id "${trimmedRawId}"`
        )
      );
      continue;
    }

    if (
      characterId === 'player' ||
      characterId === state.player.id ||
      (state.player.characterId !== null && characterId === state.player.characterId)
    ) {
      warnings.push(
        validationError(
          `new_characters[${i}].id`,
          'PLAYER_ID_CONFLICT',
          `Ignored new_characters entry targeting player character "${characterId}"`
        )
      );
      continue;
    }

    if (knownCharacterIds.has(characterId)) {
      warnings.push(
        validationError(
          `new_characters[${i}].id`,
          'CHARACTER_ALREADY_EXISTS',
          `Ignored new_characters entry for existing character "${characterId}"`
        )
      );
      continue;
    }

    if (typeof rawName !== 'string' || rawName.trim().length === 0) {
      warnings.push(
        validationError(
          `new_characters[${i}].name`,
          'INVALID_NAME',
          `Ignored new_characters entry "${characterId}" with missing or empty name`
        )
      );
      continue;
    }

    const character: Partial<Omit<CharacterEntity, 'id'>> & { name: string } = {
      name: rawName.trim(),
    };

    const rawMood = getOwn(item, 'mood');
    if (typeof rawMood === 'string' && rawMood.trim().length > 0) {
      character.mood = rawMood.trim();
    }

    const rawAllegiance = getOwn(item, 'allegiance');
    if (typeof rawAllegiance === 'string' && rawAllegiance.trim().length > 0) {
      character.allegiance = rawAllegiance.trim();
    }

    const rawTraits = getOwn(item, 'traits');
    if (isStringArray(rawTraits)) {
      character.traits = rawTraits.map((t) => t.trim()).filter((t) => t.length > 0);
    }

    const rawPresent = getOwn(item, 'presentInScene');
    if (typeof rawPresent === 'boolean') {
      character.presentInScene = rawPresent;
      if (!rawPresent && state.capabilities.spatialMode !== 'scene_only') {
        character.locationId = null;
      }
    } else {
      character.presentInScene = true;
    }

    const rawSections = getOwn(item, 'sections');
    if (isPlainRecord(rawSections)) {
      const allowedSections: Record<string, string | string[]> = {};
      for (const sectionId of Object.keys(rawSections).sort()) {
        if (!isSafeKey(sectionId)) {
          warnings.push(
            validationError(
              `new_characters[${i}].sections.${sectionId}`,
              'UNSAFE_KEY',
              `Rejected unsafe section key "${sectionId}"`
            )
          );
          continue;
        }
        const sectionVal = getOwn(rawSections, sectionId);
        if (sectionVal === undefined) {
          continue;
        }
        if (typeof sectionVal !== 'string' && !isStringArray(sectionVal)) {
          warnings.push(
            validationError(
              `new_characters[${i}].sections.${sectionId}`,
              'INVALID_TYPE',
              `Ignored non-string/string[] value for new_characters[${i}].sections.${sectionId}`
            )
          );
          continue;
        }

        const clonedVal: string | string[] =
          typeof sectionVal === 'string' ? sectionVal : [...sectionVal];
        const policy = lookupNpcSectionPolicy(compiledSchema, characterId, sectionId);
        if (policy !== undefined) {
          if (!policy.writableByTracker || policy.confirmPolicy === 'locked') {
            warnings.push(
              validationError(
                `new_characters[${i}].sections.${sectionId}`,
                'LOCKED_SECTION',
                `Stripped locked section "${sectionId}" from new_characters[${i}] ("${characterId}")`
              )
            );
            continue;
          }
          if (policy.confirmPolicy === 'always_confirm' || policy.confirmPolicy === 'batch_confirm') {
            divertedSectionOps.push({
              op: 'section_patch',
              target: { characterId },
              sectionId,
              value: clonedVal,
            });
            continue;
          }
        }

        setOwn(allowedSections, sectionId, clonedVal);
      }
      if (Object.keys(allowedSections).length > 0) {
        character.sections = allowedSections;
      }
    }

    operations.push({
      op: 'character_upsert',
      characterId,
      character,
      mergeIfExists: false,
    });
    knownCharacterIds.add(characterId);
    registeredCount += 1;
  }

  operations.push(...divertedSectionOps);
}

function normalizeNpcCustomFieldsBucket(
  rawList: unknown,
  knownCharacterIds: ReadonlySet<string>,
  operations: PatchOperation[],
  warnings: ValidationError[]
): void {
  if (!Array.isArray(rawList)) {
    return;
  }
  for (let i = 0; i < rawList.length; i += 1) {
    const item = rawList[i];
    if (!isPlainRecord(item)) {
      continue;
    }
    const characterId = getOwn(item, 'characterId');
    if (
      typeof characterId !== 'string' ||
      !isSafeKey(characterId) ||
      !knownCharacterIds.has(characterId)
    ) {
      warnings.push(
        validationError(
          `npc_custom_fields[${i}].characterId`,
          'UNKNOWN_CHARACTER',
          `Ignored custom field update for unknown character "${String(characterId)}"`
        )
      );
      continue;
    }
    for (const fieldId of Object.keys(item)) {
      if (fieldId === 'characterId' || !isSafeKey(fieldId)) {
        continue;
      }
      const val = getOwn(item, fieldId);
      if (val === undefined) {
        continue;
      }
      operations.push({
        op: 'custom_field_patch',
        target: { characterId },
        fieldId,
        value: val,
      });
    }
  }
}

function normalizeLocationCustomFieldsBucket(
  rawList: unknown,
  state: WorldState,
  operations: PatchOperation[],
  warnings: ValidationError[]
): void {
  if (!Array.isArray(rawList)) {
    return;
  }
  for (let i = 0; i < rawList.length; i += 1) {
    const item = rawList[i];
    if (!isPlainRecord(item)) {
      continue;
    }
    const locationId = getOwn(item, 'locationId');
    if (
      typeof locationId !== 'string' ||
      !isSafeKey(locationId) ||
      !Object.hasOwn(state.entities.locations, locationId)
    ) {
      warnings.push(
        validationError(
          `location_custom_fields[${i}].locationId`,
          'UNKNOWN_LOCATION',
          `Ignored custom field update for unknown location "${String(locationId)}"`
        )
      );
      continue;
    }
    const nativePatch: Record<string, unknown> = {};
    for (const fieldId of Object.keys(item)) {
      if (fieldId === 'locationId' || !isSafeKey(fieldId)) {
        continue;
      }
      const val = getOwn(item, fieldId);
      if (val === undefined) {
        continue;
      }
      if (LOCATION_NATIVE_FIELDS.has(fieldId)) {
        Object.defineProperty(nativePatch, fieldId, {
          value: val,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      } else {
        operations.push({
          op: 'custom_field_patch',
          target: 'global',
          fieldId: `location_${locationId}_${fieldId}`,
          value: val,
        });
      }
    }
    if (Object.keys(nativePatch).length > 0) {
      operations.push({
        op: 'entity_patch',
        collection: 'locations',
        entityId: locationId,
        patch: nativePatch,
      });
    }
  }
}

function normalizePcSectionsBucket(
  rawSections: unknown,
  operations: PatchOperation[],
  warnings: ValidationError[]
): void {
  if (!isPlainRecord(rawSections)) {
    return;
  }
  for (const sectionId of Object.keys(rawSections)) {
    if (!isSafeKey(sectionId)) {
      continue;
    }
    const val = getOwn(rawSections, sectionId);
    if (val === undefined) {
      continue;
    }
    if (typeof val === 'string' || isStringArray(val)) {
      operations.push({
        op: 'section_patch',
        target: 'player',
        sectionId,
        value: val,
      });
    } else {
      warnings.push(
        validationError(
          `pc_sections.${sectionId}`,
          'INVALID_TYPE',
          `Ignored non-string/string[] value for pc_sections.${sectionId}`
        )
      );
    }
  }
}

function normalizeNpcSectionsBucket(
  rawList: unknown,
  knownCharacterIds: ReadonlySet<string>,
  operations: PatchOperation[],
  warnings: ValidationError[]
): void {
  if (!Array.isArray(rawList)) {
    return;
  }
  for (let i = 0; i < rawList.length; i += 1) {
    const item = rawList[i];
    if (!isPlainRecord(item)) {
      continue;
    }
    const characterId = getOwn(item, 'characterId');
    if (
      typeof characterId !== 'string' ||
      !isSafeKey(characterId) ||
      !knownCharacterIds.has(characterId)
    ) {
      warnings.push(
        validationError(
          `npc_sections[${i}].characterId`,
          'UNKNOWN_CHARACTER',
          `Ignored section update for unknown character "${String(characterId)}"`
        )
      );
      continue;
    }
    for (const sectionId of Object.keys(item)) {
      if (sectionId === 'characterId' || !isSafeKey(sectionId)) {
        continue;
      }
      const val = getOwn(item, sectionId);
      if (val === undefined) {
        continue;
      }
      if (typeof val === 'string' || isStringArray(val)) {
        operations.push({
          op: 'section_patch',
          target: { characterId },
          sectionId,
          value: val,
        });
      } else {
        warnings.push(
          validationError(
            `npc_sections[${i}].${sectionId}`,
            'INVALID_TYPE',
            `Ignored non-string/string[] value for npc_sections.${sectionId}`
          )
        );
      }
    }
  }
}

function normalizeRelationshipsBucket(
  rawList: unknown,
  state: WorldState,
  knownCharacterIds: ReadonlySet<string>,
  operations: PatchOperation[],
  warnings: ValidationError[]
): void {
  if (!Array.isArray(rawList)) {
    return;
  }
  for (let i = 0; i < rawList.length; i += 1) {
    const item = rawList[i];
    if (!isPlainRecord(item)) {
      continue;
    }
    const fromId = getOwn(item, 'fromId');
    const toId = getOwn(item, 'toId');
    if (
      typeof fromId !== 'string' ||
      typeof toId !== 'string' ||
      !isValidCharacterOrPlayerRef(state, fromId, knownCharacterIds) ||
      !isValidCharacterOrPlayerRef(state, toId, knownCharacterIds)
    ) {
      warnings.push(
        validationError(
          `relationships[${i}]`,
          'UNKNOWN_RELATION_ENTITY',
          `Ignored relationship update for unknown entity pair (${String(fromId)} -> ${String(toId)})`
        )
      );
      continue;
    }

    const affinityDelta = getOwn(item, 'affinityDelta');
    if (typeof affinityDelta === 'number' && Number.isFinite(affinityDelta) && affinityDelta !== 0) {
      operations.push({
        op: 'increment',
        path: `relations.${fromId}.${toId}.affinity`,
        delta: affinityDelta,
      });
      operations.push({
        op: 'clamp',
        path: `relations.${fromId}.${toId}.affinity`,
        min: -100,
        max: 100,
      });
    }

    const label = getOwn(item, 'label');
    if (typeof label === 'string' && label.trim().length > 0) {
      operations.push({
        op: 'set',
        path: `relations.${fromId}.${toId}.label`,
        value: label.trim(),
      });
    }

    const tags = getOwn(item, 'tags');
    if (isStringArray(tags)) {
      operations.push({
        op: 'set',
        path: `relations.${fromId}.${toId}.tags`,
        value: [...tags],
      });
    }
  }
}

function normalizeMoodsBucket(
  rawList: unknown,
  knownCharacterIds: ReadonlySet<string>,
  operations: PatchOperation[],
  warnings: ValidationError[]
): void {
  if (!Array.isArray(rawList)) {
    return;
  }
  for (let i = 0; i < rawList.length; i += 1) {
    const item = rawList[i];
    if (!isPlainRecord(item)) {
      continue;
    }
    const characterId = getOwn(item, 'characterId');
    const mood = getOwn(item, 'mood');
    if (
      typeof characterId !== 'string' ||
      !isSafeKey(characterId) ||
      !knownCharacterIds.has(characterId)
    ) {
      warnings.push(
        validationError(
          `moods[${i}].characterId`,
          'UNKNOWN_CHARACTER',
          `Ignored mood update for unknown character "${String(characterId)}"`
        )
      );
      continue;
    }
    if (typeof mood === 'string' && mood.trim().length > 0) {
      operations.push({
        op: 'entity_patch',
        collection: 'characters',
        entityId: characterId,
        patch: { mood: mood.trim() },
      });
    }
  }
}

export function normalizeTrackerResponse(
  data: Record<string, unknown>,
  state: WorldState,
  turn: number,
  compiledSchema?: CompiledTrackerSchema,
  autoRegisterEmergentNpcs = false
): { batch: PatchBatch | null; warnings: ValidationError[] } {
  const operations: PatchOperation[] = [];
  const warnings: ValidationError[] = [];
  const knownCharacterIds = new Set<string>(
    Object.keys(state.entities.characters).filter(isSafeKey)
  );

  if (autoRegisterEmergentNpcs) {
    normalizeNewCharactersBucket(
      getOwn(data, 'new_characters'),
      state,
      compiledSchema,
      knownCharacterIds,
      operations,
      warnings
    );
  }

  normalizeSceneBucket(getOwn(data, 'scene'), state, operations);
  normalizeCustomFieldsBucket(getOwn(data, 'custom_fields'), 'global', operations);
  normalizeCustomFieldsBucket(getOwn(data, 'player_custom_fields'), 'player', operations);
  normalizeNpcCustomFieldsBucket(
    getOwn(data, 'npc_custom_fields'),
    knownCharacterIds,
    operations,
    warnings
  );
  normalizeLocationCustomFieldsBucket(
    getOwn(data, 'location_custom_fields'),
    state,
    operations,
    warnings
  );
  normalizePcSectionsBucket(getOwn(data, 'pc_sections'), operations, warnings);
  normalizeNpcSectionsBucket(getOwn(data, 'npc_sections'), knownCharacterIds, operations, warnings);
  normalizeRelationshipsBucket(
    getOwn(data, 'relationships'),
    state,
    knownCharacterIds,
    operations,
    warnings
  );
  normalizeMoodsBucket(getOwn(data, 'moods'), knownCharacterIds, operations, warnings);

  normalizeCustomFieldsBucket(getOwn(data, 'progression'), 'global', operations);
  normalizeCustomFieldsBucket(getOwn(data, 'combat'), 'global', operations);
  normalizeCustomFieldsBucket(getOwn(data, 'factions'), 'global', operations);

  if (operations.length === 0) {
    return { batch: null, warnings };
  }

  return {
    batch: {
      eventId: `tracker-turn-${turn}`,
      source: 'tracker',
      operations,
      reason: 'Dynamic state tracker extraction',
    },
    warnings,
  };
}

/**
 * Compile the cadence-throttled tracker schema for the current turn, short-circuiting with
 * zero LLM calls if no tracker modules or sections are due.
 */
export async function runDynamicStateTracker(params: RunTrackerParams): Promise<RunTrackerResult> {
  const compileContext: TrackerCompileContext =
    params.autoRegisterEmergentNpcs !== undefined
      ? { ...params.turnContext, autoRegisterEmergentNpcs: params.autoRegisterEmergentNpcs }
      : params.turnContext;
  const compiledSchema = compileActiveTrackerSchema(params.config, compileContext);

  if (compiledSchema.trackerJsonSchema === null) {
    return {
      skippedByCadence: true,
      proposedBatch: null,
      compiledSchema,
      warnings: [],
    };
  }

  const messages = buildTrackerMessages(
    params.state,
    compiledSchema,
    params.recentExchangeText,
    params.latestNarratorReply
  );

  const gatewayRes = await params.gateway.generateStructured<Record<string, unknown>>({
    role: 'state_tracker',
    messages,
    schema: compiledSchema.trackerJsonSchema,
    schemaName: 'dynamic_state_tracker',
    signal: params.signal,
  });

  if (!gatewayRes.ok) {
    return {
      skippedByCadence: false,
      proposedBatch: null,
      compiledSchema,
      warnings: [...gatewayRes.error],
    };
  }

  const normalized = normalizeTrackerResponse(
    gatewayRes.value.data,
    params.state,
    params.turnContext.turn,
    compiledSchema,
    params.autoRegisterEmergentNpcs === true
  );

  return {
    skippedByCadence: false,
    proposedBatch: normalized.batch,
    compiledSchema,
    rawResponse: gatewayRes.value.rawText,
    warnings: normalized.warnings,
  };
}
