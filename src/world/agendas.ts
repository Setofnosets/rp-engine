import { type ValidationError, validationError } from '../core/errors.js';
import { type RngState, pickOne, shuffle } from '../core/prng.js';
import { ErrorAccumulator, type Result, err, ok } from '../core/result.js';
import type { PatchOperation } from '../state/patch.js';
import {
  type CharacterEntity,
  type CharacterStatus,
  type FactionEntity,
  type ThreatEntity,
  type WorldState,
  cloneWorldState,
} from '../state/world-state.js';

/**
 * Configuration governing off-screen agenda progression, NPC relocations, and rumor generation.
 */
export interface AgendaConfig {
  factionInfluencePerDay: number;
  mainThreatProgressPerDay: number;
  secondaryThreatProgressPerDay: number;
  maxFactionDeltaPerTick: number;
  maxNpcMovesPerTick: number;
  maxDaysPerTick: number;
  rumorsPerTick: number;
  threatStageThresholds?: readonly number[];
  rumorTemplates: readonly string[];
}

/**
 * Result returned by {@link runAgendaTick}, containing both deterministic patch ops and next state.
 */
export interface AgendaTickResult {
  operations: PatchOperation[];
  nextState: WorldState;
  nextRng: RngState;
  generatedRumors: string[];
}

/**
 * Default off-screen agenda pacing rates aligned with NeoTerra defaults.
 */
export const DEFAULT_AGENDA_CONFIG: AgendaConfig = Object.freeze({
  factionInfluencePerDay: 0.5,
  mainThreatProgressPerDay: 1.0,
  secondaryThreatProgressPerDay: 0.5,
  maxFactionDeltaPerTick: 5,
  maxNpcMovesPerTick: 2,
  maxDaysPerTick: 14,
  rumorsPerTick: 2,
  threatStageThresholds: Object.freeze([25, 50, 75, 100]),
  rumorTemplates: Object.freeze([
    'Word around {location}: {faction} is making a move.',
    'Rumours say {threat} is gaining ground near {location}.',
    '{faction} pressure is felt in {location} tonight.',
    'People in {location} are talking about {threat}.',
    '{faction} activity reported around {location}.',
  ]),
});

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const NON_ACTIVE_CHARACTER_STATUSES: ReadonlySet<CharacterStatus> = new Set([
  'dead',
  'captured',
  'imprisoned',
  'missing',
  'retired',
  'lost',
]);

function isSafeKey(key: string): boolean {
  return key.length > 0 && !FORBIDDEN_KEYS.has(key);
}

function getOwn<T>(record: Record<string, T>, key: string): T | undefined {
  if (!isSafeKey(key) || !Object.hasOwn(record, key)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(record, key)?.value as T | undefined;
}

function clamp(value: number, min: number, max: number): number {
  const clamped = Math.min(max, Math.max(min, value));
  return clamped === 0 ? 0 : clamped;
}

function roundFloatNoise(value: number): number {
  const rounded = Math.round(value * 1e9) / 1e9;
  return rounded === 0 ? 0 : rounded;
}

function cloneRngState(rng: RngState): RngState {
  if (rng.type === 'queued') {
    return {
      type: 'queued',
      queue: [...rng.queue],
      cursor: rng.cursor,
      fallback: { ...rng.fallback },
      drawCount: rng.drawCount,
    };
  }
  return { ...rng };
}

/**
 * Validate an {@link AgendaConfig} object using {@link ErrorAccumulator}.
 */
export function validateAgendaConfig(config: AgendaConfig): Result<AgendaConfig, ValidationError[]> {
  const acc = new ErrorAccumulator('agendaConfig');
  if (typeof config !== 'object' || config === null) {
    return err([validationError('agendaConfig', 'INVALID_TYPE', 'AgendaConfig must be an object')]);
  }

  const finiteFields: Array<keyof Pick<
    AgendaConfig,
    | 'factionInfluencePerDay'
    | 'mainThreatProgressPerDay'
    | 'secondaryThreatProgressPerDay'
    | 'maxFactionDeltaPerTick'
    | 'maxNpcMovesPerTick'
    | 'maxDaysPerTick'
    | 'rumorsPerTick'
  >> = [
    'factionInfluencePerDay',
    'mainThreatProgressPerDay',
    'secondaryThreatProgressPerDay',
    'maxFactionDeltaPerTick',
    'maxNpcMovesPerTick',
    'maxDaysPerTick',
    'rumorsPerTick',
  ];

  for (const field of finiteFields) {
    const val = config[field];
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      acc.add(field, 'INVALID_NUMBER', `${field} must be a finite number`);
    }
  }

  if (Number.isFinite(config.maxFactionDeltaPerTick) && config.maxFactionDeltaPerTick < 0) {
    acc.add('maxFactionDeltaPerTick', 'OUT_OF_RANGE', 'maxFactionDeltaPerTick must be >= 0');
  }
  if (
    Number.isFinite(config.maxNpcMovesPerTick) &&
    (!Number.isInteger(config.maxNpcMovesPerTick) || config.maxNpcMovesPerTick < 0)
  ) {
    acc.add('maxNpcMovesPerTick', 'INVALID_INTEGER', 'maxNpcMovesPerTick must be an integer >= 0');
  }
  if (Number.isFinite(config.maxDaysPerTick) && config.maxDaysPerTick < 0) {
    acc.add('maxDaysPerTick', 'OUT_OF_RANGE', 'maxDaysPerTick must be >= 0');
  }
  if (
    Number.isFinite(config.rumorsPerTick) &&
    (!Number.isInteger(config.rumorsPerTick) || config.rumorsPerTick < 0)
  ) {
    acc.add('rumorsPerTick', 'INVALID_INTEGER', 'rumorsPerTick must be an integer >= 0');
  }

  if (config.threatStageThresholds !== undefined) {
    if (!Array.isArray(config.threatStageThresholds)) {
      acc.add('threatStageThresholds', 'INVALID_TYPE', 'threatStageThresholds must be an array');
    } else {
      for (let i = 0; i < config.threatStageThresholds.length; i += 1) {
        const threshold = config.threatStageThresholds[i];
        if (typeof threshold !== 'number' || !Number.isFinite(threshold)) {
          acc.add(
            `threatStageThresholds[${i}]`,
            'INVALID_NUMBER',
            'Each threat stage threshold must be a finite number'
          );
        }
      }
    }
  }

  if (!Array.isArray(config.rumorTemplates)) {
    acc.add('rumorTemplates', 'INVALID_TYPE', 'rumorTemplates must be an array of strings');
  } else {
    for (let i = 0; i < config.rumorTemplates.length; i += 1) {
      if (typeof config.rumorTemplates[i] !== 'string') {
        acc.add(`rumorTemplates[${i}]`, 'INVALID_TYPE', 'Each rumor template must be a string');
      }
    }
  }

  return acc.toResult(config);
}

