import { rollDice } from '../core/dice.js';
import { RefereeError, formatValidationErrors } from '../core/errors.js';
import type { RngState } from '../core/prng.js';
import { unwrap } from '../core/result.js';
import type { PatchOperation } from '../state/patch.js';
import type { CharacterEntity, WorldState } from '../state/world-state.js';
import {
  type CombatState,
  type CombatTeam,
  type CombatantState,
  type ProposedCombatAction,
  getOwnNumber,
  getSafeCombatant,
  getSafeCombatantIds,
  isActorStunned,
  isSafeKey,
  setOwnProperty,
  validateSingleCombatAction,
} from './action-validator.js';
import { computeFallbackActions } from './fallback-tactics.js';
import type { GridCoord, TacticalGrid, TerrainTheme } from './grid-types.js';
import {
  DEFAULT_MAX_PASSIVE_RECURSION_DEPTH,
  type PassiveDefinition,
  type PassiveTriggerHook,
  adjustWillpower,
  evaluatePassiveHooks,
} from './passives-and-willpower.js';
import { awardExperience } from './rpg-progression.js';
import type { SkillDefinition, SkillEffectSpec, SkillRegistry } from './skill-registry.js';
import { evaluateLineOfSight, getTileAt } from './spatial-math.js';
import {
  type ActiveStatusEffect,
  applyStatusEffect,
  tickStatusEffects,
} from './status-effects.js';
import {
  type InitiativeParticipant,
  generateDeploymentCoords,
  generateTacticalGrid,
  rollInitiativeOrder,
} from './terrain-generator.js';

export interface CombatOutcomeSummary {
  round: number;
  actorId: string;
  executedActions: string[];
  salvagedPrefixCount: number;
  usedFallback: boolean;
  rejectedReasons: string[];
  damageDealt: Record<string, number>;
  defeatedIds: string[];
  encounterEnded: boolean;
  winnerTeam: CombatTeam | 'draw' | null;
  summaryText: string;
}

export interface StartCombatEncounterParams {
  worldState: WorldState;
  participants: readonly CombatantState[];
  mode: 'tactical_grid' | 'traditional';
  theme?: TerrainTheme;
  gridSize?: { width: number; height: number };
  rng: RngState;
}

export interface StartCombatEncounterResult {
  combatState: CombatState;
  worldPatches: PatchOperation[];
  nextRng: RngState;
}

export interface ResolveCombatTurnParams {
  combatState: CombatState;
  worldState: WorldState;
  actorId: string;
  proposedActions: readonly ProposedCombatAction[];
  registry: SkillRegistry;
  rng: RngState;
  xpAwardOnVictory?: number;
}

export interface ResolveCombatTurnResult {
  nextCombatState: CombatState;
  worldPatches: PatchOperation[];
  outcomeSummary: CombatOutcomeSummary;
  salvagedCount: number;
  usedFallback: boolean;
  rejectedReasons: string[];
  nextRng: RngState;
}

function cloneNumberRecord(record: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(record)) {
    if (isSafeKey(key) && Object.hasOwn(record, key)) {
      const value = getOwnNumber(record, key);
      if (value !== undefined) {
        setOwnProperty(out, key, value === 0 ? 0 : value);
      }
    }
  }
  return out;
}

function cloneStatus(status: ActiveStatusEffect): ActiveStatusEffect {
  return {
    ...status,
    ...(status.statModifiers !== undefined
      ? { statModifiers: cloneNumberRecord(status.statModifiers) }
      : {}),
  };
}

function clonePassive(passive: PassiveDefinition): PassiveDefinition {
  return {
    ...passive,
    ...(passive.condition !== undefined ? { condition: { ...passive.condition } } : {}),
    effect: { ...passive.effect },
  };
}

function cloneCombatant(c: CombatantState): CombatantState {
  return {
    id: c.id,
    name: c.name,
    team: c.team,
    coord: { x: c.coord.x, y: c.coord.y },
    alive: c.alive,
    hp: c.hp === 0 ? 0 : c.hp,
    maxHp: c.maxHp === 0 ? 0 : c.maxHp,
    ac: c.ac,
    speed: c.speed,
    remainingMovement: c.remainingMovement === 0 ? 0 : c.remainingMovement,
    remainingActions: {
      action: c.remainingActions.action,
      bonus: c.remainingActions.bonus,
      reaction: c.remainingActions.reaction,
    },
    resources: cloneNumberRecord(c.resources),
    cooldowns: cloneNumberRecord(c.cooldowns),
    stats: cloneNumberRecord(c.stats),
    statuses: c.statuses.map(cloneStatus),
    abilities: [...c.abilities],
    passives: c.passives.map(clonePassive),
    willpower: c.willpower === 0 ? 0 : c.willpower,
    maxWillpower: c.maxWillpower === 0 ? 0 : c.maxWillpower,
  };
}

function cloneGrid(grid: TacticalGrid | null): TacticalGrid | null {
  if (grid === null) {
    return null;
  }
  return {
    width: grid.width,
    height: grid.height,
    theme: grid.theme,
    tiles: grid.tiles.map((t) => ({ ...t })),
  };
}

function cloneTriggerCountsMap(
  map: Record<string, Record<string, number>>
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const actorKey of Object.keys(map)) {
    if (isSafeKey(actorKey) && Object.hasOwn(map, actorKey)) {
      const inner = Object.getOwnPropertyDescriptor(map, actorKey)?.value as
        | Record<string, number>
        | undefined;
      if (inner !== undefined && typeof inner === 'object' && inner !== null) {
        setOwnProperty(out, actorKey, cloneNumberRecord(inner));
      }
    }
  }
  return out;
}

