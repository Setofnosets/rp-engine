import { type ValidationError, validationError } from '../core/errors.js';
import { type RngState, nextFloat } from '../core/prng.js';
import { type Result, err, ok } from '../core/result.js';
import type { PatchOperation } from '../state/patch.js';
import {
  type DiscoveryState,
  type LocationEntity,
  validateTravelTarget,
} from '../state/spatial-topology.js';
import type {
  CharacterEntity,
  DigestEdition,
  FactionEntity,
  ThreatEntity,
  WorldState,
} from '../state/world-state.js';

export type EncounterPendingAction = 'engage' | 'talk' | 'avoid';

export type DowntimeActivity = 'recover' | 'train' | 'research' | 'patrol' | 'socialize';

export interface TravelOptions {
  readonly travelSlots?: number;
  readonly baseEncounterChance?: number;
  readonly encounterChanceOverride?: number;
  readonly disableEncounters?: boolean;
  readonly defaultEncounterAction?: EncounterPendingAction;
}

export interface TravelArrivalSummary {
  readonly fromLocationId: string | null;
  readonly targetLocationId: string | null;
  readonly targetLocationName: string;
  readonly slotsAdvanced: number;
  readonly previousDiscoveryState: DiscoveryState | null;
  readonly discoveryState: DiscoveryState;
  readonly controllingFactionId: string | null;
  readonly locationStatus: string;
  readonly activeThreatsAtTarget: readonly string[];
  readonly encounterTriggered: boolean;
  readonly encounterActionPending: EncounterPendingAction | null;
  readonly summaryText: string;
}

export interface TravelExecutionResult {
  readonly patches: readonly PatchOperation[];
  readonly arrivalSummary: TravelArrivalSummary;
  readonly encounterTriggered: boolean;
  readonly encounterActionPending: EncounterPendingAction | null;
  readonly nextRng: RngState;
}

export interface DowntimeOptions {
  readonly slots?: number;
  readonly requireSafehouseTag?: boolean;
  readonly xpAmount?: number;
  readonly intelAmount?: number;
  readonly factionId?: string;
  readonly targetCharacterId?: string;
}

export interface DowntimeExecutionResult {
  readonly activity: DowntimeActivity;
  readonly patches: readonly PatchOperation[];
  readonly slotsAdvanced: number;
  readonly summaryText: string;
}

export interface DigestFlowConfig {
  readonly everyDays?: number;
  readonly minEvents?: number;
  readonly masthead?: string;
  readonly maxHeadlines?: number;
}

export interface DigestEvaluationResult {
  readonly published: boolean;
  readonly edition: DigestEdition | null;
  readonly patches: readonly PatchOperation[];
}

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const SAFEHOUSE_KINDS: ReadonlySet<string> = new Set([
  'safehouse',
  'hub',
  'base',
  'sanctuary',
  'inn',
  'camp',
  'headquarters',
]);

const SAFEHOUSE_TAGS: ReadonlySet<string> = new Set([
  'safehouse',
  'hub',
  'safe',
  'base',
  'sanctuary',
]);

const HOSTILE_LOCATION_TAGS: ReadonlySet<string> = new Set([
  'hostile',
  'dungeon',
  'dangerous',
  'wild',
  'ruins',
  'warzone',
]);

const DOWNTIME_ACTIVITIES: ReadonlySet<DowntimeActivity> = new Set([
  'recover',
  'train',
  'research',
  'patrol',
  'socialize',
]);

function isSafeKey(key: string): boolean {
  return key.length > 0 && !FORBIDDEN_KEYS.has(key);
}

function getOwn<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  if (!record || !isSafeKey(key) || !Object.hasOwn(record, key)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(record, key)?.value as T | undefined;
}

function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}

function clamp(value: number, min: number, max: number): number {
  const clamped = Math.min(max, Math.max(min, value));
  return normalizeZero(clamped);
}

