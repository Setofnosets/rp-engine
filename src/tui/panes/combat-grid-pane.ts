import {
  type CombatState,
  type CombatantState,
  getSafeCombatant,
  getSafeCombatantIds,
} from '../../combat/action-validator.js';
import { getTileAt } from '../../combat/spatial-math.js';
import {
  compareStringsDeterministic,
  renderMeterBar,
  truncateLine,
  wrapText,
} from './layout-helpers.js';

function getCombatantGlyph(combatant: CombatantState): string {
  if (combatant.team === 'ally') {
    return '@';
  }
  if (combatant.team === 'enemy') {
    return 'E';
  }
  return 'N';
}

function getTileGlyph(combatState: CombatState, x: number, y: number): string {
  const grid = combatState.grid;
  if (grid === null) {
    return '.';
  }
  const tile = getTileAt(grid, { x, y });
  if (tile === null || tile === undefined) {
    return ' ';
  }
  if (!tile.passable || tile.blocksLos) {
    return '#';
  }
  if (tile.cover === 'half' || tile.cover === 'full') {
    return '+';
  }
  if (tile.hazard !== 'none') {
    return '~';
  }
  return '.';
}

function buildCombatantListOrdered(combatState: CombatState): CombatantState[] {
  const ordered: CombatantState[] = [];
  const seen = new Set<string>();

  for (const id of combatState.initiativeOrder) {
    const c = getSafeCombatant(combatState, id);
    if (c !== undefined && !seen.has(id)) {
      seen.add(id);
      ordered.push(c);
    }
  }

  const remainingIds = getSafeCombatantIds(combatState).sort(compareStringsDeterministic);
  for (const id of remainingIds) {
    if (!seen.has(id)) {
      const c = getSafeCombatant(combatState, id);
      if (c !== undefined) {
        seen.add(id);
        ordered.push(c);
      }
    }
  }

  return ordered;
}

/**
 * Render tactical ASCII combat map (`#` wall, `+` cover, `~` hazard, `.` open, `@` ally, `E` enemy)
 * with coordinate axes, initiative turn strip, and HP/willpower bars, or traditional
 * theater-of-the-mind combatant list when `mode === 'traditional'`.
 */
