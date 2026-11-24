import { type ValidationError } from '../core/errors.js';
import { RefereeError } from '../core/errors.js';
import { type RngState, createSeededRng } from '../core/prng.js';
import { ErrorAccumulator, type Result } from '../core/result.js';
import {
  type ClockTimer,
  type CreateWorldClockOptions,
  type WorldClockState,
  createWorldClock,
  validateWorldClock,
} from '../core/world-clock.js';
import {
  type SpatialMode,
  type SystemCapabilities,
  cloneSystemCapabilities,
  validateSystemCapabilities,
} from '../schema/tracker-module.js';
import type { LocationEntity } from './spatial-topology.js';
import { type FormIndex, applyFormProfileOverlay } from './forms.js';

export const WORLD_STATE_SCHEMA_VERSION = 2 as const;

export const CHARACTER_STATUSES = Object.freeze([
  'active',
  'offscreen',
  'captured',
  'corrupted',
  'dead',
  'retired',
  'missing',
  'lost',
  'imprisoned',
] as const);

export type CharacterStatus = (typeof CHARACTER_STATUSES)[number];

export interface ResourcePool {
  current: number;
  max: number;
}

export interface CharacterProgression {
  level: number;
  xp: number;
  className?: string;
  subclass?: string;
  attributes?: Record<string, number>;
}

export interface CorruptionState {
  stage: number;
  progress: number;
  source: string | null;
}

export interface CharacterEntity {
  id: string;
  name: string;
  status: CharacterStatus;
  presentInScene: boolean;
  locationId: string | null;
  formId: string | null;
  formGroup: string | null;
  sections: Record<string, string | string[]>;
  customFields: Record<string, unknown>;
  progression?: CharacterProgression;
  resources?: Record<string, ResourcePool>;
  corruption?: CorruptionState;
  lockedForms?: Record<string, boolean>;
  abilities: string[];
  goals: string[];
  agenda: string;
  allegiance: string;
  mood: string;
  traits: string[];
}

export const FACTION_SIDES = Object.freeze([
  'hero',
  'villain',
  'neutral',
  'independent',
] as const);
export type FactionSide = (typeof FACTION_SIDES)[number];

export const FACTION_STATUSES = Object.freeze([
  'active',
  'dormant',
  'disbanded',
  'underground',
  'dominant',
] as const);
export type FactionStatus = (typeof FACTION_STATUSES)[number];

export interface FactionEntity {
  id: string;
  name: string;
  side: FactionSide;
  status: FactionStatus;
  influence: number;
  headquartersLocationId: string | null;
  goals: string[];
}

export const THREAT_RANKS = Object.freeze(['main', 'secondary'] as const);
export type ThreatRank = (typeof THREAT_RANKS)[number];

export const THREAT_STATUSES = Object.freeze([
  'active',
  'dormant',
  'defeated',
  'contained',
] as const);
export type ThreatStatus = (typeof THREAT_STATUSES)[number];

export interface ThreatEntity {
  id: string;
  name: string;
  rank: ThreatRank;
  status: ThreatStatus;
  stage: number;
  progress: number;
  locationId: string | null;
  sourceFactionId: string | null;
  agenda: string;
}

export const CHRONICLE_CATEGORIES = Object.freeze(['event', 'quest', 'world'] as const);
export type ChronicleCategory = (typeof CHRONICLE_CATEGORIES)[number];

export interface ChronicleEntry {
  id: string;
  turn: number;
  day: number;
  date: string | null;
  title: string;
  category: ChronicleCategory;
  summary: string;
  locationId: string | null;
  involvedEntityIds: string[];
  keywords: string[];
}

export interface RelationEntry {
  affinity: number;
  maxAffinity: number;
  label: string;
  tags: string[];
}

export const WORLD_ARCS = Object.freeze(['season', 'post-victory', 'freeform'] as const);
export type WorldArc = (typeof WORLD_ARCS)[number];

export const ENDING_STATUSES = Object.freeze([
  'none',
  'epilogue',
  'continued',
  'ended',
] as const);
export type EndingStatus = (typeof ENDING_STATUSES)[number];

export interface WorldState {
  schemaVersion: 2;
  meta: {
    sessionId: string;
    turn: number;
    rngState: RngState;
    arc: WorldArc;
    endingStatus: EndingStatus;
    activeEndingId: string | null;
  };
  capabilities: SystemCapabilities;
  player: {
    id: string;
    name: string;
    characterId: string | null;
    canonCharacterId?: string | null;
    locationId: string | null;
    progression?: CharacterProgression;
    resources?: Record<string, ResourcePool>;
    inventory: {
      items: Record<string, number>;
      currency: Record<string, number>;
    };
    customFields: Record<string, unknown>;
    sections: Record<string, string | string[]>;
  };
  scene: {
    location: string;
    locationId: string | null;
    presentCharacterIds: string[];
    pinnedCharacterIds: string[];
    mood: string;
    pacing: string;
    directorNudge: string | null;
  };
  flags: Record<string, boolean>;
  counters: Record<string, number>;
  customFields: Record<string, unknown>;
  clocks: WorldClockState;
  relations: Record<string, Record<string, RelationEntry>>;
  entities: {
    characters: Record<string, CharacterEntity>;
    factions: Record<string, FactionEntity>;
    threats: Record<string, ThreatEntity>;
    locations: Record<string, LocationEntity>;
  };
  chronicle: {
    events: ChronicleEntry[];
  };
  turnEvents: {
    combatOutcomes: string[];
    rumors: string[];
    systemNotices: string[];
  };
}

export interface CreateWorldStateOptions {
  sessionId?: string;
  capabilities?: SystemCapabilities;
  rngSeed?: string | number;
  rngState?: RngState;
  turn?: number;
  arc?: WorldArc;
  endingStatus?: EndingStatus;
  activeEndingId?: string | null;
  player?: Partial<WorldState['player']>;
  scene?: Partial<WorldState['scene']>;
  clocks?: CreateWorldClockOptions | WorldClockState;
  flags?: Record<string, boolean>;
  counters?: Record<string, number>;
  customFields?: Record<string, unknown>;
  relations?: Record<string, Record<string, RelationEntry>>;
  characters?: Record<string, CharacterEntity> | readonly CharacterEntity[];
  factions?: Record<string, FactionEntity> | readonly FactionEntity[];
  threats?: Record<string, ThreatEntity> | readonly ThreatEntity[];
  locations?: Record<string, LocationEntity> | readonly LocationEntity[];
  entities?: Partial<WorldState['entities']>;
  chronicleEvents?: readonly ChronicleEntry[];
  turnEvents?: Partial<WorldState['turnEvents']>;
}

const DEFAULT_CAPABILITIES: SystemCapabilities = {
  spatialMode: 'scene_only',
  combatMode: 'disabled',
  progression: 'disabled',
  clocks: 'disabled',
  factions: false,
  beats: false,
  relationships: false,
  chronicle: false,
};

const VALID_CHARACTER_STATUSES: ReadonlySet<string> = new Set(CHARACTER_STATUSES);
const VALID_FACTION_SIDES: ReadonlySet<string> = new Set(FACTION_SIDES);
const VALID_FACTION_STATUSES: ReadonlySet<string> = new Set(FACTION_STATUSES);
const VALID_THREAT_RANKS: ReadonlySet<string> = new Set(THREAT_RANKS);
const VALID_THREAT_STATUSES: ReadonlySet<string> = new Set(THREAT_STATUSES);
const VALID_CHRONICLE_CATEGORIES: ReadonlySet<string> = new Set(CHRONICLE_CATEGORIES);
const VALID_WORLD_ARCS: ReadonlySet<string> = new Set(WORLD_ARCS);
const VALID_ENDING_STATUSES: ReadonlySet<string> = new Set(ENDING_STATUSES);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function isUnsafeKey(key: string): boolean {
  return key.length === 0 || FORBIDDEN_KEYS.has(key);
}

function setRecordEntry<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function cloneUnknownValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneUnknownValue);
  }
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      setRecordEntry(out, k, cloneUnknownValue(v));
    }
    return out;
  }
  return value;
}

function clonePlainRecord(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    setRecordEntry(out, key, cloneUnknownValue(value));
  }
  return out;
}

function clonePrimitiveRecord<T>(record: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    setRecordEntry(out, key, value);
  }
  return out;
}

function cloneSections(sections: Record<string, string | string[]>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(sections)) {
    setRecordEntry(out, key, Array.isArray(value) ? [...value] : value);
  }
  return out;
}

function cloneResources(resources: Record<string, ResourcePool>): Record<string, ResourcePool> {
  const out: Record<string, ResourcePool> = {};
  for (const [key, pool] of Object.entries(resources)) {
    setRecordEntry(out, key, { current: pool.current, max: pool.max });
  }
  return out;
}

function cloneProgression(progression: CharacterProgression): CharacterProgression {
  const cloned: CharacterProgression = {
    level: progression.level,
    xp: progression.xp,
  };
  if (progression.className !== undefined) {
    cloned.className = progression.className;
  }
  if (progression.subclass !== undefined) {
    cloned.subclass = progression.subclass;
  }
  if (progression.attributes !== undefined) {
    cloned.attributes = clonePrimitiveRecord(progression.attributes);
  }
  return cloned;
}

function cloneRngState(rngState: RngState): RngState {
  if (rngState.type === 'queued') {
    return {
      type: 'queued',
      queue: [...rngState.queue],
      cursor: rngState.cursor,
      fallback: { ...rngState.fallback },
      drawCount: rngState.drawCount,
    };
  }
  return { ...rngState };
}

