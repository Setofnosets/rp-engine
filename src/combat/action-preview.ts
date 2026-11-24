import { parseDiceNotation } from '../core/dice.js';
import type { ValidationError } from '../core/errors.js';
import {
  type CombatState,
  type CombatantState,
  type ProposedCombatAction,
  areTeamsHostile,
  getOccupiedCoords,
  getOwnNumber,
  getSafeCombatant,
  getSafeCombatantIds,
  isActorRooted,
  isActorStunned,
  isSafeKey,
  validateSingleCombatAction,
} from './action-validator.js';
import { computeCombatVariables, resolveScaledDiceExpression } from './combat-variables.js';
import type { EffectTemplate } from './effect-templates.js';
import type {
  CoverLevel,
  GridCoord,
  TacticalGrid,
  TerrainModificationSpec,
  TileHazard,
} from './grid-types.js';
import { isCriticalNaturalRoll, isFumbleNaturalRoll } from './passives-and-willpower.js';
import type { SkillDefinition, SkillEffectSpec, SkillRegistry } from './skill-registry.js';
import {
  computeHighGroundAttackBonus,
  evaluateLineOfSight,
  getTileAt,
} from './spatial-math.js';
import type { CombatFormLoadout, SummonTemplate } from './summons-and-transforms.js';
import {
  type KnockbackCollisionType,
  resolveTerrainFootprint,
} from './terrain-effects.js';
import { computeTraditionalEffectiveAc, isRangedSkill } from './traditional-theater.js';

export interface HazardWarning {
  readonly coord: GridCoord;
  readonly hazard: TileHazard;
}

export interface ReachableTilePreview {
  readonly coord: GridCoord;
  readonly cost: number;
  readonly path: readonly GridCoord[];
  readonly elevation: number;
  readonly cover: 'none' | 'half' | 'full';
  readonly hazard: TileHazard;
  readonly hazardWarnings: readonly HazardWarning[];
}

export interface ReachableTilesPreviewResult {
  readonly actorId: string;
  readonly tiles: readonly ReachableTilePreview[];
}

export interface DamageRangePreview {
  readonly min: number;
  readonly expected: number;
  readonly max: number;
}

export interface KnockbackPreview {
  readonly direction: GridCoord;
  readonly distance: number;
  readonly path: readonly GridCoord[];
  readonly collisionWarning: KnockbackCollisionType | null;
  readonly collidedCombatantId: string | null;
}

export interface TargetActionPreview {
  readonly targetId: string;
  readonly effectiveAc: number;
  readonly highGroundBonus: number;
  readonly cover: CoverLevel;
  readonly hitProbability: number;
  readonly critProbability: number;
  readonly saveSuccessProbability: number;
  readonly damageRange: DamageRangePreview;
  readonly knockbackPreview?: KnockbackPreview;
}

export interface PreviewCombatActionOptions {
  readonly summons?: Record<string, SummonTemplate>;
  readonly formLoadouts?: Record<string, CombatFormLoadout>;
  readonly effectTemplates?: Record<string, EffectTemplate>;
  readonly fleeDc?: number;
}

export interface CombatActionPreviewResult {
  readonly legal: boolean;
  readonly errors: readonly ValidationError[];
  readonly actionType: ProposedCombatAction['type'];
  readonly actorId: string;
  readonly affectedTargetIds: readonly string[];
  readonly targetPreviews: readonly TargetActionPreview[];
  readonly terrainModificationFootprint: readonly GridCoord[];
  readonly summonSpawnCoord: GridCoord | null;
  readonly movePreview?: {
    readonly path: readonly GridCoord[];
    readonly cost: number;
    readonly hazardWarnings: readonly HazardWarning[];
  };
}

function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}

function isDamagingOrEffectHazard(hazard: TileHazard): boolean {
  return hazard !== 'none' && hazard !== 'difficult';
}

function getEffectiveStatPure(combatant: CombatantState, statKey: string): number {
  if (!isSafeKey(statKey)) {
    return 0;
  }
  let total = getOwnNumber(combatant.stats, statKey) ?? 0;
  for (const status of combatant.statuses) {
    if (status.remainingTurns > 0 && status.statModifiers !== undefined) {
      total += getOwnNumber(status.statModifiers, statKey) ?? 0;
    }
  }
  return normalizeZero(total);
}