function cloneCombatState(state: CombatState): CombatState {
  const combatants: Record<string, CombatantState> = {};
  for (const id of getSafeCombatantIds(state)) {
    const c = getSafeCombatant(state, id);
    if (c !== undefined) {
      setOwnProperty(combatants, id, cloneCombatant(c));
    }
  }

  return {
    active: state.active,
    mode: state.mode,
    round: state.round,
    turnIndex: state.turnIndex,
    initiativeOrder: [...state.initiativeOrder],
    grid: cloneGrid(state.grid),
    combatants,
    triggerCountsThisTurn: cloneTriggerCountsMap(state.triggerCountsThisTurn),
    ...(state.encounterActionPending !== undefined
      ? { encounterActionPending: state.encounterActionPending }
      : {}),
  };
}

function getStatusModifierSum(combatant: CombatantState, statKey: string): number {
  if (!isSafeKey(statKey)) {
    return 0;
  }
  let total = 0;
  for (const status of combatant.statuses) {
    if (status.remainingTurns > 0 && status.statModifiers !== undefined) {
      total += getOwnNumber(status.statModifiers, statKey) ?? 0;
    }
  }
  return total;
}

function getEffectiveStat(combatant: CombatantState, statKey: string): number {
  if (!isSafeKey(statKey)) {
    return 0;
  }
  return (getOwnNumber(combatant.stats, statKey) ?? 0) + getStatusModifierSum(combatant, statKey);
}

function getActorTriggerCounts(
  combat: CombatState,
  actorId: string
): Record<string, number> {
  if (!isSafeKey(actorId) || !Object.hasOwn(combat.triggerCountsThisTurn, actorId)) {
    return {};
  }
  const counts = Object.getOwnPropertyDescriptor(combat.triggerCountsThisTurn, actorId)?.value as
    | Record<string, number>
    | undefined;
  return counts !== undefined ? cloneNumberRecord(counts) : {};
}

function setActorTriggerCounts(
  combat: CombatState,
  actorId: string,
  counts: Record<string, number>
): void {
  if (isSafeKey(actorId)) {
    setOwnProperty(combat.triggerCountsThisTurn, actorId, cloneNumberRecord(counts));
  }
}

function buildStatusEffectFromSpec(spec: SkillEffectSpec): ActiveStatusEffect {
  const id = spec.statusId ?? 'effect';
  const normalized = id.toLowerCase();
  const duration = Math.max(1, spec.statusDuration ?? 1);
  const intensity = spec.statusIntensity ?? 1;

  if (normalized === 'stun' || normalized === 'stunned') {
    return {
      id,
      name: id === 'stunned' ? 'Stunned' : id,
      remainingTurns: duration,
      intensity,
      stackPolicy: 'refresh',
      tickTiming: 'turn_end',
      stun: true,
    };
  }
  if (normalized === 'root' || normalized === 'rooted') {
    return {
      id,
      name: id === 'rooted' ? 'Rooted' : id,
      remainingTurns: duration,
      intensity,
      stackPolicy: 'refresh',
      tickTiming: 'turn_end',
      root: true,
    };
  }
  if (normalized === 'guarded') {
    return {
      id,
      name: 'Guarded',
      remainingTurns: duration,
      intensity,
      stackPolicy: 'refresh',
      tickTiming: 'turn_start',
      statModifiers: { ac: 2 * intensity },
    };
  }
  if (normalized === 'burning' || normalized === 'poison' || normalized === 'poisoned') {
    return {
      id,
      name: id,
      remainingTurns: duration,
      intensity,
      stackPolicy: 'stack_intensity',
      tickTiming: 'turn_start',
      damageDice: spec.dice ?? '1d4',
    };
  }
  if (normalized === 'regeneration') {
    return {
      id,
      name: 'Regeneration',
      remainingTurns: duration,
      intensity,
      stackPolicy: 'refresh',
      tickTiming: 'turn_start',
      healDice: spec.dice ?? '1d4',
    };
  }
  return {
    id,
    name: id,
    remainingTurns: duration,
    intensity,
    stackPolicy: 'refresh',
    tickTiming: 'turn_start',
    ...(spec.dice !== undefined ? { damageDice: spec.dice } : {}),
  };
}

function clampHp(value: number, maxHp: number): number {
  const safeMax = Math.max(0, maxHp);
  const clamped = Math.max(0, Math.min(safeMax, value));
  return clamped === 0 ? 0 : clamped;
}

function recordDamage(damageDealt: Record<string, number>, targetId: string, amount: number): void {
  if (!isSafeKey(targetId) || amount <= 0) {
    return;
  }
  const prev = getOwnNumber(damageDealt, targetId) ?? 0;
  setOwnProperty(damageDealt, targetId, prev + amount);
}

function markDefeatedIfDead(combatant: CombatantState, defeatedIds: string[]): boolean {
  if (combatant.hp <= 0) {
    combatant.hp = 0;
    if (combatant.alive) {
      combatant.alive = false;
      if (!defeatedIds.includes(combatant.id)) {
        defeatedIds.push(combatant.id);
      }
      return true;
    }
  }
  return false;
}

function computeEffectMagnitude(
  effect: SkillEffectSpec,
  caster: CombatantState,
  rng: RngState
): { amount: number; nextRng: RngState } {
  let currentRng = rng;
  let total = 0;

  if (effect.dice !== undefined) {
    const rollRes = rollDice(effect.dice, currentRng);
    if (!rollRes.ok) {
      throw new RefereeError(
        `Invalid dice notation "${effect.dice}": ${formatValidationErrors(rollRes.error)}`,
        { code: 'INVALID_SKILL_DICE', details: rollRes.error }
      );
    }
    currentRng = rollRes.value.nextState;
    total += rollRes.value.total;
  }
  if (effect.flat !== undefined) {
    total += effect.flat;
  }
  if (effect.scalingStat !== undefined) {
    total += getEffectiveStat(caster, effect.scalingStat);
  }

  return { amount: total, nextRng: currentRng };
}

