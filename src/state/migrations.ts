import { type ValidationError, validationError } from '../core/errors.js';
import { createSeededRng } from '../core/prng.js';
import { type Result, err, ok } from '../core/result.js';
import { DEFAULT_TIME_SLOTS } from '../core/world-clock.js';
import type { SystemCapabilities } from '../schema/tracker-module.js';
import {
  WORLD_STATE_SCHEMA_VERSION,
  type WorldState,
  validateWorldState,
} from './world-state.js';

export const CURRENT_STATE_SCHEMA_VERSION = WORLD_STATE_SCHEMA_VERSION;

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function isSafeKey(key: string): boolean {
  return key.length > 0 && !FORBIDDEN_KEYS.has(key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function getOwn(obj: Record<string, unknown>, key: string): unknown {
  if (!isSafeKey(key) || !Object.hasOwn(obj, key)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(obj, key)?.value;
}

function setOwn(obj: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(obj, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function assertNoForbiddenKeys(value: unknown, path: string): Result<void, ValidationError[]> {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const check = assertNoForbiddenKeys(value[i], `${path}[${i}]`);
      if (!check.ok) {
        return check;
      }
    }
    return ok(undefined);
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.getOwnPropertyNames(value)) {
      if (!isSafeKey(key)) {
        return err([
          validationError(
            path ? `${path}.${key}` : key,
            'UNSAFE_KEY',
            `Forbidden property key "${key}"`
          ),
        ]);
      }
      const child = Object.getOwnPropertyDescriptor(value, key)?.value;
      const check = assertNoForbiddenKeys(child, path ? `${path}.${key}` : key);
      if (!check.ok) {
        return check;
      }
    }
  }
  return ok(undefined);
}

function clonePlainDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(clonePlainDeep);
  }
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (!isSafeKey(key)) {
        continue;
      }
      setOwn(out, key, clonePlainDeep(getOwn(value as Record<string, unknown>, key)));
    }
    return out;
  }
  return value;
}

function normalizeProgression(rawProgression: unknown): unknown {
  if (!isPlainObject(rawProgression)) {
    return rawProgression;
  }
  const cloned = clonePlainDeep(rawProgression) as Record<string, unknown>;
  const legacyClass = getOwn(cloned, 'class');
  if (legacyClass !== undefined && getOwn(cloned, 'className') === undefined) {
    setOwn(cloned, 'className', legacyClass);
  }
  if (Object.hasOwn(cloned, 'class')) {
    delete cloned['class'];
  }
  return cloned;
}

function normalizeResources(rawResources: unknown): unknown {
  if (!isPlainObject(rawResources)) {
    return rawResources;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(rawResources)) {
    if (!isSafeKey(key)) {
      continue;
    }
    const val = getOwn(rawResources, key);
    if (typeof val === 'number' && Number.isFinite(val)) {
      setOwn(out, key, { current: val, max: val });
    } else {
      setOwn(out, key, clonePlainDeep(val));
    }
  }
  return out;
}

function normalizeCollectionToMap(rawCollection: unknown): Record<string, unknown> | unknown {
  if (rawCollection === undefined) {
    return {};
  }
  if (Array.isArray(rawCollection)) {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < rawCollection.length; i += 1) {
      const item = rawCollection[i];
      if (isPlainObject(item)) {
        const id = getOwn(item, 'id');
        if (typeof id === 'string' && id.trim().length > 0 && isSafeKey(id)) {
          setOwn(out, id, clonePlainDeep(item));
        } else {
          const cloned = clonePlainDeep(item) as Record<string, unknown>;
          if (id === undefined) {
            setOwn(cloned, 'id', '');
          }
          setOwn(out, `__invalid_${i}`, cloned);
        }
      } else {
        setOwn(out, `__invalid_${i}`, item);
      }
    }
    return out;
  }
  if (isPlainObject(rawCollection)) {
    return clonePlainDeep(rawCollection) as Record<string, unknown>;
  }
  return rawCollection;
}

