import type { GameSystemModule, SystemPack } from '../schema/tracker-module.js';
import {
  ALL_PAYLOAD_GROUP_IDS,
  type ControlRoomLayer,
  type PayloadGroupId,
  type ResolvedControlRoomConfig,
  applyControlRoomLayer,
  createStockBaselineConfig,
} from './control-room-config.js';

export type ImpactBadge = 'matches_stock' | 'from_cartridge' | 'user_customized';

export interface SectionDiffEntry {
  readonly sectionId: string;
  readonly badge: ImpactBadge;
  readonly liveFingerprint: string;
  readonly stockFingerprint: string | undefined;
  readonly cartridgeFingerprint: string | undefined;
  readonly unlocked: boolean;
  readonly hasOverride: boolean;
}

export interface ModuleDiffEntry {
  readonly moduleId: string;
  readonly badge: ImpactBadge;
  readonly liveFingerprint: string | undefined;
  readonly stockFingerprint: string | undefined;
  readonly cartridgeFingerprint: string | undefined;
}

export interface ControlRoomDiffReport {
  readonly overallBadge: ImpactBadge;
  readonly promptSections: Record<string, SectionDiffEntry>;
  readonly gameSystems: Record<string, ModuleDiffEntry>;
  readonly groupBadges: Record<PayloadGroupId, ImpactBadge>;
  readonly fingerprints: {
    readonly stock: string;
    readonly cartridge: string | undefined;
    readonly resolved: string;
  };
}

const FNV_OFFSET_BASIS_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;
const UTF8_ENCODER = new TextEncoder();

function compareStringsDeterministic(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

/**
 * Normalize text for format-neutral diffing and fingerprinting:
 * converts CRLF / CR line endings to LF and strips trailing horizontal
 * whitespace per line as well as trailing whitespace/newlines at EOF.
 */
export function normalizeDiffText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .trimEnd();
}

function canonicalSerialize(value: unknown, seen: WeakSet<object>): string {
  if (value === undefined) {
    return '"__undefined__"';
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    if (Object.is(value, -0)) {
      return '0';
    }
    if (Number.isNaN(value)) {
      return '"__NaN__"';
    }
    if (value === Infinity) {
      return '"__Infinity__"';
    }
    if (value === -Infinity) {
      return '"__-Infinity__"';
    }
    return String(value);
  }
  if (typeof value === 'bigint') {
    return `"__bigint__:${value.toString()}"`;
  }
  if (typeof value === 'string') {
    return JSON.stringify(normalizeDiffText(value));
  }
  if (typeof value === 'symbol') {
    return JSON.stringify(`__symbol__:${String(value)}`);
  }
  if (typeof value === 'function') {
    return '"__function__"';
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '"__circular__"';
    }
    seen.add(value);
    try {
      if (value instanceof Date) {
        return JSON.stringify(`__date__:${Number.isNaN(value.getTime()) ? 'invalid' : value.toISOString()}`);
      }
      if (value instanceof RegExp) {
        return JSON.stringify(`__regexp__:${value.source}/${value.flags}`);
      }
      if (Array.isArray(value)) {
        const items = value.map((item) => canonicalSerialize(item, seen));
        return `[${items.join(',')}]`;
      }
      if (value instanceof Set) {
        const serializedItems = Array.from(value, (item) => canonicalSerialize(item, seen)).sort(
          compareStringsDeterministic
        );
        return `["__set__",${serializedItems.join(',')}]`;
      }
      if (value instanceof Map) {
        const entries = Array.from(value.entries())
          .map(([k, v]) => [canonicalSerialize(k, seen), canonicalSerialize(v, seen)] as const)
          .sort((a, b) => compareStringsDeterministic(a[0], b[0]));
        const formatted = entries.map(([k, v]) => `[${k},${v}]`);
        return `["__map__",${formatted.join(',')}]`;
      }

      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort(compareStringsDeterministic);
      const parts: string[] = [];
      for (const key of keys) {
        const propVal = record[key];
        if (propVal === undefined || typeof propVal === 'function' || typeof propVal === 'symbol') {
          continue;
        }
        parts.push(`${JSON.stringify(key)}:${canonicalSerialize(propVal, seen)}`);
      }
      return `{${parts.join(',')}}`;
    } finally {
      seen.delete(value);
    }
  }

  return JSON.stringify(String(value));
}

function fnv1a64Hex(input: string): string {
  const bytes = UTF8_ENCODER.encode(input);
  let hash = FNV_OFFSET_BASIS_64;
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i];
    if (byte !== undefined) {
      hash ^= BigInt(byte);
      hash = (hash * FNV_PRIME_64) & MASK_64;
    }
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * Compute a deterministic, format-neutral 64-bit FNV-1a fingerprint over any JSON/text value.
 * Object keys are sorted lexicographically and strings normalize CRLF -> LF with trailing
 * whitespace trimmed.
 */