function computeThreatStage(progress: number, thresholds: readonly number[]): number {
  const sorted = thresholds
    .filter((n) => typeof n === 'number' && Number.isFinite(n))
    .slice()
    .sort((a, b) => a - b);

  let stage = 0;
  for (const threshold of sorted) {
    if (progress >= threshold) {
      stage += 1;
    }
  }
  return stage;
}

function findFactionHqDestinations(
  char: CharacterEntity,
  factions: Record<string, FactionEntity>,
  locations: Record<string, unknown>
): string[] {
  const allegianceLower = char.allegiance.trim().toLowerCase();
  const hqs: string[] = [];
  const factionIds = Object.keys(factions).filter(isSafeKey).sort();

  for (const factionId of factionIds) {
    const faction = getOwn(factions, factionId);
    if (!faction || faction.status === 'disbanded') {
      continue;
    }
    const hq = faction.headquartersLocationId;
    if (
      typeof hq !== 'string' ||
      !isSafeKey(hq) ||
      hq === char.locationId ||
      !Object.hasOwn(locations, hq)
    ) {
      continue;
    }

    const matchesAllegiance =
      allegianceLower.length > 0 &&
      (faction.id.toLowerCase() === allegianceLower ||
        faction.name.trim().toLowerCase() === allegianceLower ||
        faction.side.toLowerCase() === allegianceLower);

    if (matchesAllegiance && !hqs.includes(hq)) {
      hqs.push(hq);
    }
  }

  return hqs;
}

function collectNpcCandidateDestinations(
  char: CharacterEntity,
  state: WorldState
): string[] {
  const destinations = new Set<string>();
  const locations = state.entities.locations;

  if (
    typeof char.locationId === 'string' &&
    isSafeKey(char.locationId) &&
    Object.hasOwn(locations, char.locationId)
  ) {
    const origin = getOwn(locations, char.locationId);
    if (origin) {
      for (const connId of origin.connectedLocations) {
        if (isSafeKey(connId) && connId !== char.locationId && Object.hasOwn(locations, connId)) {
          destinations.add(connId);
        }
      }
    }
  }

  for (const hq of findFactionHqDestinations(char, state.entities.factions, locations)) {
    destinations.add(hq);
  }

  // Fallback for unplaced off-screen NPCs with no matched faction HQ
  if (destinations.size === 0 && char.locationId === null) {
    const factionIds = Object.keys(state.entities.factions).filter(isSafeKey).sort();
    for (const factionId of factionIds) {
      const faction = getOwn(state.entities.factions, factionId);
      const hq = faction?.headquartersLocationId;
      if (
        faction &&
        faction.status !== 'disbanded' &&
        typeof hq === 'string' &&
        isSafeKey(hq) &&
        Object.hasOwn(locations, hq)
      ) {
        destinations.add(hq);
      }
    }
  }

  return [...destinations].sort();
}