function normalizeCharactersMap(rawChars: unknown): unknown {
  const mapOrInvalid = normalizeCollectionToMap(rawChars);
  if (!isPlainObject(mapOrInvalid)) {
    return mapOrInvalid;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(mapOrInvalid)) {
    if (!isSafeKey(key)) {
      continue;
    }
    const rawChar = getOwn(mapOrInvalid, key);
    if (!isPlainObject(rawChar)) {
      setOwn(out, key, rawChar);
      continue;
    }
    const charObj = clonePlainDeep(rawChar) as Record<string, unknown>;
    if (getOwn(charObj, 'id') === undefined) {
      setOwn(charObj, 'id', key);
    }
    const legacyCustomFields = getOwn(charObj, 'custom_fields');
    if (legacyCustomFields !== undefined && getOwn(charObj, 'customFields') === undefined) {
      setOwn(charObj, 'customFields', legacyCustomFields);
    }
    if (Object.hasOwn(charObj, 'custom_fields')) {
      delete charObj['custom_fields'];
    }
    const prog = getOwn(charObj, 'progression');
    if (prog !== undefined) {
      setOwn(charObj, 'progression', normalizeProgression(prog));
    }
    const res = getOwn(charObj, 'resources');
    if (res !== undefined) {
      setOwn(charObj, 'resources', normalizeResources(res));
    }
    setOwn(out, key, charObj);
  }
  return out;
}

function normalizeRelations(rawRelations: unknown): unknown {
  if (rawRelations === undefined) {
    return {};
  }
  if (!isPlainObject(rawRelations)) {
    return rawRelations;
  }
  const out: Record<string, unknown> = {};
  for (const fromId of Object.keys(rawRelations)) {
    if (!isSafeKey(fromId)) {
      continue;
    }
    const targets = getOwn(rawRelations, fromId);
    if (!isPlainObject(targets)) {
      setOwn(out, fromId, targets);
      continue;
    }
    const targetOut: Record<string, unknown> = {};
    for (const toId of Object.keys(targets)) {
      if (!isSafeKey(toId)) {
        continue;
      }
      const entry = getOwn(targets, toId);
      if (typeof entry === 'number' && Number.isFinite(entry)) {
        setOwn(targetOut, toId, {
          affinity: entry,
          maxAffinity: 100,
          label: '',
          tags: [],
        });
      } else if (isPlainObject(entry)) {
        const clonedEntry = clonePlainDeep(entry) as Record<string, unknown>;
        if (getOwn(clonedEntry, 'maxAffinity') === undefined) {
          setOwn(clonedEntry, 'maxAffinity', 100);
        }
        if (getOwn(clonedEntry, 'label') === undefined) {
          setOwn(clonedEntry, 'label', '');
        }
        if (getOwn(clonedEntry, 'tags') === undefined) {
          setOwn(clonedEntry, 'tags', []);
        }
        setOwn(targetOut, toId, clonedEntry);
      } else {
        setOwn(targetOut, toId, entry);
      }
    }
    setOwn(out, fromId, targetOut);
  }
  return out;
}

function normalizeInventory(rawInventory: unknown): unknown {
  if (rawInventory === undefined) {
    return { items: {}, currency: {} };
  }
  if (Array.isArray(rawInventory)) {
    const items: Record<string, number> = {};
    for (const entry of rawInventory) {
      if (typeof entry === 'string' && isSafeKey(entry)) {
        const prev = getOwn(items, entry);
        setOwn(items, entry, typeof prev === 'number' ? prev + 1 : 1);
      }
    }
    return { items, currency: {} };
  }
  if (isPlainObject(rawInventory)) {
    const cloned = clonePlainDeep(rawInventory) as Record<string, unknown>;
    if (Array.isArray(getOwn(cloned, 'items'))) {
      const items: Record<string, number> = {};
      for (const entry of getOwn(cloned, 'items') as unknown[]) {
        if (typeof entry === 'string' && isSafeKey(entry)) {
          const prev = getOwn(items, entry);
          setOwn(items, entry, typeof prev === 'number' ? prev + 1 : 1);
        }
      }
      setOwn(cloned, 'items', items);
    }
    return cloned;
  }
  return rawInventory;
}

