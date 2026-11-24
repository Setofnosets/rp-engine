import { parseDiceNotation } from '../core/dice.js';
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
  resolveSkillDefinition,
  validateSingleCombatAction,
} from './action-validator.js';
import type { GridCoord, TacticalGrid, TileHazard } from './grid-types.js';
import type { SkillDefinition, SkillRegistry } from './skill-registry.js';
import { findShortestPath, getTileAt } from './spatial-math.js';

function getEffectiveStatValue(combatant: CombatantState, statKey: string): number {
  if (!isSafeKey(statKey)) {
    return 0;
  }
  let total = getOwnNumber(combatant.stats, statKey) ?? 0;
  for (const status of combatant.statuses) {
    if (status.remainingTurns > 0 && status.statModifiers !== undefined) {
      total += getOwnNumber(status.statModifiers, statKey) ?? 0;
    }
  }
  return total;
}

function estimateSkillDamage(actor: CombatantState, skill: SkillDefinition): number {
  let total = 0;
  for (const effect of skill.effects) {
    if (effect.type !== 'damage') {
      continue;
    }
    if (effect.dice !== undefined) {
      const parsed = parseDiceNotation(effect.dice);
      if (parsed.ok) {
        const d = parsed.value;
        const kept = d.keepCount ?? d.diceCount;
        total += kept * ((d.sides + 1) / 2) + d.modifier;
      }
    }
    if (effect.flat !== undefined) {
      total += effect.flat;
    }
    if (effect.scalingStat !== undefined) {
      total += getEffectiveStatValue(actor, effect.scalingStat);
    }
  }
  return total;
}

function totalResourceCost(skill: SkillDefinition): number {
  let sum = 0;
  for (const key of Object.keys(skill.resourceCosts)) {
    if (isSafeKey(key) && Object.hasOwn(skill.resourceCosts, key)) {
      sum += getOwnNumber(skill.resourceCosts, key) ?? 0;
    }
  }
  return sum;
}

function canAffordSkillEconomy(actor: CombatantState, skill: SkillDefinition): boolean {
  if (skill.actionCost === 'action' && actor.remainingActions.action <= 0) {
    return false;
  }
  if (skill.actionCost === 'bonus' && actor.remainingActions.bonus <= 0) {
    return false;
  }
  if (skill.actionCost === 'reaction' && actor.remainingActions.reaction <= 0) {
    return false;
  }
  if ((getOwnNumber(actor.cooldowns, skill.id) ?? 0) > 0) {
    return false;
  }
  for (const key of Object.keys(skill.resourceCosts)) {
    if (isSafeKey(key) && Object.hasOwn(skill.resourceCosts, key)) {
      const cost = getOwnNumber(skill.resourceCosts, key) ?? 0;
      if (cost > 0 && (getOwnNumber(actor.resources, key) ?? 0) < cost) {
        return false;
      }
    }
  }
  return true;
}