function cloneWorldClockState(clock: WorldClockState): WorldClockState {
  const timers: Record<string, ClockTimer> = {};
  for (const [id, timer] of Object.entries(clock.timers)) {
    setRecordEntry(timers, id, { ...timer });
  }
  return {
    turn: clock.turn,
    storyTurn: clock.storyTurn,
    day: clock.day,
    inGameDate: clock.inGameDate,
    slot: clock.slot,
    slotsPerDay: [...clock.slotsPerDay],
    held: clock.held,
    holdReason: clock.holdReason,
    timers,
  };
}

function cloneCharacterEntity(character: CharacterEntity): CharacterEntity {
  const cloned: CharacterEntity = {
    id: character.id,
    name: character.name,
    status: character.status,
    presentInScene: character.presentInScene,
    locationId: character.locationId,
    formId: character.formId,
    formGroup: character.formGroup,
    sections: cloneSections(character.sections),
    customFields: clonePlainRecord(character.customFields),
    abilities: [...character.abilities],
    goals: [...character.goals],
    agenda: character.agenda,
    allegiance: character.allegiance,
    mood: character.mood,
    traits: [...character.traits],
  };
  if (character.progression !== undefined) {
    cloned.progression = cloneProgression(character.progression);
  }
  if (character.resources !== undefined) {
    cloned.resources = cloneResources(character.resources);
  }
  if (character.corruption !== undefined) {
    cloned.corruption = { ...character.corruption };
  }
  if (character.lockedForms !== undefined) {
    cloned.lockedForms = clonePrimitiveRecord(character.lockedForms);
  }
  return cloned;
}

function cloneFactionEntity(faction: FactionEntity): FactionEntity {
  return {
    id: faction.id,
    name: faction.name,
    side: faction.side,
    status: faction.status,
    influence: faction.influence,
    headquartersLocationId: faction.headquartersLocationId,
    goals: [...faction.goals],
  };
}

function cloneThreatEntity(threat: ThreatEntity): ThreatEntity {
  return {
    id: threat.id,
    name: threat.name,
    rank: threat.rank,
    status: threat.status,
    stage: threat.stage,
    progress: threat.progress,
    locationId: threat.locationId,
    sourceFactionId: threat.sourceFactionId,
    agenda: threat.agenda,
  };
}

function cloneLocationEntity(location: LocationEntity): LocationEntity {
  return {
    id: location.id,
    name: location.name,
    kind: location.kind,
    status: location.status,
    controllingFactionId: location.controllingFactionId,
    connectedLocations: [...location.connectedLocations],
    discovered: location.discovered,
    tags: [...location.tags],
    notes: location.notes,
  };
}

function cloneChronicleEntry(entry: ChronicleEntry): ChronicleEntry {
  return {
    id: entry.id,
    turn: entry.turn,
    day: entry.day,
    date: entry.date,
    title: entry.title,
    category: entry.category,
    summary: entry.summary,
    locationId: entry.locationId,
    involvedEntityIds: [...entry.involvedEntityIds],
    keywords: [...entry.keywords],
  };
}

function cloneRelations(
  relations: Record<string, Record<string, RelationEntry>>
): Record<string, Record<string, RelationEntry>> {
  const out: Record<string, Record<string, RelationEntry>> = {};
  for (const [fromId, targets] of Object.entries(relations)) {
    const inner: Record<string, RelationEntry> = {};
    for (const [toId, entry] of Object.entries(targets)) {
      setRecordEntry(inner, toId, {
        affinity: entry.affinity,
        maxAffinity: entry.maxAffinity,
        label: entry.label,
        tags: [...entry.tags],
      });
    }
    setRecordEntry(out, fromId, inner);
  }
  return out;
}

function normalizeEntityMap<T extends { id: string }>(
  input: Record<string, T> | readonly T[] | undefined,
  cloneFn: (item: T) => T
): Record<string, T> {
  const out: Record<string, T> = {};
  if (!input) {
    return out;
  }
  if (Array.isArray(input)) {
    for (const item of input) {
      setRecordEntry(out, item.id, cloneFn(item));
    }
    return out;
  }
  for (const [id, item] of Object.entries(input as Record<string, T>)) {
    setRecordEntry(out, id, cloneFn(item));
  }
  return out;
}

/**
 * Create a deep, isolated clone of a {@link WorldState} document.
 */
export function cloneWorldState(state: WorldState): WorldState {
  const player: WorldState['player'] = {
    id: state.player.id,
    name: state.player.name,
    characterId: state.player.characterId,
    locationId: state.player.locationId,
    inventory: {
      items: clonePrimitiveRecord(state.player.inventory.items),
      currency: clonePrimitiveRecord(state.player.inventory.currency),
    },
    customFields: clonePlainRecord(state.player.customFields),
    sections: cloneSections(state.player.sections),
  };
  if (state.player.canonCharacterId !== undefined) {
    player.canonCharacterId = state.player.canonCharacterId;
  }
  if (state.player.progression !== undefined) {
    player.progression = cloneProgression(state.player.progression);
  }
  if (state.player.resources !== undefined) {
    player.resources = cloneResources(state.player.resources);
  }

  const characters: Record<string, CharacterEntity> = {};
  for (const [id, char] of Object.entries(state.entities.characters)) {
    setRecordEntry(characters, id, cloneCharacterEntity(char));
  }
  const factions: Record<string, FactionEntity> = {};
  for (const [id, faction] of Object.entries(state.entities.factions)) {
    setRecordEntry(factions, id, cloneFactionEntity(faction));
  }
  const threats: Record<string, ThreatEntity> = {};
  for (const [id, threat] of Object.entries(state.entities.threats)) {
    setRecordEntry(threats, id, cloneThreatEntity(threat));
  }
  const locations: Record<string, LocationEntity> = {};
  for (const [id, location] of Object.entries(state.entities.locations)) {
    setRecordEntry(locations, id, cloneLocationEntity(location));
  }

  return {
    schemaVersion: WORLD_STATE_SCHEMA_VERSION,
    meta: {
      sessionId: state.meta.sessionId,
      turn: state.meta.turn,
      rngState: cloneRngState(state.meta.rngState),
      arc: state.meta.arc,
      endingStatus: state.meta.endingStatus,
      activeEndingId: state.meta.activeEndingId,
    },
    capabilities: cloneSystemCapabilities(state.capabilities),
    player,
    scene: {
      location: state.scene.location,
      locationId: state.scene.locationId,
      presentCharacterIds: [...state.scene.presentCharacterIds],
      pinnedCharacterIds: [...state.scene.pinnedCharacterIds],
      mood: state.scene.mood,
      pacing: state.scene.pacing,
      directorNudge: state.scene.directorNudge,
    },
    flags: clonePrimitiveRecord(state.flags),
    counters: clonePrimitiveRecord(state.counters),
    customFields: clonePlainRecord(state.customFields),
    clocks: cloneWorldClockState(state.clocks),
    relations: cloneRelations(state.relations),
    entities: {
      characters,
      factions,
      threats,
      locations,
    },
    chronicle: {
      events: state.chronicle.events.map(cloneChronicleEntry),
    },
    turnEvents: {
      combatOutcomes: [...state.turnEvents.combatOutcomes],
      rumors: [...state.turnEvents.rumors],
      systemNotices: [...state.turnEvents.systemNotices],
    },
  };
}

/**
 * Deterministically create a v2 {@link WorldState} driven by {@link SystemCapabilities}
 * and initial seed data. Never reads wall-clock time (`Date.now()`) or `Math.random()`.
 */