function stepKnockback(
  combat: CombatState,
  casterCoord: GridCoord,
  target: CombatantState,
  distance: number
): void {
  if (combat.mode !== 'tactical_grid' || combat.grid === null || distance <= 0) {
    return;
  }
  const dx = Math.sign(target.coord.x - casterCoord.x);
  const dy = Math.sign(target.coord.y - casterCoord.y);
  if (dx === 0 && dy === 0) {
    return;
  }

  const occupiedKeys = new Set<string>();
  for (const id of getSafeCombatantIds(combat)) {
    const c = getSafeCombatant(combat, id);
    if (c !== undefined && c.alive && c.hp > 0 && c.id !== target.id) {
      occupiedKeys.add(`${c.coord.x},${c.coord.y}`);
    }
  }

  const steps = Math.floor(distance);
  for (let i = 0; i < steps; i += 1) {
    const nextCoord: GridCoord = { x: target.coord.x + dx, y: target.coord.y + dy };
    const tile = getTileAt(combat.grid, nextCoord);
    if (tile === null || !tile.passable || occupiedKeys.has(`${nextCoord.x},${nextCoord.y}`)) {
      break;
    }
    target.coord = nextCoord;
  }
}

interface TurnExecutionContext {
  combat: CombatState;
  rng: RngState;
  executedActions: string[];
  damageDealt: Record<string, number>;
  defeatedIds: string[];
  newlyTriggeredCooldowns: Set<string>;
}

function applySelfPassiveEffects(
  ctx: TurnExecutionContext,
  owner: CombatantState,
  hook: PassiveTriggerHook
): void {
  if (!owner.alive || owner.hp <= 0) {
    return;
  }
  const counts = getActorTriggerCounts(ctx.combat, owner.id);
  const evalRes = evaluatePassiveHooks({
    hook,
    passives: owner.passives,
    triggerCountsThisTurn: counts,
    recursionDepth: 0,
    maxRecursionDepth: DEFAULT_MAX_PASSIVE_RECURSION_DEPTH,
    actorStats: { hp: owner.hp, maxHp: owner.maxHp, willpower: owner.willpower },
  });
  setActorTriggerCounts(ctx.combat, owner.id, evalRes.nextTriggerCounts);

  for (const passive of evalRes.triggered) {
    const mag = computeEffectMagnitude(passive.effect, owner, ctx.rng);
    ctx.rng = mag.nextRng;
    switch (passive.effect.type) {
      case 'heal': {
        owner.hp = clampHp(owner.hp + Math.max(0, mag.amount), owner.maxHp);
        break;
      }
      case 'restore_resource': {
        const resKey = passive.effect.resourceKey;
        if (resKey !== undefined && isSafeKey(resKey)) {
          const prev = getOwnNumber(owner.resources, resKey) ?? 0;
          setOwnProperty(owner.resources, resKey, prev + Math.max(0, mag.amount));
        }
        break;
      }
      case 'apply_status': {
        if (passive.effect.statusId !== undefined) {
          owner.statuses = applyStatusEffect(owner.statuses, buildStatusEffectFromSpec(passive.effect));
        }
        break;
      }
      case 'remove_status': {
        if (passive.effect.statusId !== undefined) {
          owner.statuses = owner.statuses.filter((s) => s.id !== passive.effect.statusId);
        }
        break;
      }
      default:
        break;
    }
  }
}

function triggerOnDamagedChain(
  ctx: TurnExecutionContext,
  reactor: CombatantState,
  attacker: CombatantState,
  recursionDepth: number
): void {
  if (recursionDepth > DEFAULT_MAX_PASSIVE_RECURSION_DEPTH || !reactor.alive || reactor.hp <= 0) {
    return;
  }

  const counts = getActorTriggerCounts(ctx.combat, reactor.id);
  const evalRes = evaluatePassiveHooks({
    hook: 'on_damaged',
    passives: reactor.passives,
    triggerCountsThisTurn: counts,
    recursionDepth,
    maxRecursionDepth: DEFAULT_MAX_PASSIVE_RECURSION_DEPTH,
    actorStats: { hp: reactor.hp, maxHp: reactor.maxHp, willpower: reactor.willpower },
  });
  setActorTriggerCounts(ctx.combat, reactor.id, evalRes.nextTriggerCounts);

  for (const passive of evalRes.triggered) {
    const mag = computeEffectMagnitude(passive.effect, reactor, ctx.rng);
    ctx.rng = mag.nextRng;

    switch (passive.effect.type) {
      case 'damage': {
        if (attacker.alive && attacker.hp > 0) {
          const dmg = Math.max(0, mag.amount);
          attacker.hp = clampHp(attacker.hp - dmg, attacker.maxHp);
          recordDamage(ctx.damageDealt, attacker.id, dmg);
          const attackerDied = markDefeatedIfDead(attacker, ctx.defeatedIds);
          if (attackerDied) {
            handleTargetDefeated(ctx, reactor, attacker);
          } else if (dmg > 0 && attacker.alive) {
            triggerOnDamagedChain(ctx, attacker, reactor, recursionDepth + 1);
          }
        }
        break;
      }
      case 'heal': {
        reactor.hp = clampHp(reactor.hp + Math.max(0, mag.amount), reactor.maxHp);
        break;
      }
      case 'apply_status': {
        if (passive.effect.statusId !== undefined) {
          reactor.statuses = applyStatusEffect(reactor.statuses, buildStatusEffectFromSpec(passive.effect));
        }
        break;
      }
      case 'restore_resource': {
        const resKey = passive.effect.resourceKey;
        if (resKey !== undefined && isSafeKey(resKey)) {
          const prev = getOwnNumber(reactor.resources, resKey) ?? 0;
          setOwnProperty(reactor.resources, resKey, prev + Math.max(0, mag.amount));
        }
        break;
      }
      default:
        break;
    }
  }
}