function compareIdsDeterministic(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

function getSortedSafeKeys<T>(record: Record<string, T>): string[] {
  return Object.keys(record).filter(isSafeKey).sort(compareIdsDeterministic);
}

function computeTravelEncounterRisk(
  worldState: WorldState,
  targetLocation: LocationEntity | undefined,
  targetLocationId: string | null,
  options: TravelOptions
): number {
  if (options.disableEncounters === true) {
    return 0;
  }
  if (options.encounterChanceOverride !== undefined) {
    if (!Number.isFinite(options.encounterChanceOverride)) {
      return 0;
    }
    return clamp(options.encounterChanceOverride, 0, 1);
  }

  let risk =
    options.baseEncounterChance !== undefined && Number.isFinite(options.baseEncounterChance)
      ? options.baseEncounterChance
      : 0.1;

  if (targetLocation) {
    if (targetLocation.status === 'contested') {
      risk += 0.25;
    }
    const lowerTags = targetLocation.tags.map((t) => t.toLowerCase());
    if (lowerTags.some((t) => HOSTILE_LOCATION_TAGS.has(t))) {
      risk += 0.15;
    }
    if (lowerTags.some((t) => SAFEHOUSE_TAGS.has(t))) {
      risk -= 0.2;
    }
  }

  const threatIds = getSortedSafeKeys(worldState.entities.threats);
  for (const threatId of threatIds) {
    const threat: ThreatEntity | undefined = getOwn(worldState.entities.threats, threatId);
    if (!threat || threat.status !== 'active') {
      continue;
    }
    if (targetLocationId !== null && threat.locationId === targetLocationId) {
      risk += 0.25;
    } else {
      risk += 0.03 * Math.min(3, Math.max(1, threat.stage));
    }
  }

  return clamp(risk, 0, 0.95);
}

function selectEncounterActionPending(
  worldState: WorldState,
  targetLocation: LocationEntity | undefined,
  options: TravelOptions
): EncounterPendingAction {
  if (options.defaultEncounterAction !== undefined) {
    return options.defaultEncounterAction;
  }
  if (worldState.capabilities.combatMode === 'disabled') {
    return 'talk';
  }
  if (targetLocation?.status === 'contested') {
    return 'engage';
  }
  return 'engage';
}

/**
 * Deterministically execute a travel transition to `targetLocationId`:
 * validates connection state via {@link validateTravelTarget}, advances travel time,
 * marks destination `discoveryState: 'visited'`, rolls a deterministic encounter check,
 * and compiles a structured {@link TravelArrivalSummary}.
 */
export function executeTravel(
  worldState: WorldState,
  targetLocationId: string,
  options: TravelOptions = {}
): Result<TravelExecutionResult, ValidationError[]> {
  const targetRes = validateTravelTarget(
    worldState.capabilities.spatialMode,
    worldState.entities.locations,
    worldState.scene.locationId,
    targetLocationId
  );
  if (!targetRes.ok) {
    return err(targetRes.error);
  }

  const { targetId, targetName } = targetRes.value;
  const targetLocation =
    targetId !== null ? getOwn(worldState.entities.locations, targetId) : undefined;

  const travelSlots =
    options.travelSlots !== undefined &&
    Number.isInteger(options.travelSlots) &&
    options.travelSlots >= 0
      ? options.travelSlots
      : 1;

  const patches: PatchOperation[] = [];
  const effectiveSlots = worldState.capabilities.clocks === 'disabled' ? 0 : travelSlots;
  if (effectiveSlots > 0) {
    patches.push({
      op: 'clock_advance',
      storySlots: effectiveSlots,
    });
  }

  patches.push({ op: 'set', path: 'scene.location', value: targetName });

  let previousDiscoveryState: DiscoveryState | null = null;
  if (targetId !== null && targetLocation !== undefined) {
    previousDiscoveryState =
      targetLocation.discoveryState ?? (targetLocation.discovered ? 'discovered' : 'unknown');
    patches.push({ op: 'set', path: 'scene.locationId', value: targetId });
    patches.push({ op: 'set', path: 'player.locationId', value: targetId });
    patches.push({
      op: 'entity_patch',
      collection: 'locations',
      entityId: targetId,
      patch: {
        discovered: true,
        discoveryState: 'visited',
      },
    });
  } else if (worldState.capabilities.spatialMode === 'emergent') {
    patches.push({
      op: 'emergent_location_visit',
      locationName: targetName,
    });
  }

  const activeThreatsAtTarget: string[] = [];
  if (targetId !== null) {
    for (const threatId of getSortedSafeKeys(worldState.entities.threats)) {
      const threat = getOwn(worldState.entities.threats, threatId);
      if (threat && threat.status === 'active' && threat.locationId === targetId) {
        activeThreatsAtTarget.push(threat.id);
      }
    }
  }

  const risk = computeTravelEncounterRisk(worldState, targetLocation, targetId, options);
  const { value: roll, nextState: nextRng } = nextFloat(worldState.meta.rngState);
  const encounterTriggered = risk > 0 && roll < risk;
  const encounterActionPending: EncounterPendingAction | null = encounterTriggered
    ? selectEncounterActionPending(worldState, targetLocation, options)
    : null;

  if (encounterTriggered && encounterActionPending !== null) {
    patches.push({
      op: 'custom_field_patch',
      target: 'global',
      fieldId: 'encounterActionPending',
      value: encounterActionPending,
    });
    patches.push({
      op: 'push',
      path: 'turnEvents.systemNotices',
      value: `Travel encounter triggered at ${targetName} (pending: ${encounterActionPending}).`,
    });
  } else {
    patches.push({
      op: 'custom_field_patch',
      target: 'global',
      fieldId: 'encounterActionPending',
      value: null,
    });
  }

  const summaryParts = [`Arrived at ${targetName}.`];
  if (effectiveSlots > 0) {
    summaryParts.push(`Time advanced ${effectiveSlots} slot(s).`);
  }
  if (activeThreatsAtTarget.length > 0) {
    summaryParts.push(`Active threats detected: ${activeThreatsAtTarget.join(', ')}.`);
  }
  if (encounterTriggered && encounterActionPending !== null) {
    summaryParts.push(`Encounter triggered (action pending: ${encounterActionPending}).`);
  }

  const arrivalSummary: TravelArrivalSummary = {
    fromLocationId: worldState.scene.locationId,
    targetLocationId: targetId,
    targetLocationName: targetName,
    slotsAdvanced: effectiveSlots,
    previousDiscoveryState,
    discoveryState: 'visited',
    controllingFactionId: targetLocation?.controllingFactionId ?? null,
    locationStatus: targetLocation?.status ?? 'normal',
    activeThreatsAtTarget,
    encounterTriggered,
    encounterActionPending,
    summaryText: summaryParts.join(' '),
  };

  return ok({
    patches,
    arrivalSummary,
    encounterTriggered,
    encounterActionPending,
    nextRng,
  });
}

function validateDowntimeLocation(
  worldState: WorldState,
  options: DowntimeOptions
): ValidationError[] {
  const locId = worldState.scene.locationId ?? worldState.player.locationId;
  if (locId === null) {
    if (options.requireSafehouseTag === true) {
      return [
        validationError(
          'scene.locationId',
          'DOWNTIME_NOT_SAFEHOUSE',
          'Downtime requires an active safehouse or hub location'
        ),
      ];
    }
    return [];
  }

  const loc = getOwn(worldState.entities.locations, locId);
  if (!loc) {
    return [];
  }

  if (loc.status === 'contested' || loc.status === 'destroyed' || loc.status === 'locked') {
    return [
      validationError(
        'scene.locationId',
        'DOWNTIME_UNSAFE_LOCATION',
        `Cannot perform downtime at "${loc.name}" while status is "${loc.status}"`
      ),
    ];
  }

  const lowerKind = loc.kind.toLowerCase();
  const lowerTags = loc.tags.map((t) => t.toLowerCase());
  const isExplicitSafehouse =
    SAFEHOUSE_KINDS.has(lowerKind) || lowerTags.some((t) => SAFEHOUSE_TAGS.has(t));
  const isHostile = lowerTags.some((t) => HOSTILE_LOCATION_TAGS.has(t));

  if (options.requireSafehouseTag === true && !isExplicitSafehouse) {
    return [
      validationError(
        'scene.locationId',
        'DOWNTIME_NOT_SAFEHOUSE',
        `Location "${loc.name}" is not a safehouse or hub`
      ),
    ];
  }

  if (isHostile && !isExplicitSafehouse) {
    return [
      validationError(
        'scene.locationId',
        'DOWNTIME_UNSAFE_LOCATION',
        `Cannot perform downtime in hostile location "${loc.name}"`
      ),
    ];
  }

  return [];
}

/**
 * Deterministically execute a safehouse/hub downtime activity (`recover`, `train`, `research`,
 * `patrol`, `socialize`), advancing a clock slot and emitting deterministic state patches.
 */
export function executeDowntime(
  worldState: WorldState,
  activity: DowntimeActivity,
  options: DowntimeOptions = {}
): Result<DowntimeExecutionResult, ValidationError[]> {
  if (!DOWNTIME_ACTIVITIES.has(activity)) {
    return err([
      validationError(
        'activity',
        'INVALID_DOWNTIME_ACTIVITY',
        `Unsupported downtime activity "${String(activity)}"`
      ),
    ]);
  }

  const locationErrors = validateDowntimeLocation(worldState, options);
  if (locationErrors.length > 0) {
    return err(locationErrors);
  }

  const slots =
    options.slots !== undefined && Number.isInteger(options.slots) && options.slots >= 0
      ? options.slots
      : 1;
  const effectiveSlots = worldState.capabilities.clocks === 'disabled' ? 0 : slots;

  const patches: PatchOperation[] = [];
  if (effectiveSlots > 0) {
    patches.push({
      op: 'clock_advance',
      storySlots: effectiveSlots,
    });
  }

  let summaryText = '';

  switch (activity) {
    case 'recover': {
      let restoredCount = 0;
      const resources = worldState.player.resources;
      if (resources) {
        for (const poolKey of getSortedSafeKeys(resources)) {
          const pool = getOwn(resources, poolKey);
          if (!pool || pool.max <= 0 || pool.current >= pool.max) {
            continue;
          }
          const healAmount = Math.max(1, Math.ceil(pool.max * 0.5));
          const nextValue = Math.min(pool.max, pool.current + healAmount);
          patches.push({
            op: 'set',
            path: `player.resources.${poolKey}.current`,
            value: normalizeZero(nextValue),
          });
          restoredCount += 1;
        }
      }
      const linkedCharId = worldState.player.canonCharacterId ?? worldState.player.characterId;
      if (linkedCharId) {
        const linkedChar = getOwn(worldState.entities.characters, linkedCharId);
        if (linkedChar?.resources) {
          for (const poolKey of getSortedSafeKeys(linkedChar.resources)) {
            const pool = getOwn(linkedChar.resources, poolKey);
            if (!pool || pool.max <= 0 || pool.current >= pool.max) {
              continue;
            }
            const healAmount = Math.max(1, Math.ceil(pool.max * 0.5));
            const nextValue = Math.min(pool.max, pool.current + healAmount);
            patches.push({
              op: 'set',
              path: `entities.characters.${linkedCharId}.resources.${poolKey}.current`,
              value: normalizeZero(nextValue),
            });
          }
        }
      }
      patches.push({
        op: 'increment',
        path: 'counters.downtimeRecoverCount',
        delta: 1,
      });
      summaryText =
        restoredCount > 0
          ? `Recovered at safehouse; restored ${restoredCount} resource pool(s).`
          : 'Rested and recovered at safehouse.';
      break;
    }

    case 'train': {
      const xpAmount =
        options.xpAmount !== undefined && Number.isFinite(options.xpAmount) && options.xpAmount > 0
          ? Math.floor(options.xpAmount)
          : 25;
      if (worldState.capabilities.progression !== 'disabled' && worldState.player.progression) {
        patches.push({
          op: 'increment',
          path: 'player.progression.xp',
          delta: xpAmount,
        });
      }
      patches.push({
        op: 'increment',
        path: 'counters.downtimeTrainCount',
        delta: 1,
      });
      summaryText = `Completed training session (+${xpAmount} XP).`;
      break;
    }

    case 'research': {
      const intelAmount =
        options.intelAmount !== undefined &&
        Number.isFinite(options.intelAmount) &&
        options.intelAmount > 0
          ? Math.floor(options.intelAmount)
          : 1;
      patches.push({
        op: 'increment',
        path: 'counters.intel',
        delta: intelAmount,
      });
      patches.push({
        op: 'push',
        path: 'turnEvents.rumors',
        value: `Downtime research uncovered +${intelAmount} intel lead(s).`,
      });
      summaryText = `Conducted research (+${intelAmount} intel).`;
      break;
    }

    case 'patrol': {
      const locId = worldState.scene.locationId ?? worldState.player.locationId;
      const loc = locId !== null ? getOwn(worldState.entities.locations, locId) : undefined;
      const targetFactionId = options.factionId ?? loc?.controllingFactionId ?? null;
      if (targetFactionId !== null) {
        const faction: FactionEntity | undefined = getOwn(
          worldState.entities.factions,
          targetFactionId
        );
        if (faction) {
          patches.push({
            op: 'entity_patch',
            collection: 'factions',
            entityId: targetFactionId,
            patch: { influence: normalizeZero(faction.influence + 1) },
          });
        }
      }
      patches.push({
        op: 'increment',
        path: 'counters.downtimePatrolCount',
        delta: 1,
      });
      summaryText =
        targetFactionId !== null
          ? `Patrolled sector and bolstered ${targetFactionId} influence.`
          : 'Patrolled surrounding area.';
      break;
    }

    case 'socialize': {
      let targetCharId = options.targetCharacterId ?? null;
      if (targetCharId === null) {
        for (const candidateId of worldState.scene.presentCharacterIds) {
          if (candidateId === worldState.player.characterId) {
            continue;
          }
          const candidate: CharacterEntity | undefined = getOwn(
            worldState.entities.characters,
            candidateId
          );
          if (candidate && candidate.status === 'active') {
            targetCharId = candidateId;
            break;
          }
        }
      }
      if (targetCharId !== null && isSafeKey(targetCharId)) {
        const playerRelations = getOwn(worldState.relations, worldState.player.id);
        const existingRel = getOwn(playerRelations, targetCharId);
        if (existingRel) {
          const nextAffinity = Math.min(existingRel.maxAffinity, existingRel.affinity + 5);
          patches.push({
            op: 'set',
            path: `relations.${worldState.player.id}.${targetCharId}.affinity`,
            value: normalizeZero(nextAffinity),
          });
        } else {
          patches.push({
            op: 'set',
            path: `relations.${worldState.player.id}.${targetCharId}`,
            value: {
              affinity: 5,
              maxAffinity: 100,
              label: 'acquaintance',
              tags: ['socialized'],
            },
          });
        }
      }
      patches.push({
        op: 'increment',
        path: 'counters.downtimeSocializeCount',
        delta: 1,
      });
      summaryText =
        targetCharId !== null
          ? `Socialized with ${targetCharId} (+5 affinity).`
          : 'Socialized with locals.';
      break;
    }
  }

  patches.push({
    op: 'push',
    path: 'turnEvents.systemNotices',
    value: summaryText,
  });

  return ok({
    activity,
    patches,
    slotsAdvanced: effectiveSlots,
    summaryText,
  });
}

/**
 * Evaluate the Newsroom digest cadence (`everyDays` or `minEvents` since last edition)
 * and synthesize a deterministic {@link DigestEdition} when due.
 */
export function evaluateDigestFlow(
  worldState: WorldState,
  config: DigestFlowConfig = {}
): DigestEvaluationResult {
  const everyDays =
    config.everyDays !== undefined && Number.isInteger(config.everyDays) && config.everyDays >= 1
      ? config.everyDays
      : 3;
  const minEvents =
    config.minEvents !== undefined && Number.isInteger(config.minEvents) && config.minEvents >= 1
      ? config.minEvents
      : 6;
  const maxHeadlines =
    config.maxHeadlines !== undefined &&
    Number.isInteger(config.maxHeadlines) &&
    config.maxHeadlines >= 1
      ? config.maxHeadlines
      : 5;
  const masthead =
    typeof config.masthead === 'string' && config.masthead.trim().length > 0
      ? config.masthead.trim()
      : 'The World Dispatch';

  const existingEditions = worldState.chronicle.digestEditions ?? [];
  const lastEdition =
    existingEditions.length > 0 ? existingEditions[existingEditions.length - 1] : undefined;

  const lastDigestDay = Object.hasOwn(worldState.counters, 'lastDigestDay')
    ? (getOwn(worldState.counters, 'lastDigestDay') ?? 0)
    : (lastEdition?.day ?? 0);

  const lastDigestChronicleCount = Object.hasOwn(
    worldState.counters,
    'lastDigestChronicleCount'
  )
    ? (getOwn(worldState.counters, 'lastDigestChronicleCount') ?? 0)
    : 0;

  const daysSinceLast = worldState.clocks.day - lastDigestDay;
  const newEventsCount = worldState.chronicle.events.length - lastDigestChronicleCount;

  if (daysSinceLast < everyDays && newEventsCount < minEvents) {
    return {
      published: false,
      edition: null,
      patches: [],
    };
  }

  const headlines: string[] = [];
  const headlineSeen = new Set<string>();
  const locationIdSet = new Set<string>();

  const pushHeadline = (text: string): void => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || headlines.length >= maxHeadlines) {
      return;
    }
    const key = trimmed.toLowerCase();
    if (headlineSeen.has(key)) {
      return;
    }
    headlineSeen.add(key);
    headlines.push(trimmed);
  };

  const recentEvents = worldState.chronicle.events.slice(Math.max(0, lastDigestChronicleCount));
  const sourceEvents =
    recentEvents.length > 0 ? recentEvents : worldState.chronicle.events.slice(-maxHeadlines);

  for (let i = sourceEvents.length - 1; i >= 0; i -= 1) {
    const evt = sourceEvents[i];
    if (!evt) {
      continue;
    }
    pushHeadline(`${evt.title}: ${evt.summary}`.slice(0, 160));
    if (evt.locationId !== null) {
      locationIdSet.add(evt.locationId);
    }
  }

  for (const threatId of getSortedSafeKeys(worldState.entities.threats)) {
    const threat = getOwn(worldState.entities.threats, threatId);
    if (!threat || threat.status !== 'active') {
      continue;
    }
    pushHeadline(`${threat.name} (Stage ${threat.stage}): ${threat.agenda}`.slice(0, 160));
    if (threat.locationId !== null) {
      locationIdSet.add(threat.locationId);
    }
  }

  for (const rumor of worldState.turnEvents.rumors) {
    pushHeadline(rumor.slice(0, 160));
  }

  if (headlines.length === 0) {
    pushHeadline(`Day ${worldState.clocks.day} Bulletin: All sectors report routine activity.`);
  }

  const locationIds = [...locationIdSet].sort(compareIdsDeterministic);
  const editionNumber = existingEditions.length + 1;
  const edition: DigestEdition = {
    id: `digest-day-${worldState.clocks.day}-e${editionNumber}`,
    day: worldState.clocks.day,
    inGameDate: worldState.clocks.inGameDate,
    masthead,
    headlines,
    locationIds,
  };

  const patches: PatchOperation[] = [
    {
      op: 'push',
      path: 'chronicle.digestEditions',
      value: edition,
    },
    {
      op: 'set',
      path: 'counters.lastDigestDay',
      value: worldState.clocks.day,
    },
    {
      op: 'set',
      path: 'counters.lastDigestChronicleCount',
      value: worldState.chronicle.events.length,
    },
    {
      op: 'push',
      path: 'turnEvents.systemNotices',
      value: `Newsroom published ${edition.masthead} (Day ${edition.day}, ${edition.headlines.length} headline(s)).`,
    },
  ];

  return {
    published: true,
    edition,
    patches,
  };
}