function formatRumorTemplate(
  template: string,
  values: { faction: string; location: string; threat: string }
): string {
  const filled = template
    .replace(/\{faction\}/g, () => values.faction)
    .replace(/\{location\}/g, () => values.location)
    .replace(/\{threat\}/g, () => values.threat);
  return filled.replace(/\s+/g, ' ').trim();
}

/**
 * Advance off-screen factions, threats, NPC relocations, and rumors deterministically.
 *
 * Returns a no-op result when `daysElapsed <= 0` or `!state.capabilities.factions`.
 */
export function runAgendaTick(
  state: WorldState,
  config: AgendaConfig,
  daysElapsed: number,
  rng: RngState
): AgendaTickResult {
  const baseRng = cloneRngState(rng);

  if (
    !Number.isFinite(daysElapsed) ||
    daysElapsed <= 0 ||
    !state.capabilities.factions ||
    !Number.isFinite(config.maxDaysPerTick) ||
    config.maxDaysPerTick <= 0
  ) {
    return {
      operations: [],
      nextState: cloneWorldState(state),
      nextRng: baseRng,
      generatedRumors: [],
    };
  }

  const days = Math.min(daysElapsed, config.maxDaysPerTick);
  const nextState = cloneWorldState(state);
  const operations: PatchOperation[] = [];
  let currentRng = baseRng;

  // 1. Advance active faction influence (clamped 0..100, capped by maxFactionDeltaPerTick)
  const maxFactionDelta = Math.max(0, config.maxFactionDeltaPerTick);
  const rawFactionDelta = days * config.factionInfluencePerDay;
  const factionDelta = clamp(rawFactionDelta, -maxFactionDelta, maxFactionDelta);

  const factionIds = Object.keys(nextState.entities.factions).filter(isSafeKey).sort();
  for (const factionId of factionIds) {
    const faction = getOwn(nextState.entities.factions, factionId);
    if (!faction || faction.status !== 'active') {
      continue;
    }
    const nextInfluence = roundFloatNoise(clamp(faction.influence + factionDelta, 0, 100));
    if (nextInfluence !== faction.influence) {
      faction.influence = nextInfluence;
      operations.push({
        op: 'entity_patch',
        collection: 'factions',
        entityId: factionId,
        patch: { influence: nextInfluence },
      });
    }
  }

  // 2. Advance active main/secondary threat progress and update stage across thresholds
  const thresholds =
    config.threatStageThresholds ?? DEFAULT_AGENDA_CONFIG.threatStageThresholds ?? [25, 50, 75, 100];
  const threatIds = Object.keys(nextState.entities.threats).filter(isSafeKey).sort();

  for (const threatId of threatIds) {
    const threat = getOwn(nextState.entities.threats, threatId);
    if (!threat || threat.status !== 'active') {
      continue;
    }
    const rate =
      threat.rank === 'main'
        ? config.mainThreatProgressPerDay
        : config.secondaryThreatProgressPerDay;
    const progressDelta = days * rate;
    const nextProgress = roundFloatNoise(clamp(threat.progress + progressDelta, 0, 100));
    const computedStage = computeThreatStage(nextProgress, thresholds);
    const nextStage =
      progressDelta >= 0 ? Math.max(threat.stage, computedStage) : computedStage;

    const patch: Record<string, unknown> = {};
    let changed = false;
    if (nextProgress !== threat.progress) {
      threat.progress = nextProgress;
      patch['progress'] = nextProgress;
      changed = true;
    }
    if (nextStage !== threat.stage) {
      threat.stage = nextStage;
      patch['stage'] = nextStage;
      changed = true;
    }

    if (changed) {
      operations.push({
        op: 'entity_patch',
        collection: 'threats',
        entityId: threatId,
        patch,
      });
    }
  }

  // 3. Deterministic off-screen NPC relocations (up to maxNpcMovesPerTick)
  const maxNpcMoves = Math.max(0, Math.floor(config.maxNpcMovesPerTick));
  if (maxNpcMoves > 0) {
    const pinnedSet = new Set(nextState.scene.pinnedCharacterIds);
    const presentSet = new Set(nextState.scene.presentCharacterIds);
    const playerCharId = nextState.player.characterId;
    const sceneLocationId = nextState.scene.locationId;
    const isSpatialScene = nextState.capabilities.spatialMode !== 'scene_only';

    const eligibleNpcIds = Object.keys(nextState.entities.characters)
      .filter(isSafeKey)
      .sort()
      .filter((charId) => {
        if (charId === playerCharId || pinnedSet.has(charId) || presentSet.has(charId)) {
          return false;
        }
        const char = getOwn(nextState.entities.characters, charId);
        if (!char || NON_ACTIVE_CHARACTER_STATUSES.has(char.status)) {
          return false;
        }
        if (char.presentInScene) {
          return false;
        }
        if (isSpatialScene && sceneLocationId !== null && char.locationId === sceneLocationId) {
          return false;
        }
        return true;
      });

    const shuffledResult = shuffle(eligibleNpcIds, currentRng);
    currentRng = shuffledResult.nextState;

    let movesPerformed = 0;
    for (const charId of shuffledResult.shuffled) {
      if (movesPerformed >= maxNpcMoves) {
        break;
      }
      const char = getOwn(nextState.entities.characters, charId);
      if (!char) {
        continue;
      }
      const destinations = collectNpcCandidateDestinations(char, nextState);
      if (destinations.length === 0) {
        continue;
      }

      const picked = pickOne(destinations, currentRng);
      currentRng = picked.nextState;
      if (picked.item !== undefined && picked.item !== char.locationId) {
        char.locationId = picked.item;
        movesPerformed += 1;
        operations.push({
          op: 'entity_patch',
          collection: 'characters',
          entityId: charId,
          patch: { locationId: picked.item },
        });
      }
    }
  }

  // 4. Format up to rumorsPerTick rumors stored into turnEvents.rumors
  const generatedRumors: string[] = [];
  const maxRumors = Math.max(0, Math.floor(config.rumorsPerTick));
  const validTemplates = config.rumorTemplates.filter((t) => typeof t === 'string' && t.trim().length > 0);

  if (maxRumors > 0 && validTemplates.length > 0) {
    const activeFactions: FactionEntity[] = [];
    for (const id of factionIds) {
      const f = getOwn(nextState.entities.factions, id);
      if (f && f.status !== 'disbanded') {
        activeFactions.push(f);
      }
    }

    const activeThreats: ThreatEntity[] = [];
    for (const id of threatIds) {
      const t = getOwn(nextState.entities.threats, id);
      if (t && t.status === 'active') {
        activeThreats.push(t);
      }
    }

    const locationIds = Object.keys(nextState.entities.locations).filter(isSafeKey).sort();
    const locationNames = locationIds
      .map((id) => getOwn(nextState.entities.locations, id)?.name)
      .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);

    for (let i = 0; i < maxRumors; i += 1) {
      const tplPick = pickOne(validTemplates, currentRng);
      currentRng = tplPick.nextState;
      const template = tplPick.item ?? validTemplates[0] ?? '';

      let factionName = 'an unknown faction';
      let pickedFaction: FactionEntity | undefined;
      if (activeFactions.length > 0) {
        const facPick = pickOne(activeFactions, currentRng);
        currentRng = facPick.nextState;
        pickedFaction = facPick.item;
        if (pickedFaction) {
          factionName = pickedFaction.name;
        }
      }

      let threatName = 'unrest';
      let pickedThreat: ThreatEntity | undefined;
      if (activeThreats.length > 0) {
        const thrPick = pickOne(activeThreats, currentRng);
        currentRng = thrPick.nextState;
        pickedThreat = thrPick.item;
        if (pickedThreat) {
          threatName = pickedThreat.name;
        }
      }

      let locationName =
        nextState.scene.location.trim().length > 0 ? nextState.scene.location.trim() : 'the city';
      const contextualLocId =
        pickedThreat?.locationId ?? pickedFaction?.headquartersLocationId ?? null;
      if (
        typeof contextualLocId === 'string' &&
        isSafeKey(contextualLocId) &&
        Object.hasOwn(nextState.entities.locations, contextualLocId)
      ) {
        const loc = getOwn(nextState.entities.locations, contextualLocId);
        if (loc && loc.name.trim().length > 0) {
          locationName = loc.name;
        }
      } else if (locationNames.length > 0) {
        const locPick = pickOne(locationNames, currentRng);
        currentRng = locPick.nextState;
        if (locPick.item !== undefined) {
          locationName = locPick.item;
        }
      }

      const formatted = formatRumorTemplate(template, {
        faction: factionName,
        location: locationName,
        threat: threatName,
      });

      if (formatted.length > 0) {
        generatedRumors.push(formatted);
        nextState.turnEvents.rumors.push(formatted);
        operations.push({
          op: 'push',
          path: 'turnEvents.rumors',
          value: formatted,
        });
      }
    }
  }

  nextState.meta.rngState = cloneRngState(currentRng);

  return {
    operations,
    nextState,
    nextRng: currentRng,
    generatedRumors,
  };
}