function migrateV1ToV2Candidate(raw: Record<string, unknown>): Record<string, unknown> {
  const rawMeta = isPlainObject(getOwn(raw, 'meta')) ? (getOwn(raw, 'meta') as Record<string, unknown>) : {};
  const rawClocksSource = getOwn(raw, 'clocks') ?? getOwn(raw, 'worldClock');
  const rawClocks = isPlainObject(rawClocksSource) ? rawClocksSource : {};

  const sessionId =
    getOwn(rawMeta, 'sessionId') ??
    getOwn(raw, 'sessionId') ??
    'migrated-v1-session';

  const turn =
    getOwn(rawMeta, 'turn') ??
    getOwn(raw, 'turn') ??
    getOwn(rawClocks, 'turn') ??
    0;

  const rngSeed = getOwn(rawMeta, 'rngSeed') ?? getOwn(raw, 'rngSeed');
  const rngSeedArg =
    typeof rngSeed === 'string' || typeof rngSeed === 'number'
      ? rngSeed
      : typeof sessionId === 'string'
        ? sessionId
        : 'migrated-v1-session';

  const rngState =
    getOwn(rawMeta, 'rngState') ??
    getOwn(raw, 'rngState') ??
    createSeededRng(rngSeedArg);

  const meta: Record<string, unknown> = {
    sessionId,
    turn,
    rngState: clonePlainDeep(rngState),
    arc: getOwn(rawMeta, 'arc') ?? getOwn(raw, 'arc') ?? 'freeform',
    endingStatus: getOwn(rawMeta, 'endingStatus') ?? getOwn(raw, 'endingStatus') ?? 'none',
    activeEndingId: getOwn(rawMeta, 'activeEndingId') ?? getOwn(raw, 'activeEndingId') ?? null,
  };

  // entities
  const rawEntities = isPlainObject(getOwn(raw, 'entities'))
    ? (getOwn(raw, 'entities') as Record<string, unknown>)
    : {};
  const characters = normalizeCharactersMap(
    getOwn(rawEntities, 'characters') ?? getOwn(raw, 'characters')
  );
  const factions = normalizeCollectionToMap(
    getOwn(rawEntities, 'factions') ?? getOwn(raw, 'factions')
  );
  const threats = normalizeCollectionToMap(
    getOwn(rawEntities, 'threats') ?? getOwn(raw, 'threats')
  );
  const locations = normalizeCollectionToMap(
    getOwn(rawEntities, 'locations') ?? getOwn(raw, 'locations')
  );
  if (isPlainObject(locations)) {
    for (const loc of Object.values(locations)) {
      if (isPlainObject(loc) && getOwn(loc, 'discoveryState') === undefined) {
        const discovered = getOwn(loc, 'discovered');
        if (typeof discovered === 'boolean') {
          setOwn(loc, 'discoveryState', discovered ? 'discovered' : 'unknown');
        }
      }
    }
  }

  // player
  const rawPlayerSource = getOwn(raw, 'player');
  let player: unknown;
  if (rawPlayerSource !== undefined && !isPlainObject(rawPlayerSource)) {
    player = rawPlayerSource;
  } else {
    const rp = isPlainObject(rawPlayerSource) ? rawPlayerSource : {};
    const playerCustomFields =
      getOwn(rp, 'customFields') ?? getOwn(rp, 'custom_fields') ?? {};
    const p: Record<string, unknown> = {
      id: getOwn(rp, 'id') ?? 'player',
      name: getOwn(rp, 'name') ?? getOwn(raw, 'playerName') ?? 'The Player',
      characterId: getOwn(rp, 'characterId') ?? null,
      locationId: getOwn(rp, 'locationId') ?? null,
      inventory: normalizeInventory(getOwn(rp, 'inventory')),
      customFields: clonePlainDeep(playerCustomFields),
      sections: clonePlainDeep(getOwn(rp, 'sections') ?? {}),
    };
    const pProg = getOwn(rp, 'progression');
    if (pProg !== undefined) {
      setOwn(p, 'progression', normalizeProgression(pProg));
    }
    const pRes = getOwn(rp, 'resources');
    if (pRes !== undefined) {
      setOwn(p, 'resources', normalizeResources(pRes));
    }
    player = p;
  }

  // scene
  const rawSceneSource = getOwn(raw, 'scene');
  let scene: unknown;
  if (rawSceneSource !== undefined && !isPlainObject(rawSceneSource)) {
    scene = rawSceneSource;
  } else {
    const rs = isPlainObject(rawSceneSource) ? rawSceneSource : {};
    const rpObj = isPlainObject(rawPlayerSource) ? rawPlayerSource : {};
    const fallbackLocation =
      typeof getOwn(rpObj, 'location') === 'string' ? getOwn(rpObj, 'location') : '';
    scene = {
      location: getOwn(rs, 'location') ?? fallbackLocation ?? '',
      locationId: getOwn(rs, 'locationId') ?? null,
      presentCharacterIds:
        getOwn(rs, 'presentCharacterIds') ?? getOwn(rs, 'presentCharacters') ?? [],
      pinnedCharacterIds:
        getOwn(rs, 'pinnedCharacterIds') ?? getOwn(rs, 'pinnedCharacters') ?? [],
      mood: getOwn(rs, 'mood') ?? 'neutral',
      pacing: getOwn(rs, 'pacing') ?? 'balanced',
      directorNudge: getOwn(rs, 'directorNudge') ?? null,
    };
  }

  // clocks
  let clocks: unknown;
  if (rawClocksSource !== undefined && !isPlainObject(rawClocksSource)) {
    clocks = rawClocksSource;
  } else {
    const defaultTurn = typeof turn === 'number' && Number.isInteger(turn) && turn >= 0 ? turn : 0;
    clocks = {
      turn: getOwn(rawClocks, 'turn') ?? defaultTurn,
      storyTurn: getOwn(rawClocks, 'storyTurn') ?? defaultTurn,
      day: getOwn(rawClocks, 'day') ?? getOwn(raw, 'day') ?? 1,
      inGameDate:
        getOwn(rawClocks, 'inGameDate') ??
        getOwn(rawClocks, 'date') ??
        getOwn(raw, 'inGameDate') ??
        getOwn(raw, 'date') ??
        null,
      slot: getOwn(rawClocks, 'slot') ?? getOwn(raw, 'slot') ?? 'morning',
      slotsPerDay: clonePlainDeep(
        getOwn(rawClocks, 'slotsPerDay') ?? [...DEFAULT_TIME_SLOTS]
      ),
      held: getOwn(rawClocks, 'held') ?? false,
      holdReason: getOwn(rawClocks, 'holdReason') ?? null,
      timers: clonePlainDeep(getOwn(rawClocks, 'timers') ?? {}),
    };
  }

  // relations
  const relations = normalizeRelations(getOwn(raw, 'relations'));

  // chronicle
  const rawChronicle = getOwn(raw, 'chronicle');
  let chronicle: unknown;
  if (Array.isArray(rawChronicle)) {
    chronicle = { events: clonePlainDeep(rawChronicle) };
  } else if (isPlainObject(rawChronicle)) {
    chronicle = clonePlainDeep(rawChronicle);
  } else if (Array.isArray(getOwn(raw, 'chronicleEvents'))) {
    chronicle = { events: clonePlainDeep(getOwn(raw, 'chronicleEvents')) };
  } else if (rawChronicle !== undefined) {
    chronicle = rawChronicle;
  } else {
    chronicle = { events: [] };
  }

  // capabilities
  const rawCapabilities = getOwn(raw, 'capabilities');
  let capabilities: unknown;
  if (rawCapabilities !== undefined) {
    capabilities = clonePlainDeep(rawCapabilities);
  } else {
    const hasLocations = isPlainObject(locations) && Object.keys(locations).length > 0;
    const hasFactions = isPlainObject(factions) && Object.keys(factions).length > 0;
    const hasRelations = isPlainObject(relations) && Object.keys(relations).length > 0;
    const hasChronicle =
      isPlainObject(chronicle) &&
      Array.isArray(getOwn(chronicle, 'events')) &&
      (getOwn(chronicle, 'events') as unknown[]).length > 0;
    const playerHasProgression =
      isPlainObject(player) && getOwn(player, 'progression') !== undefined;
    const playerHasResources =
      isPlainObject(player) && getOwn(player, 'resources') !== undefined;

    const inferredCapabilities: SystemCapabilities = {
      spatialMode: hasLocations ? 'emergent' : 'scene_only',
      combatMode: playerHasResources ? 'traditional' : 'disabled',
      progression: playerHasProgression ? 'rpg_levels' : 'disabled',
      clocks: rawClocksSource !== undefined ? 'full_sim' : 'disabled',
      factions: hasFactions,
      beats: false,
      relationships: hasRelations,
      chronicle: hasChronicle,
    };
    capabilities = inferredCapabilities;
  }

  const customFields = clonePlainDeep(
    getOwn(raw, 'customFields') ?? getOwn(raw, 'custom_fields') ?? {}
  );

  const turnEvents =
    getOwn(raw, 'turnEvents') !== undefined
      ? clonePlainDeep(getOwn(raw, 'turnEvents'))
      : { combatOutcomes: [], rumors: [], systemNotices: [] };

  return {
    schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
    meta,
    capabilities,
    player,
    scene,
    flags: clonePlainDeep(getOwn(raw, 'flags') ?? {}),
    counters: clonePlainDeep(getOwn(raw, 'counters') ?? {}),
    customFields,
    clocks,
    relations,
    entities: {
      characters,
      factions,
      threats,
      locations,
    },
    chronicle,
    turnEvents,
  };
}