export function computeNormalizedFingerprint(value: unknown): string {
  const canonical = canonicalSerialize(value, new WeakSet<object>());
  return fnv1a64Hex(canonical);
}

/**
 * Classify a prompt section's live content against Stock and Cartridge baselines.
 */
export function getSectionImpactBadge(
  _sectionId: string,
  liveText: string,
  stockText: string | undefined,
  cartridgeText: string | undefined
): ImpactBadge {
  const liveFp = computeNormalizedFingerprint(liveText);
  const stockFp = stockText !== undefined ? computeNormalizedFingerprint(stockText) : undefined;
  const cartridgeFp =
    cartridgeText !== undefined ? computeNormalizedFingerprint(cartridgeText) : undefined;

  if (stockFp !== undefined && liveFp === stockFp) {
    return 'matches_stock';
  }
  if (cartridgeFp !== undefined && liveFp === cartridgeFp) {
    return 'from_cartridge';
  }
  if (stockFp === undefined && cartridgeFp === undefined && normalizeDiffText(liveText) === '') {
    return 'matches_stock';
  }
  return 'user_customized';
}

function resolveBaselineBadge(
  liveFp: string | undefined,
  stockFp: string | undefined,
  cartridgeFp: string | undefined,
  hasCartridge: boolean
): ImpactBadge {
  if (liveFp === stockFp) {
    return 'matches_stock';
  }
  if (hasCartridge && liveFp === cartridgeFp) {
    return 'from_cartridge';
  }
  return 'user_customized';
}

function extractGroupSnapshot(
  config: Readonly<ResolvedControlRoomConfig>,
  groupId: PayloadGroupId
): unknown {
  switch (groupId) {
    case 'capabilities':
      return config.capabilities;
    case 'characterSections':
      return {
        pcCoreSections: config.pcCoreSections,
        npcCoreSections: config.npcCoreSections,
      };
    case 'gameSystems':
      return {
        gameSystems: config.gameSystems,
        blockOrder: config.blockOrder,
      };
    case 'promptSections':
      return {
        basePrompts: config.basePrompts,
        unlockedPromptSections: config.unlockedPromptSections,
        syspromptSectionOrder: config.syspromptSectionOrder,
      };
    case 'combatRules':
      return config.combatRules;
    case 'tuningDials':
      return config.tuningDials;
  }
}

function collectSectionIds(
  stockBaseline: Readonly<ResolvedControlRoomConfig>,
  cartridgeBaseline: Readonly<ResolvedControlRoomConfig> | undefined,
  resolved: Readonly<ResolvedControlRoomConfig>,
  cartridgeLayer?: Readonly<ControlRoomLayer>
): string[] {
  const ids = new Set<string>([
    ...stockBaseline.syspromptSectionOrder,
    ...Object.keys(stockBaseline.basePrompts),
    ...resolved.syspromptSectionOrder,
    ...Object.keys(resolved.basePrompts),
    ...Object.keys(resolved.unlockedPromptSections),
  ]);
  if (cartridgeBaseline !== undefined) {
    for (const id of cartridgeBaseline.syspromptSectionOrder) {
      ids.add(id);
    }
    for (const id of Object.keys(cartridgeBaseline.basePrompts)) {
      ids.add(id);
    }
  }
  if (cartridgeLayer?.basePrompts !== undefined) {
    for (const id of Object.keys(cartridgeLayer.basePrompts)) {
      ids.add(id);
    }
  }
  if (cartridgeLayer?.unlockedPromptSections !== undefined) {
    for (const id of Object.keys(cartridgeLayer.unlockedPromptSections)) {
      ids.add(id);
    }
  }
  return Array.from(ids).sort(compareStringsDeterministic);
}

function collectModuleIds(
  stockBaseline: Readonly<ResolvedControlRoomConfig>,
  cartridgeBaseline: Readonly<ResolvedControlRoomConfig> | undefined,
  resolved: Readonly<ResolvedControlRoomConfig>
): string[] {
  const ids = new Set<string>();
  for (const mod of stockBaseline.gameSystems) {
    ids.add(mod.id);
  }
  if (cartridgeBaseline !== undefined) {
    for (const mod of cartridgeBaseline.gameSystems) {
      ids.add(mod.id);
    }
  }
  for (const mod of resolved.gameSystems) {
    ids.add(mod.id);
  }
  return Array.from(ids).sort(compareStringsDeterministic);
}

function indexModulesById(
  modules: readonly GameSystemModule[]
): Map<string, GameSystemModule> {
  const map = new Map<string, GameSystemModule>();
  for (const mod of modules) {
    map.set(mod.id, mod);
  }
  return map;
}