function getStatusAcModifierSum(combatant: CombatantState, excludeGuarded = false): number {
  let total = 0;
  for (const status of combatant.statuses) {
    if (status.remainingTurns > 0 && status.statModifiers !== undefined) {
      if (excludeGuarded && status.id === 'guarded') {
        continue;
      }
      total += getOwnNumber(status.statModifiers, 'ac') ?? 0;
    }
  }
  return normalizeZero(total);
}

function canStepDiagonalPure(grid: TacticalGrid, fromX: number, fromY: number, dx: number, dy: number): boolean {
  if (dx === 0 || dy === 0) {
    return true;
  }
  const adj1 = getTileAt(grid, { x: fromX + dx, y: fromY });
  const adj2 = getTileAt(grid, { x: fromX, y: fromY + dy });
  return (adj1 !== null && adj1.passable) || (adj2 !== null && adj2.passable);
}

/**
 * Purely compute all reachable tiles, shortest path costs, hazard warnings, and
 * cover/elevation metadata for `actorId` within `remainingMovement`.
 * Never mutates `combatState` or advances any PRNG.
 */
export function computeReachableTilesPreview(
  combatState: CombatState,
  actorId: string
): ReachableTilesPreviewResult {
  if (!isSafeKey(actorId)) {
    return { actorId, tiles: [] };
  }
  const actor = getSafeCombatant(combatState, actorId);
  if (
    actor === undefined ||
    !actor.alive ||
    actor.hp <= 0 ||
    isActorStunned(actor) ||
    isActorRooted(actor) ||
    actor.remainingMovement <= 0 ||
    combatState.mode !== 'tactical_grid' ||
    combatState.grid === null
  ) {
    return { actorId, tiles: [] };
  }

  const grid = combatState.grid;
  const maxCost = Math.floor(actor.remainingMovement);
  const occupied = getOccupiedCoords(combatState, actorId);
  const occupiedSet = new Set<string>(occupied.map((c) => `${c.x},${c.y}`));

  const startIdx = actor.coord.y * grid.width + actor.coord.x;
  const totalTiles = grid.width * grid.height;
  const dist = new Array<number>(totalTiles).fill(Number.POSITIVE_INFINITY);
  const parent = new Array<number>(totalTiles).fill(-1);
  const visited = new Array<boolean>(totalTiles).fill(false);

  if (startIdx < 0 || startIdx >= totalTiles) {
    return { actorId, tiles: [] };
  }
  dist[startIdx] = 0;

  // Deterministic Dijkstra over grid indices
  for (let iter = 0; iter < totalTiles; iter += 1) {
    let bestIdx = -1;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < totalTiles; i += 1) {
      if (!visited[i] && dist[i]! < bestDist) {
        bestDist = dist[i]!;
        bestIdx = i;
      }
    }
    if (bestIdx === -1 || bestDist > maxCost) {
      break;
    }
    visited[bestIdx] = true;

    const cx = bestIdx % grid.width;
    const cy = Math.floor(bestIdx / grid.width);

    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dy === 0) {
          continue;
        }
        const nx = cx + dx;
        const ny = cy + dy;
        const nTile = getTileAt(grid, { x: nx, y: ny });
        if (nTile === null || !nTile.passable) {
          continue;
        }
        if (occupiedSet.has(`${nx},${ny}`)) {
          continue;
        }
        if (!canStepDiagonalPure(grid, cx, cy, dx, dy)) {
          continue;
        }
        const stepCost = nTile.hazard === 'difficult' ? 2 : 1;
        const nextDist = bestDist + stepCost;
        const nIdx = ny * grid.width + nx;
        if (nextDist <= maxCost && nextDist < dist[nIdx]!) {
          dist[nIdx] = nextDist;
          parent[nIdx] = bestIdx;
        }
      }
    }
  }

  const tiles: ReachableTilePreview[] = [];
  for (let y = 0; y < grid.height; y += 1) {
    for (let x = 0; x < grid.width; x += 1) {
      const idx = y * grid.width + x;
      if (idx === startIdx || dist[idx]! > maxCost) {
        continue;
      }
      const gridTile = grid.tiles[idx];
      if (gridTile === undefined) {
        continue;
      }
      const pathIndices: number[] = [];
      let cur = idx;
      while (cur !== -1) {
        pathIndices.push(cur);
        cur = parent[cur] ?? -1;
      }
      pathIndices.reverse();

      const path: GridCoord[] = [];
      const hazardWarnings: HazardWarning[] = [];
      for (let p = 0; p < pathIndices.length; p += 1) {
        const pIdx = pathIndices[p]!;
        const px = pIdx % grid.width;
        const py = Math.floor(pIdx / grid.width);
        const coord: GridCoord = { x: normalizeZero(px), y: normalizeZero(py) };
        path.push(coord);
        if (p > 0) {
          const stepTile = grid.tiles[pIdx];
          if (stepTile !== undefined && isDamagingOrEffectHazard(stepTile.hazard)) {
            hazardWarnings.push({ coord, hazard: stepTile.hazard });
          }
        }
      }

      tiles.push({
        coord: { x: normalizeZero(x), y: normalizeZero(y) },
        cost: normalizeZero(dist[idx]!),
        path,
        elevation: normalizeZero(gridTile.elevation),
        cover: gridTile.cover,
        hazard: gridTile.hazard,
        hazardWarnings,
      });
    }
  }

  return { actorId, tiles };
}