export function createWorldState(options: CreateWorldStateOptions = {}): WorldState {
  const capabilities = cloneSystemCapabilities(options.capabilities ?? DEFAULT_CAPABILITIES);
  const capCheck = validateSystemCapabilities(capabilities, 'capabilities');
  if (!capCheck.ok) {
    throw new RefereeError('Invalid SystemCapabilities passed to createWorldState', {
      code: 'INVALID_CAPABILITIES',
      details: capCheck.error,
    });
  }

  const sessionId =
    options.sessionId !== undefined && options.sessionId.trim().length > 0
      ? options.sessionId
      : 'session-default';

  const turn =
    options.turn !== undefined && Number.isInteger(options.turn) && options.turn >= 0
      ? options.turn
      : (options.clocks?.turn ?? 0);

  const clocks = createWorldClock({
    ...options.clocks,
    turn,
  });

  const rngState = options.rngState
    ? cloneRngState(options.rngState)
    : createSeededRng(options.rngSeed ?? sessionId);

  const characters = normalizeEntityMap(
    options.characters ?? options.entities?.characters,
    cloneCharacterEntity
  );
  const factions = normalizeEntityMap(
    options.factions ?? options.entities?.factions,
    cloneFactionEntity
  );
  const threats = normalizeEntityMap(
    options.threats ?? options.entities?.threats,
    cloneThreatEntity
  );
  const locations = normalizeEntityMap(
    options.locations ?? options.entities?.locations,
    cloneLocationEntity
  );

  const sceneLocationId = options.scene?.locationId ?? null;
  const resolvedLocationName =
    options.scene?.location !== undefined
      ? options.scene.location
      : sceneLocationId !== null && Object.hasOwn(locations, sceneLocationId)
        ? (locations[sceneLocationId]?.name ?? '')
        : '';

  const presentCharacterIds =
    options.scene?.presentCharacterIds !== undefined
      ? [...options.scene.presentCharacterIds]
      : Object.keys(characters)
          .sort()
          .filter((id) => characters[id]?.presentInScene === true);

  const player: WorldState['player'] = {
    id: options.player?.id ?? 'player',
    name: options.player?.name ?? 'The Player',
    characterId: options.player?.characterId ?? null,
    locationId: options.player?.locationId ?? sceneLocationId,
    inventory: {
      items: options.player?.inventory?.items
        ? clonePrimitiveRecord(options.player.inventory.items)
        : {},
      currency: options.player?.inventory?.currency
        ? clonePrimitiveRecord(options.player.inventory.currency)
        : {},
    },
    customFields: options.player?.customFields
      ? clonePlainRecord(options.player.customFields)
      : {},
    sections: options.player?.sections ? cloneSections(options.player.sections) : {},
  };
  if (options.player?.canonCharacterId !== undefined) {
    player.canonCharacterId = options.player.canonCharacterId;
  }

  if (options.player?.progression !== undefined) {
    player.progression = cloneProgression(options.player.progression);
  } else if (capabilities.progression !== 'disabled') {
    player.progression = { level: 1, xp: 0 };
  }

  if (options.player?.resources !== undefined) {
    player.resources = cloneResources(options.player.resources);
  } else if (capabilities.combatMode !== 'disabled') {
    player.resources = {
      hp: { current: 20, max: 20 },
      willpower: { current: 10, max: 10 },
      stamina: { current: 100, max: 100 },
    };
  }

  const defaultArc: WorldArc =
    capabilities.factions || capabilities.beats ? 'season' : 'freeform';

  const state: WorldState = {
    schemaVersion: WORLD_STATE_SCHEMA_VERSION,
    meta: {
      sessionId,
      turn: clocks.turn,
      rngState,
      arc: options.arc ?? defaultArc,
      endingStatus: options.endingStatus ?? 'none',
      activeEndingId: options.activeEndingId ?? null,
    },
    capabilities,
    player,
    scene: {
      location: resolvedLocationName,
      locationId: sceneLocationId,
      presentCharacterIds,
      pinnedCharacterIds: options.scene?.pinnedCharacterIds
        ? [...options.scene.pinnedCharacterIds]
        : [],
      mood: options.scene?.mood ?? 'neutral',
      pacing: options.scene?.pacing ?? 'balanced',
      directorNudge: options.scene?.directorNudge ?? null,
    },
    flags: options.flags ? clonePrimitiveRecord(options.flags) : {},
    counters: options.counters ? clonePrimitiveRecord(options.counters) : {},
    customFields: options.customFields ? clonePlainRecord(options.customFields) : {},
    clocks,
    relations: options.relations ? cloneRelations(options.relations) : {},
    entities: {
      characters,
      factions,
      threats,
      locations,
    },
    chronicle: {
      events: options.chronicleEvents ? options.chronicleEvents.map(cloneChronicleEntry) : [],
    },
    turnEvents: {
      combatOutcomes: options.turnEvents?.combatOutcomes
        ? [...options.turnEvents.combatOutcomes]
        : [],
      rumors: options.turnEvents?.rumors ? [...options.turnEvents.rumors] : [],
      systemNotices: options.turnEvents?.systemNotices ? [...options.turnEvents.systemNotices] : [],
    },
  };

  const validated = validateWorldState(state);
  if (!validated.ok) {
    throw new RefereeError('Failed to create valid WorldState', {
      code: 'INVALID_WORLD_STATE_SEED',
      details: validated.error,
    });
  }
  return validated.value.state;
}

function warnMissing(warnings: ErrorAccumulator, path: string, fieldLabel: string): void {
  warnings.add(
    path,
    'MISSING_KEY_DEFAULTED',
    `Missing ${fieldLabel} was defaulted for WorldState v2 resilience`
  );
}

function isUint32(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

function validateAndCloneRngState(
  raw: unknown,
  acc: ErrorAccumulator,
  fallbackSeed: string
): RngState {
  if (!isPlainObject(raw)) {
    acc.add('', 'INVALID_RNG_STATE', 'rngState must be an object');
    return createSeededRng(fallbackSeed);
  }
  if (raw.type === 'xoshiro128**') {
    const s0 = raw.s0;
    const s1 = raw.s1;
    const s2 = raw.s2;
    const s3 = raw.s3;
    const drawCount = raw.drawCount;
    if (!isUint32(s0) || !isUint32(s1) || !isUint32(s2) || !isUint32(s3)) {
      acc.add('', 'INVALID_RNG_STATE', 'xoshiro128** words s0..s3 must be uint32 integers');
    } else if ((s0 | s1 | s2 | s3) === 0) {
      acc.add('', 'INVALID_RNG_STATE', 'xoshiro128** state words cannot all be zero');
    }
    if (typeof drawCount !== 'number' || !Number.isInteger(drawCount) || drawCount < 0) {
      acc.add('drawCount', 'INVALID_RNG_STATE', 'drawCount must be a non-negative integer');
    }
    if (!acc.hasErrors()) {
      return {
        type: 'xoshiro128**',
        s0: s0 as number,
        s1: s1 as number,
        s2: s2 as number,
        s3: s3 as number,
        drawCount: drawCount as number,
      };
    }
    return createSeededRng(fallbackSeed);
  }

  if (raw.type === 'queued') {
    if (!Array.isArray(raw.queue)) {
      acc.add('queue', 'INVALID_RNG_STATE', 'queued RNG queue must be an array');
    } else {
      for (let i = 0; i < raw.queue.length; i += 1) {
        const val = raw.queue[i];
        if (typeof val !== 'number' || !Number.isFinite(val) || val < 0 || val >= 1) {
          acc.add(`queue[${i}]`, 'INVALID_RNG_STATE', 'queued RNG values must be finite floats in [0, 1)');
        }
      }
    }
    if (typeof raw.cursor !== 'number' || !Number.isInteger(raw.cursor) || raw.cursor < 0) {
      acc.add('cursor', 'INVALID_RNG_STATE', 'queued RNG cursor must be a non-negative integer');
    }
    if (typeof raw.drawCount !== 'number' || !Number.isInteger(raw.drawCount) || raw.drawCount < 0) {
      acc.add('drawCount', 'INVALID_RNG_STATE', 'drawCount must be a non-negative integer');
    }
    const fallback = validateAndCloneRngState(raw.fallback, acc.scope('fallback'), fallbackSeed);
    if (fallback.type !== 'xoshiro128**') {
      acc.add('fallback', 'INVALID_RNG_STATE', 'queued RNG fallback must be xoshiro128**');
    }
    if (!acc.hasErrors() && fallback.type === 'xoshiro128**') {
      return {
        type: 'queued',
        queue: [...(raw.queue as number[])],
        cursor: raw.cursor as number,
        fallback,
        drawCount: raw.drawCount as number,
      };
    }
    return createSeededRng(fallbackSeed);
  }

  acc.add('type', 'INVALID_RNG_STATE', `Unsupported rngState type "${String(raw.type)}"`);
  return createSeededRng(fallbackSeed);
}

function validateStringArrayField(
  raw: unknown,
  path: string,
  errors: ErrorAccumulator,
  warnings: ErrorAccumulator,
  defaultOnMissing = true
): string[] {
  if (raw === undefined) {
    if (defaultOnMissing) {
      warnMissing(warnings, path, path);
    }
    return [];
  }
  if (!Array.isArray(raw) || !raw.every((item) => typeof item === 'string')) {
    errors.add(path, 'INVALID_STRING_ARRAY', `${path} must be an array of strings`);
    return [];
  }
  return [...raw];
}

function validateSectionsField(
  raw: unknown,
  path: string,
  errors: ErrorAccumulator,
  warnings: ErrorAccumulator
): Record<string, string | string[]> {
  if (raw === undefined) {
    warnMissing(warnings, path, path);
    return {};
  }
  if (!isPlainObject(raw)) {
    errors.add(path, 'INVALID_TYPE', `${path} must be a plain record`);
    return {};
  }
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') {
      setRecordEntry(out, k, v);
    } else if (Array.isArray(v) && v.every((item) => typeof item === 'string')) {
      setRecordEntry(out, k, [...v]);
    } else {
      errors.add(`${path}.${k}`, 'INVALID_SECTION_VALUE', 'Section value must be string or string[]');
    }
  }
  return out;
}

function validateResourcesField(
  raw: unknown,
  path: string,
  errors: ErrorAccumulator
): Record<string, ResourcePool> | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isPlainObject(raw)) {
    errors.add(path, 'INVALID_TYPE', `${path} must be a plain record`);
    return undefined;
  }
  const out: Record<string, ResourcePool> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (!isPlainObject(val)) {
      errors.add(`${path}.${key}`, 'INVALID_TYPE', 'ResourcePool must be an object');
      continue;
    }
    if (typeof val.current !== 'number' || !Number.isFinite(val.current) || val.current < 0) {
      errors.add(`${path}.${key}.current`, 'INVALID_NUMBER', 'ResourcePool current must be >= 0');
    }
    if (typeof val.max !== 'number' || !Number.isFinite(val.max) || val.max < 0) {
      errors.add(`${path}.${key}.max`, 'INVALID_NUMBER', 'ResourcePool max must be >= 0');
    }
    if (
      typeof val.current === 'number' &&
      typeof val.max === 'number' &&
      Number.isFinite(val.current) &&
      Number.isFinite(val.max) &&
      val.current > val.max
    ) {
      errors.add(`${path}.${key}.current`, 'OUT_OF_RANGE', 'ResourcePool current cannot exceed max');
    }
    setRecordEntry(out, key, {
      current: typeof val.current === 'number' ? val.current : 0,
      max: typeof val.max === 'number' ? val.max : 0,
    });
  }
  return out;
}