function triggerOnHitPassives(
  ctx: TurnExecutionContext,
  actor: CombatantState,
  target: CombatantState
): void {
  if (!actor.alive || actor.hp <= 0) {
    return;
  }
  const counts = getActorTriggerCounts(ctx.combat, actor.id);
  const evalRes = evaluatePassiveHooks({
    hook: 'on_hit',
    passives: actor.passives,
    triggerCountsThisTurn: counts,
    recursionDepth: 0,
    maxRecursionDepth: DEFAULT_MAX_PASSIVE_RECURSION_DEPTH,
    actorStats: { hp: actor.hp, maxHp: actor.maxHp, willpower: actor.willpower },
  });
  setActorTriggerCounts(ctx.combat, actor.id, evalRes.nextTriggerCounts);

  for (const passive of evalRes.triggered) {
    const mag = computeEffectMagnitude(passive.effect, actor, ctx.rng);
    ctx.rng = mag.nextRng;
    switch (passive.effect.type) {
      case 'damage': {
        if (target.alive && target.hp > 0) {
          const dmg = Math.max(0, mag.amount);
          target.hp = clampHp(target.hp - dmg, target.maxHp);
          recordDamage(ctx.damageDealt, target.id, dmg);
          markDefeatedIfDead(target, ctx.defeatedIds);
        }
        break;
      }
      case 'heal': {
        actor.hp = clampHp(actor.hp + Math.max(0, mag.amount), actor.maxHp);
        break;
      }
      case 'apply_status': {
        if (passive.effect.statusId !== undefined && target.alive) {
          target.statuses = applyStatusEffect(target.statuses, buildStatusEffectFromSpec(passive.effect));
        }
        break;
      }
      case 'restore_resource': {
        const resKey = passive.effect.resourceKey;
        if (resKey !== undefined && isSafeKey(resKey)) {
          const prev = getOwnNumber(actor.resources, resKey) ?? 0;
          setOwnProperty(actor.resources, resKey, prev + Math.max(0, mag.amount));
        }
        break;
      }
      default:
        break;
    }
  }
}

function handleTargetDefeated(
  ctx: TurnExecutionContext,
  killer: CombatantState,
  victim: CombatantState
): void {
  applySelfPassiveEffects(ctx, killer, 'on_kill');
  const killerWill = adjustWillpower(killer.willpower, killer.maxWillpower, 2);
  killer.willpower = killerWill.next;

  for (const id of getSafeCombatantIds(ctx.combat)) {
    if (id === victim.id) {
      continue;
    }
    const ally = getSafeCombatant(ctx.combat, id);
    if (ally !== undefined && ally.alive && ally.hp > 0 && ally.team === victim.team) {
      applySelfPassiveEffects(ctx, ally, 'on_ally_down');
      const allyWill = adjustWillpower(ally.willpower, ally.maxWillpower, -2);
      ally.willpower = allyWill.next;
    }
  }
}

function executeSkillOnTarget(
  ctx: TurnExecutionContext,
  actor: CombatantState,
  target: CombatantState,
  skill: SkillDefinition
): void {
  if (!target.alive || target.hp <= 0) {
    return;
  }

  let coverAcBonus = 0;
  if (ctx.combat.mode === 'tactical_grid' && ctx.combat.grid !== null && target.id !== actor.id) {
    const los = evaluateLineOfSight(ctx.combat.grid, actor.coord, target.coord);
    if (los.cover === 'half') {
      coverAcBonus = 2;
    } else if (los.cover === 'full') {
      coverAcBonus = 5;
    }
  }

  let didHit = true;
  let saveSucceeded = false;

  if (skill.hitResolution.kind === 'attack_roll') {
    const rollRes = unwrap(rollDice('1d20', ctx.rng));
    ctx.rng = rollRes.nextState;
    const attackStat = skill.hitResolution.stat ?? 'str';
    const attackTotal = rollRes.total + getEffectiveStat(actor, attackStat);
    const effectiveAc = target.ac + getStatusModifierSum(target, 'ac') + coverAcBonus;
    didHit = attackTotal >= effectiveAc;
  } else if (skill.hitResolution.kind === 'save') {
    const saveRes = unwrap(rollDice('1d20', ctx.rng));
    ctx.rng = saveRes.nextState;
    const saveStat = skill.hitResolution.saveStat ?? 'dex';
    const dc = skill.hitResolution.dc ?? 10;
    const saveTotal = saveRes.total + getEffectiveStat(target, saveStat);
    saveSucceeded = saveTotal >= dc;
    didHit = true;
  }

  if (!didHit) {
    return;
  }

  const targetWasAlive = target.alive;
  let totalDamageTaken = 0;

  for (const effect of skill.effects) {
    const mag = computeEffectMagnitude(effect, actor, ctx.rng);
    ctx.rng = mag.nextRng;

    switch (effect.type) {
      case 'damage': {
        let dmg = Math.max(0, mag.amount);
        if (skill.hitResolution.kind === 'save' && saveSucceeded) {
          dmg = Math.floor(dmg / 2);
        }
        target.hp = clampHp(target.hp - dmg, target.maxHp);
        recordDamage(ctx.damageDealt, target.id, dmg);
        totalDamageTaken += dmg;
        markDefeatedIfDead(target, ctx.defeatedIds);
        break;
      }

      case 'heal': {
        if (target.alive && target.hp > 0) {
          const healAmt = Math.max(0, mag.amount);
          target.hp = clampHp(target.hp + healAmt, target.maxHp);
        }
        break;
      }

      case 'apply_status': {
        if (skill.hitResolution.kind === 'save' && saveSucceeded) {
          break;
        }
        if (target.alive && target.hp > 0 && effect.statusId !== undefined) {
          target.statuses = applyStatusEffect(target.statuses, buildStatusEffectFromSpec(effect));
        }
        break;
      }

      case 'remove_status': {
        if (effect.statusId !== undefined) {
          target.statuses = target.statuses.filter((s) => s.id !== effect.statusId);
        }
        break;
      }

      case 'restore_resource': {
        const resKey = effect.resourceKey;
        if (target.alive && resKey !== undefined && isSafeKey(resKey)) {
          const prev = getOwnNumber(target.resources, resKey) ?? 0;
          setOwnProperty(target.resources, resKey, prev + Math.max(0, mag.amount));
        }
        break;
      }

      case 'knockback': {
        if (skill.hitResolution.kind === 'save' && saveSucceeded) {
          break;
        }
        if (target.alive && target.hp > 0 && effect.distance !== undefined) {
          stepKnockback(ctx.combat, actor.coord, target, effect.distance);
        }
        break;
      }
    }
  }

  if (target.id !== actor.id) {
    triggerOnHitPassives(ctx, actor, target);
    if (totalDamageTaken > 0) {
      if (target.alive && target.hp > 0) {
        const willDelta = -Math.max(1, Math.floor(totalDamageTaken / 4));
        const willRes = adjustWillpower(target.willpower, target.maxWillpower, willDelta);
        target.willpower = willRes.next;
        triggerOnDamagedChain(ctx, target, actor, 0);
      }
    }
    if (targetWasAlive && !target.alive) {
      handleTargetDefeated(ctx, actor, target);
    }
  }
}