/**
 * Migrate a v1 or legacy {@link WorldState} document into v2 and validate it
 * via {@link validateWorldState}. Never mutates `raw`.
 */
export function migrateWorldStateDocument(
  raw: unknown
): Result<{ worldState: WorldState; migratedFromVersion: number }, ValidationError[]> {
  if (!isPlainObject(raw)) {
    return err([
      validationError('', 'INVALID_TYPE', 'WorldState document must be a non-null plain object'),
    ]);
  }

  const safeCheck = assertNoForbiddenKeys(raw, '');
  if (!safeCheck.ok) {
    return safeCheck;
  }

  const explicitSchemaVersion = getOwn(raw, 'schemaVersion');
  const legacyVersion = getOwn(raw, 'version');
  const versionRaw = explicitSchemaVersion !== undefined ? explicitSchemaVersion : legacyVersion;

  let migratedFromVersion: number;
  if (versionRaw === undefined) {
    migratedFromVersion = 1;
  } else if (typeof versionRaw !== 'number' || !Number.isInteger(versionRaw) || versionRaw < 1) {
    return err([
      validationError(
        'schemaVersion',
        'INVALID_SCHEMA_VERSION',
        `Unsupported or invalid schemaVersion "${String(versionRaw)}"`
      ),
    ]);
  } else if (versionRaw > CURRENT_STATE_SCHEMA_VERSION) {
    return err([
      validationError(
        'schemaVersion',
        'UNSUPPORTED_SCHEMA_VERSION',
        `Cannot migrate schemaVersion ${versionRaw} newer than current ${CURRENT_STATE_SCHEMA_VERSION}`
      ),
    ]);
  } else {
    migratedFromVersion = versionRaw;
  }

  const candidate =
    migratedFromVersion === CURRENT_STATE_SCHEMA_VERSION
      ? clonePlainDeep(raw)
      : migrateV1ToV2Candidate(raw);

  const validation = validateWorldState(candidate);
  if (!validation.ok) {
    return err(validation.error);
  }

  return ok({
    worldState: validation.value.state,
    migratedFromVersion,
  });
}