function getRankedAttackSkills(actor: CombatantState, registry: SkillRegistry): SkillDefinition[] {
  const seen = new Set<string>();
  const skills: SkillDefinition[] = [];

  const candidateIds = [...actor.abilities, 'basic_strike'];
  for (const skillId of candidateIds) {
    if (!isSafeKey(skillId) || seen.has(skillId)) {
      continue;
    }
    seen.add(skillId);
    const skill = resolveSkillDefinition(skillId, registry);
    if (skill === undefined) {
      continue;
    }
    const isAttackSkill =
      (skill.category === 'attack' || skill.category === 'skill' || skill.category === 'spell') &&
      skill.effects.some((e) => e.type === 'damage');
    if (!isAttackSkill || !canAffordSkillEconomy(actor, skill)) {
      continue;
    }
    skills.push(skill);
  }

  skills.sort((a, b) => {
    const dmgDiff = estimateSkillDamage(actor, b) - estimateSkillDamage(actor, a);
    if (Math.abs(dmgDiff) > 1e-9) {
      return dmgDiff;
    }
    const costDiff = totalResourceCost(a) - totalResourceCost(b);
    if (costDiff !== 0) {
      return costDiff;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return skills;
}

function getLivingOpposingTargets(combat: CombatState, actor: CombatantState): CombatantState[] {
  const targets: CombatantState[] = [];
  for (const id of getSafeCombatantIds(combat)) {
    const candidate = getSafeCombatant(combat, id);
    if (
      candidate !== undefined &&
      candidate.alive &&
      candidate.hp > 0 &&
      areTeamsHostile(actor.team, candidate.team)
    ) {
      targets.push(candidate);
    }
  }

  targets.sort((a, b) => {
    if (a.hp !== b.hp) {
      return a.hp - b.hp;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return targets;
}

function buildSkillActionForTarget(
  skill: SkillDefinition,
  target: CombatantState
): ProposedCombatAction {
  if (
    skill.targeting.shape === 'aoe_radius' ||
    skill.targeting.shape === 'line' ||
    skill.targeting.shape === 'cone'
  ) {
    return {
      type: 'skill',
      skillId: skill.id,
      targetId: target.id,
      targetCoord: { x: target.coord.x, y: target.coord.y },
    };
  }
  return {
    type: 'skill',
    skillId: skill.id,
    targetId: target.id,
  };
}

function findBestValidAttackAgainst(
  combat: CombatState,
  actorId: string,
  rankedSkills: readonly SkillDefinition[],
  target: CombatantState,
  registry: SkillRegistry
): ProposedCombatAction | null {
  for (const skill of rankedSkills) {
    const candidateAction = buildSkillActionForTarget(skill, target);
    const res = validateSingleCombatAction(combat, actorId, candidateAction, registry);
    if (res.ok) {
      return candidateAction;
    }
  }
  return null;
}

function isDamagingHazard(hazard: TileHazard): boolean {
  return hazard === 'fire' || hazard === 'acid' || hazard === 'ice' || hazard === 'electrified';
}

function getHazardAvoidCoords(grid: TacticalGrid, start: GridCoord): GridCoord[] {
  const coords: GridCoord[] = [];
  for (const tile of grid.tiles) {
    if ((tile.x !== start.x || tile.y !== start.y) && isDamagingHazard(tile.hazard)) {
      coords.push({ x: tile.x, y: tile.y });
    }
  }
  return coords;
}

function findShortestPathTowardRangeOfTarget(
  grid: TacticalGrid,
  start: GridCoord,
  targetCoord: GridCoord,
  occupied: readonly GridCoord[],
  maxRange: number
): { path: GridCoord[]; cost: number } | null {
  const hazardAvoid = getHazardAvoidCoords(grid, start);
  const safePath = findShortestPathWithAvoidance(
    grid,
    start,
    targetCoord,
    [...occupied, ...hazardAvoid],
    maxRange,
    true
  );
  if (safePath !== null) {
    return safePath;
  }
  return findShortestPathWithAvoidance(grid, start, targetCoord, occupied, maxRange, false);
}

function findShortestPathWithAvoidance(
  grid: TacticalGrid,
  start: GridCoord,
  targetCoord: GridCoord,
  occupied: readonly GridCoord[],
  maxRange: number,
  avoidHazardGoals: boolean
): { path: GridCoord[]; cost: number } | null {
  const occupiedKeys = new Set<string>(occupied.map((c) => `${c.x},${c.y}`));
  const cappedRange = Math.min(Math.max(1, maxRange), 4);

  for (let ring = 1; ring <= cappedRange; ring += 1) {
    let best: { path: GridCoord[]; cost: number; goal: GridCoord } | null = null;
    for (let dy = -ring; dy <= ring; dy += 1) {
      for (let dx = -ring; dx <= ring; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) {
          continue;
        }
        const goal: GridCoord = { x: targetCoord.x + dx, y: targetCoord.y + dy };
        const tile = getTileAt(grid, goal);
        if (tile === null || !tile.passable) {
          continue;
        }
        if (avoidHazardGoals && isDamagingHazard(tile.hazard)) {
          continue;
        }
        if ((goal.x !== start.x || goal.y !== start.y) && occupiedKeys.has(`${goal.x},${goal.y}`)) {
          continue;
        }
        const res = findShortestPath(grid, start, goal, { occupied });
        if (!res.reachable || res.path.length < 2) {
          continue;
        }
        if (
          best === null ||
          res.cost < best.cost ||
          (res.cost === best.cost &&
            (goal.y < best.goal.y || (goal.y === best.goal.y && goal.x < best.goal.x)))
        ) {
          best = { path: res.path, cost: res.cost, goal };
        }
      }
    }
    if (best !== null) {
      return { path: best.path, cost: best.cost };
    }
  }

  return null;
}

function truncatePathToBudget(
  grid: TacticalGrid,
  fullPath: readonly GridCoord[],
  budget: number
): { prefix: GridCoord[]; spentCost: number } {
  if (fullPath.length < 2 || budget <= 0) {
    return { prefix: [], spentCost: 0 };
  }

  const prefix: GridCoord[] = [{ x: fullPath[0]!.x, y: fullPath[0]!.y }];
  let spentCost = 0;

  for (let i = 1; i < fullPath.length; i += 1) {
    const step = fullPath[i] as GridCoord;
    const tile = getTileAt(grid, step);
    if (tile === null || !tile.passable) {
      break;
    }
    const stepCost = tile.hazard === 'difficult' ? 2 : 1;
    if (spentCost + stepCost > budget) {
      break;
    }
    spentCost += stepCost;
    prefix.push({ x: step.x, y: step.y });
  }

  return prefix.length >= 2 ? { prefix, spentCost } : { prefix: [], spentCost: 0 };
}

function createMovedActorPreviewCombat(
  combat: CombatState,
  actorId: string,
  actor: CombatantState,
  newCoord: GridCoord,
  spentMovement: number
): CombatState {
  const movedActor: CombatantState = {
    ...actor,
    coord: { x: newCoord.x, y: newCoord.y },
    remainingMovement: Math.max(0, actor.remainingMovement - spentMovement),
  };
  const nextCombatants: Record<string, CombatantState> = {};
  for (const id of getSafeCombatantIds(combat)) {
    const entry = getSafeCombatant(combat, id);
    if (entry !== undefined) {
      Object.defineProperty(nextCombatants, id, {
        value: id === actorId ? movedActor : entry,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return {
    ...combat,
    combatants: nextCombatants,
  };
}

/**
 * Compute deterministic fallback combat actions when proposed LLM actions fail or are empty.
 */
export function computeFallbackActions(
  combat: CombatState,
  actorId: string,
  registry: SkillRegistry
): ProposedCombatAction[] {
  if (!isSafeKey(actorId)) {
    return [];
  }
  const actor = getSafeCombatant(combat, actorId);
  if (actor === undefined || !actor.alive || actor.hp <= 0 || isActorStunned(actor)) {
    return [];
  }

  const targets = getLivingOpposingTargets(combat, actor);
  if (targets.length === 0) {
    return [];
  }

  const rankedSkills = getRankedAttackSkills(actor, registry);
  const canDefend = actor.remainingActions.action > 0;

  if (combat.mode === 'traditional') {
    for (const target of targets) {
      const attackAction = findBestValidAttackAgainst(
        combat,
        actorId,
        rankedSkills,
        target,
        registry
      );
      if (attackAction !== null) {
        return [attackAction];
      }
    }
    return canDefend ? [{ type: 'defend' }] : [];
  }

  if (combat.grid === null) {
    return canDefend ? [{ type: 'defend' }] : [];
  }

  const primaryTarget = targets[0] as CombatantState;
  const directAttack = findBestValidAttackAgainst(
    combat,
    actorId,
    rankedSkills,
    primaryTarget,
    registry
  );
  if (directAttack !== null) {
    return [directAttack];
  }

  if (!isActorRooted(actor) && actor.remainingMovement > 0) {
    const occupied = getOccupiedCoords(combat, actorId);
    const bestMaxRange = rankedSkills.reduce(
      (max, skill) => Math.max(max, skill.targeting.maxRange),
      1
    );
    let chosenPath: { path: GridCoord[]; cost: number } | null = null;
    for (const target of targets) {
      const candidatePath = findShortestPathTowardRangeOfTarget(
        combat.grid,
        actor.coord,
        target.coord,
        occupied,
        bestMaxRange
      );
      if (candidatePath !== null) {
        chosenPath = candidatePath;
        break;
      }
    }

    if (chosenPath !== null) {
      const { prefix, spentCost } = truncatePathToBudget(
        combat.grid,
        chosenPath.path,
        actor.remainingMovement
      );
      if (prefix.length >= 2) {
        const destination = prefix[prefix.length - 1] as GridCoord;
        const moveAction: ProposedCombatAction = {
          type: 'move',
          path: prefix,
          to: { x: destination.x, y: destination.y },
        };

        const previewCombat = createMovedActorPreviewCombat(
          combat,
          actorId,
          actor,
          destination,
          spentCost
        );

        for (const target of targets) {
          const postMoveAttack = findBestValidAttackAgainst(
            previewCombat,
            actorId,
            rankedSkills,
            target,
            registry
          );
          if (postMoveAttack !== null) {
            return [moveAction, postMoveAttack];
          }
        }

        return canDefend ? [moveAction, { type: 'defend' }] : [moveAction];
      }
    }
  }

  // Cannot move (rooted, no movement left, or path blocked): attack any secondary target already in range/LOS.
  for (let i = 1; i < targets.length; i += 1) {
    const secondary = targets[i] as CombatantState;
    const secondaryAttack = findBestValidAttackAgainst(
      combat,
      actorId,
      rankedSkills,
      secondary,
      registry
    );
    if (secondaryAttack !== null) {
      return [secondaryAttack];
    }
  }

  return canDefend ? [{ type: 'defend' }] : [];
}
