import type { ResolvedControlRoomConfig } from '../../config/control-room-config.js';
import type { ControlRoomDiffReport, ImpactBadge } from '../../config/prompt-diff.js';
import type { CadencePolicy } from '../../schema/tracker-module.js';
import {
  compareStringsDeterministic,
  getSafeOwn,
  isSafeRecordKey,
  truncateLine,
  wrapText,
} from './layout-helpers.js';

export interface RenderControlRoomPaneParams {
  readonly config: ResolvedControlRoomConfig;
  readonly diffReport?: ControlRoomDiffReport;
  readonly width: number;
}

function formatCadence(cadence: CadencePolicy): string {
  if (typeof cadence === 'string') {
    return cadence;
  }
  return `every ${cadence.everyNTurns}t`;
}

function formatBadgeLabel(badge: ImpactBadge | undefined): string {
  if (badge === 'user_customized') {
    return ' [User Customized]';
  }
  if (badge === 'from_cartridge') {
    return ' [Cartridge]';
  }
  return '';
}

/**
 * Render the Control Room pane displaying the active System Pack, capability toggles,
 * tuning dials (`beatPressure`, etc.), Game Systems (`[ON]/[OFF]`, cadence),
 * and `"User Customized"` badges from the diff report.
 */
export function renderControlRoomPane(params: RenderControlRoomPaneParams): string[] {
  const { config, diffReport } = params;
  const width = Math.max(1, Math.floor(params.width));
  const lines: string[] = [];

  const overallBadge = formatBadgeLabel(diffReport?.overallBadge);
  lines.push(truncateLine(`CONTROL ROOM | Pack: ${config.packName} (${config.packId})${overallBadge}`, width));

  const capBadge = formatBadgeLabel(diffReport?.groupBadges.capabilities);
  lines.push(truncateLine(`Capabilities:${capBadge}`, width));
  const caps = config.capabilities;
  const capSummary = [
    `spatial=${caps.spatialMode}`,
    `combat=${caps.combatMode}`,
    `prog=${caps.progression}`,
    `clocks=${caps.clocks}`,
    `factions=${caps.factions ? 'ON' : 'OFF'}`,
    `beats=${caps.beats ? 'ON' : 'OFF'}`,
    `rel=${caps.relationships ? 'ON' : 'OFF'}`,
    `chronicle=${caps.chronicle ? 'ON' : 'OFF'}`,
  ].join(' | ');
  for (const wrapped of wrapText(`  ${capSummary}`, width)) {
    lines.push(wrapped);
  }

  const dialBadge = formatBadgeLabel(diffReport?.groupBadges.tuningDials);
  lines.push(
    truncateLine(
      `Dials:${dialBadge} beatPressure=${config.tuningDials.beatPressure} | pacing=${config.tuningDials.narrativePacing} | cyoa=${config.tuningDials.cyoaEnabled ? 'ON' : 'OFF'}`,
      width
    )
  );

  const gen = config.generation;
  const customBlockCount =
    config.customPromptBlocks !== undefined
      ? Object.keys(config.customPromptBlocks).filter(isSafeRecordKey).length
      : 0;
  const genParts: string[] = [];
  if (gen?.temperature !== undefined) {
    genParts.push(`temp=${gen.temperature}`);
  }
  if (gen?.maxTokens !== undefined) {
    genParts.push(`maxTokens=${gen.maxTokens}`);
  }
  if (gen?.topP !== undefined) {
    genParts.push(`topP=${gen.topP}`);
  }
  if (gen?.repetitionPenalty !== undefined) {
    genParts.push(`repPen=${gen.repetitionPenalty}`);
  }
  if (gen?.maxContextTokens !== undefined) {
    genParts.push(`maxContext=${gen.maxContextTokens}`);
  }
  const genSummary = genParts.length > 0 ? genParts.join(' | ') : 'defaults';
  const presetTag = gen?.presetName ? ` [${gen.presetName}]` : '';
  const genLine = `Generation:${presetTag} ${genSummary} | ST Blocks: ${customBlockCount}`;
  for (const wrapped of wrapText(genLine, width)) {
    lines.push(wrapped);
  }

  const sysBadge = formatBadgeLabel(diffReport?.groupBadges.gameSystems);
  lines.push(truncateLine(`Game Systems (${config.gameSystems.length}):${sysBadge}`, width));

  const sortedModules = config.gameSystems.slice().sort((a, b) => {
    if (a.ui.order !== b.ui.order) {
      return a.ui.order - b.ui.order;
    }
    return compareStringsDeterministic(a.id, b.id);
  });

  if (sortedModules.length === 0) {
    lines.push('  (No game system modules configured)');
  } else {
    for (const mod of sortedModules) {
      const toggle = mod.enabled ? '[ON]' : '[OFF]';
      const modDiff = diffReport ? getSafeOwn(diffReport.gameSystems, mod.id) : undefined;
      const badge = formatBadgeLabel(modDiff?.badge);
      const entry = `  ${toggle} ${mod.id} (${mod.name}) | ${formatCadence(mod.cadence)}${badge}`;
      lines.push(truncateLine(entry, width));
    }
  }

  if (diffReport !== undefined) {
    const customizedSections = Object.keys(diffReport.promptSections)
      .sort(compareStringsDeterministic)
      .filter((secId) => {
        const entry = getSafeOwn(diffReport.promptSections, secId);
        return entry?.badge === 'user_customized';
      });
    if (customizedSections.length > 0) {
      lines.push(
        truncateLine(`Customized Prompts: ${customizedSections.join(', ')} [User Customized]`, width)
      );
    }
  }

  return lines;
}