function executeValidatedAction(
  ctx: TurnExecutionContext,
  actor: CombatantState,
  action: ProposedCombatAction,
  payload: {
    resolvedPath?: GridCoord[];
    moveCost?: number;
    skill?: SkillDefinition;
    resolvedTargetIds?: string[];
  }
): 'continue' | 'end_turn' {
  switch (action.type) {
    case 'move': {
      if (payload.resolvedPath !== undefined && payload.resolvedPath.length > 0) {
        const dest = payload.resolvedPath[payload.resolvedPath.length - 1] as GridCoord;
        actor.coord = { x: dest.x, y: dest.y };
      }
      actor.remainingMovement = Math.max(0, actor.remainingMovement - (payload.moveCost ?? 0));
      ctx.executedActions.push(`move:${actor.coord.x},${actor.coord.y}`);
      return 'continue';
    }

    case 'defend': {
      actor.remainingActions.action = Math.max(0, actor.remainingActions.action - 1);
      actor.statuses = applyStatusEffect(actor.statuses, {
        id: 'guarded',
        name: 'Guarded',
        remainingTurns: 1,
        intensity: 1,
        stackPolicy: 'refresh',
        tickTiming: 'turn_start',
        statModifiers: { ac: 2 },
      });
      ctx.executedActions.push('defend');
      return 'continue';
    }

    case 'end_turn': {
      ctx.executedActions.push('end_turn');
      return 'end_turn';
    }

    case 'skill': {
      const skill = payload.skill;
      if (skill === undefined) {
        return 'continue';
      }

      if (skill.actionCost === 'action') {
        actor.remainingActions.action = Math.max(0, actor.remainingActions.action - 1);
      } else if (skill.actionCost === 'bonus') {
        actor.remainingActions.bonus = Math.max(0, actor.remainingActions.bonus - 1);
      } else if (skill.actionCost === 'reaction') {
        actor.remainingActions.reaction = Math.max(0, actor.remainingActions.reaction - 1);
      }

      for (const resKey of Object.keys(skill.resourceCosts)) {
        if (!isSafeKey(resKey) || !Object.hasOwn(skill.resourceCosts, resKey)) {
          continue;
        }
        const cost = getOwnNumber(skill.resourceCosts, resKey) ?? 0;
        if (cost > 0) {
          const prev = getOwnNumber(actor.resources, resKey) ?? 0;
          setOwnProperty(actor.resources, resKey, Math.max(0, prev - cost));
        }
      }

      if (skill.cooldownTurns !== undefined && skill.cooldownTurns > 0) {
        setOwnProperty(actor.cooldowns, skill.id, skill.cooldownTurns);
        ctx.newlyTriggeredCooldowns.add(skill.id);
      }

      const targetIds = payload.resolvedTargetIds ?? [];
      for (const targetId of targetIds) {
        if (!actor.alive || actor.hp <= 0) {
          break;
        }
        const target = getSafeCombatant(ctx.combat, targetId);
        if (target !== undefined) {
          executeSkillOnTarget(ctx, actor, target, skill);
        }
      }

      ctx.executedActions.push(`skill:${skill.id}`);
      return 'continue';
    }
  }
}

function evaluateEncounterOutcome(combat: CombatState): {
  encounterEnded: boolean;
  winnerTeam: CombatTeam | 'draw' | null;
} {
  let livingAllies = 0;
  let livingEnemies = 0;
  let hadAllies = false;
  let hadEnemies = false;

  for (const id of getSafeCombatantIds(combat)) {
    const c = getSafeCombatant(combat, id);
    if (c === undefined) {
      continue;
    }
    if (c.team === 'ally') {
      hadAllies = true;
      if (c.alive && c.hp > 0) {
        livingAllies += 1;
      }
    } else if (c.team === 'enemy') {
      hadEnemies = true;
      if (c.alive && c.hp > 0) {
        livingEnemies += 1;
      }
    }
  }

  if (hadAllies && hadEnemies) {
    if (livingAllies === 0 && livingEnemies === 0) {
      return { encounterEnded: true, winnerTeam: 'draw' };
    }
    if (livingEnemies === 0) {
      return { encounterEnded: true, winnerTeam: 'ally' };
    }
    if (livingAllies === 0) {
      return { encounterEnded: true, winnerTeam: 'enemy' };
    }
  } else if (hadEnemies && livingEnemies === 0) {
    return { encounterEnded: true, winnerTeam: 'ally' };
  } else if (hadAllies && livingAllies === 0) {
    return { encounterEnded: true, winnerTeam: 'enemy' };
  }

  return { encounterEnded: false, winnerTeam: null };
}