export function renderCombatGridPane(combatState: CombatState, width: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const lines: string[] = [];

  const statusTag = combatState.active ? 'ACTIVE' : 'ENDED';
  const turnStylePart =
    combatState.mode === 'traditional' && combatState.turnStyle !== undefined
      ? ` | TurnStyle: ${combatState.turnStyle}`
      : '';
  lines.push(
    truncateLine(
      `COMBAT [${statusTag}] | Round ${combatState.round} | Mode: ${combatState.mode}${turnStylePart}`,
      safeWidth
    )
  );

  const initiativeParts: string[] = [];
  for (let i = 0; i < combatState.initiativeOrder.length; i += 1) {
    const id = combatState.initiativeOrder[i];
    if (id === undefined) {
      continue;
    }
    const c = getSafeCombatant(combatState, id);
    const label = c !== undefined ? c.name : id;
    const activePrefix = i === combatState.turnIndex ? '>' : '';
    const deadSuffix = c !== undefined && !c.alive ? '(KO)' : '';
    initiativeParts.push(`${activePrefix}${label}${deadSuffix}`);
  }

  if (initiativeParts.length > 0) {
    for (const wrapped of wrapText(`Turn Order: ${initiativeParts.join(' -> ')}`, safeWidth)) {
      lines.push(wrapped);
    }
  }

  if (combatState.mode === 'tactical_grid' && combatState.grid !== null) {
    const grid = combatState.grid;
    const unitByCoord = new Map<string, string>();
    for (const c of buildCombatantListOrdered(combatState)) {
      if (!c.alive) {
        continue;
      }
      const key = `${c.coord.x},${c.coord.y}`;
      const glyph = getCombatantGlyph(c);
      const existing = unitByCoord.get(key);
      if (existing === undefined || glyph === '@') {
        unitByCoord.set(key, glyph);
      }
    }

    const colHeader = Array.from({ length: grid.width }, (_, x) => String(x % 10)).join(' ');
    lines.push(truncateLine(`    ${colHeader}`, safeWidth));
    lines.push(truncateLine(`   +${'-'.repeat(Math.max(1, grid.width * 2 - 1))}+`, safeWidth));

    for (let y = 0; y < grid.height; y += 1) {
      const cells: string[] = [];
      for (let x = 0; x < grid.width; x += 1) {
        const unitGlyph = unitByCoord.get(`${x},${y}`);
        cells.push(unitGlyph ?? getTileGlyph(combatState, x, y));
      }
      const rowLabel = String(y).padStart(2, ' ');
      lines.push(truncateLine(`${rowLabel} |${cells.join(' ')}|`, safeWidth));
    }

    lines.push(truncateLine(`   +${'-'.repeat(Math.max(1, grid.width * 2 - 1))}+`, safeWidth));
    lines.push(
      truncateLine('Legend: @=Ally E=Enemy #=Wall +=Cover ~=Hazard .=Open', safeWidth)
    );

    const hazardParts: string[] = [];
    const coverParts: string[] = [];
    for (let y = 0; y < grid.height; y += 1) {
      for (let x = 0; x < grid.width; x += 1) {
        const tile = getTileAt(grid, { x, y });
        if (tile === null || tile === undefined) {
          continue;
        }
        if (tile.hazard !== 'none') {
          hazardParts.push(`(${x},${y})=${tile.hazard}`);
        }
        if (tile.cover !== 'none') {
          const maybeCoverHp = (tile as { coverHp?: unknown }).coverHp;
          if (typeof maybeCoverHp === 'number' && Number.isFinite(maybeCoverHp)) {
            coverParts.push(`(${x},${y})=${tile.cover}(${maybeCoverHp}HP)`);
          }
        }
      }
    }
    if (hazardParts.length > 0) {
      for (const wrapped of wrapText(`Hazards: ${hazardParts.join(', ')}`, safeWidth)) {
        lines.push(wrapped);
      }
    }
    if (coverParts.length > 0) {
      for (const wrapped of wrapText(`Cover HP: ${coverParts.join(', ')}`, safeWidth)) {
        lines.push(wrapped);
      }
    }
  } else {
    const styleLabel = combatState.turnStyle ?? 'phased';
    lines.push(truncateLine(`Theater of the Mind (Traditional Mode | ${styleLabel})`, safeWidth));
  }

  const combatants = buildCombatantListOrdered(combatState);
  for (const c of combatants) {
    const glyph = getCombatantGlyph(c);
    const activeId = combatState.initiativeOrder[combatState.turnIndex];
    const marker = c.id === activeId ? '*' : ' ';
    const stateLabel = c.alive ? '' : ' [KO]';
    const rowTag =
      combatState.mode === 'traditional' || c.formationRow !== undefined
        ? ` [${(c.formationRow ?? 'front').toUpperCase()}]`
        : '';
    const summonTag = c.isSummon === true ? ' [SUMMON]' : '';
    const transformTag =
      c.activeTransform !== undefined
        ? ` [FORM:${c.activeTransform.loadoutId}${
            c.activeTransform.tempHp > 0 ? ` +${c.activeTransform.tempHp}THP` : ''
          }]`
        : '';
    const wpLabel = `WP ${c.willpower}/${c.maxWillpower}`;
    const header = truncateLine(
      `${marker}${glyph} ${c.name} (${c.team})${rowTag}${summonTag}${transformTag}${stateLabel} | AC ${c.ac} | ${wpLabel}`,
      safeWidth
    );
    lines.push(header);
    lines.push(renderMeterBar('  HP', c.hp, c.maxHp, safeWidth));
  }

  return lines;
}
