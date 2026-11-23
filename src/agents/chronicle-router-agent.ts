import type { ResolvedControlRoomConfig } from '../config/control-room-config.js';
import { type ValidationError, validationError } from '../core/errors.js';
import type { ModelGateway } from '../gateway/model-gateway.js';
import type { ChatMessage } from '../gateway/types.js';
import { type CadenceContext, isCadenceDue } from '../schema/dynamic-schema-compiler.js';
import type { GameSystemModule } from '../schema/tracker-module.js';
import type { PatchBatch, PatchOperation } from '../state/patch.js';
import { slugifyLocationName } from '../state/spatial-topology.js';
import { CHRONICLE_CATEGORIES, type ChronicleCategory, type WorldState } from '../state/world-state.js';

export interface RunChronicleRouterParams {
  state: WorldState;
  config: ResolvedControlRoomConfig;
  turnContext: CadenceContext;
  recentExchangeText: string;
  gateway: ModelGateway;
  signal?: AbortSignal;
}

export interface RunChronicleRouterResult {
  skippedByCadence: boolean;
  proposedBatch: PatchBatch | null;
  warnings: ValidationError[];
}

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const CHRONICLE_MODULE_IDS: ReadonlySet<string> = new Set(['chronicle', 'episodic_chronicle']);
const VALID_CATEGORIES: ReadonlySet<string> = new Set(CHRONICLE_CATEGORIES);

const CHRONICLE_ROUTER_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['category', 'title', 'summary', 'keywords', 'involvedEntityIds'],
  properties: {
    shouldRecord: { type: 'boolean' },
    category: { type: 'string', enum: ['event', 'quest', 'world'] },
    title: { type: 'string', maxLength: 120 },
    summary: { type: 'string', maxLength: 600 },
    keywords: { type: 'array', items: { type: 'string' }, maxItems: 12 },
    involvedEntityIds: { type: 'array', items: { type: 'string' }, maxItems: 16 },
    emergentLocationName: { type: 'string', maxLength: 120 },
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

function getOwn(record: Record<string, unknown>, key: string): unknown {
  if (!isSafeKey(key) || !Object.hasOwn(record, key)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(record, key)?.value;
}

function findChronicleModule(config: ResolvedControlRoomConfig): GameSystemModule | undefined {
  for (const mod of config.gameSystems) {
    if (CHRONICLE_MODULE_IDS.has(mod.id)) {
      return mod;
    }
  }
  return undefined;
}

function normalizeStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      continue;
    }
    const trimmed = item.trim();
    if (trimmed.length === 0 || !isSafeKey(trimmed) || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function buildChronicleMessages(
  state: WorldState,
  recentExchangeText: string
): ChatMessage[] {
  const knownCharacters = Object.keys(state.entities.characters).filter(isSafeKey).sort();
  const knownFactions = Object.keys(state.entities.factions).filter(isSafeKey).sort();
  const knownThreats = Object.keys(state.entities.threats).filter(isSafeKey).sort();

  return [
    {
      role: 'system',
      content: [
        'You are the chronicle router micro-agent. Extract a concise milestone entry if a lasting event occurred.',
        'Respond ONLY with JSON matching the schema.',
        `Spatial mode: ${state.capabilities.spatialMode}`,
        `Current location: ${state.scene.location} (locationId=${state.scene.locationId ?? 'none'})`,
        `Known characters: ${knownCharacters.join(', ') || 'none'}`,
        `Known factions: ${knownFactions.join(', ') || 'none'}`,
        `Known threats: ${knownThreats.join(', ') || 'none'}`,
      ].join('\n'),
    },
    {
      role: 'user',
      content: recentExchangeText,
    },
  ];
}

/**
 * Extract an episodic chronicle milestone (and optional emergent location visit) when the
 * chronicle capability and cadence policy are active and due.
 */
export async function runChronicleRouter(
  params: RunChronicleRouterParams
): Promise<RunChronicleRouterResult> {
  if (!params.state.capabilities.chronicle || !params.config.capabilities.chronicle) {
    return {
      skippedByCadence: true,
      proposedBatch: null,
      warnings: [],
    };
  }

  const chronicleMod = findChronicleModule(params.config);
  if (chronicleMod !== undefined) {
    if (!chronicleMod.enabled || !isCadenceDue(chronicleMod.cadence, params.turnContext)) {
      return {
        skippedByCadence: true,
        proposedBatch: null,
        warnings: [],
      };
    }
  }

  const gatewayRes = await params.gateway.generateStructured<unknown>({
    role: 'chronicle_router',
    messages: buildChronicleMessages(params.state, params.recentExchangeText),
    schema: CHRONICLE_ROUTER_SCHEMA,
    schemaName: 'chronicle_router_milestone',
    signal: params.signal,
  });

  if (!gatewayRes.ok) {
    return {
      skippedByCadence: false,
      proposedBatch: null,
      warnings: [...gatewayRes.error],
    };
  }

  const data = gatewayRes.value.data;
  if (!isPlainRecord(data)) {
    return {
      skippedByCadence: false,
      proposedBatch: null,
      warnings: [
        validationError('response', 'INVALID_TYPE', 'Chronicle router response was not an object'),
      ],
    };
  }

  const shouldRecord = getOwn(data, 'shouldRecord');
  if (shouldRecord === false) {
    return {
      skippedByCadence: false,
      proposedBatch: null,
      warnings: [],
    };
  }

  const rawCategory = getOwn(data, 'category');
  const rawTitle = getOwn(data, 'title');
  const rawSummary = getOwn(data, 'summary');

  if (
    typeof rawCategory !== 'string' ||
    !VALID_CATEGORIES.has(rawCategory) ||
    typeof rawTitle !== 'string' ||
    rawTitle.trim().length === 0 ||
    typeof rawSummary !== 'string' ||
    rawSummary.trim().length === 0
  ) {
    return {
      skippedByCadence: false,
      proposedBatch: null,
      warnings: [
        validationError(
          'chronicle',
          'INVALID_CHRONICLE_MILESTONE',
          'Chronicle router output lacked valid category, title, or summary'
        ),
      ],
    };
  }

  const category = rawCategory as ChronicleCategory;
  const title = rawTitle.trim();
  const summary = rawSummary.trim();
  const keywords = normalizeStringList(getOwn(data, 'keywords'));
  const involvedEntityIds = normalizeStringList(getOwn(data, 'involvedEntityIds'));
  const rawEmergentName = getOwn(data, 'emergentLocationName');

  const operations: PatchOperation[] = [];
  let entryLocationId: string | null = params.state.scene.locationId;

  if (
    params.state.capabilities.spatialMode === 'emergent' &&
    typeof rawEmergentName === 'string' &&
    rawEmergentName.trim().length > 0
  ) {
    const trimmedLocName = rawEmergentName.trim();
    operations.push({
      op: 'emergent_location_visit',
      locationName: trimmedLocName,
    });
    entryLocationId = slugifyLocationName(trimmedLocName);
  }

  operations.push({
    op: 'chronicle_append',
    entry: {
      category,
      title,
      summary,
      locationId: entryLocationId,
      involvedEntityIds,
      keywords,
    },
  });

  return {
    skippedByCadence: false,
    proposedBatch: {
      eventId: `chronicle-turn-${params.turnContext.turn}`,
      source: 'tracker',
      operations,
      reason: 'Chronicle router milestone extraction',
    },
    warnings: [],
  };
}