function validateProgressionField(
  raw: unknown,
  path: string,
  errors: ErrorAccumulator
): CharacterProgression | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isPlainObject(raw)) {
    errors.add(path, 'INVALID_TYPE', `${path} must be an object`);
    return undefined;
  }
  if (typeof raw.level !== 'number' || !Number.isInteger(raw.level) || raw.level < 1) {
    errors.add(`${path}.level`, 'INVALID_INTEGER', 'level must be an integer >= 1');
  }
  if (typeof raw.xp !== 'number' || !Number.isFinite(raw.xp) || raw.xp < 0) {
    errors.add(`${path}.xp`, 'INVALID_NUMBER', 'xp must be a finite number >= 0');
  }
  if (raw.className !== undefined && typeof raw.className !== 'string') {
    errors.add(`${path}.className`, 'INVALID_TYPE', 'className must be a string');
  }
  if (raw.subclass !== undefined && typeof raw.subclass !== 'string') {
    errors.add(`${path}.subclass`, 'INVALID_TYPE', 'subclass must be a string');
  }
  let attributes: Record<string, number> | undefined;
  if (raw.attributes !== undefined) {
    if (!isPlainObject(raw.attributes)) {
      errors.add(`${path}.attributes`, 'INVALID_TYPE', 'attributes must be a plain record');
    } else {
      attributes = {};
      for (const [k, v] of Object.entries(raw.attributes)) {
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          errors.add(`${path}.attributes.${k}`, 'INVALID_NUMBER', 'attribute must be a finite number');
        } else {
          setRecordEntry(attributes, k, v);
        }
      }
    }
  }
  const out: CharacterProgression = {
    level: typeof raw.level === 'number' ? raw.level : 1,
    xp: typeof raw.xp === 'number' ? raw.xp : 0,
  };
  if (typeof raw.className === 'string') {
    out.className = raw.className;
  }
  if (typeof raw.subclass === 'string') {
    out.subclass = raw.subclass;
  }
  if (attributes !== undefined) {
    out.attributes = attributes;
  }
  return out;
}

function validateNumberRecord(
  raw: unknown,
  path: string,
  errors: ErrorAccumulator,
  warnings: ErrorAccumulator
): Record<string, number> {
  if (raw === undefined) {
    warnMissing(warnings, path, path);
    return {};
  }
  if (!isPlainObject(raw)) {
    errors.add(path, 'INVALID_TYPE', `${path} must be a plain record`);
    return {};
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      errors.add(`${path}.${k}`, 'INVALID_NUMBER', `${path}.${k} must be a finite number`);
    } else {
      setRecordEntry(out, k, v);
    }
  }
  return out;
}

function validateCustomFields(
  raw: unknown,
  path: string,
  errors: ErrorAccumulator,
  warnings: ErrorAccumulator
): Record<string, unknown> {
  if (raw === undefined) {
    warnMissing(warnings, path, path);
    return {};
  }
  if (!isPlainObject(raw)) {
    errors.add(path, 'INVALID_TYPE', `${path} must be a plain object`);
    return {};
  }
  return clonePlainRecord(raw);
}

function validateNullableString(
  raw: unknown,
  path: string,
  errors: ErrorAccumulator,
  warnings: ErrorAccumulator
): string | null {
  if (raw === undefined) {
    warnMissing(warnings, path, path);
    return null;
  }
  if (raw !== null && typeof raw !== 'string') {
    errors.add(path, 'INVALID_TYPE', `${path} must be a string or null`);
    return null;
  }
  return raw;
}

function validateStringWithDefault(
  raw: unknown,
  defaultValue: string,
  path: string,
  errors: ErrorAccumulator,
  warnings: ErrorAccumulator
): string {
  if (raw === undefined) {
    warnMissing(warnings, path, path);
    return defaultValue;
  }
  if (typeof raw !== 'string') {
    errors.add(path, 'INVALID_TYPE', `${path} must be a string`);
    return defaultValue;
  }
  return raw;
}

function validateBooleanWithDefault(
  raw: unknown,
  defaultValue: boolean,
  path: string,
  errors: ErrorAccumulator,
  warnings: ErrorAccumulator
): boolean {
  if (raw === undefined) {
    warnMissing(warnings, path, path);
    return defaultValue;
  }
  if (typeof raw !== 'boolean') {
    errors.add(path, 'INVALID_TYPE', `${path} must be a boolean`);
    return defaultValue;
  }
  return raw;
}

/**
 * Validate a candidate {@link WorldState} document, safely defaulting missing keys with
 * BR-8 warnings while enforcing strict schema, enum, numeric, and Tier 2 spatial integrity.
 */
