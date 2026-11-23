import { type ValidationError } from '../core/errors.js';
import { ErrorAccumulator, type Result, err, ok } from '../core/result.js';
import type { GridCoord, TacticalGrid } from './grid-types.js';
import type { PassiveDefinition } from './passives-and-willpower.js';
import type { SkillDefinition, SkillRegistry } from './skill-registry.js';
import { chebyshevDistance, evaluateLineOfSight, findShortestPath, getTileAt } from './spatial-math.js';
import type { ActiveStatusEffect } from './status-effects.js';

export type CombatTeam = 'ally' | 'enemy' | 'neutral';

export interface CombatantState {
  id: string;
  name: string;
  team: CombatTeam;
  coord: GridCoord;
  alive: boolean;
  hp: number;
  maxHp: number;
  ac: number;
  speed: number;
  remainingMovement: number;
  remainingActions: {
    action: number;
    bonus: number;
    reaction: number;
  };
  resources: Record<string, number>;
  cooldowns: Record<string, number>;
  stats: Record<string, number>;
  statuses: ActiveStatusEffect[];
  abilities: string[];
  passives: PassiveDefinition[];
  willpower: number;
  maxWillpower: number;
}

export interface CombatState {
  active: boolean;
  mode: 'tactical_grid' | 'traditional';
  round: number;
  turnIndex: number;
  initiativeOrder: string[];
  grid: TacticalGrid | null;
  combatants: Record<string, CombatantState>;
  triggerCountsThisTurn: Record<string, Record<string, number>>;
  encounterActionPending?: 'engage' | 'talk' | 'avoid' | null;
}

export type ProposedCombatAction =
  | { type: 'move'; path?: readonly GridCoord[]; to?: GridCoord }
  | { type: 'skill'; skillId: string; targetId?: string; targetCoord?: GridCoord }
  | { type: 'defend' }
  | { type: 'end_turn' };

export interface ValidatedCombatActionPayload {
  resolvedPath?: GridCoord[];
  moveCost?: number;
  skill?: SkillDefinition;
  resolvedTargetIds?: string[];
}

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const BUILTIN_BASIC_STRIKE: SkillDefinition = {
  id: 'basic_strike',
  name: 'Basic Strike',
  description: 'A standard melee weapon strike against an adjacent foe.',
  category: 'attack',
  actionCost: 'action',
  resourceCosts: {},
  targeting: {
    shape: 'single_enemy',
    minRange: 1,
    maxRange: 1,
    requiresLos: true,
  },
  hitResolution: {
    kind: 'attack_roll',
    stat: 'str',
  },
  effects: [
    {
      type: 'damage',
      dice: '1d8',
      scalingStat: 'str',
    },
  ],
  tags: ['melee', 'weapon'],
};

const BUILTIN_DEFEND_SKILL: SkillDefinition = {
  id: 'defend',
  name: 'Defend',
  description: 'Takes a defensive stance against incoming attacks.',
  category: 'defend',
  actionCost: 'action',
  resourceCosts: {},
  targeting: {
    shape: 'self',
    minRange: 0,
    maxRange: 0,
    requiresLos: false,
  },
  hitResolution: {
    kind: 'auto',
  },
  effects: [
    {
      type: 'apply_status',
      statusId: 'guarded',
      statusDuration: 1,
      statusIntensity: 1,
    },
  ],
  tags: ['defense'],
};

export function isSafeKey(key: string): boolean {
  return key.length > 0 && !FORBIDDEN_KEYS.has(key);
}