function computeEffectDiceStatsPure(
  effect: SkillEffectSpec,
  combatState: CombatState,
  actor: CombatantState,
  target: CombatantState
): {
  normalMin: number;
  normalExpected: number;
  normalMax: number;
  critMin: number;
  critExpected: number;
  critMax: number;
} {
  let diceMin = 0;
  let diceExpected = 0;
  let diceMax = 0;

  if (effect.dice !== undefined) {
    let diceExpr = effect.dice;
    if (diceExpr.includes('@') || effect.scale !== undefined) {
      const vars = computeCombatVariables(combatState, actor, target);
      diceExpr = resolveScaledDiceExpression(diceExpr, vars, effect.scale);
    }
    if (/^[+-]?\d+$/.test(diceExpr.trim())) {
      const fixed = Number.parseInt(diceExpr.trim(), 10);
      diceMin += fixed;
      diceExpected += fixed;
      diceMax += fixed;
    } else {
      const parsed = parseDiceNotation(diceExpr);
      if (parsed.ok) {
        const d = parsed.value;
        const kept = d.keepCount ?? d.diceCount;
        diceMin += kept * 1 + d.modifier;
        diceExpected += kept * ((d.sides + 1) / 2) + d.modifier;
        diceMax += kept * d.sides + d.modifier;
      }
    }
  } else if (effect.scale !== undefined) {
    const vars = computeCombatVariables(combatState, actor, target);
    const rawVal = vars[effect.scale.variable];
    const scaled = Math.trunc(rawVal * effect.scale.per);
    const minVal = effect.scale.min ?? -Infinity;
    const maxVal = effect.scale.max ?? Infinity;
    const bonus = Math.max(minVal, Math.min(maxVal, scaled));
    diceMin += bonus;
    diceExpected += bonus;
    diceMax += bonus;
  }

  const staticBonus =
    (effect.flat ?? 0) +
    (effect.scalingStat !== undefined ? getEffectiveStatPure(actor, effect.scalingStat) : 0);

  return {
    normalMin: Math.max(0, normalizeZero(diceMin + staticBonus)),
    normalExpected: Math.max(0, normalizeZero(diceExpected + staticBonus)),
    normalMax: Math.max(0, normalizeZero(diceMax + staticBonus)),
    critMin: Math.max(0, normalizeZero(diceMin * 2 + staticBonus)),
    critExpected: Math.max(0, normalizeZero(diceExpected * 2 + staticBonus)),
    critMax: Math.max(0, normalizeZero(diceMax * 2 + staticBonus)),
  };
}

