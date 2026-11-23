import type { BeatLedgerState } from '../../beats/beat-ledger.js';
import type { ResolvedControlRoomConfig } from '../../config/control-room-config.js';
import { formatClockDisplay } from '../../core/world-clock.js';
import type { DynamicFieldSpec, GameSystemModule } from '../../schema/tracker-module.js';
import type { WorldState } from '../../state/world-state.js';
import {
  compareStringsDeterministic,
  getSafeOwn,
  isSafeRecordKey,
  renderMeterBar,
  truncateLine,
  wrapText,
} from './layout-helpers.js';

export interface RenderDynamicHudPaneParams {
  readonly state: WorldState;
  readonly config: ResolvedControlRoomConfig;
  readonly beatLedger: BeatLedgerState;
  readonly pendingConfirmationsCount: number;
  readonly width: number;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function resolveModuleFieldValue(
  state: WorldState,
  module: GameSystemModule,
  fieldKey: string,
  spec: DynamicFieldSpec
): unknown {
  const sources: Array<Record<string, unknown>> =
    module.target === 'player'
      ? [state.player.customFields, state.customFields]
      : [state.customFields, state.player.customFields];

  for (const src of sources) {
    const nested = getSafeOwn(src, module.id);
    if (isPlainRecord(nested)) {
      const val = getSafeOwn(nested, fieldKey);
      if (val !== undefined) {
        return val;
      }
    }
    const direct = getSafeOwn(src, fieldKey);
    if (direct !== undefined) {
      return direct;
    }
  }

  return spec.default;
}

function formatModuleLines(
  state: WorldState,
  module: GameSystemModule,
  width: number
): string[] {
  const lines: string[] = [];
  const fieldEntries = Object.entries(module.fields).filter(([key]) => isSafeRecordKey(key));

  if (fieldEntries.length === 0) {
    return lines;
  }

  if (module.ui.widget === 'bar') {
    let renderedBar = false;
    const extras: string[] = [];
    for (const [key, spec] of fieldEntries) {
      const val = resolveModuleFieldValue(state, module, key, spec);
      if (spec.type === 'meter' && typeof val === 'number' && Number.isFinite(val)) {
        lines.push(renderMeterBar(`${module.name}:${key}`, val, spec.max, width, spec.min));
        renderedBar = true;
      } else {
        extras.push(`${key}=${String(val)}`);
      }
    }
    if (!renderedBar || extras.length > 0) {
      const summary = `${module.name}: ${extras.join(' | ')}`;
      if (extras.length > 0) {
        lines.push(truncateLine(summary, width));
      }
    }
    return lines;
  }

  const parts: string[] = [];
  for (const [key, spec] of fieldEntries) {
    const val = resolveModuleFieldValue(state, module, key, spec);
    if (Array.isArray(val)) {
      parts.push(`${key}=[${val.map(String).join(', ')}]`);
    } else {
      parts.push(`${key}=${String(val)}`);
    }
  }
  for (const wrapped of wrapText(`[${module.name}] ${parts.join(' | ')}`, width)) {
    lines.push(wrapped);
  }
  return lines;
}

/**
 * Render the Dynamic HUD adapting strictly to enabled modules and capabilities:
 * - Dual Clock only when `capabilities.clocks !== 'disabled'`
 * - Progression/RPG stats only when `capabilities.progression !== 'disabled'`
 * - Active `pcCoreSections` and enabled `GameSystemModule` widgets
 * - Active `LIVE` gate objective when beats are active
 * - Faction/threat meters only when `capabilities.factions === true`
 */
export function renderDynamicHudPane(params: RenderDynamicHudPaneParams): string[] {
  const { state, config, beatLedger, pendingConfirmationsCount } = params;
  const width = Math.max(1, Math.floor(params.width));
  const caps = config.capabilities;
  const lines: string[] = [];

  const locationLabel = state.scene.location.trim().length > 0 ? state.scene.location : 'Scene';
  const moodLabel = state.scene.mood.trim().length > 0 ? state.scene.mood : 'neutral';
  lines.push(
    truncateLine(`Loc: ${locationLabel} | Mood: ${moodLabel} | Turn: ${state.meta.turn}`, width)
  );

  if (caps.clocks !== 'disabled') {
    const clockStr = formatClockDisplay(state.clocks, {
      use24hTime: config.tuningDials.use24hTime,
      useDdMmYyFormat: config.tuningDials.useDdMmYyFormat,
    });
    lines.push(truncateLine(`Clock: ${clockStr} | StoryTurn: ${state.clocks.storyTurn}`, width));
  }

  if (caps.progression !== 'disabled' && state.player.progression !== undefined) {
    const prog = state.player.progression;
    const classPart = prog.className ? ` ${prog.className}` : '';
    lines.push(truncateLine(`PC: ${state.player.name} (Lv ${prog.level}${classPart}, XP ${prog.xp})`, width));
  }

  if (state.player.resources !== undefined) {
    const resKeys = Object.keys(state.player.resources).sort(compareStringsDeterministic);
    for (const key of resKeys) {
      const pool = getSafeOwn(state.player.resources, key);
      if (pool !== undefined && Number.isFinite(pool.current) && Number.isFinite(pool.max)) {
        lines.push(renderMeterBar(key.toUpperCase(), pool.current, pool.max, width));
      }
    }
  }

  for (const section of config.pcCoreSections) {
    const secVal = getSafeOwn(state.player.sections, section.id);
    if (secVal === undefined) {
      continue;
    }
    const text = Array.isArray(secVal) ? secVal.join(', ') : secVal;
    if (text.trim().length > 0) {
      lines.push(truncateLine(`${section.name}: ${text}`, width));
    }
  }

  const visibleModules = config.gameSystems
    .filter((mod) => mod.enabled && mod.ui.widget !== 'hidden' && mod.id !== 'scene_context')
    .slice()
    .sort((a, b) => {
      if (a.ui.order !== b.ui.order) {
        return a.ui.order - b.ui.order;
      }
      return compareStringsDeterministic(a.id, b.id);
    });

  for (const mod of visibleModules) {
    const modLines = formatModuleLines(state, mod, width);
    lines.push(...modLines);
  }

  if (caps.beats && beatLedger.liveGateId !== null) {
    lines.push(truncateLine(`LIVE Gate: ${beatLedger.liveGateId}`, width));
  }

  if (caps.factions) {
    const factionIds = Object.keys(state.entities.factions).sort(compareStringsDeterministic);
    for (const fid of factionIds) {
      const faction = getSafeOwn(state.entities.factions, fid);
      if (faction !== undefined) {
        lines.push(
          renderMeterBar(`Faction:${faction.name}`, faction.influence, 100, width)
        );
      }
    }

    const threatIds = Object.keys(state.entities.threats).sort(compareStringsDeterministic);
    for (const tid of threatIds) {
      const threat = getSafeOwn(state.entities.threats, tid);
      if (threat !== undefined && threat.status === 'active') {
        lines.push(
          renderMeterBar(`Threat:${threat.name} (S${threat.stage})`, threat.progress, 100, width)
        );
      }
    }
  }

  if (pendingConfirmationsCount > 0) {
    lines.push(
      truncateLine(
        `Pending Confirmations: ${pendingConfirmationsCount} (/confirm or /reject)`,
        width
      )
    );
  }

  return lines;
}