export function validateWorldState(
  state: unknown
): Result<{ state: WorldState; warnings: ValidationError[] }, ValidationError[]> {
  const errors = new ErrorAccumulator();
  const warnings = new ErrorAccumulator();

  if (!isPlainObject(state)) {
    errors.add('', 'INVALID_TYPE', 'WorldState must be a non-null plain object');
    return errors.toResult({ state: createWorldState(), warnings: [] });
  }

  if (state.schemaVersion !== WORLD_STATE_SCHEMA_VERSION) {
    errors.add(
      'schemaVersion',
      'INVALID_SCHEMA_VERSION',
      `schemaVersion must be ${WORLD_STATE_SCHEMA_VERSION}`
    );
  }

  let capabilities: SystemCapabilities = cloneSystemCapabilities(DEFAULT_CAPABILITIES);
  let validSpatialMode: SpatialMode | null = null;
  if (state.capabilities === undefined) {
    errors.add('capabilities', 'REQUIRED', 'capabilities manifest is required');
  } else {
    const capResult = validateSystemCapabilities(
      state.capabilities as SystemCapabilities,
      'capabilities'
    );
    if (capResult.ok) {
      capabilities = cloneSystemCapabilities(capResult.value);
      validSpatialMode = capabilities.spatialMode;
    } else {
      errors.addAll(capResult.error);
    }
  }

  // meta
  let sessionId = 'session-default';
  let metaTurn = 0;
  let rngState: RngState = createSeededRng(sessionId);
  let arc: WorldArc = 'freeform';
  let endingStatus: EndingStatus = 'none';
  let activeEndingId: string | null = null;

  if (state.meta === undefined) {
    warnMissing(warnings, 'meta', 'meta');
  } else if (!isPlainObject(state.meta)) {
    errors.add('meta', 'INVALID_TYPE', 'meta must be an object');
  } else {
    const rawMeta = state.meta;
    if (rawMeta.sessionId === undefined) {
      warnMissing(warnings, 'meta.sessionId', 'meta.sessionId');
    } else if (typeof rawMeta.sessionId !== 'string' || rawMeta.sessionId.trim().length === 0) {
      errors.add('meta.sessionId', 'REQUIRED', 'meta.sessionId must be a non-empty string');
    } else {
      sessionId = rawMeta.sessionId;
    }

    if (rawMeta.turn === undefined) {
      warnMissing(warnings, 'meta.turn', 'meta.turn');
    } else if (typeof rawMeta.turn !== 'number' || !Number.isInteger(rawMeta.turn) || rawMeta.turn < 0) {
      errors.add('meta.turn', 'INVALID_TURN', 'meta.turn must be a non-negative integer');
    } else {
      metaTurn = rawMeta.turn;
    }

    if (rawMeta.rngState === undefined) {
      warnMissing(warnings, 'meta.rngState', 'meta.rngState');
      rngState = createSeededRng(sessionId);
    } else {
      rngState = validateAndCloneRngState(rawMeta.rngState, errors.scope('meta.rngState'), sessionId);
    }

    if (rawMeta.arc === undefined) {
      warnMissing(warnings, 'meta.arc', 'meta.arc');
    } else if (typeof rawMeta.arc !== 'string' || !VALID_WORLD_ARCS.has(rawMeta.arc)) {
      errors.add('meta.arc', 'INVALID_ENUM', `Invalid arc "${String(rawMeta.arc)}"`);
    } else {
      arc = rawMeta.arc as WorldArc;
    }

    if (rawMeta.endingStatus === undefined) {
      warnMissing(warnings, 'meta.endingStatus', 'meta.endingStatus');
    } else if (
      typeof rawMeta.endingStatus !== 'string' ||
      !VALID_ENDING_STATUSES.has(rawMeta.endingStatus)
    ) {
      errors.add(
        'meta.endingStatus',
        'INVALID_ENUM',
        `Invalid endingStatus "${String(rawMeta.endingStatus)}"`
      );
    } else {
      endingStatus = rawMeta.endingStatus as EndingStatus;
    }

    activeEndingId = validateNullableString(
      rawMeta.activeEndingId,
      'meta.activeEndingId',
      errors,
      warnings
    );
  }

  // flags
  const flags: Record<string, boolean> = {};
  if (state.flags === undefined) {
    warnMissing(warnings, 'flags', 'flags');
  } else if (!isPlainObject(state.flags)) {
    errors.add('flags', 'INVALID_TYPE', 'flags must be a plain record');
  } else {
    for (const [k, v] of Object.entries(state.flags)) {
      if (typeof v !== 'boolean') {
        errors.add(`flags.${k}`, 'INVALID_TYPE', `flags.${k} must be a boolean`);
      } else {
        setRecordEntry(flags, k, v);
      }
    }
  }

  // counters
  const counters = validateNumberRecord(state.counters, 'counters', errors, warnings);

  // customFields
  const customFields = validateCustomFields(state.customFields, 'customFields', errors, warnings);

  // clocks
  let clocks = createWorldClock({ turn: metaTurn });
  if (state.clocks === undefined) {
    warnMissing(warnings, 'clocks', 'clocks');
  } else if (!isPlainObject(state.clocks)) {
    errors.add('clocks', 'INVALID_TYPE', 'clocks must be an object');
  } else {
    const rawClocks = state.clocks;
    const defaultClock = createWorldClock({ turn: metaTurn });
    const clockTurn =
      rawClocks.turn === undefined
        ? (warnMissing(warnings, 'clocks.turn', 'clocks.turn'), defaultClock.turn)
        : rawClocks.turn;
    const storyTurn =
      rawClocks.storyTurn === undefined
        ? (warnMissing(warnings, 'clocks.storyTurn', 'clocks.storyTurn'), defaultClock.storyTurn)
        : rawClocks.storyTurn;
    const day =
      rawClocks.day === undefined
        ? (warnMissing(warnings, 'clocks.day', 'clocks.day'), defaultClock.day)
        : rawClocks.day;
    const inGameDate =
      rawClocks.inGameDate === undefined
        ? (warnMissing(warnings, 'clocks.inGameDate', 'clocks.inGameDate'), defaultClock.inGameDate)
        : rawClocks.inGameDate;
    const slotsPerDay =
      rawClocks.slotsPerDay === undefined
        ? (warnMissing(warnings, 'clocks.slotsPerDay', 'clocks.slotsPerDay'), [...defaultClock.slotsPerDay])
        : rawClocks.slotsPerDay;
    const slot =
      rawClocks.slot === undefined
        ? (warnMissing(warnings, 'clocks.slot', 'clocks.slot'), defaultClock.slot)
        : rawClocks.slot;
    const held = validateBooleanWithDefault(rawClocks.held, false, 'clocks.held', errors, warnings);
    const holdReason = validateNullableString(
      rawClocks.holdReason,
      'clocks.holdReason',
      errors,
      warnings
    );

    const timers: Record<string, ClockTimer> = {};
    if (rawClocks.timers === undefined) {
      warnMissing(warnings, 'clocks.timers', 'clocks.timers');
    } else if (!isPlainObject(rawClocks.timers)) {
      errors.add('clocks.timers', 'INVALID_TYPE', 'clocks.timers must be a plain record');
    } else {
      for (const [id, rawTimer] of Object.entries(rawClocks.timers)) {
        if (!isPlainObject(rawTimer)) {
          errors.add(`clocks.timers.${id}`, 'INVALID_TYPE', 'ClockTimer must be an object');
        } else {
          const tickOn = rawTimer.tickOn;
          if (tickOn !== 'turn' && tickOn !== 'slot' && tickOn !== 'day') {
            errors.add(`clocks.timers.${id}.tickOn`, 'INVALID_ENUM', 'Invalid timer tickOn value');
          }
          if (rawTimer.repeat !== undefined && typeof rawTimer.repeat !== 'boolean') {
            errors.add(`clocks.timers.${id}.repeat`, 'INVALID_TYPE', 'Timer repeat must be a boolean');
          }
          setRecordEntry(timers, id, {
            current: typeof rawTimer.current === 'number' ? rawTimer.current : -1,
            max: typeof rawTimer.max === 'number' ? rawTimer.max : 0,
            tickOn: tickOn === 'turn' || tickOn === 'slot' || tickOn === 'day' ? tickOn : 'turn',
            ...(typeof rawTimer.repeat === 'boolean' ? { repeat: rawTimer.repeat } : {}),
          });
        }
      }
    }

    if (!Array.isArray(slotsPerDay) || !slotsPerDay.every((s) => typeof s === 'string')) {
      errors.add('clocks.slotsPerDay', 'INVALID_TYPE', 'clocks.slotsPerDay must be string[]');
    } else if (typeof slot !== 'string') {
      errors.add('clocks.slot', 'INVALID_TYPE', 'clocks.slot must be a string');
    } else if (inGameDate !== null && typeof inGameDate !== 'string') {
      errors.add('clocks.inGameDate', 'INVALID_TYPE', 'clocks.inGameDate must be string or null');
    } else if (typeof clockTurn !== 'number' || typeof storyTurn !== 'number' || typeof day !== 'number') {
      errors.add('clocks', 'INVALID_TYPE', 'clocks.turn, storyTurn, and day must be numbers');
    } else {
      const candidateClock: WorldClockState = {
        turn: clockTurn,
        storyTurn,
        day,
        inGameDate,
        slot,
        slotsPerDay: [...slotsPerDay],
        held,
        holdReason,
        timers,
      };
      const clockRes = validateWorldClock(candidateClock);
      if (clockRes.ok) {
        clocks = cloneWorldClockState(clockRes.value);
      } else {
        for (const errItem of clockRes.error) {
          errors.scope('clocks').addError(errItem);
        }
      }
    }
  }

  // entities
  const characters: Record<string, CharacterEntity> = {};
  const factions: Record<string, FactionEntity> = {};
  const threats: Record<string, ThreatEntity> = {};
  const locations: Record<string, LocationEntity> = {};

  if (state.entities === undefined) {
    warnMissing(warnings, 'entities', 'entities');
  } else if (!isPlainObject(state.entities)) {
    errors.add('entities', 'INVALID_TYPE', 'entities must be an object');
  } else {
    const rawEntities = state.entities;

    // entities.locations
    if (rawEntities.locations === undefined) {
      warnMissing(warnings, 'entities.locations', 'entities.locations');
    } else if (!isPlainObject(rawEntities.locations)) {
      errors.add('entities.locations', 'INVALID_TYPE', 'entities.locations must be a plain record');
    } else {
      for (const [key, rawLoc] of Object.entries(rawEntities.locations)) {
        const locPath = `entities.locations.${key}`;
        if (!isPlainObject(rawLoc)) {
          errors.add(locPath, 'INVALID_TYPE', 'LocationEntity must be an object');
          continue;
        }
        const id = validateStringWithDefault(rawLoc.id, key, `${locPath}.id`, errors, warnings);
        if (id !== key) {
          errors.add(`${locPath}.id`, 'ID_MISMATCH', `Location id "${id}" must match key "${key}"`);
        }
        let name = '';
        if (typeof rawLoc.name !== 'string' || rawLoc.name.trim().length === 0) {
          errors.add(`${locPath}.name`, 'REQUIRED', 'Location name must be a non-empty string');
        } else {
          name = rawLoc.name;
        }
        const kind = validateStringWithDefault(
          rawLoc.kind,
          'landmark',
          `${locPath}.kind`,
          errors,
          warnings
        );
        const status = validateStringWithDefault(
          rawLoc.status,
          'normal',
          `${locPath}.status`,
          errors,
          warnings
        );
        const controllingFactionId = validateNullableString(
          rawLoc.controllingFactionId,
          `${locPath}.controllingFactionId`,
          errors,
          warnings
        );
        const connectedLocations = validateStringArrayField(
          rawLoc.connectedLocations,
          `${locPath}.connectedLocations`,
          errors,
          warnings
        );
        const discovered = validateBooleanWithDefault(
          rawLoc.discovered,
          true,
          `${locPath}.discovered`,
          errors,
          warnings
        );
        const tags = validateStringArrayField(rawLoc.tags, `${locPath}.tags`, errors, warnings);
        const notes = validateStringWithDefault(rawLoc.notes, '', `${locPath}.notes`, errors, warnings);

        setRecordEntry(locations, key, {
          id,
          name,
          kind,
          status,
          controllingFactionId,
          connectedLocations,
          discovered,
          tags,
          notes,
        });
      }
    }

    // entities.characters
    if (rawEntities.characters === undefined) {
      warnMissing(warnings, 'entities.characters', 'entities.characters');
    } else if (!isPlainObject(rawEntities.characters)) {
      errors.add('entities.characters', 'INVALID_TYPE', 'entities.characters must be a plain record');
    } else {
      for (const [key, rawChar] of Object.entries(rawEntities.characters)) {
        const charPath = `entities.characters.${key}`;
        if (!isPlainObject(rawChar)) {
          errors.add(charPath, 'INVALID_TYPE', 'CharacterEntity must be an object');
          continue;
        }
        const id = validateStringWithDefault(rawChar.id, key, `${charPath}.id`, errors, warnings);
        if (id !== key) {
          errors.add(`${charPath}.id`, 'ID_MISMATCH', `Character id "${id}" must match key "${key}"`);
        }
        let name = '';
        if (typeof rawChar.name !== 'string' || rawChar.name.trim().length === 0) {
          errors.add(`${charPath}.name`, 'REQUIRED', 'Character name must be a non-empty string');
        } else {
          name = rawChar.name;
        }
        let status: CharacterStatus = 'active';
        if (rawChar.status === undefined) {
          warnMissing(warnings, `${charPath}.status`, `${charPath}.status`);
        } else if (typeof rawChar.status !== 'string' || !VALID_CHARACTER_STATUSES.has(rawChar.status)) {
          errors.add(
            `${charPath}.status`,
            'INVALID_ENUM',
            `Invalid CharacterStatus "${String(rawChar.status)}"`
          );
        } else {
          status = rawChar.status as CharacterStatus;
        }
        const presentInScene = validateBooleanWithDefault(
          rawChar.presentInScene,
          false,
          `${charPath}.presentInScene`,
          errors,
          warnings
        );
        const locationId = validateNullableString(
          rawChar.locationId,
          `${charPath}.locationId`,
          errors,
          warnings
        );
        const formId = validateNullableString(rawChar.formId, `${charPath}.formId`, errors, warnings);
        const formGroup = validateNullableString(
          rawChar.formGroup,
          `${charPath}.formGroup`,
          errors,
          warnings
        );
        const sections = validateSectionsField(rawChar.sections, `${charPath}.sections`, errors, warnings);
        const charCustomFields = validateCustomFields(
          rawChar.customFields,
          `${charPath}.customFields`,
          errors,
          warnings
        );
        const progression = validateProgressionField(
          rawChar.progression,
          `${charPath}.progression`,
          errors
        );
        const resources = validateResourcesField(rawChar.resources, `${charPath}.resources`, errors);

        let corruption: CorruptionState | undefined;
        if (rawChar.corruption !== undefined) {
          if (!isPlainObject(rawChar.corruption)) {
            errors.add(`${charPath}.corruption`, 'INVALID_TYPE', 'corruption must be an object');
          } else {
            const c = rawChar.corruption;
            if (typeof c.stage !== 'number' || !Number.isInteger(c.stage) || c.stage < 0) {
              errors.add(`${charPath}.corruption.stage`, 'INVALID_INTEGER', 'stage must be integer >= 0');
            }
            if (
              typeof c.progress !== 'number' ||
              !Number.isFinite(c.progress) ||
              c.progress < 0 ||
              c.progress > 100
            ) {
              errors.add(
                `${charPath}.corruption.progress`,
                'OUT_OF_RANGE',
                'progress must be in [0, 100]'
              );
            }
            if (c.source !== null && typeof c.source !== 'string') {
              errors.add(`${charPath}.corruption.source`, 'INVALID_TYPE', 'source must be string or null');
            }
            corruption = {
              stage: typeof c.stage === 'number' ? c.stage : 0,
              progress: typeof c.progress === 'number' ? c.progress : 0,
              source: typeof c.source === 'string' ? c.source : null,
            };
          }
        }

        const abilities = validateStringArrayField(
          rawChar.abilities,
          `${charPath}.abilities`,
          errors,
          warnings
        );
        const goals = validateStringArrayField(rawChar.goals, `${charPath}.goals`, errors, warnings);
        const agenda = validateStringWithDefault(
          rawChar.agenda,
          '',
          `${charPath}.agenda`,
          errors,
          warnings
        );
        const allegiance = validateStringWithDefault(
          rawChar.allegiance,
          'neutral',
          `${charPath}.allegiance`,
          errors,
          warnings
        );
        const mood = validateStringWithDefault(
          rawChar.mood,
          'neutral',
          `${charPath}.mood`,
          errors,
          warnings
        );
        const traits = validateStringArrayField(rawChar.traits, `${charPath}.traits`, errors, warnings);

        const entity: CharacterEntity = {
          id,
          name,
          status,
          presentInScene,
          locationId,
          formId,
          formGroup,
          sections,
          customFields: charCustomFields,
          abilities,
          goals,
          agenda,
          allegiance,
          mood,
          traits,
        };
        if (progression !== undefined) {
          entity.progression = progression;
        }
        if (resources !== undefined) {
          entity.resources = resources;
        }
        if (corruption !== undefined) {
          entity.corruption = corruption;
        }
        if (rawChar.lockedForms !== undefined) {
          if (!isPlainObject(rawChar.lockedForms)) {
            errors.add(`${charPath}.lockedForms`, 'INVALID_TYPE', 'lockedForms must be an object');
          } else {
            const lockedForms: Record<string, boolean> = {};
            for (const [formKey, lockedVal] of Object.entries(rawChar.lockedForms)) {
              if (isUnsafeKey(formKey)) {
                errors.add(
                  `${charPath}.lockedForms.${formKey}`,
                  'UNSAFE_PROPERTY_KEY',
                  `Unsafe lockedForms key "${formKey}"`
                );
                continue;
              }
              if (typeof lockedVal !== 'boolean') {
                errors.add(
                  `${charPath}.lockedForms.${formKey}`,
                  'INVALID_TYPE',
                  'lockedForms values must be boolean'
                );
                continue;
              }
              setRecordEntry(lockedForms, formKey, lockedVal);
            }
            entity.lockedForms = lockedForms;
          }
        }
        setRecordEntry(characters, key, entity);
      }
    }

    // entities.factions
    if (rawEntities.factions === undefined) {
      warnMissing(warnings, 'entities.factions', 'entities.factions');
    } else if (!isPlainObject(rawEntities.factions)) {
      errors.add('entities.factions', 'INVALID_TYPE', 'entities.factions must be a plain record');
    } else {
      for (const [key, rawFaction] of Object.entries(rawEntities.factions)) {
        const facPath = `entities.factions.${key}`;
        if (!isPlainObject(rawFaction)) {
          errors.add(facPath, 'INVALID_TYPE', 'FactionEntity must be an object');
          continue;
        }
        const id = validateStringWithDefault(rawFaction.id, key, `${facPath}.id`, errors, warnings);
        if (id !== key) {
          errors.add(`${facPath}.id`, 'ID_MISMATCH', `Faction id "${id}" must match key "${key}"`);
        }
        let name = '';
        if (typeof rawFaction.name !== 'string' || rawFaction.name.trim().length === 0) {
          errors.add(`${facPath}.name`, 'REQUIRED', 'Faction name must be a non-empty string');
        } else {
          name = rawFaction.name;
        }
        let side: FactionSide = 'neutral';
        if (rawFaction.side === undefined) {
          warnMissing(warnings, `${facPath}.side`, `${facPath}.side`);
        } else if (typeof rawFaction.side !== 'string' || !VALID_FACTION_SIDES.has(rawFaction.side)) {
          errors.add(`${facPath}.side`, 'INVALID_ENUM', `Invalid FactionSide "${String(rawFaction.side)}"`);
        } else {
          side = rawFaction.side as FactionSide;
        }
        let status: FactionStatus = 'active';
        if (rawFaction.status === undefined) {
          warnMissing(warnings, `${facPath}.status`, `${facPath}.status`);
        } else if (
          typeof rawFaction.status !== 'string' ||
          !VALID_FACTION_STATUSES.has(rawFaction.status)
        ) {
          errors.add(
            `${facPath}.status`,
            'INVALID_ENUM',
            `Invalid FactionStatus "${String(rawFaction.status)}"`
          );
        } else {
          status = rawFaction.status as FactionStatus;
        }
        let influence = 0;
        if (rawFaction.influence === undefined) {
          warnMissing(warnings, `${facPath}.influence`, `${facPath}.influence`);
        } else if (
          typeof rawFaction.influence !== 'number' ||
          !Number.isFinite(rawFaction.influence) ||
          rawFaction.influence < 0 ||
          rawFaction.influence > 100
        ) {
          errors.add(`${facPath}.influence`, 'OUT_OF_RANGE', 'influence must be in [0, 100]');
        } else {
          influence = rawFaction.influence;
        }
        const headquartersLocationId = validateNullableString(
          rawFaction.headquartersLocationId,
          `${facPath}.headquartersLocationId`,
          errors,
          warnings
        );
        const goals = validateStringArrayField(
          rawFaction.goals,
          `${facPath}.goals`,
          errors,
          warnings
        );

        setRecordEntry(factions, key, {
          id,
          name,
          side,
          status,
          influence,
          headquartersLocationId,
          goals,
        });
      }
    }

    // entities.threats
    if (rawEntities.threats === undefined) {
      warnMissing(warnings, 'entities.threats', 'entities.threats');
    } else if (!isPlainObject(rawEntities.threats)) {
      errors.add('entities.threats', 'INVALID_TYPE', 'entities.threats must be a plain record');
    } else {
      for (const [key, rawThreat] of Object.entries(rawEntities.threats)) {
        const threatPath = `entities.threats.${key}`;
        if (!isPlainObject(rawThreat)) {
          errors.add(threatPath, 'INVALID_TYPE', 'ThreatEntity must be an object');
          continue;
        }
        const id = validateStringWithDefault(rawThreat.id, key, `${threatPath}.id`, errors, warnings);
        if (id !== key) {
          errors.add(`${threatPath}.id`, 'ID_MISMATCH', `Threat id "${id}" must match key "${key}"`);
        }
        let name = '';
        if (typeof rawThreat.name !== 'string' || rawThreat.name.trim().length === 0) {
          errors.add(`${threatPath}.name`, 'REQUIRED', 'Threat name must be a non-empty string');
        } else {
          name = rawThreat.name;
        }
        let rank: ThreatRank = 'secondary';
        if (rawThreat.rank === undefined) {
          warnMissing(warnings, `${threatPath}.rank`, `${threatPath}.rank`);
        } else if (typeof rawThreat.rank !== 'string' || !VALID_THREAT_RANKS.has(rawThreat.rank)) {
          errors.add(`${threatPath}.rank`, 'INVALID_ENUM', `Invalid ThreatRank "${String(rawThreat.rank)}"`);
        } else {
          rank = rawThreat.rank as ThreatRank;
        }
        let status: ThreatStatus = 'active';
        if (rawThreat.status === undefined) {
          warnMissing(warnings, `${threatPath}.status`, `${threatPath}.status`);
        } else if (
          typeof rawThreat.status !== 'string' ||
          !VALID_THREAT_STATUSES.has(rawThreat.status)
        ) {
          errors.add(
            `${threatPath}.status`,
            'INVALID_ENUM',
            `Invalid ThreatStatus "${String(rawThreat.status)}"`
          );
        } else {
          status = rawThreat.status as ThreatStatus;
        }
        let stage = 0;
        if (rawThreat.stage === undefined) {
          warnMissing(warnings, `${threatPath}.stage`, `${threatPath}.stage`);
        } else if (
          typeof rawThreat.stage !== 'number' ||
          !Number.isInteger(rawThreat.stage) ||
          rawThreat.stage < 0
        ) {
          errors.add(`${threatPath}.stage`, 'INVALID_INTEGER', 'stage must be an integer >= 0');
        } else {
          stage = rawThreat.stage;
        }
        let progress = 0;
        if (rawThreat.progress === undefined) {
          warnMissing(warnings, `${threatPath}.progress`, `${threatPath}.progress`);
        } else if (
          typeof rawThreat.progress !== 'number' ||
          !Number.isFinite(rawThreat.progress) ||
          rawThreat.progress < 0 ||
          rawThreat.progress > 100
        ) {
          errors.add(`${threatPath}.progress`, 'OUT_OF_RANGE', 'progress must be in [0, 100]');
        } else {
          progress = rawThreat.progress;
        }
        const locationId = validateNullableString(
          rawThreat.locationId,
          `${threatPath}.locationId`,
          errors,
          warnings
        );
        const sourceFactionId = validateNullableString(
          rawThreat.sourceFactionId,
          `${threatPath}.sourceFactionId`,
          errors,
          warnings
        );
        const agenda = validateStringWithDefault(
          rawThreat.agenda,
          '',
          `${threatPath}.agenda`,
          errors,
          warnings
        );

        setRecordEntry(threats, key, {
          id,
          name,
          rank,
          status,
          stage,
          progress,
          locationId,
          sourceFactionId,
          agenda,
        });
      }
    }
  }

  // player
  const player: WorldState['player'] = {
    id: 'player',
    name: 'The Player',
    characterId: null,
    locationId: null,
    inventory: { items: {}, currency: {} },
    customFields: {},
    sections: {},
  };
  if (state.player === undefined) {
    warnMissing(warnings, 'player', 'player');
  } else if (!isPlainObject(state.player)) {
    errors.add('player', 'INVALID_TYPE', 'player must be an object');
  } else {
    const rawPlayer = state.player;
    if (rawPlayer.id === undefined) {
      warnMissing(warnings, 'player.id', 'player.id');
    } else if (typeof rawPlayer.id !== 'string' || rawPlayer.id.trim().length === 0) {
      errors.add('player.id', 'REQUIRED', 'player.id must be a non-empty string');
    } else {
      player.id = rawPlayer.id;
    }

    player.name = validateStringWithDefault(
      rawPlayer.name,
      'The Player',
      'player.name',
      errors,
      warnings
    );
    player.characterId = validateNullableString(
      rawPlayer.characterId,
      'player.characterId',
      errors,
      warnings
    );
    if (player.characterId !== null && !Object.hasOwn(characters, player.characterId)) {
      errors.add(
        'player.characterId',
        'UNRESOLVED_CHARACTER',
        `player.characterId "${player.characterId}" does not resolve in entities.characters`
      );
    }
    if (rawPlayer.canonCharacterId !== undefined) {
      const canonCharacterId = validateNullableString(
        rawPlayer.canonCharacterId,
        'player.canonCharacterId',
        errors,
        warnings
      );
      player.canonCharacterId = canonCharacterId;
      if (canonCharacterId !== null && !Object.hasOwn(characters, canonCharacterId)) {
        errors.add(
          'player.canonCharacterId',
          'UNRESOLVED_CHARACTER',
          `player.canonCharacterId "${canonCharacterId}" does not resolve in entities.characters`
        );
      }
    }
    player.locationId = validateNullableString(
      rawPlayer.locationId,
      'player.locationId',
      errors,
      warnings
    );

    const progression = validateProgressionField(rawPlayer.progression, 'player.progression', errors);
    if (progression !== undefined) {
      player.progression = progression;
    }
    const resources = validateResourcesField(rawPlayer.resources, 'player.resources', errors);
    if (resources !== undefined) {
      player.resources = resources;
    }

    if (rawPlayer.inventory === undefined) {
      warnMissing(warnings, 'player.inventory', 'player.inventory');
    } else if (!isPlainObject(rawPlayer.inventory)) {
      errors.add('player.inventory', 'INVALID_TYPE', 'player.inventory must be an object');
    } else {
      player.inventory = {
        items: validateNumberRecord(
          rawPlayer.inventory.items,
          'player.inventory.items',
          errors,
          warnings
        ),
        currency: validateNumberRecord(
          rawPlayer.inventory.currency,
          'player.inventory.currency',
          errors,
          warnings
        ),
      };
    }

    player.customFields = validateCustomFields(
      rawPlayer.customFields,
      'player.customFields',
      errors,
      warnings
    );
    player.sections = validateSectionsField(rawPlayer.sections, 'player.sections', errors, warnings);
  }

  // scene
  const scene: WorldState['scene'] = {
    location: '',
    locationId: null,
    presentCharacterIds: [],
    pinnedCharacterIds: [],
    mood: 'neutral',
    pacing: 'balanced',
    directorNudge: null,
  };
  if (state.scene === undefined) {
    warnMissing(warnings, 'scene', 'scene');
  } else if (!isPlainObject(state.scene)) {
    errors.add('scene', 'INVALID_TYPE', 'scene must be an object');
  } else {
    const rawScene = state.scene;
    scene.location = validateStringWithDefault(
      rawScene.location,
      '',
      'scene.location',
      errors,
      warnings
    );
    scene.locationId = validateNullableString(
      rawScene.locationId,
      'scene.locationId',
      errors,
      warnings
    );
    scene.presentCharacterIds = validateStringArrayField(
      rawScene.presentCharacterIds,
      'scene.presentCharacterIds',
      errors,
      warnings
    );
    for (const charId of scene.presentCharacterIds) {
      if (!Object.hasOwn(characters, charId)) {
        errors.add(
          'scene.presentCharacterIds',
          'UNRESOLVED_CHARACTER',
          `scene.presentCharacterIds references unknown character "${charId}"`
        );
      }
    }
    scene.pinnedCharacterIds = validateStringArrayField(
      rawScene.pinnedCharacterIds,
      'scene.pinnedCharacterIds',
      errors,
      warnings
    );
    for (const charId of scene.pinnedCharacterIds) {
      if (!Object.hasOwn(characters, charId)) {
        errors.add(
          'scene.pinnedCharacterIds',
          'UNRESOLVED_CHARACTER',
          `scene.pinnedCharacterIds references unknown character "${charId}"`
        );
      }
    }
    scene.mood = validateStringWithDefault(
      rawScene.mood,
      'neutral',
      'scene.mood',
      errors,
      warnings
    );
    scene.pacing = validateStringWithDefault(
      rawScene.pacing,
      'balanced',
      'scene.pacing',
      errors,
      warnings
    );
    scene.directorNudge = validateNullableString(
      rawScene.directorNudge,
      'scene.directorNudge',
      errors,
      warnings
    );
  }

  // relations
  const relations: Record<string, Record<string, RelationEntry>> = {};
  if (state.relations === undefined) {
    warnMissing(warnings, 'relations', 'relations');
  } else if (!isPlainObject(state.relations)) {
    errors.add('relations', 'INVALID_TYPE', 'relations must be a plain record');
  } else {
    for (const [fromId, rawTargets] of Object.entries(state.relations)) {
      if (!isPlainObject(rawTargets)) {
        errors.add(`relations.${fromId}`, 'INVALID_TYPE', 'Relation target map must be an object');
        continue;
      }
      const targetMap: Record<string, RelationEntry> = {};
      for (const [toId, rawEntry] of Object.entries(rawTargets)) {
        const relPath = `relations.${fromId}.${toId}`;
        if (!isPlainObject(rawEntry)) {
          errors.add(relPath, 'INVALID_TYPE', 'RelationEntry must be an object');
          continue;
        }
        if (typeof rawEntry.affinity !== 'number' || !Number.isFinite(rawEntry.affinity)) {
          errors.add(`${relPath}.affinity`, 'INVALID_NUMBER', 'affinity must be a finite number');
        }
        if (
          typeof rawEntry.maxAffinity !== 'number' ||
          !Number.isFinite(rawEntry.maxAffinity) ||
          rawEntry.maxAffinity < 0
        ) {
          errors.add(
            `${relPath}.maxAffinity`,
            'INVALID_NUMBER',
            'maxAffinity must be a finite number >= 0'
          );
        }
        const label = validateStringWithDefault(
          rawEntry.label,
          '',
          `${relPath}.label`,
          errors,
          warnings
        );
        const tags = validateStringArrayField(
          rawEntry.tags,
          `${relPath}.tags`,
          errors,
          warnings
        );
        setRecordEntry(targetMap, toId, {
          affinity: typeof rawEntry.affinity === 'number' ? rawEntry.affinity : 0,
          maxAffinity: typeof rawEntry.maxAffinity === 'number' ? rawEntry.maxAffinity : 100,
          label,
          tags,
        });
      }
      setRecordEntry(relations, fromId, targetMap);
    }
  }

  // chronicle
  const chronicleEvents: ChronicleEntry[] = [];
  if (state.chronicle === undefined) {
    warnMissing(warnings, 'chronicle', 'chronicle');
  } else if (!isPlainObject(state.chronicle)) {
    errors.add('chronicle', 'INVALID_TYPE', 'chronicle must be an object');
  } else if (state.chronicle.events === undefined) {
    warnMissing(warnings, 'chronicle.events', 'chronicle.events');
  } else if (!Array.isArray(state.chronicle.events)) {
    errors.add('chronicle.events', 'INVALID_TYPE', 'chronicle.events must be an array');
  } else {
    for (let i = 0; i < state.chronicle.events.length; i += 1) {
      const rawEntry = state.chronicle.events[i];
      const entryPath = `chronicle.events[${i}]`;
      if (!isPlainObject(rawEntry)) {
        errors.add(entryPath, 'INVALID_TYPE', 'ChronicleEntry must be an object');
        continue;
      }
      let id = '';
      if (typeof rawEntry.id !== 'string' || rawEntry.id.trim().length === 0) {
        errors.add(`${entryPath}.id`, 'REQUIRED', 'ChronicleEntry id must be a non-empty string');
      } else {
        id = rawEntry.id;
      }
      if (typeof rawEntry.turn !== 'number' || !Number.isInteger(rawEntry.turn) || rawEntry.turn < 0) {
        errors.add(`${entryPath}.turn`, 'INVALID_INTEGER', 'turn must be an integer >= 0');
      }
      if (typeof rawEntry.day !== 'number' || !Number.isInteger(rawEntry.day) || rawEntry.day < 0) {
        errors.add(`${entryPath}.day`, 'INVALID_INTEGER', 'day must be an integer >= 0');
      }
      const date = validateNullableString(rawEntry.date, `${entryPath}.date`, errors, warnings);
      const title = validateStringWithDefault(
        rawEntry.title,
        '',
        `${entryPath}.title`,
        errors,
        warnings
      );
      let category: ChronicleCategory = 'event';
      if (rawEntry.category === undefined) {
        warnMissing(warnings, `${entryPath}.category`, `${entryPath}.category`);
      } else if (
        typeof rawEntry.category !== 'string' ||
        !VALID_CHRONICLE_CATEGORIES.has(rawEntry.category)
      ) {
        errors.add(
          `${entryPath}.category`,
          'INVALID_ENUM',
          `Invalid ChronicleCategory "${String(rawEntry.category)}"`
        );
      } else {
        category = rawEntry.category as ChronicleCategory;
      }
      const summary = validateStringWithDefault(
        rawEntry.summary,
        '',
        `${entryPath}.summary`,
        errors,
        warnings
      );
      const locationId = validateNullableString(
        rawEntry.locationId,
        `${entryPath}.locationId`,
        errors,
        warnings
      );
      const involvedEntityIds = validateStringArrayField(
        rawEntry.involvedEntityIds,
        `${entryPath}.involvedEntityIds`,
        errors,
        warnings
      );
      const keywords = validateStringArrayField(
        rawEntry.keywords,
        `${entryPath}.keywords`,
        errors,
        warnings
      );
      chronicleEvents.push({
        id,
        turn: typeof rawEntry.turn === 'number' ? rawEntry.turn : 0,
        day: typeof rawEntry.day === 'number' ? rawEntry.day : 1,
        date,
        title,
        category,
        summary,
        locationId,
        involvedEntityIds,
        keywords,
      });
    }
  }

  // turnEvents
  const turnEvents: WorldState['turnEvents'] = {
    combatOutcomes: [],
    rumors: [],
    systemNotices: [],
  };
  if (state.turnEvents === undefined) {
    warnMissing(warnings, 'turnEvents', 'turnEvents');
  } else if (!isPlainObject(state.turnEvents)) {
    errors.add('turnEvents', 'INVALID_TYPE', 'turnEvents must be an object');
  } else {
    turnEvents.combatOutcomes = validateStringArrayField(
      state.turnEvents.combatOutcomes,
      'turnEvents.combatOutcomes',
      errors,
      warnings
    );
    turnEvents.rumors = validateStringArrayField(
      state.turnEvents.rumors,
      'turnEvents.rumors',
      errors,
      warnings
    );
    turnEvents.systemNotices = validateStringArrayField(
      state.turnEvents.systemNotices,
      'turnEvents.systemNotices',
      errors,
      warnings
    );
  }

  // Tier 2 strict spatial cross-checks (omitted in Tier 0 scene_only)
  if (validSpatialMode === 'authored_graph') {
    if (player.locationId !== null && !Object.hasOwn(locations, player.locationId)) {
      errors.add(
        'player.locationId',
        'UNRESOLVED_LOCATION',
        `player.locationId "${player.locationId}" does not resolve in entities.locations`
      );
    }
    if (scene.locationId !== null && !Object.hasOwn(locations, scene.locationId)) {
      errors.add(
        'scene.locationId',
        'UNRESOLVED_LOCATION',
        `scene.locationId "${scene.locationId}" does not resolve in entities.locations`
      );
    }
    for (const [id, char] of Object.entries(characters)) {
      if (char.locationId !== null && !Object.hasOwn(locations, char.locationId)) {
        errors.add(
          `entities.characters.${id}.locationId`,
          'UNRESOLVED_LOCATION',
          `Character locationId "${char.locationId}" does not resolve in entities.locations`
        );
      }
    }
    for (const [id, faction] of Object.entries(factions)) {
      if (
        faction.headquartersLocationId !== null &&
        !Object.hasOwn(locations, faction.headquartersLocationId)
      ) {
        errors.add(
          `entities.factions.${id}.headquartersLocationId`,
          'UNRESOLVED_LOCATION',
          `Faction headquartersLocationId "${faction.headquartersLocationId}" does not resolve in entities.locations`
        );
      }
    }
    for (const [id, threat] of Object.entries(threats)) {
      if (threat.locationId !== null && !Object.hasOwn(locations, threat.locationId)) {
        errors.add(
          `entities.threats.${id}.locationId`,
          'UNRESOLVED_LOCATION',
          `Threat locationId "${threat.locationId}" does not resolve in entities.locations`
        );
      }
    }
    for (let i = 0; i < chronicleEvents.length; i += 1) {
      const entry = chronicleEvents[i];
      if (entry && entry.locationId !== null && !Object.hasOwn(locations, entry.locationId)) {
        errors.add(
          `chronicle.events[${i}].locationId`,
          'UNRESOLVED_LOCATION',
          `Chronicle locationId "${entry.locationId}" does not resolve in entities.locations`
        );
      }
    }
    for (const [id, loc] of Object.entries(locations)) {
      for (const connectedId of loc.connectedLocations) {
        if (connectedId === id) {
          errors.add(
            `entities.locations.${id}.connectedLocations`,
            'SELF_CONNECTED_LOCATION',
            `Location "${id}" cannot connect to itself`
          );
        } else if (!Object.hasOwn(locations, connectedId)) {
          errors.add(
            `entities.locations.${id}.connectedLocations`,
            'UNRESOLVED_LOCATION',
            `Connected location "${connectedId}" does not resolve in entities.locations`
          );
        }
      }
    }
  }

  const normalizedState: WorldState = {
    schemaVersion: WORLD_STATE_SCHEMA_VERSION,
    meta: {
      sessionId,
      turn: metaTurn,
      rngState,
      arc,
      endingStatus,
      activeEndingId,
    },
    capabilities,
    player,
    scene,
    flags,
    counters,
    customFields,
    clocks,
    relations,
    entities: {
      characters,
      factions,
      threats,
      locations,
    },
    chronicle: {
      events: chronicleEvents,
    },
    turnEvents,
  };

  return errors.toResult({
    state: normalizedState,
    warnings: [...warnings.errors],
  });
}