function previewKnockbackPure(
  combatState: CombatState,
  casterCoord: GridCoord,
  target: CombatantState,
  distance: number
): KnockbackPreview | undefined {
  if (
    combatState.mode !== 'tactical_grid' ||
    combatState.grid === null ||
    !Number.isFinite(distance) ||
    distance <= 0
  ) {
    return undefined;
  }
  const dx = Math.sign(target.coord.x - casterCoord.x);
  const dy = Math.sign(target.coord.y - casterCoord.y);
  if (dx === 0 && dy === 0) {
    return undefined;
  }

  const occupantByCoord = new Map<string, string>();
  for (const id of getSafeCombatantIds(combatState)) {
    const candidate = getSafeCombatant(combatState, id);
    if (candidate !== undefined && candidate.alive && candidate.hp > 0 && candidate.id !== target.id) {
      occupantByCoord.set(`${candidate.coord.x},${candidate.coord.y}`, candidate.id);
    }
  }

  const path: GridCoord[] = [];
  let curX = target.coord.x;
  let curY = target.coord.y;
  let collisionWarning: KnockbackCollisionType | null = null;
  let collidedCombatantId: string | null = null;
  const steps = Math.floor(distance);

  for (let i = 0; i < steps; i += 1) {
    const nx = curX + dx;
    const ny = curY + dy;
    const tile = getTileAt(combatState.grid, { x: nx, y: ny });
    if (tile === null || !tile.passable) {
      collisionWarning = tile !== null && tile.destructible === true ? 'obstacle' : 'wall';
      break;
    }
    const occupantId = occupantByCoord.get(`${nx},${ny}`);
    if (occupantId !== undefined) {
      collisionWarning = 'combatant';
      collidedCombatantId = occupantId;
      break;
    }
    curX = nx;
    curY = ny;
    path.push({ x: normalizeZero(curX), y: normalizeZero(curY) });
  }

  return {
    direction: { x: normalizeZero(dx), y: normalizeZero(dy) },
    distance: normalizeZero(steps),
    path,
    collisionWarning,
    collidedCombatantId,
  };
}

function previewSummonSpawnCoordPure(
  combatState: CombatState,
  preferred: GridCoord
): GridCoord {
  if (combatState.mode !== 'tactical_grid' || combatState.grid === null) {
    return { x: normalizeZero(preferred.x), y: normalizeZero(preferred.y) };
  }
  const grid = combatState.grid;
  const occupied = new Set<string>(
    getOccupiedCoords(combatState, '').map((c) => `${c.x},${c.y}`)
  );

  const visited = new Set<string>();
  const queue: GridCoord[] = [{ x: preferred.x, y: preferred.y }];
  visited.add(`${preferred.x},${preferred.y}`);

  while (queue.length > 0) {
    const cur = queue.shift()!;
    const tile = getTileAt(grid, cur);
    if (tile !== null && tile.passable && !occupied.has(`${cur.x},${cur.y}`)) {
      return { x: normalizeZero(cur.x), y: normalizeZero(cur.y) };
    }
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dy === 0) {
          continue;
        }
        const nx = cur.x + dx;
        const ny = cur.y + dy;
        const key = `${nx},${ny}`;
        if (!visited.has(key) && getTileAt(grid, { x: nx, y: ny }) !== null) {
          visited.add(key);
          queue.push({ x: nx, y: ny });
        }
      }
    }
  }

  return { x: normalizeZero(preferred.x), y: normalizeZero(preferred.y) };
}