/**
 * Compute a full diff and impact-badge report comparing a resolved Control Room config
 * against Stock and optional Cartridge baselines.
 */
export function computeControlRoomDiffReport(
  resolved: Readonly<ResolvedControlRoomConfig>,
  stockPack: SystemPack,
  cartridgeLayer?: Readonly<ControlRoomLayer>
): ControlRoomDiffReport {
  const hasCartridge = cartridgeLayer !== undefined;
  const stockBaseline = createStockBaselineConfig(stockPack);
  const cartridgeBaseline = hasCartridge
    ? applyControlRoomLayer(stockBaseline, cartridgeLayer)
    : undefined;

  const promptSections: Record<string, SectionDiffEntry> = {};
  const sectionIds = collectSectionIds(stockBaseline, cartridgeBaseline, resolved, cartridgeLayer);

  let anyCustomized = false;
  let anyFromCartridge = false;

  const trackBadge = (badge: ImpactBadge): void => {
    if (badge === 'user_customized') {
      anyCustomized = true;
    } else if (badge === 'from_cartridge') {
      anyFromCartridge = true;
    }
  };

  for (const sectionId of sectionIds) {
    const stockText = stockBaseline.basePrompts[sectionId];
    const cartridgeText =
      cartridgeBaseline !== undefined ? cartridgeBaseline.basePrompts[sectionId] : undefined;
    const liveHasOverride = Object.hasOwn(resolved.basePrompts, sectionId);
    const liveText = resolved.basePrompts[sectionId] ?? '';

    const badge = getSectionImpactBadge(sectionId, liveText, stockText, cartridgeText);
    trackBadge(badge);

    promptSections[sectionId] = {
      sectionId,
      badge,
      liveFingerprint: computeNormalizedFingerprint(liveText),
      stockFingerprint:
        stockText !== undefined ? computeNormalizedFingerprint(stockText) : undefined,
      cartridgeFingerprint:
        cartridgeText !== undefined ? computeNormalizedFingerprint(cartridgeText) : undefined,
      unlocked: Boolean(resolved.unlockedPromptSections[sectionId]),
      hasOverride: liveHasOverride,
    };
  }

  const gameSystems: Record<string, ModuleDiffEntry> = {};
  const stockModMap = indexModulesById(stockBaseline.gameSystems);
  const cartridgeModMap =
    cartridgeBaseline !== undefined
      ? indexModulesById(cartridgeBaseline.gameSystems)
      : undefined;
  const resolvedModMap = indexModulesById(resolved.gameSystems);

  const moduleIds = collectModuleIds(stockBaseline, cartridgeBaseline, resolved);
  for (const moduleId of moduleIds) {
    const stockMod = stockModMap.get(moduleId);
    const cartridgeMod = cartridgeModMap?.get(moduleId);
    const liveMod = resolvedModMap.get(moduleId);

    const stockFp =
      stockMod !== undefined ? computeNormalizedFingerprint(stockMod) : undefined;
    const cartridgeFp =
      cartridgeMod !== undefined ? computeNormalizedFingerprint(cartridgeMod) : undefined;
    const liveFp = liveMod !== undefined ? computeNormalizedFingerprint(liveMod) : undefined;

    const badge = resolveBaselineBadge(liveFp, stockFp, cartridgeFp, hasCartridge);
    trackBadge(badge);

    gameSystems[moduleId] = {
      moduleId,
      badge,
      liveFingerprint: liveFp,
      stockFingerprint: stockFp,
      cartridgeFingerprint: cartridgeFp,
    };
  }

  const groupBadges = {} as Record<PayloadGroupId, ImpactBadge>;
  for (const groupId of ALL_PAYLOAD_GROUP_IDS) {
    const stockFp = computeNormalizedFingerprint(extractGroupSnapshot(stockBaseline, groupId));
    const cartridgeFp =
      cartridgeBaseline !== undefined
        ? computeNormalizedFingerprint(extractGroupSnapshot(cartridgeBaseline, groupId))
        : undefined;
    const liveFp = computeNormalizedFingerprint(extractGroupSnapshot(resolved, groupId));

    const badge = resolveBaselineBadge(liveFp, stockFp, cartridgeFp, hasCartridge);
    trackBadge(badge);
    groupBadges[groupId] = badge;
  }

  const overallBadge: ImpactBadge = anyCustomized
    ? 'user_customized'
    : anyFromCartridge
      ? 'from_cartridge'
      : 'matches_stock';

  return {
    overallBadge,
    promptSections,
    gameSystems,
    groupBadges,
    fingerprints: {
      stock: computeNormalizedFingerprint(stockBaseline),
      cartridge:
        cartridgeBaseline !== undefined
          ? computeNormalizedFingerprint(cartridgeBaseline)
          : undefined,
      resolved: computeNormalizedFingerprint(resolved),
    },
  };
}