/**
 * Bind the player to a canon roster character, syncing identity, location, sections,
 * resources, and progression from the character (and its active form if `formIndex` is supplied),
 * and removing the bound character (and same-formGroup forms) from `scene.presentCharacterIds`.
 */
export function bindPlayerToCanonCharacter(
  worldState: WorldState,
  canonCharacterId: string,
  formIndex?: FormIndex
): WorldState {
  if (typeof canonCharacterId !== 'string' || canonCharacterId.trim().length === 0 || isUnsafeKey(canonCharacterId)) {
    throw new RefereeError(`Invalid canonCharacterId "${String(canonCharacterId)}"`, {
      code: 'INVALID_CANON_CHARACTER_ID',
      details: { canonCharacterId },
    });
  }

  if (!Object.hasOwn(worldState.entities.characters, canonCharacterId)) {
    throw new RefereeError(`Canon character "${canonCharacterId}" was not found in entities.characters`, {
      code: 'CHARACTER_NOT_FOUND',
      details: { canonCharacterId },
    });
  }

  const nextState = cloneWorldState(worldState);
  const rawChar = Object.getOwnPropertyDescriptor(nextState.entities.characters, canonCharacterId)
    ?.value as CharacterEntity | undefined;
  if (!rawChar) {
    throw new RefereeError(`Canon character "${canonCharacterId}" was not found in entities.characters`, {
      code: 'CHARACTER_NOT_FOUND',
      details: { canonCharacterId },
    });
  }

  let effectiveChar = rawChar;
  if (formIndex && rawChar.formId !== null && formIndex.byId.has(rawChar.formId)) {
    effectiveChar = applyFormProfileOverlay(rawChar, rawChar.formId, formIndex);
    setRecordEntry(nextState.entities.characters, canonCharacterId, effectiveChar);
  }

  nextState.player.characterId = effectiveChar.id;
  nextState.player.canonCharacterId = effectiveChar.id;
  nextState.player.name = effectiveChar.name;
  nextState.player.locationId = effectiveChar.locationId;
  nextState.player.sections = cloneSections(effectiveChar.sections);

  if (effectiveChar.resources !== undefined) {
    nextState.player.resources = cloneResources(effectiveChar.resources);
  } else {
    delete nextState.player.resources;
  }

  if (effectiveChar.progression !== undefined) {
    nextState.player.progression = cloneProgression(effectiveChar.progression);
  } else {
    delete nextState.player.progression;
  }

  if (effectiveChar.locationId !== null) {
    nextState.scene.locationId = effectiveChar.locationId;
    if (!isUnsafeKey(effectiveChar.locationId) && Object.hasOwn(nextState.entities.locations, effectiveChar.locationId)) {
      const loc = Object.getOwnPropertyDescriptor(
        nextState.entities.locations,
        effectiveChar.locationId
      )?.value as LocationEntity | undefined;
      if (loc) {
        nextState.scene.location = loc.name;
      }
    }
  }

  const excludedGroup =
    effectiveChar.formGroup ??
    (effectiveChar.formId !== null ? formIndex?.byId.get(effectiveChar.formId)?.formGroup ?? null : null);
  nextState.scene.presentCharacterIds = nextState.scene.presentCharacterIds.filter((id) => {
    if (id === effectiveChar.id) {
      return false;
    }
    if (excludedGroup !== null && !isUnsafeKey(id) && Object.hasOwn(nextState.entities.characters, id)) {
      const other = Object.getOwnPropertyDescriptor(nextState.entities.characters, id)
        ?.value as CharacterEntity | undefined;
      if (other) {
        const otherGroup =
          other.formGroup ??
          (other.formId !== null ? formIndex?.byId.get(other.formId)?.formGroup ?? null : null);
        if (otherGroup === excludedGroup) {
          return false;
        }
      }
    }
    return true;
  });

  return nextState;
}