function previewSingleTarget(
  combatState: CombatState,
  actor: CombatantState,
  target: CombatantState,
  skill: SkillDefinition
): TargetActionPreview {
  let effectiveAc = target.ac + getStatusAcModifierSum(target, false);
  let highGroundBonus = 0;
  let cover: CoverLevel = 'none';

  if (combatState.mode === 'tactical_grid' && combatState.grid !== null && target.id !== actor.id) {
    const los = evaluateLineOfSight(combatState.grid, actor.coord, target.coord);
    cover = los.cover;
    if (los.cover === 'half') {
      effectiveAc += 2;
    } else if (los.cover === 'full') {
      effectiveAc += 5;
    }
    highGroundBonus = computeHighGroundAttackBonus(combatState.grid, actor.coord, target.coord);
  } else if (combatState.mode === 'traditional' && target.id !== actor.id) {
    const tradAc = computeTraditionalEffectiveAc(combatState, target.id, isRangedSkill(skill));
    effectiveAc = tradAc + getStatusAcModifierSum(target, true);
  }

  let hitCount = 0;
  let critCount = 0;
  let saveSuccessCount = 0;

  if (skill.hitResolution.kind === 'attack_roll') {
    const attackStat = skill.hitResolution.stat ?? 'str';
    const attackMod = getEffectiveStatPure(actor, attackStat) + highGroundBonus;
    for (let d20 = 1; d20 <= 20; d20 += 1) {
      if (isFumbleNaturalRoll(d20)) {
        continue;
      }
      if (isCriticalNaturalRoll(d20)) {
        hitCount += 1;
        critCount += 1;
      } else if (d20 + attackMod >= effectiveAc) {
        hitCount += 1;
      }
    }
  } else if (skill.hitResolution.kind === 'save') {
    hitCount = 20;
    const saveStat = skill.hitResolution.saveStat ?? 'dex';
    const saveMod = getEffectiveStatPure(target, saveStat);
    const dc = skill.hitResolution.dc ?? 10;
    for (let d20 = 1; d20 <= 20; d20 += 1) {
      if (d20 + saveMod >= dc) {
        saveSuccessCount += 1;
      }
    }
  } else {
    hitCount = 20;
  }

  const hitProbability = normalizeZero(hitCount / 20);
  const critProbability = normalizeZero(critCount / 20);
  const saveSuccessProbability = normalizeZero(saveSuccessCount / 20);

  let totalNormalMin = 0;
  let totalNormalExpected = 0;
  let totalNormalMax = 0;
  let totalCritMin = 0;
  let totalCritExpected = 0;
  let totalCritMax = 0;
  let knockbackPreview: KnockbackPreview | undefined;

  for (const effect of skill.effects) {
    if (effect.type === 'damage' || effect.type === 'drain') {
      const stats = computeEffectDiceStatsPure(effect, combatState, actor, target);
      totalNormalMin += stats.normalMin;
      totalNormalExpected += stats.normalExpected;
      totalNormalMax += stats.normalMax;
      totalCritMin += stats.critMin;
      totalCritExpected += stats.critExpected;
      totalCritMax += stats.critMax;
    } else if (effect.type === 'knockback' && effect.distance !== undefined) {
      knockbackPreview = previewKnockbackPure(combatState, actor.coord, target, effect.distance);
    }
  }

  let rangeMin = 0;
  let rangeExpected = 0;
  let rangeMax = 0;

  if (skill.hitResolution.kind === 'attack_roll') {
    const nonCritHitProb = hitProbability - critProbability;
    rangeMin = hitProbability > 0 ? totalNormalMin : 0;
    rangeMax = critProbability > 0 ? totalCritMax : hitProbability > 0 ? totalNormalMax : 0;
    rangeExpected = nonCritHitProb * totalNormalExpected + critProbability * totalCritExpected;
  } else if (skill.hitResolution.kind === 'save') {
    rangeMin =
      saveSuccessProbability > 0 ? Math.floor(totalNormalMin / 2) : totalNormalMin;
    rangeMax =
      saveSuccessProbability < 1 ? totalNormalMax : Math.floor(totalNormalMax / 2);
    rangeExpected =
      (1 - saveSuccessProbability) * totalNormalExpected +
      saveSuccessProbability * Math.floor(totalNormalExpected / 2);
  } else {
    rangeMin = totalNormalMin;
    rangeExpected = totalNormalExpected;
    rangeMax = totalNormalMax;
  }

  // Silence unused import warning while ensuring hostile check helper is available if needed
  void areTeamsHostile;

  return {
    targetId: target.id,
    effectiveAc: normalizeZero(effectiveAc),
    highGroundBonus: normalizeZero(highGroundBonus),
    cover,
    hitProbability,
    critProbability,
    saveSuccessProbability,
    damageRange: {
      min: normalizeZero(rangeMin),
      expected: normalizeZero(rangeExpected),
      max: normalizeZero(rangeMax),
    },
    ...(knockbackPreview !== undefined ? { knockbackPreview } : {}),
  };
}