function advanceTurnPointer(combat: CombatState, actorId: string): void {
  const order = combat.initiativeOrder;
  if (order.length === 0) {
    return;
  }

  const currentIdx =
    order[combat.turnIndex] === actorId
      ? combat.turnIndex
      : Math.max(0, order.indexOf(actorId));

  for (let offset = 1; offset <= order.length; offset += 1) {
    const rawNext = currentIdx + offset;
    const candidateIdx = rawNext % order.length;
    const candidateId = order[candidateIdx];
    if (candidateId === undefined) {
      continue;
    }
    const candidate = getSafeCombatant(combat, candidateId);
    if (candidate !== undefined && candidate.alive && candidate.hp > 0) {
      if (rawNext >= order.length) {
        combat.round += 1;
      }
      combat.turnIndex = candidateIdx;
      return;
    }
  }
}

function decrementCooldowns(actor: CombatantState, skipKeys: ReadonlySet<string>): void {
  for (const skillId of Object.keys(actor.cooldowns)) {
    if (!isSafeKey(skillId) || !Object.hasOwn(actor.cooldowns, skillId)) {
      continue;
    }
    if (skipKeys.has(skillId)) {
      continue;
    }
    const val = getOwnNumber(actor.cooldowns, skillId) ?? 0;
    const nextVal = Math.max(0, val - 1);
    setOwnProperty(actor.cooldowns, skillId, nextVal);
  }
}

function applyTickDamageAndHealing(
  combatant: CombatantState,
  tickDamageTotal: number,
  tickHealingTotal: number,
  defeatedIds: string[],
  damageDealt: Record<string, number>
): void {
  if (tickDamageTotal > 0) {
    combatant.hp = clampHp(combatant.hp - tickDamageTotal, combatant.maxHp);
    recordDamage(damageDealt, combatant.id, tickDamageTotal);
    markDefeatedIfDead(combatant, defeatedIds);
  }
  if (tickHealingTotal > 0 && combatant.alive && combatant.hp > 0) {
    combatant.hp = clampHp(combatant.hp + tickHealingTotal, combatant.maxHp);
  }
}

function buildSummaryText(summary: Omit<CombatOutcomeSummary, 'summaryText'>): string {
  const parts: string[] = [
    `Round ${summary.round} [${summary.actorId}]:`,
    summary.executedActions.length > 0 ? summary.executedActions.join(', ') : 'no actions',
  ];
  if (summary.usedFallback) {
    parts.push(`(fallback, salvaged=${summary.salvagedPrefixCount})`);
  }
  const dmgEntries = Object.entries(summary.damageDealt);
  if (dmgEntries.length > 0) {
    parts.push(
      `damage={${dmgEntries.map(([id, dmg]) => `${id}:${dmg}`).join(', ')}}`
    );
  }
  if (summary.defeatedIds.length > 0) {
    parts.push(`defeated=[${summary.defeatedIds.join(', ')}]`);
  }
  if (summary.encounterEnded) {
    parts.push(`encounter ended (winner=${String(summary.winnerTeam)})`);
  }
  return parts.join(' ');
}

function syncWorldPatches(
  combat: CombatState,
  worldState: WorldState,
  encounterEnded: boolean,
  winnerTeam: CombatTeam | 'draw' | null,
  xpAwardOnVictory: number | undefined,
  summaryText: string
): PatchOperation[] {
  const patches: PatchOperation[] = [];

  for (const id of getSafeCombatantIds(combat)) {
    const combatant = getSafeCombatant(combat, id);
    if (combatant === undefined || !Object.hasOwn(worldState.entities.characters, id)) {
      continue;
    }
    const char = Object.getOwnPropertyDescriptor(worldState.entities.characters, id)?.value as
      | CharacterEntity
      | undefined;
    if (char === undefined) {
      continue;
    }

    if (char.resources !== undefined && Object.hasOwn(char.resources, 'hp')) {
      const hpPool = char.resources['hp'];
      if (hpPool !== undefined) {
        const clampedWorldHp = Math.max(0, Math.min(hpPool.max, combatant.hp));
        patches.push({
          op: 'set',
          path: `entities.characters.${id}.resources.hp.current`,
          value: clampedWorldHp === 0 ? 0 : clampedWorldHp,
        });
      }
    }

    if ((!combatant.alive || combatant.hp <= 0) && char.status !== 'dead') {
      patches.push({
        op: 'set',
        path: `entities.characters.${id}.status`,
        value: 'dead',
      });
    }
  }

  if (
    encounterEnded &&
    winnerTeam === 'ally' &&
    xpAwardOnVictory !== undefined &&
    xpAwardOnVictory > 0 &&
    worldState.capabilities.progression !== 'disabled'
  ) {
    for (const id of getSafeCombatantIds(combat)) {
      const combatant = getSafeCombatant(combat, id);
      if (
        combatant === undefined ||
        combatant.team !== 'ally' ||
        !combatant.alive ||
        !Object.hasOwn(worldState.entities.characters, id)
      ) {
        continue;
      }
      const char = Object.getOwnPropertyDescriptor(worldState.entities.characters, id)?.value as
        | CharacterEntity
        | undefined;
      if (char === undefined) {
        continue;
      }
      const syncedChar: CharacterEntity = {
        ...char,
        ...(char.resources !== undefined
          ? {
              resources: {
                ...char.resources,
                ...(Object.hasOwn(char.resources, 'hp') && char.resources['hp'] !== undefined
                  ? {
                      hp: {
                        current: Math.max(0, Math.min(char.resources['hp'].max, combatant.hp)),
                        max: char.resources['hp'].max,
                      },
                    }
                  : {}),
              },
            }
          : {}),
      };
      const xpRes = awardExperience(syncedChar, xpAwardOnVictory, worldState.capabilities);
      patches.push(...xpRes.patches);
    }
  }

  patches.push({
    op: 'push',
    path: 'turnEvents.combatOutcomes',
    value: summaryText,
  });

  if (encounterEnded) {
    patches.push({ op: 'clock_release' });
  }

  return patches;
}

/**
 * Initialize a deterministic combat encounter in `tactical_grid` or `traditional` mode,
 * deploying participants, rolling initiative order, and emitting a `clock_hold` patch.
 */