export function getOwnNumber(record: Record<string, number>, key: string): number | undefined {
  if (!isSafeKey(key) || !Object.hasOwn(record, key)) {
    return undefined;
  }
  const value = Object.getOwnPropertyDescriptor(record, key)?.value;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function setOwnProperty<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export function getSafeCombatant(combat: CombatState, id: string): CombatantState | undefined {
  if (!isSafeKey(id) || !Object.hasOwn(combat.combatants, id)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(combat.combatants, id)?.value as CombatantState | undefined;
}

export function getSafeCombatantIds(combat: CombatState): string[] {
  const ids: string[] = [];
  for (const key of Object.keys(combat.combatants)) {
    if (isSafeKey(key) && Object.hasOwn(combat.combatants, key)) {
      ids.push(key);
    }
  }
  return ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function getOccupiedCoords(combat: CombatState, excludeId: string): GridCoord[] {
  const occupied: GridCoord[] = [];
  for (const id of getSafeCombatantIds(combat)) {
    if (id === excludeId) {
      continue;
    }
    const combatant = getSafeCombatant(combat, id);
    if (combatant !== undefined && combatant.alive && combatant.hp > 0) {
      occupied.push({ x: combatant.coord.x, y: combatant.coord.y });
    }
  }
  return occupied;
}

export function isActorStunned(combatant: CombatantState): boolean {
  return combatant.statuses.some(
    (status) =>
      status.remainingTurns > 0 &&
      (status.stun === true || (status.stun !== false && (status.id === 'stun' || status.id === 'stunned')))
  );
}

export function isActorRooted(combatant: CombatantState): boolean {
  return combatant.statuses.some(
    (status) =>
      status.remainingTurns > 0 &&
      (status.root === true || (status.root !== false && (status.id === 'root' || status.id === 'rooted')))
  );
}

export function areTeamsHostile(a: CombatTeam, b: CombatTeam): boolean {
  return a !== b && a !== 'neutral' && b !== 'neutral';
}

export function resolveSkillDefinition(
  skillId: string,
  registry: SkillRegistry
): SkillDefinition | undefined {
  if (!isSafeKey(skillId)) {
    return undefined;
  }
  const fromRegistry = registry.get(skillId);
  if (fromRegistry !== undefined) {
    return fromRegistry;
  }
  if (skillId === 'basic_strike') {
    return {
      ...BUILTIN_BASIC_STRIKE,
      resourceCosts: {},
      targeting: { ...BUILTIN_BASIC_STRIKE.targeting },
      hitResolution: { ...BUILTIN_BASIC_STRIKE.hitResolution },
      effects: BUILTIN_BASIC_STRIKE.effects.map((e) => ({ ...e })),
      ...(BUILTIN_BASIC_STRIKE.tags !== undefined ? { tags: [...BUILTIN_BASIC_STRIKE.tags] } : {}),
    };
  }
  if (skillId === 'defend') {
    return {
      ...BUILTIN_DEFEND_SKILL,
      resourceCosts: {},
      targeting: { ...BUILTIN_DEFEND_SKILL.targeting },
      hitResolution: { ...BUILTIN_DEFEND_SKILL.hitResolution },
      effects: BUILTIN_DEFEND_SKILL.effects.map((e) => ({ ...e })),
      ...(BUILTIN_DEFEND_SKILL.tags !== undefined ? { tags: [...BUILTIN_DEFEND_SKILL.tags] } : {}),
    };
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function isValidGridCoord(coord: unknown): coord is GridCoord {
  if (!isPlainObject(coord)) {
    return false;
  }
  return (
    typeof coord['x'] === 'number' &&
    Number.isSafeInteger(coord['x']) &&
    typeof coord['y'] === 'number' &&
    Number.isSafeInteger(coord['y'])
  );
}

function coordsEqual(a: GridCoord, b: GridCoord): boolean {
  return a.x === b.x && a.y === b.y;
}

function isRestorativeOnlySkill(skill: SkillDefinition): boolean {
  const hasHealOrRestore = skill.effects.some(
    (e) => e.type === 'heal' || e.type === 'restore_resource' || e.type === 'remove_status'
  );
  const hasDamage = skill.effects.some((e) => e.type === 'damage');
  return hasHealOrRestore && !hasDamage;
}

function isPointInCone(
  origin: GridCoord,
  aimPoint: GridCoord,
  candidate: GridCoord,
  maxRange: number
): boolean {
  if (coordsEqual(origin, candidate)) {
    return false;
  }
  const dist = chebyshevDistance(origin, candidate);
  if (dist > maxRange) {
    return false;
  }
  const dirX = aimPoint.x - origin.x;
  const dirY = aimPoint.y - origin.y;
  const candX = candidate.x - origin.x;
  const candY = candidate.y - origin.y;
  const dirLen = Math.hypot(dirX, dirY);
  const candLen = Math.hypot(candX, candY);
  if (dirLen === 0 || candLen === 0) {
    return false;
  }
  const cosTheta = (dirX * candX + dirY * candY) / (dirLen * candLen);
  // ~90-degree total cone (half-angle <= 45 deg => cos(theta) >= cos(45 deg) - eps)
  return cosTheta >= Math.SQRT1_2 - 1e-6;
}

function validateMoveAction(
  combat: CombatState,
  actorId: string,
  actor: CombatantState,
  action: { type: 'move'; path?: readonly GridCoord[]; to?: GridCoord },
  acc: ErrorAccumulator
): { resolvedPath?: GridCoord[]; moveCost?: number } {
  if (isActorRooted(actor)) {
    acc.add('action', 'ACTOR_ROOTED', `Actor "${actorId}" is rooted and cannot move`);
    return {};
  }

  if (combat.mode === 'traditional') {
    acc.add(
      'action.type',
      'MOVE_UNAVAILABLE_IN_TRADITIONAL',
      'Grid movement is not available in traditional combat mode'
    );
    return {};
  }

  if (combat.grid === null) {
    acc.add('combat.grid', 'MISSING_GRID', 'Tactical grid mode requires a valid grid');
    return {};
  }

  const grid = combat.grid;
  const occupied = getOccupiedCoords(combat, actorId);
  const occupiedKeys = new Set<string>(occupied.map((c) => `${c.x},${c.y}`));

  if (action.path !== undefined) {
    if (!Array.isArray(action.path)) {
      acc.add('action.path', 'INVALID_TYPE', 'Move path must be an array of coordinates');
      return {};
    }
    if (action.path.length === 0) {
      if (action.to === undefined) {
        acc.add('action.path', 'EMPTY_PATH', 'Move path cannot be empty');
        return {};
      }
    } else {
      for (let i = 0; i < action.path.length; i += 1) {
        if (!isValidGridCoord(action.path[i])) {
          acc.add(`action.path[${i}]`, 'INVALID_COORD', 'Path step must be a valid integer GridCoord');
          return {};
        }
      }

      const firstStep = action.path[0] as GridCoord;
      const lastStep = action.path[action.path.length - 1] as GridCoord;
      if (action.to !== undefined) {
        if (!isValidGridCoord(action.to)) {
          acc.add('action.to', 'INVALID_COORD', 'Move destination must be a valid integer GridCoord');
          return {};
        }
        if (!coordsEqual(lastStep, action.to)) {
          acc.add(
            'action.to',
            'PATH_DESTINATION_MISMATCH',
            'Move path end coordinate does not match "to" destination'
          );
          return {};
        }
      }

      const resolvedPath: GridCoord[] = [{ x: actor.coord.x, y: actor.coord.y }];
      const startIndex = coordsEqual(firstStep, actor.coord) ? 1 : 0;
      for (let i = startIndex; i < action.path.length; i += 1) {
        const step = action.path[i] as GridCoord;
        resolvedPath.push({ x: step.x, y: step.y });
      }

      let totalCost = 0;
      for (let i = 1; i < resolvedPath.length; i += 1) {
        const prev = resolvedPath[i - 1] as GridCoord;
        const curr = resolvedPath[i] as GridCoord;

        if (coordsEqual(prev, curr) || chebyshevDistance(prev, curr) !== 1) {
          acc.add(
            `action.path[${i}]`,
            'NON_ADJACENT_STEP',
            `Move path step (${curr.x},${curr.y}) is not adjacent to (${prev.x},${prev.y})`
          );
          return {};
        }

        const tile = getTileAt(grid, curr);
        if (tile === null) {
          acc.add(
            `action.path[${i}]`,
            'OUT_OF_BOUNDS',
            `Move step (${curr.x},${curr.y}) is outside the tactical grid`
          );
          return {};
        }
        if (!tile.passable) {
          acc.add(
            `action.path[${i}]`,
            'IMPASSABLE_TILE',
            `Move step (${curr.x},${curr.y}) is blocked by an obstacle`
          );
          return {};
        }
        if (occupiedKeys.has(`${curr.x},${curr.y}`)) {
          acc.add(
            `action.path[${i}]`,
            'OCCUPIED_TILE',
            `Move step (${curr.x},${curr.y}) is occupied by another combatant`
          );
          return {};
        }

        const dx = curr.x - prev.x;
        const dy = curr.y - prev.y;
        if (dx !== 0 && dy !== 0) {
          const adj1 = getTileAt(grid, { x: prev.x + dx, y: prev.y });
          const adj2 = getTileAt(grid, { x: prev.x, y: prev.y + dy });
          if ((adj1 === null || !adj1.passable) && (adj2 === null || !adj2.passable)) {
            acc.add(
              `action.path[${i}]`,
              'BLOCKED_DIAGONAL',
              `Cannot squeeze diagonally between impassable corners at (${curr.x},${curr.y})`
            );
            return {};
          }
        }

        totalCost += tile.hazard === 'difficult' ? 2 : 1;
      }

      if (totalCost > actor.remainingMovement) {
        acc.add(
          'action',
          'INSUFFICIENT_MOVEMENT',
          `Move cost ${totalCost} exceeds remaining movement ${actor.remainingMovement}`
        );
        return {};
      }

      return { resolvedPath, moveCost: totalCost };
    }
  }

  if (action.to === undefined) {
    acc.add('action', 'MISSING_DESTINATION', 'Move action requires either "to" coordinate or "path"');
    return {};
  }

  if (!isValidGridCoord(action.to)) {
    acc.add('action.to', 'INVALID_COORD', 'Move destination must be a valid integer GridCoord');
    return {};
  }

  const destTile = getTileAt(grid, action.to);
  if (destTile === null) {
    acc.add('action.to', 'OUT_OF_BOUNDS', `Destination (${action.to.x},${action.to.y}) is out of bounds`);
    return {};
  }
  if (!destTile.passable) {
    acc.add('action.to', 'IMPASSABLE_TILE', `Destination (${action.to.x},${action.to.y}) is impassable`);
    return {};
  }
  if (!coordsEqual(action.to, actor.coord) && occupiedKeys.has(`${action.to.x},${action.to.y}`)) {
    acc.add('action.to', 'OCCUPIED_TILE', `Destination (${action.to.x},${action.to.y}) is occupied`);
    return {};
  }

  const pathRes = findShortestPath(grid, actor.coord, action.to, { occupied });
  if (!pathRes.reachable) {
    acc.add('action.to', 'UNREACHABLE', `Destination (${action.to.x},${action.to.y}) is unreachable`);
    return {};
  }

  if (pathRes.cost > actor.remainingMovement) {
    acc.add(
      'action',
      'INSUFFICIENT_MOVEMENT',
      `Move cost ${pathRes.cost} exceeds remaining movement ${actor.remainingMovement}`
    );
    return {};
  }

  return {
    resolvedPath: pathRes.path,
    moveCost: pathRes.cost,
  };
}

function validateSkillAction(
  combat: CombatState,
  actorId: string,
  actor: CombatantState,
  action: { type: 'skill'; skillId: string; targetId?: string; targetCoord?: GridCoord },
  registry: SkillRegistry,
  acc: ErrorAccumulator
): { skill?: SkillDefinition; resolvedTargetIds?: string[] } {
  const skillId = action.skillId;
  if (typeof skillId !== 'string' || !isSafeKey(skillId)) {
    acc.add('action.skillId', 'INVALID_SKILL_ID', 'Skill ID must be a safe non-empty string');
    return {};
  }

  const skill = resolveSkillDefinition(skillId, registry);
  if (skill === undefined) {
    acc.add('action.skillId', 'SKILL_NOT_FOUND', `Skill "${skillId}" not found in registry`);
    return {};
  }

  const isBasicAction = skillId === 'basic_strike' || skillId === 'defend';
  if (!isBasicAction && !actor.abilities.includes(skillId)) {
    acc.add('action.skillId', 'SKILL_NOT_KNOWN', `Actor "${actorId}" does not know skill "${skillId}"`);
    return {};
  }

  if (skill.actionCost === 'action' && actor.remainingActions.action <= 0) {
    acc.add('action', 'INSUFFICIENT_ACTION', 'Actor has no remaining action points');
  } else if (skill.actionCost === 'bonus' && actor.remainingActions.bonus <= 0) {
    acc.add('action', 'INSUFFICIENT_BONUS', 'Actor has no remaining bonus action points');
  } else if (skill.actionCost === 'reaction' && actor.remainingActions.reaction <= 0) {
    acc.add('action', 'INSUFFICIENT_REACTION', 'Actor has no remaining reaction points');
  }

  for (const resKey of Object.keys(skill.resourceCosts)) {
    if (!isSafeKey(resKey) || !Object.hasOwn(skill.resourceCosts, resKey)) {
      continue;
    }
    const costVal = getOwnNumber(skill.resourceCosts, resKey) ?? 0;
    if (costVal > 0) {
      const available = getOwnNumber(actor.resources, resKey) ?? 0;
      if (available < costVal) {
        acc.add(
          `resourceCosts.${resKey}`,
          'INSUFFICIENT_RESOURCE',
          `Insufficient "${resKey}": requires ${costVal}, have ${available}`
        );
      }
    }
  }

  const cooldownRemaining = getOwnNumber(actor.cooldowns, skillId) ?? 0;
  if (cooldownRemaining > 0) {
    acc.add(
      'action.skillId',
      'SKILL_ON_COOLDOWN',
      `Skill "${skillId}" is on cooldown for ${cooldownRemaining} more turn(s)`
    );
  }

  const resolvedTargetIds: string[] = [];
  const targeting = skill.targeting;

  switch (targeting.shape) {
    case 'self': {
      if (action.targetId !== undefined && action.targetId !== actorId) {
        acc.add('action.targetId', 'INVALID_TARGET', 'Self-targeted skill cannot target another unit');
      } else {
        resolvedTargetIds.push(actorId);
      }
      break;
    }

    case 'single_enemy':
    case 'single_ally': {
      const targetId = action.targetId;
      if (typeof targetId !== 'string' || !isSafeKey(targetId)) {
        acc.add('action.targetId', 'MISSING_TARGET', 'Targeting requires a valid targetId');
        break;
      }
      const target = getSafeCombatant(combat, targetId);
      if (target === undefined) {
        acc.add('action.targetId', 'TARGET_NOT_FOUND', `Target "${targetId}" not found`);
        break;
      }
      if (!target.alive || target.hp <= 0) {
        acc.add('action.targetId', 'TARGET_DEAD', `Target "${targetId}" is dead and cannot be targeted`);
        break;
      }
      if (targeting.shape === 'single_enemy' && target.team === actor.team) {
        acc.add('action.targetId', 'INVALID_TARGET_TEAM', `Target "${targetId}" is on the same team`);
        break;
      }
      if (targeting.shape === 'single_ally' && target.team !== actor.team) {
        acc.add('action.targetId', 'INVALID_TARGET_TEAM', `Target "${targetId}" is not an ally`);
        break;
      }

      if (combat.mode === 'tactical_grid') {
        if (combat.grid === null) {
          acc.add('combat.grid', 'MISSING_GRID', 'Tactical grid mode requires a valid grid');
          break;
        }
        const dist = chebyshevDistance(actor.coord, target.coord);
        if (dist < targeting.minRange || dist > targeting.maxRange) {
          acc.add(
            'action',
            'OUT_OF_RANGE',
            `Target distance ${dist} outside skill range [${targeting.minRange}, ${targeting.maxRange}]`
          );
        }
        if (targeting.requiresLos) {
          const los = evaluateLineOfSight(combat.grid, actor.coord, target.coord);
          if (!los.visible) {
            acc.add('action', 'NO_LINE_OF_SIGHT', `No line of sight to target "${targetId}"`);
          }
        }
      }

      resolvedTargetIds.push(target.id);
      break;
    }

    case 'aoe_radius':
    case 'line':
    case 'cone': {
      let explicitTarget: CombatantState | undefined;
      if (action.targetId !== undefined) {
        if (typeof action.targetId !== 'string' || !isSafeKey(action.targetId)) {
          acc.add('action.targetId', 'INVALID_TARGET_ID', 'Invalid targetId');
          break;
        }
        explicitTarget = getSafeCombatant(combat, action.targetId);
        if (explicitTarget === undefined) {
          acc.add('action.targetId', 'TARGET_NOT_FOUND', `Target "${action.targetId}" not found`);
          break;
        }
        if (!explicitTarget.alive || explicitTarget.hp <= 0) {
          acc.add(
            'action.targetId',
            'TARGET_DEAD',
            `Target "${action.targetId}" is dead and cannot be targeted`
          );
          break;
        }
      }

      if (combat.mode === 'traditional') {
        const restorative = isRestorativeOnlySkill(skill);
        for (const id of getSafeCombatantIds(combat)) {
          const candidate = getSafeCombatant(combat, id);
          if (candidate === undefined || !candidate.alive || candidate.hp <= 0) {
            continue;
          }
          if (restorative) {
            if (candidate.team === actor.team) {
              resolvedTargetIds.push(id);
            }
          } else if (areTeamsHostile(actor.team, candidate.team)) {
            resolvedTargetIds.push(id);
          }
        }
        break;
      }

      if (combat.grid === null) {
        acc.add('combat.grid', 'MISSING_GRID', 'Tactical grid mode requires a valid grid');
        break;
      }

      let aimCoord: GridCoord | undefined;
      if (action.targetCoord !== undefined) {
        if (!isValidGridCoord(action.targetCoord)) {
          acc.add('action.targetCoord', 'INVALID_COORD', 'targetCoord must be a valid integer GridCoord');
          break;
        }
        if (getTileAt(combat.grid, action.targetCoord) === null) {
          acc.add('action.targetCoord', 'OUT_OF_BOUNDS', 'targetCoord is outside the tactical grid');
          break;
        }
        aimCoord = action.targetCoord;
      } else if (explicitTarget !== undefined) {
        aimCoord = explicitTarget.coord;
      } else if (targeting.minRange === 0) {
        aimCoord = actor.coord;
      } else {
        acc.add('action', 'MISSING_TARGET', 'AoE skill requires targetCoord or targetId');
        break;
      }

      const castDist = chebyshevDistance(actor.coord, aimCoord);
      if (castDist < targeting.minRange || castDist > targeting.maxRange) {
        acc.add(
          'action',
          'OUT_OF_RANGE',
          `Aim distance ${castDist} outside skill range [${targeting.minRange}, ${targeting.maxRange}]`
        );
      }

      if (targeting.requiresLos) {
        const los = evaluateLineOfSight(combat.grid, actor.coord, aimCoord);
        if (!los.visible) {
          acc.add('action', 'NO_LINE_OF_SIGHT', 'No line of sight to target area');
        }
      }

      const restorative = isRestorativeOnlySkill(skill);
      const radius = targeting.radius ?? 0;
      const lineCoords =
        targeting.shape === 'line'
          ? evaluateLineOfSight(combat.grid, actor.coord, aimCoord).path.slice(1)
          : [];

      for (const id of getSafeCombatantIds(combat)) {
        const candidate = getSafeCombatant(combat, id);
        if (candidate === undefined || !candidate.alive || candidate.hp <= 0) {
          continue;
        }
        if (restorative) {
          if (candidate.team !== actor.team) {
            continue;
          }
        } else if (!areTeamsHostile(actor.team, candidate.team)) {
          continue;
        }

        if (targeting.shape === 'aoe_radius') {
          if (chebyshevDistance(aimCoord, candidate.coord) <= radius) {
            resolvedTargetIds.push(id);
          }
        } else if (targeting.shape === 'line') {
          if (lineCoords.some((p) => coordsEqual(p, candidate.coord))) {
            resolvedTargetIds.push(id);
          }
        } else if (targeting.shape === 'cone') {
          if (isPointInCone(actor.coord, aimCoord, candidate.coord, targeting.maxRange)) {
            resolvedTargetIds.push(id);
          }
        }
      }
      break;
    }
  }

  if (acc.hasErrors()) {
    return {};
  }

  return {
    skill,
    resolvedTargetIds,
  };
}

/**
 * Validate a single proposed combat action against the current {@link CombatState} and {@link SkillRegistry}.
 */
export function validateSingleCombatAction(
  combat: CombatState,
  actorId: string,
  action: ProposedCombatAction,
  registry: SkillRegistry
): Result<ValidatedCombatActionPayload, ValidationError[]> {
  const acc = new ErrorAccumulator();

  if (!isSafeKey(actorId)) {
    acc.add('actorId', 'INVALID_ACTOR_ID', `Invalid or forbidden actor id "${actorId}"`);
    return err([...acc.errors]);
  }

  const actor = getSafeCombatant(combat, actorId);
  if (actor === undefined) {
    acc.add('actorId', 'ACTOR_NOT_FOUND', `Actor "${actorId}" not found in combat`);
    return err([...acc.errors]);
  }

  if (!actor.alive || actor.hp <= 0) {
    acc.add('actorId', 'ACTOR_DEAD', `Actor "${actorId}" is dead and cannot act`);
    return err([...acc.errors]);
  }

  if (isActorStunned(actor)) {
    acc.add('actorId', 'ACTOR_STUNNED', `Actor "${actorId}" is stunned and cannot act`);
    return err([...acc.errors]);
  }

  if (!isPlainObject(action)) {
    acc.add('action', 'INVALID_TYPE', 'Proposed combat action must be a plain object');
    return err([...acc.errors]);
  }

  const actionType = Object.getOwnPropertyDescriptor(action, 'type')?.value;
  if (typeof actionType !== 'string') {
    acc.add('action.type', 'INVALID_TYPE', 'Action type must be a string');
    return err([...acc.errors]);
  }

  switch (actionType) {
    case 'move': {
      const movePayload = validateMoveAction(
        combat,
        actorId,
        actor,
        action as { type: 'move'; path?: readonly GridCoord[]; to?: GridCoord },
        acc
      );
      return acc.hasErrors() ? err([...acc.errors]) : ok(movePayload);
    }

    case 'skill': {
      const skillPayload = validateSkillAction(
        combat,
        actorId,
        actor,
        action as { type: 'skill'; skillId: string; targetId?: string; targetCoord?: GridCoord },
        registry,
        acc
      );
      return acc.hasErrors() ? err([...acc.errors]) : ok(skillPayload);
    }

    case 'defend': {
      if (actor.remainingActions.action <= 0) {
        acc.add('action', 'INSUFFICIENT_ACTION', 'Actor has no remaining action points to defend');
        return err([...acc.errors]);
      }
      const defendSkill = resolveSkillDefinition('defend', registry);
      return ok({
        ...(defendSkill !== undefined ? { skill: defendSkill } : {}),
        resolvedTargetIds: [actorId],
      });
    }

    case 'end_turn': {
      return ok({});
    }

    default: {
      acc.add('action.type', 'UNKNOWN_ACTION_TYPE', `Unknown action type "${actionType}"`);
      return err([...acc.errors]);
    }
  }
}