/**
 * Run a 100% pure, zero-mutation, zero-PRNG-advance dry-run preview of a proposed
 * combat action, evaluating all 20 faces of `1d20` against effective target AC/saves.
 */
export function previewCombatAction(
  combatState: CombatState,
  actorId: string,
  action: ProposedCombatAction,
  registry: SkillRegistry,
  _options?: PreviewCombatActionOptions
): CombatActionPreviewResult {
  const validation = validateSingleCombatAction(combatState, actorId, action, registry);
  if (!validation.ok) {
    return {
      legal: false,
      errors: [...validation.error],
      actionType: action.type,
      actorId,
      affectedTargetIds: [],
      targetPreviews: [],
      terrainModificationFootprint: [],
      summonSpawnCoord: null,
    };
  }

  const actor = getSafeCombatant(combatState, actorId);
  if (actor === undefined) {
    return {
      legal: false,
      errors: [],
      actionType: action.type,
      actorId,
      affectedTargetIds: [],
      targetPreviews: [],
      terrainModificationFootprint: [],
      summonSpawnCoord: null,
    };
  }

  const payload = validation.value;
  if (action.type === 'move') {
    const path = payload.resolvedPath ?? [];
    const hazardWarnings: HazardWarning[] = [];
    if (combatState.grid !== null) {
      for (let i = 1; i < path.length; i += 1) {
        const coord = path[i]!;
        const tile = getTileAt(combatState.grid, coord);
        if (tile !== null && isDamagingOrEffectHazard(tile.hazard)) {
          hazardWarnings.push({
            coord: { x: normalizeZero(coord.x), y: normalizeZero(coord.y) },
            hazard: tile.hazard,
          });
        }
      }
    }
    return {
      legal: true,
      errors: [],
      actionType: 'move',
      actorId,
      affectedTargetIds: [],
      targetPreviews: [],
      terrainModificationFootprint: [],
      summonSpawnCoord: null,
      movePreview: {
        path: path.map((c) => ({ x: normalizeZero(c.x), y: normalizeZero(c.y) })),
        cost: normalizeZero(payload.moveCost ?? 0),
        hazardWarnings,
      },
    };
  }

  const affectedTargetIds = [...(payload.resolvedTargetIds ?? [])];
  const skill = payload.skill;
  const targetPreviews: TargetActionPreview[] = [];
  const terrainModificationFootprint: GridCoord[] = [];
  let summonSpawnCoord: GridCoord | null = null;

  if (skill !== undefined) {
    for (const targetId of affectedTargetIds) {
      const target = getSafeCombatant(combatState, targetId);
      if (target !== undefined) {
        targetPreviews.push(previewSingleTarget(combatState, actor, target, skill));
      }
    }

    for (const effect of skill.effects) {
      if (
        effect.type === 'modify_terrain' &&
        effect.terrainSpec !== undefined &&
        combatState.mode === 'tactical_grid' &&
        combatState.grid !== null
      ) {
        const spec = effect.terrainSpec as unknown as TerrainModificationSpec;
        const aimCoord =
          (action.type === 'skill' || action.type === 'item' ? action.targetCoord : undefined) ??
          (affectedTargetIds[0] !== undefined
            ? getSafeCombatant(combatState, affectedTargetIds[0])?.coord
            : undefined) ??
          actor.coord;
        const footprint = resolveTerrainFootprint(combatState.grid, actor.coord, aimCoord, spec);
        for (const coord of footprint) {
          terrainModificationFootprint.push({
            x: normalizeZero(coord.x),
            y: normalizeZero(coord.y),
          });
        }
      } else if (effect.type === 'summon') {
        const prefCoord =
          (action.type === 'skill' || action.type === 'item' ? action.targetCoord : undefined) ??
          actor.coord;
        summonSpawnCoord = previewSummonSpawnCoordPure(combatState, prefCoord);
      }
    }
  }

  return {
    legal: true,
    errors: [],
    actionType: action.type,
    actorId,
    affectedTargetIds,
    targetPreviews,
    terrainModificationFootprint,
    summonSpawnCoord,
  };
}