export function startCombatEncounter(
  params: StartCombatEncounterParams
): StartCombatEncounterResult {
  let currentRng = params.rng;
  const clonedParticipants = params.participants.map(cloneCombatant);
  for (const p of clonedParticipants) {
    if (!isSafeKey(p.id)) {
      throw new RefereeError(`Invalid or forbidden combatant id "${p.id}"`, {
        code: 'INVALID_COMBATANT_ID',
      });
    }
    p.hp = clampHp(p.hp, p.maxHp);
    p.alive = p.alive && p.hp > 0;
    p.remainingMovement = Math.max(0, p.speed);
    p.remainingActions = { action: 1, bonus: 1, reaction: 1 };
  }

  let grid: TacticalGrid | null = null;
  if (params.mode === 'tactical_grid') {
    const width = Math.max(4, params.gridSize?.width ?? 10);
    const height = Math.max(4, params.gridSize?.height ?? 8);
    const theme: TerrainTheme = params.theme ?? 'open';
    const gridRes = unwrap(
      generateTacticalGrid({
        width,
        height,
        theme,
        rng: currentRng,
      })
    );
    grid = gridRes.grid;
    currentRng = gridRes.nextRng;

    const allies = clonedParticipants.filter((p) => p.team === 'ally');
    const enemies = clonedParticipants.filter((p) => p.team === 'enemy');
    const neutrals = clonedParticipants.filter((p) => p.team === 'neutral');

    const occupied: GridCoord[] = [];
    const allyCoords = generateDeploymentCoords(grid, allies.length, 'ally', occupied);
    for (let i = 0; i < allies.length; i += 1) {
      const coord = allyCoords[i];
      if (coord !== undefined) {
        allies[i]!.coord = { x: coord.x, y: coord.y };
        occupied.push(coord);
      }
    }

    const enemyCoords = generateDeploymentCoords(grid, enemies.length, 'enemy', occupied);
    for (let i = 0; i < enemies.length; i += 1) {
      const coord = enemyCoords[i];
      if (coord !== undefined) {
        enemies[i]!.coord = { x: coord.x, y: coord.y };
        occupied.push(coord);
      }
    }

    if (neutrals.length > 0) {
      const neutralCoords = generateDeploymentCoords(grid, neutrals.length, 'ally', occupied);
      for (let i = 0; i < neutrals.length; i += 1) {
        const coord = neutralCoords[i];
        if (coord !== undefined) {
          neutrals[i]!.coord = { x: coord.x, y: coord.y };
          occupied.push(coord);
        }
      }
    }
  }

  const initParticipants: InitiativeParticipant[] = clonedParticipants.map((p) => ({
    id: p.id,
    initiativeBonus: getOwnNumber(p.stats, 'initiative') ?? getOwnNumber(p.stats, 'dex') ?? 0,
  }));
  const initRes = rollInitiativeOrder(initParticipants, currentRng);
  currentRng = initRes.nextRng;

  const initiativeOrder = initRes.order.map((e) => e.id);
  const combatants: Record<string, CombatantState> = {};
  for (const p of clonedParticipants) {
    if (Object.hasOwn(combatants, p.id)) {
      throw new RefereeError(`Duplicate combatant id "${p.id}" in startCombatEncounter`, {
        code: 'DUPLICATE_COMBATANT_ID',
      });
    }
    setOwnProperty(combatants, p.id, p);
  }

  let firstLivingIndex = 0;
  for (let i = 0; i < initiativeOrder.length; i += 1) {
    const id = initiativeOrder[i] as string;
    const combatant = getSafeCombatant({ combatants } as CombatState, id);
    if (combatant !== undefined && combatant.alive && combatant.hp > 0) {
      firstLivingIndex = i;
      break;
    }
  }

  const combatState: CombatState = {
    active: true,
    mode: params.mode,
    round: 1,
    turnIndex: firstLivingIndex,
    initiativeOrder,
    grid,
    combatants,
    triggerCountsThisTurn: {},
  };

  return {
    combatState,
    worldPatches: [{ op: 'clock_hold', reason: 'combat' }],
    nextRng: currentRng,
  };
}

/**
 * Resolve a single combatant's turn deterministically with start/end status ticking,
 * partial-prefix salvage, fallback tactics AI, passives/willpower, encounter termination,
 * and world-state patch generation.
 */
export function resolveCombatTurn(
  params: ResolveCombatTurnParams
): ResolveCombatTurnResult {
  if (!isSafeKey(params.actorId)) {
    throw new RefereeError(`Invalid or forbidden actor id "${params.actorId}"`, {
      code: 'INVALID_ACTOR_ID',
    });
  }

  const nextCombatState = cloneCombatState(params.combatState);
  let currentRng = params.rng;
  const roundAtTurnStart = nextCombatState.round;

  if (!nextCombatState.active) {
    const outcome: CombatOutcomeSummary = {
      round: roundAtTurnStart,
      actorId: params.actorId,
      executedActions: [],
      salvagedPrefixCount: 0,
      usedFallback: false,
      rejectedReasons: ['COMBAT_INACTIVE: Combat encounter is not active'],
      damageDealt: {},
      defeatedIds: [],
      encounterEnded: true,
      winnerTeam: evaluateEncounterOutcome(nextCombatState).winnerTeam,
      summaryText: `Round ${roundAtTurnStart} [${params.actorId}]: combat inactive`,
    };
    return {
      nextCombatState,
      worldPatches: [],
      outcomeSummary: outcome,
      salvagedCount: 0,
      usedFallback: false,
      rejectedReasons: [...outcome.rejectedReasons],
      nextRng: currentRng,
    };
  }

  const actor = getSafeCombatant(nextCombatState, params.actorId);
  if (actor === undefined) {
    const rejectedReasons = [`ACTOR_NOT_FOUND: Combatant "${params.actorId}" not found`];
    const outcome: CombatOutcomeSummary = {
      round: roundAtTurnStart,
      actorId: params.actorId,
      executedActions: [],
      salvagedPrefixCount: 0,
      usedFallback: false,
      rejectedReasons,
      damageDealt: {},
      defeatedIds: [],
      encounterEnded: false,
      winnerTeam: null,
      summaryText: `Round ${roundAtTurnStart} [${params.actorId}]: actor not found`,
    };
    return {
      nextCombatState,
      worldPatches: [],
      outcomeSummary: outcome,
      salvagedCount: 0,
      usedFallback: false,
      rejectedReasons: [...rejectedReasons],
      nextRng: currentRng,
    };
  }

  nextCombatState.triggerCountsThisTurn = {};
  actor.remainingMovement = Math.max(0, actor.speed);
  actor.remainingActions = { action: 1, bonus: 1, reaction: 1 };

  const ctx: TurnExecutionContext = {
    combat: nextCombatState,
    rng: currentRng,
    executedActions: [],
    damageDealt: {},
    defeatedIds: [],
    newlyTriggeredCooldowns: new Set<string>(),
  };

  // Start-of-turn status ticks
  const tickStart = tickStatusEffects(actor.statuses, 'turn_start', ctx.rng);
  ctx.rng = tickStart.nextRng;
  actor.statuses = tickStart.statuses;
  applyTickDamageAndHealing(
    actor,
    tickStart.tickDamageTotal,
    tickStart.tickHealingTotal,
    ctx.defeatedIds,
    ctx.damageDealt
  );

  if (actor.alive && actor.hp > 0) {
    applySelfPassiveEffects(ctx, actor, 'on_turn_start');
  }

  const stunnedAtTurnStart = tickStart.isStunned || isActorStunned(actor);
  const rejectedReasons: string[] = [];
  let salvagedPrefixCount = 0;
  let usedFallback = false;

  if (!actor.alive || actor.hp <= 0) {
    rejectedReasons.push(`ACTOR_DEAD: Actor "${actor.id}" is defeated and skips turn`);
  } else if (stunnedAtTurnStart) {
    rejectedReasons.push(`ACTOR_STUNNED: Actor "${actor.id}" is stunned and skips turn`);
  } else {
    let needFallback = params.proposedActions.length === 0;

    for (const action of params.proposedActions) {
      const checkOutcome = evaluateEncounterOutcome(nextCombatState);
      if (checkOutcome.encounterEnded || !actor.alive || actor.hp <= 0) {
        break;
      }

      const validation = validateSingleCombatAction(
        nextCombatState,
        params.actorId,
        action,
        params.registry
      );
      if (!validation.ok) {
        for (const errItem of validation.error) {
          rejectedReasons.push(`${errItem.code}: ${errItem.message}`);
        }
        salvagedPrefixCount = ctx.executedActions.length;
        needFallback = true;
        break;
      }

      const stepSignal = executeValidatedAction(ctx, actor, action, validation.value);
      if (stepSignal === 'end_turn') {
        break;
      }
    }

    const midOutcome = evaluateEncounterOutcome(nextCombatState);
    if (needFallback && !midOutcome.encounterEnded && actor.alive && actor.hp > 0) {
      const fallbackActions = computeFallbackActions(
        nextCombatState,
        params.actorId,
        params.registry
      );
      if (fallbackActions.length > 0) {
        usedFallback = true;
        for (const fbAction of fallbackActions) {
          const checkOutcome = evaluateEncounterOutcome(nextCombatState);
          if (checkOutcome.encounterEnded || !actor.alive || actor.hp <= 0) {
            break;
          }
          const validation = validateSingleCombatAction(
            nextCombatState,
            params.actorId,
            fbAction,
            params.registry
          );
          if (!validation.ok) {
            continue;
          }
          const stepSignal = executeValidatedAction(ctx, actor, fbAction, validation.value);
          if (stepSignal === 'end_turn') {
            break;
          }
        }
      }
    }
  }

  // End-of-turn status ticks and cooldown decay for the acting combatant
  const tickEnd = tickStatusEffects(actor.statuses, 'turn_end', ctx.rng);
  ctx.rng = tickEnd.nextRng;
  actor.statuses = tickEnd.statuses;
  if (actor.alive && actor.hp > 0) {
    applyTickDamageAndHealing(
      actor,
      tickEnd.tickDamageTotal,
      tickEnd.tickHealingTotal,
      ctx.defeatedIds,
      ctx.damageDealt
    );
  }
  decrementCooldowns(actor, ctx.newlyTriggeredCooldowns);

  const finalOutcome = evaluateEncounterOutcome(nextCombatState);
  if (finalOutcome.encounterEnded) {
    nextCombatState.active = false;
  } else {
    advanceTurnPointer(nextCombatState, params.actorId);
  }

  const baseSummary: Omit<CombatOutcomeSummary, 'summaryText'> = {
    round: roundAtTurnStart,
    actorId: params.actorId,
    executedActions: [...ctx.executedActions],
    salvagedPrefixCount,
    usedFallback,
    rejectedReasons: [...rejectedReasons],
    damageDealt: cloneNumberRecord(ctx.damageDealt),
    defeatedIds: [...ctx.defeatedIds],
    encounterEnded: finalOutcome.encounterEnded,
    winnerTeam: finalOutcome.winnerTeam,
  };
  const summaryText = buildSummaryText(baseSummary);
  const outcomeSummary: CombatOutcomeSummary = {
    ...baseSummary,
    summaryText,
  };

  const worldPatches = syncWorldPatches(
    nextCombatState,
    params.worldState,
    finalOutcome.encounterEnded,
    finalOutcome.winnerTeam,
    params.xpAwardOnVictory,
    summaryText
  );

  return {
    nextCombatState,
    worldPatches,
    outcomeSummary,
    salvagedCount: salvagedPrefixCount,
    usedFallback,
    rejectedReasons: [...rejectedReasons],
    nextRng: ctx.rng,
  };
}
