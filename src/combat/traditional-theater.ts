import { rollDice } from '../core/dice.js';
import { RefereeError } from '../core/errors.js';
import type { RngState } from '../core/prng.js';
import { unwrap } from '../core/result.js';
import type { PatchOperation } from '../state/patch.js';
import type { CharacterEntity, WorldState } from '../state/world-state.js';
import {
  type CombatState,
  type CombatTeam,
  type CombatantState,
  type ProposedCombatAction,
  areTeamsHostile,
  getOwnNumber,
  getSafeCombatant,
  getSafeCombatantIds,
  isActorStunned,
  isSafeKey,
  resolveSkillDefinition,
  setOwnProperty,
} from './action-validator.js';
import {
  computeCombatVariables,
  resolveScaledDiceExpression,
} from './combat-variables.js';
import { expandEffectTemplateTargets } from './effect-templates.js';
import { computeFallbackActions } from './fallback-tactics.js';
import {
  DEFAULT_MAX_PASSIVE_RECURSION_DEPTH,
  type PassiveDefinition,
  type PassiveTriggerHook,
  type WillpowerBreakOutcome,
  adjustWillpower,
  evaluatePassiveHooks,
  isCriticalNaturalRoll,
  isFumbleNaturalRoll,
  resolveWillpowerBreak,
} from './passives-and-willpower.js';
import { awardExperience } from './rpg-progression.js';
import type { SkillDefinition, SkillEffectSpec, SkillRegistry } from './skill-registry.js';
import {
  type ActiveStatusEffect,
  applyStatusEffect,
  tickStatusEffects,
} from './status-effects.js';
import {
  type InitiativeParticipant,
  rollInitiativeOrder,
} from './terrain-generator.js';

export type TraditionalTurnStyle = 'initiative' | 'phased';
export type TraditionalPhase = 'player' | 'enemy';
export type FormationRow = 'front' | 'back';

export interface TraditionalFormationConfig {
  enforceFrontRowGuard: boolean;
  frontRowInterceptionMode: 'redirect' | 'block';
  backRowCoverAcBonus: number;
}

export const DEFAULT_TRADITIONAL_FORMATION_CONFIG: TraditionalFormationConfig = {
  enforceFrontRowGuard: true,
  frontRowInterceptionMode: 'redirect',
  backRowCoverAcBonus: 2,
};

export interface TraditionalCombatState extends CombatState {
  mode: 'traditional';
  turnStyle: TraditionalTurnStyle;
  activePhase: TraditionalPhase;
  actedThisPhase: Record<string, boolean>;
  fledIds: string[];
  surrenderedIds: string[];
  expendedItems: Record<string, number>;
  formationConfig: TraditionalFormationConfig;
}

export interface TraditionalOutcomeSummary {
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

export interface TraditionalEnemySpec {
  id: string;
  name: string;
  maxHp: number;
  hp?: number;
  ac?: number;
  speed?: number;
  stats?: Record<string, number>;
  resources?: Record<string, number>;
  abilities?: readonly string[];
  passives?: readonly PassiveDefinition[];
  willpower?: number;
  maxWillpower?: number;
  willpowerOutcome?: WillpowerBreakOutcome;
  formationRow?: FormationRow;
  team?: CombatTeam;
}

export interface EquipmentBonusSpec {
  acBonus?: number;
  speedBonus?: number;
  statBonuses?: Record<string, number>;
  abilities?: readonly string[];
}

export interface BuildTraditionalParticipantsOptions {
  allyIds?: readonly string[];
  enemyIds?: readonly string[];
  formationRows?: Record<string, FormationRow>;
  equipmentCatalog?: Record<string, EquipmentBonusSpec>;
}

export interface BuildTraditionalParticipantsResult {
  participants: CombatantState[];
  availableItems: Record<string, number>;
}

export interface StartTraditionalEncounterParams {
  worldState: WorldState;
  participants: readonly CombatantState[];
  turnStyle?: TraditionalTurnStyle;
  formationConfig?: Partial<TraditionalFormationConfig>;
  rng: RngState;
}

export interface StartTraditionalEncounterResult {
  combatState: TraditionalCombatState;
  worldPatches: PatchOperation[];
  nextRng: RngState;
}

export interface ResolveTraditionalTargetIdsParams {
  combatState: CombatState | TraditionalCombatState;
  actorId: string;
  skill: SkillDefinition;
  primaryTargetId?: string;
}

export type ResolveTraditionalTargetIdsResult =
  | {
      ok: true;
      targetIds: string[];
      interceptedBy?: string;
      originalTargetId?: string;
    }
  | {
      ok: false;
      code: string;
      reason: string;
    };

export interface ResolveTraditionalCombatTurnParams {
  combatState: CombatState | TraditionalCombatState;
  worldState: WorldState;
  actorId: string;
  proposedActions: readonly ProposedCombatAction[];
  registry: SkillRegistry;
  rng: RngState;
  xpAwardOnVictory?: number;
  fleeDc?: number;
}

export interface ResolveTraditionalCombatTurnResult {
  nextCombatState: TraditionalCombatState;
  worldPatches: PatchOperation[];
  outcomeSummary: TraditionalOutcomeSummary;
  salvagedCount: number;
  usedFallback: boolean;
  rejectedReasons: string[];
  nextRng: RngState;
  interceptedTargets: Record<string, string>;
}

export interface ResolveTraditionalEnemyPhaseParams {
  combatState: CombatState | TraditionalCombatState;
  worldState: WorldState;
  teamActions: Record<string, readonly ProposedCombatAction[]>;
  registry: SkillRegistry;
  rng: RngState;
  xpAwardOnVictory?: number;
  fleeDc?: number;
}

export interface ResolveTraditionalEnemyPhaseResult {
  nextCombatState: TraditionalCombatState;
  worldPatches: PatchOperation[];
  turnResults: ResolveTraditionalCombatTurnResult[];
  outcomeSummary: TraditionalOutcomeSummary;
  nextRng: RngState;
}

export interface BuildTraditionalAftermathOptions {
  xpAwardOnVictory?: number;
}

function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}

function clampHp(hp: number, maxHp: number): number {
  if (!Number.isFinite(hp) || !Number.isFinite(maxHp)) {
    return 0;
  }
  return normalizeZero(Math.max(0, Math.min(maxHp, Math.trunc(hp))));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function getOwnValue(record: Record<string, unknown>, key: string): unknown {
  if (!isSafeKey(key) || !Object.hasOwn(record, key)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(record, key)?.value;
}

function cloneNumberRecord(record: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(record)) {
    if (isSafeKey(key) && Object.hasOwn(record, key)) {
      const value = getOwnNumber(record, key);
      if (value !== undefined) {
        setOwnProperty(out, key, normalizeZero(value));
      }
    }
  }
  return out;
}

function cloneBooleanRecord(record: Record<string, boolean>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const key of Object.keys(record)) {
    if (isSafeKey(key) && Object.hasOwn(record, key)) {
      const value = Object.getOwnPropertyDescriptor(record, key)?.value;
      if (typeof value === 'boolean') {
        setOwnProperty(out, key, value);
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
    hp: normalizeZero(c.hp),
    maxHp: normalizeZero(c.maxHp),
    ac: c.ac,
    speed: c.speed,
    remainingMovement: normalizeZero(c.remainingMovement),
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
    willpower: normalizeZero(c.willpower),
    maxWillpower: normalizeZero(c.maxWillpower),
    formationRow: c.formationRow ?? 'front',
    ...(c.willpowerOutcome !== undefined ? { willpowerOutcome: c.willpowerOutcome } : {}),
    ...(c.isSummon !== undefined ? { isSummon: c.isSummon } : {}),
    ...(c.summonerId !== undefined ? { summonerId: c.summonerId } : {}),
    ...(c.summonRemainingTurns !== undefined
      ? { summonRemainingTurns: c.summonRemainingTurns }
      : {}),
  };
}

function isTraditionalCombatState(
  state: CombatState | TraditionalCombatState
): state is TraditionalCombatState {
  return (
    'activePhase' in state &&
    'actedThisPhase' in state &&
    'fledIds' in state &&
    'surrenderedIds' in state &&
    'expendedItems' in state &&
    'formationConfig' in state
  );
}

function cloneTraditionalCombatState(
  state: CombatState | TraditionalCombatState
): TraditionalCombatState {
  const combatants: Record<string, CombatantState> = {};
  for (const id of getSafeCombatantIds(state)) {
    const c = getSafeCombatant(state, id);
    if (c !== undefined) {
      setOwnProperty(combatants, id, cloneCombatant(c));
    }
  }

  const triggerCountsThisTurn: Record<string, Record<string, number>> = {};
  for (const key of Object.keys(state.triggerCountsThisTurn)) {
    if (isSafeKey(key) && Object.hasOwn(state.triggerCountsThisTurn, key)) {
      const inner = Object.getOwnPropertyDescriptor(state.triggerCountsThisTurn, key)?.value;
      if (isPlainRecord(inner)) {
        const clonedInner: Record<string, number> = {};
        for (const innerKey of Object.keys(inner)) {
          if (isSafeKey(innerKey) && Object.hasOwn(inner, innerKey)) {
            const val = Object.getOwnPropertyDescriptor(inner, innerKey)?.value;
            if (typeof val === 'number' && Number.isFinite(val)) {
              setOwnProperty(clonedInner, innerKey, normalizeZero(val));
            }
          }
        }
        setOwnProperty(triggerCountsThisTurn, key, clonedInner);
      }
    }
  }

  const trad = isTraditionalCombatState(state) ? state : undefined;

  return {
    active: state.active,
    mode: 'traditional',
    turnStyle: state.turnStyle ?? 'phased',
    round: state.round,
    turnIndex: state.turnIndex,
    initiativeOrder: [...state.initiativeOrder],
    grid: null,
    combatants,
    triggerCountsThisTurn,
    activePhase: trad?.activePhase ?? 'player',
    actedThisPhase: trad ? cloneBooleanRecord(trad.actedThisPhase) : {},
    fledIds: trad ? [...trad.fledIds] : [],
    surrenderedIds: trad ? [...trad.surrenderedIds] : [],
    expendedItems: trad ? cloneNumberRecord(trad.expendedItems) : {},
    formationConfig: trad
      ? { ...trad.formationConfig }
      : { ...DEFAULT_TRADITIONAL_FORMATION_CONFIG },
  };
}

function getEffectiveStat(combatant: CombatantState, statKey: string): number {
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

function getGuardedAcBonus(combatant: CombatantState): number {
  let bonus = 0;
  for (const status of combatant.statuses) {
    if (status.remainingTurns > 0 && status.id === 'guarded') {
      bonus += 2 * Math.max(1, status.intensity);
    }
  }
  return normalizeZero(bonus);
}

export function isMeleeSkill(skill: SkillDefinition): boolean {
  const tags = skill.tags ?? [];
  if (tags.includes('melee')) {
    return true;
  }
  if (tags.includes('ranged')) {
    return false;
  }
  return skill.targeting.maxRange <= 1;
}

export function isRangedSkill(skill: SkillDefinition): boolean {
  return !isMeleeSkill(skill);
}

function isRestorativeOnlySkill(skill: SkillDefinition): boolean {
  if (skill.effects.length === 0) {
    return false;
  }
  return skill.effects.every(
    (e) =>
      e.type === 'heal' ||
      e.type === 'restore_resource' ||
      e.type === 'remove_status' ||
      (e.type === 'apply_status' &&
        (e.statusId === 'guarded' || e.statusId === 'blessed' || e.statusId === 'hasted'))
  );
}

function hasLivingFrontRowAlly(combat: CombatState, team: CombatTeam): boolean {
  for (const id of getSafeCombatantIds(combat)) {
    const c = getSafeCombatant(combat, id);
    if (
      c !== undefined &&
      c.team === team &&
      c.alive &&
      c.hp > 0 &&
      (c.formationRow ?? 'front') === 'front'
    ) {
      return true;
    }
  }
  return false;
}

function getLivingFrontRowDefenders(combat: CombatState, team: CombatTeam): CombatantState[] {
  const defenders: CombatantState[] = [];
  for (const id of getSafeCombatantIds(combat)) {
    const c = getSafeCombatant(combat, id);
    if (
      c !== undefined &&
      c.team === team &&
      c.alive &&
      c.hp > 0 &&
      (c.formationRow ?? 'front') === 'front'
    ) {
      defenders.push(c);
    }
  }
  defenders.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return defenders;
}

/**
 * Compute effective AC for a target in traditional theater combat, including
 * guarded status bonuses and back-row ranged cover when front-row allies stand.
 */
export function computeTraditionalEffectiveAc(
  combatState: CombatState | TraditionalCombatState,
  targetId: string,
  isRangedAttack: boolean
): number {
  const target = getSafeCombatant(combatState, targetId);
  if (target === undefined) {
    return 10;
  }
  const formationConfig = isTraditionalCombatState(combatState)
    ? combatState.formationConfig
    : DEFAULT_TRADITIONAL_FORMATION_CONFIG;
  const coverBonus =
    isRangedAttack &&
    (target.formationRow ?? 'front') === 'back' &&
    hasLivingFrontRowAlly(combatState, target.team)
      ? formationConfig.backRowCoverAcBonus
      : 0;
  return normalizeZero(target.ac + getGuardedAcBonus(target) + coverBonus);
}

/**
 * Resolve target IDs for a skill in traditional theater combat:
 * - Enforces front-row guard interception/blocking for single-target melee attacks against back-row foes.
 * - Resolves `'splash'` / `'aoe_radius'` / `'line'` / `'cone'` to a bounded `1 + (radius ?? 1)` targets
 *   (respecting `maxTargets` if set, starting with `primaryTargetId` then deterministic sorted living targets).
 * - Resolves `'all_enemies'` / `'all_allies'` to the entire living opposing/allied side.
 */
export function resolveTraditionalTargetIds(
  params: ResolveTraditionalTargetIdsParams
): ResolveTraditionalTargetIdsResult {
  const { combatState, actorId, skill, primaryTargetId } = params;
  const actor = getSafeCombatant(combatState, actorId);
  if (actor === undefined || !actor.alive || actor.hp <= 0) {
    return {
      ok: false,
      code: 'INVALID_ACTOR',
      reason: `Actor "${actorId}" is absent or defeated`,
    };
  }

  const formationConfig = isTraditionalCombatState(combatState)
    ? combatState.formationConfig
    : DEFAULT_TRADITIONAL_FORMATION_CONFIG;

  const { targeting } = skill;
  const shape = targeting.shape;

  if (shape === 'self') {
    return { ok: true, targetIds: [actor.id] };
  }

  if (shape === 'single_ally') {
    const resolvedId =
      primaryTargetId !== undefined && primaryTargetId.trim().length > 0
        ? primaryTargetId.trim()
        : targeting.minRange === 0
          ? actor.id
          : undefined;
    if (resolvedId === undefined) {
      return { ok: false, code: 'MISSING_TARGET', reason: 'Skill requires a targetId' };
    }
    const target = getSafeCombatant(combatState, resolvedId);
    if (target === undefined || !target.alive || target.hp <= 0) {
      return {
        ok: false,
        code: 'INVALID_TARGET',
        reason: `Target "${resolvedId}" is absent or defeated`,
      };
    }
    if (target.team !== actor.team) {
      return {
        ok: false,
        code: 'INVALID_TARGET_TEAM',
        reason: `Target "${resolvedId}" is not an ally`,
      };
    }
    return { ok: true, targetIds: [target.id] };
  }

  if (shape === 'single_enemy') {
    if (primaryTargetId === undefined || primaryTargetId.trim().length === 0) {
      return { ok: false, code: 'MISSING_TARGET', reason: 'Skill requires a targetId' };
    }
    const target = getSafeCombatant(combatState, primaryTargetId.trim());
    if (target === undefined || !target.alive || target.hp <= 0) {
      return {
        ok: false,
        code: 'INVALID_TARGET',
        reason: `Target "${primaryTargetId}" is absent or defeated`,
      };
    }
    if (!areTeamsHostile(actor.team, target.team)) {
      return {
        ok: false,
        code: 'TARGET_NOT_HOSTILE',
        reason: `Target "${target.id}" is not hostile`,
      };
    }

    const tags = skill.tags ?? [];
    const ignoresFormation = tags.includes('ignores_formation');
    if (
      formationConfig.enforceFrontRowGuard &&
      !ignoresFormation &&
      isMeleeSkill(skill) &&
      (target.formationRow ?? 'front') === 'back'
    ) {
      const frontDefenders = getLivingFrontRowDefenders(combatState, target.team);
      if (frontDefenders.length > 0) {
        if (formationConfig.frontRowInterceptionMode === 'block') {
          return {
            ok: false,
            code: 'FRONT_ROW_GUARDED',
            reason: `Back-row target "${target.id}" is protected by living front-row defenders`,
          };
        }
        const interceptor = frontDefenders[0] as CombatantState;
        return {
          ok: true,
          targetIds: [interceptor.id],
          interceptedBy: interceptor.id,
          originalTargetId: target.id,
        };
      }
    }

    return { ok: true, targetIds: [target.id] };
  }

  if (shape === 'all_enemies' || shape === 'all_allies') {
    const wantAllies = shape === 'all_allies';
    const candidates: string[] = [];
    for (const id of getSafeCombatantIds(combatState).sort()) {
      const c = getSafeCombatant(combatState, id);
      if (c === undefined || !c.alive || c.hp <= 0) {
        continue;
      }
      const match = wantAllies ? c.team === actor.team : areTeamsHostile(actor.team, c.team);
      if (match) {
        candidates.push(id);
      }
    }
    if (primaryTargetId !== undefined && candidates.includes(primaryTargetId)) {
      const rest = candidates.filter((id) => id !== primaryTargetId);
      return { ok: true, targetIds: [primaryTargetId, ...rest] };
    }
    return { ok: true, targetIds: candidates };
  }

  // Bounded splash / aoe_radius / line / cone / single_tile
  const restorative = isRestorativeOnlySkill(skill);
  const sideCandidates: string[] = [];
  for (const id of getSafeCombatantIds(combatState).sort()) {
    const c = getSafeCombatant(combatState, id);
    if (c === undefined || !c.alive || c.hp <= 0) {
      continue;
    }
    const match = restorative ? c.team === actor.team : areTeamsHostile(actor.team, c.team);
    if (match) {
      sideCandidates.push(id);
    }
  }

  if (sideCandidates.length === 0) {
    return { ok: true, targetIds: [] };
  }

  const baseBound =
    shape === 'single_tile' ? 1 : 1 + Math.max(0, targeting.radius ?? 1);
  const cap =
    targeting.maxTargets !== undefined
      ? Math.min(baseBound, Math.max(1, targeting.maxTargets))
      : baseBound;

  const ordered: string[] = [];
  if (primaryTargetId !== undefined && sideCandidates.includes(primaryTargetId)) {
    ordered.push(primaryTargetId);
  }
  for (const id of sideCandidates) {
    if (ordered.length >= cap) {
      break;
    }
    if (!ordered.includes(id)) {
      ordered.push(id);
    }
  }

  return { ok: true, targetIds: ordered.slice(0, cap) };
}

function readEquippedBonuses(
  customFields: Record<string, unknown>,
  equipmentCatalog?: Record<string, EquipmentBonusSpec>
): { acBonus: number; speedBonus: number; statBonuses: Record<string, number>; abilities: string[] } {
  const statBonuses: Record<string, number> = {};
  const abilities: string[] = [];
  let acBonus = 0;
  let speedBonus = 0;

  const rawEquipped =
    getOwnValue(customFields, 'equipped') ?? getOwnValue(customFields, 'equipment');
  if (!isPlainRecord(rawEquipped)) {
    return { acBonus, speedBonus, statBonuses, abilities };
  }

  for (const slotKey of Object.keys(rawEquipped)) {
    if (!isSafeKey(slotKey) || !Object.hasOwn(rawEquipped, slotKey)) {
      continue;
    }
    const slotVal = getOwnValue(rawEquipped, slotKey);
    let spec: EquipmentBonusSpec | undefined;

    if (typeof slotVal === 'string' && equipmentCatalog !== undefined && isSafeKey(slotVal)) {
      spec = Object.hasOwn(equipmentCatalog, slotVal)
        ? (Object.getOwnPropertyDescriptor(equipmentCatalog, slotVal)?.value as
            | EquipmentBonusSpec
            | undefined)
        : undefined;
    } else if (isPlainRecord(slotVal)) {
      const itemId = getOwnValue(slotVal, 'id');
      if (
        typeof itemId === 'string' &&
        equipmentCatalog !== undefined &&
        isSafeKey(itemId) &&
        Object.hasOwn(equipmentCatalog, itemId)
      ) {
        spec = Object.getOwnPropertyDescriptor(equipmentCatalog, itemId)?.value as
          | EquipmentBonusSpec
          | undefined;
      } else {
        const rawAc = getOwnValue(slotVal, 'acBonus');
        const rawSpeed = getOwnValue(slotVal, 'speedBonus');
        const rawStats = getOwnValue(slotVal, 'statBonuses');
        const rawAbilities = getOwnValue(slotVal, 'abilities');
        const inlineStats: Record<string, number> = {};
        if (isPlainRecord(rawStats)) {
          for (const sk of Object.keys(rawStats)) {
            if (isSafeKey(sk) && Object.hasOwn(rawStats, sk)) {
              const sv = getOwnValue(rawStats, sk);
              if (typeof sv === 'number' && Number.isFinite(sv)) {
                setOwnProperty(inlineStats, sk, sv);
              }
            }
          }
        }
        spec = {
          ...(typeof rawAc === 'number' && Number.isFinite(rawAc) ? { acBonus: rawAc } : {}),
          ...(typeof rawSpeed === 'number' && Number.isFinite(rawSpeed)
            ? { speedBonus: rawSpeed }
            : {}),
          statBonuses: inlineStats,
          ...(Array.isArray(rawAbilities)
            ? { abilities: rawAbilities.filter((a): a is string => typeof a === 'string') }
            : {}),
        };
      }
    }

    if (spec === undefined) {
      continue;
    }
    if (spec.acBonus !== undefined && Number.isFinite(spec.acBonus)) {
      acBonus += spec.acBonus;
    }
    if (spec.speedBonus !== undefined && Number.isFinite(spec.speedBonus)) {
      speedBonus += spec.speedBonus;
    }
    if (spec.statBonuses !== undefined) {
      for (const sk of Object.keys(spec.statBonuses)) {
        if (isSafeKey(sk) && Object.hasOwn(spec.statBonuses, sk)) {
          const val = getOwnNumber(spec.statBonuses, sk);
          if (val !== undefined) {
            setOwnProperty(statBonuses, sk, (getOwnNumber(statBonuses, sk) ?? 0) + val);
          }
        }
      }
    }
    if (spec.abilities !== undefined) {
      for (const ab of spec.abilities) {
        if (isSafeKey(ab) && !abilities.includes(ab)) {
          abilities.push(ab);
        }
      }
    }
  }

  return { acBonus, speedBonus, statBonuses, abilities };
}

function buildCombatantFromCharacter(
  char: CharacterEntity,
  team: CombatTeam,
  options?: BuildTraditionalParticipantsOptions
): CombatantState {
  const gear = readEquippedBonuses(char.customFields, options?.equipmentCatalog);
  const stats: Record<string, number> = {};
  if (char.progression?.attributes !== undefined) {
    for (const sk of Object.keys(char.progression.attributes)) {
      if (isSafeKey(sk) && Object.hasOwn(char.progression.attributes, sk)) {
        const val = getOwnNumber(char.progression.attributes, sk);
        if (val !== undefined) {
          setOwnProperty(stats, sk, normalizeZero(val));
        }
      }
    }
  }
  for (const sk of Object.keys(gear.statBonuses)) {
    if (isSafeKey(sk) && Object.hasOwn(gear.statBonuses, sk)) {
      const bonus = getOwnNumber(gear.statBonuses, sk) ?? 0;
      setOwnProperty(stats, sk, normalizeZero((getOwnNumber(stats, sk) ?? 0) + bonus));
    }
  }
  if (char.progression !== undefined) {
    setOwnProperty(stats, 'level', char.progression.level);
  }

  const resources: Record<string, number> = {};
  let hp = 20;
  let maxHp = 20;
  let willpower = 10;
  let maxWillpower = 10;

  if (char.resources !== undefined) {
    for (const rk of Object.keys(char.resources)) {
      if (!isSafeKey(rk) || !Object.hasOwn(char.resources, rk)) {
        continue;
      }
      const pool = Object.getOwnPropertyDescriptor(char.resources, rk)?.value as
        | { current: number; max: number }
        | undefined;
      if (pool === undefined) {
        continue;
      }
      if (rk === 'hp') {
        maxHp = Math.max(1, pool.max);
        hp = clampHp(pool.current, maxHp);
      } else if (rk === 'willpower') {
        maxWillpower = Math.max(1, pool.max);
        willpower = Math.max(0, Math.min(maxWillpower, pool.current));
      } else {
        setOwnProperty(resources, rk, normalizeZero(pool.current));
      }
    }
  }

  const rawAc = getOwnValue(char.customFields, 'ac');
  const baseAc = typeof rawAc === 'number' && Number.isFinite(rawAc) ? rawAc : 10 + (getOwnNumber(stats, 'dex') ?? 0);
  const rawSpeed = getOwnValue(char.customFields, 'speed');
  const baseSpeed = typeof rawSpeed === 'number' && Number.isFinite(rawSpeed) ? rawSpeed : 30;

  const customRow = getOwnValue(char.customFields, 'formationRow');
  const optionRow =
    options?.formationRows !== undefined && isSafeKey(char.id) && Object.hasOwn(options.formationRows, char.id)
      ? options.formationRows[char.id]
      : undefined;
  const formationRow: FormationRow =
    optionRow ?? (customRow === 'back' ? 'back' : 'front');

  const abilities = [...char.abilities];
  for (const ab of gear.abilities) {
    if (!abilities.includes(ab)) {
      abilities.push(ab);
    }
  }

  return {
    id: char.id,
    name: char.name,
    team,
    coord: { x: 0, y: 0 },
    alive: char.status !== 'dead' && hp > 0,
    hp,
    maxHp,
    ac: normalizeZero(baseAc + gear.acBonus),
    speed: normalizeZero(baseSpeed + gear.speedBonus),
    remainingMovement: 0,
    remainingActions: { action: 1, bonus: 1, reaction: 1 },
    resources,
    cooldowns: {},
    stats,
    statuses: [],
    abilities,
    passives: [],
    willpower: normalizeZero(willpower),
    maxWillpower: normalizeZero(maxWillpower),
    formationRow,
  };
}

/**
 * Build combatant participants and available consumable items from `WorldState`
 * plus enemy specifications for a traditional theater encounter.
 */
export function buildTraditionalEncounterParticipants(
  worldState: WorldState,
  enemySpecs: readonly TraditionalEnemySpec[],
  options?: BuildTraditionalParticipantsOptions
): BuildTraditionalParticipantsResult {
  const participants: CombatantState[] = [];
  const seenIds = new Set<string>();

  // 1. Player combatant (either linked CharacterEntity or standalone player)
  const playerCharId = worldState.player.characterId;
  if (
    playerCharId !== null &&
    isSafeKey(playerCharId) &&
    Object.hasOwn(worldState.entities.characters, playerCharId)
  ) {
    const playerChar = Object.getOwnPropertyDescriptor(
      worldState.entities.characters,
      playerCharId
    )?.value as CharacterEntity | undefined;
    if (playerChar !== undefined && playerChar.status !== 'dead') {
      participants.push(buildCombatantFromCharacter(playerChar, 'ally', options));
      seenIds.add(playerChar.id);
    }
  } else if (isSafeKey(worldState.player.id)) {
    const gear = readEquippedBonuses(worldState.player.customFields, options?.equipmentCatalog);
    const stats: Record<string, number> = {};
    if (worldState.player.progression?.attributes !== undefined) {
      for (const sk of Object.keys(worldState.player.progression.attributes)) {
        if (isSafeKey(sk) && Object.hasOwn(worldState.player.progression.attributes, sk)) {
          const val = getOwnNumber(worldState.player.progression.attributes, sk);
          if (val !== undefined) {
            setOwnProperty(stats, sk, normalizeZero(val));
          }
        }
      }
    }
    for (const sk of Object.keys(gear.statBonuses)) {
      if (isSafeKey(sk) && Object.hasOwn(gear.statBonuses, sk)) {
        const bonus = getOwnNumber(gear.statBonuses, sk) ?? 0;
        setOwnProperty(stats, sk, normalizeZero((getOwnNumber(stats, sk) ?? 0) + bonus));
      }
    }
    if (worldState.player.progression !== undefined) {
      setOwnProperty(stats, 'level', worldState.player.progression.level);
    }

    const resources: Record<string, number> = {};
    let hp = 24;
    let maxHp = 24;
    let willpower = 10;
    let maxWillpower = 10;
    if (worldState.player.resources !== undefined) {
      for (const rk of Object.keys(worldState.player.resources)) {
        if (!isSafeKey(rk) || !Object.hasOwn(worldState.player.resources, rk)) {
          continue;
        }
        const pool = Object.getOwnPropertyDescriptor(worldState.player.resources, rk)?.value as
          | { current: number; max: number }
          | undefined;
        if (pool === undefined) {
          continue;
        }
        if (rk === 'hp') {
          maxHp = Math.max(1, pool.max);
          hp = clampHp(pool.current, maxHp);
        } else if (rk === 'willpower') {
          maxWillpower = Math.max(1, pool.max);
          willpower = Math.max(0, Math.min(maxWillpower, pool.current));
        } else {
          setOwnProperty(resources, rk, normalizeZero(pool.current));
        }
      }
    }

    const rawAc = getOwnValue(worldState.player.customFields, 'ac');
    const baseAc =
      typeof rawAc === 'number' && Number.isFinite(rawAc)
        ? rawAc
        : 10 + (getOwnNumber(stats, 'dex') ?? 0);
    const customRow = getOwnValue(worldState.player.customFields, 'formationRow');
    const optionRow =
      options?.formationRows !== undefined &&
      isSafeKey(worldState.player.id) &&
      Object.hasOwn(options.formationRows, worldState.player.id)
        ? options.formationRows[worldState.player.id]
        : undefined;

    participants.push({
      id: worldState.player.id,
      name: worldState.player.name,
      team: 'ally',
      coord: { x: 0, y: 0 },
      alive: hp > 0,
      hp,
      maxHp,
      ac: normalizeZero(baseAc + gear.acBonus),
      speed: normalizeZero(30 + gear.speedBonus),
      remainingMovement: 0,
      remainingActions: { action: 1, bonus: 1, reaction: 1 },
      resources,
      cooldowns: {},
      stats,
      statuses: [],
      abilities: [...gear.abilities],
      passives: [],
      willpower: normalizeZero(willpower),
      maxWillpower: normalizeZero(maxWillpower),
      formationRow: optionRow ?? (customRow === 'back' ? 'back' : 'front'),
    });
    seenIds.add(worldState.player.id);
  }

  // 2. Scene present characters
  const allySet = new Set(options?.allyIds ?? []);
  const enemySet = new Set(options?.enemyIds ?? []);
  for (const charId of worldState.scene.presentCharacterIds) {
    if (
      !isSafeKey(charId) ||
      seenIds.has(charId) ||
      !Object.hasOwn(worldState.entities.characters, charId)
    ) {
      continue;
    }
    const char = Object.getOwnPropertyDescriptor(worldState.entities.characters, charId)?.value as
      | CharacterEntity
      | undefined;
    if (char === undefined || char.status === 'dead' || !char.presentInScene) {
      continue;
    }
    let team: CombatTeam = 'ally';
    if (enemySet.has(charId)) {
      team = 'enemy';
    } else if (!allySet.has(charId)) {
      const alleg = char.allegiance.trim().toLowerCase();
      if (alleg === 'enemy' || alleg === 'hostile') {
        team = 'enemy';
      }
    }
    participants.push(buildCombatantFromCharacter(char, team, options));
    seenIds.add(charId);
  }

  // 3. Explicit enemy specs
  for (const spec of enemySpecs) {
    if (!isSafeKey(spec.id) || seenIds.has(spec.id)) {
      continue;
    }
    const maxHp = Math.max(1, spec.maxHp);
    const hp = clampHp(spec.hp ?? maxHp, maxHp);
    const maxWillpower = Math.max(1, spec.maxWillpower ?? 10);
    const willpower = Math.max(0, Math.min(maxWillpower, spec.willpower ?? maxWillpower));
    participants.push({
      id: spec.id,
      name: spec.name,
      team: spec.team ?? 'enemy',
      coord: { x: 0, y: 0 },
      alive: hp > 0,
      hp,
      maxHp,
      ac: normalizeZero(spec.ac ?? 12),
      speed: normalizeZero(spec.speed ?? 30),
      remainingMovement: 0,
      remainingActions: { action: 1, bonus: 1, reaction: 1 },
      resources: spec.resources !== undefined ? cloneNumberRecord(spec.resources) : {},
      cooldowns: {},
      stats: spec.stats !== undefined ? cloneNumberRecord(spec.stats) : {},
      statuses: [],
      abilities: spec.abilities !== undefined ? [...spec.abilities] : [],
      passives: spec.passives !== undefined ? spec.passives.map(clonePassive) : [],
      willpower: normalizeZero(willpower),
      maxWillpower: normalizeZero(maxWillpower),
      formationRow: spec.formationRow ?? 'front',
      ...(spec.willpowerOutcome !== undefined ? { willpowerOutcome: spec.willpowerOutcome } : {}),
    });
    seenIds.add(spec.id);
  }

  const availableItems: Record<string, number> = {};
  for (const itemId of Object.keys(worldState.player.inventory.items)) {
    if (isSafeKey(itemId) && Object.hasOwn(worldState.player.inventory.items, itemId)) {
      const count = getOwnNumber(worldState.player.inventory.items, itemId);
      if (count !== undefined && count > 0) {
        setOwnProperty(availableItems, itemId, normalizeZero(count));
      }
    }
  }

  return { participants, availableItems };
}

/**
 * Initialize a traditional (no-grid Theater-of-the-Mind) combat encounter in
 * either `'phased'` (Player Phase <-> Enemy Phase) or `'initiative'` (`1d20 + mod`) turn style.
 */
export function startTraditionalEncounter(
  params: StartTraditionalEncounterParams
): StartTraditionalEncounterResult {
  let currentRng = params.rng;
  const cloned = params.participants.map(cloneCombatant);

  for (const p of cloned) {
    if (!isSafeKey(p.id)) {
      throw new RefereeError(`Invalid or forbidden combatant id "${p.id}"`, {
        code: 'INVALID_COMBATANT_ID',
      });
    }
    p.hp = clampHp(p.hp, p.maxHp);
    p.alive = p.alive && p.hp > 0;
    p.remainingMovement = 0;
    p.remainingActions = { action: 1, bonus: 1, reaction: 1 };
    p.formationRow = p.formationRow ?? 'front';
  }

  const initParticipants: InitiativeParticipant[] = cloned.map((p) => ({
    id: p.id,
    initiativeBonus: getOwnNumber(p.stats, 'initiative') ?? getOwnNumber(p.stats, 'dex') ?? 0,
  }));
  const initRes = rollInitiativeOrder(initParticipants, currentRng);
  currentRng = initRes.nextRng;
  const initiativeOrder = initRes.order.map((e) => e.id);

  const combatants: Record<string, CombatantState> = {};
  for (const p of cloned) {
    if (Object.hasOwn(combatants, p.id)) {
      throw new RefereeError(`Duplicate combatant id "${p.id}" in startTraditionalEncounter`, {
        code: 'DUPLICATE_COMBATANT_ID',
      });
    }
    setOwnProperty(combatants, p.id, p);
  }

  const turnStyle: TraditionalTurnStyle = params.turnStyle ?? 'phased';
  const hasLivingAlly = cloned.some((p) => p.team === 'ally' && p.alive && p.hp > 0);
  const activePhase: TraditionalPhase = hasLivingAlly ? 'player' : 'enemy';

  let firstLivingIndex = 0;
  for (let i = 0; i < initiativeOrder.length; i += 1) {
    const id = initiativeOrder[i];
    if (id !== undefined) {
      const c = getSafeCombatant({ combatants } as CombatState, id);
      if (c !== undefined && c.alive && c.hp > 0) {
        if (turnStyle === 'initiative' || (activePhase === 'player' ? c.team === 'ally' : c.team !== 'ally')) {
          firstLivingIndex = i;
          break;
        }
      }
    }
  }

  const formationConfig: TraditionalFormationConfig = {
    enforceFrontRowGuard:
      params.formationConfig?.enforceFrontRowGuard ??
      DEFAULT_TRADITIONAL_FORMATION_CONFIG.enforceFrontRowGuard,
    frontRowInterceptionMode:
      params.formationConfig?.frontRowInterceptionMode ??
      DEFAULT_TRADITIONAL_FORMATION_CONFIG.frontRowInterceptionMode,
    backRowCoverAcBonus:
      params.formationConfig?.backRowCoverAcBonus ??
      DEFAULT_TRADITIONAL_FORMATION_CONFIG.backRowCoverAcBonus,
  };

  const combatState: TraditionalCombatState = {
    active: true,
    mode: 'traditional',
    turnStyle,
    round: 1,
    turnIndex: firstLivingIndex,
    initiativeOrder,
    grid: null,
    combatants,
    triggerCountsThisTurn: {},
    activePhase,
    actedThisPhase: {},
    fledIds: [],
    surrenderedIds: [],
    expendedItems: {},
    formationConfig,
  };

  return {
    combatState,
    worldPatches: [{ op: 'clock_hold', reason: 'combat' }],
    nextRng: currentRng,
  };
}

function evaluateEncounterOutcome(combat: CombatState): {
  encounterEnded: boolean;
  winnerTeam: CombatTeam | 'draw' | null;
} {
  let livingAllies = 0;
  let livingEnemies = 0;
  for (const id of getSafeCombatantIds(combat)) {
    const c = getSafeCombatant(combat, id);
    if (c !== undefined && c.alive && c.hp > 0) {
      if (c.team === 'ally') {
        livingAllies += 1;
      } else if (c.team === 'enemy') {
        livingEnemies += 1;
      }
    }
  }
  if (livingAllies === 0 && livingEnemies === 0) {
    return { encounterEnded: true, winnerTeam: 'draw' };
  }
  if (livingEnemies === 0) {
    return { encounterEnded: true, winnerTeam: 'ally' };
  }
  if (livingAllies === 0) {
    return { encounterEnded: true, winnerTeam: 'enemy' };
  }
  return { encounterEnded: false, winnerTeam: null };
}

function recordDamage(
  damageDealt: Record<string, number>,
  actorId: string,
  amount: number
): void {
  if (amount <= 0) {
    return;
  }
  const prev = getOwnNumber(damageDealt, actorId) ?? 0;
  setOwnProperty(damageDealt, actorId, normalizeZero(prev + amount));
}

function recordDefeat(defeatedIds: string[], targetId: string): void {
  if (!defeatedIds.includes(targetId)) {
    defeatedIds.push(targetId);
  }
}

function applyTickEffectsToCombatant(
  target: CombatantState,
  tickDamage: number,
  tickHealing: number,
  defeatedIds: string[],
  damageDealt: Record<string, number>
): void {
  if (tickDamage > 0 && target.alive && target.hp > 0) {
    const before = target.hp;
    target.hp = clampHp(target.hp - tickDamage, target.maxHp);
    recordDamage(damageDealt, target.id, before - target.hp);
    if (target.hp <= 0) {
      target.alive = false;
      recordDefeat(defeatedIds, target.id);
    }
  }
  if (tickHealing > 0 && target.alive && target.hp > 0) {
    target.hp = clampHp(target.hp + tickHealing, target.maxHp);
  }
}

function decrementCooldowns(
  actor: CombatantState,
  newlyTriggered: ReadonlySet<string>
): void {
  for (const key of Object.keys(actor.cooldowns)) {
    if (!isSafeKey(key) || !Object.hasOwn(actor.cooldowns, key) || newlyTriggered.has(key)) {
      continue;
    }
    const cd = getOwnNumber(actor.cooldowns, key) ?? 0;
    if (cd > 1) {
      setOwnProperty(actor.cooldowns, key, cd - 1);
    } else if (cd <= 1) {
      delete actor.cooldowns[key];
    }
  }
}

interface TurnExecutionContext {
  combat: TraditionalCombatState;
  worldState: WorldState;
  rng: RngState;
  executedActions: string[];
  damageDealt: Record<string, number>;
  defeatedIds: string[];
  newlyTriggeredCooldowns: Set<string>;
  interceptedTargets: Record<string, string>;
  fleeDc: number;
}

function getActorTriggerCounts(
  combat: TraditionalCombatState,
  ownerId: string
): Record<string, number> {
  const existing = Object.hasOwn(combat.triggerCountsThisTurn, ownerId)
    ? (Object.getOwnPropertyDescriptor(combat.triggerCountsThisTurn, ownerId)?.value as
        | Record<string, number>
        | undefined)
    : undefined;
  return existing ?? {};
}

function setActorTriggerCounts(
  combat: TraditionalCombatState,
  ownerId: string,
  counts: Record<string, number>
): void {
  setOwnProperty(combat.triggerCountsThisTurn, ownerId, counts);
}

function checkAndResolveWillpowerBreak(
  ctx: TurnExecutionContext,
  target: CombatantState
): void {
  if (!target.alive || target.willpower > 0 || target.willpowerOutcome === undefined) {
    return;
  }
  const res = resolveWillpowerBreak(
    {
      alive: target.alive,
      team: target.team,
      hp: target.hp,
      willpower: target.willpower,
    },
    target.willpowerOutcome
  );
  target.alive = res.alive;
  target.team = res.team;
  target.hp = clampHp(res.hp, target.maxHp);
  target.willpower = normalizeZero(res.willpower);
  if (res.outcome === 'flee' && !ctx.combat.fledIds.includes(target.id)) {
    ctx.combat.fledIds.push(target.id);
  } else if (res.outcome === 'surrender' && !ctx.combat.surrenderedIds.includes(target.id)) {
    ctx.combat.surrenderedIds.push(target.id);
  }
  if (res.appliedStatusId !== null) {
    target.statuses = applyStatusEffect(target.statuses, {
      id: res.appliedStatusId,
      name: res.appliedStatusId,
      remainingTurns: 2,
      intensity: 1,
      stackPolicy: 'refresh',
      tickTiming: 'turn_end',
    });
  }
  if (!target.alive) {
    recordDefeat(ctx.defeatedIds, target.id);
  }
}

function triggerPassivesForCombatant(
  ctx: TurnExecutionContext,
  hook: PassiveTriggerHook,
  owner: CombatantState,
  counterpart: CombatantState | undefined,
  recursionDepth: number
): void {
  if (owner.passives.length === 0 || recursionDepth > DEFAULT_MAX_PASSIVE_RECURSION_DEPTH) {
    return;
  }
  const evalRes = evaluatePassiveHooks({
    hook,
    passives: owner.passives,
    triggerCountsThisTurn: getActorTriggerCounts(ctx.combat, owner.id),
    recursionDepth,
    maxRecursionDepth: DEFAULT_MAX_PASSIVE_RECURSION_DEPTH,
    actorStats: {
      hp: owner.hp,
      maxHp: owner.maxHp,
      willpower: owner.willpower,
    },
  });
  setActorTriggerCounts(ctx.combat, owner.id, evalRes.nextTriggerCounts);

  for (const passive of evalRes.triggered) {
    const recipient =
      passive.effect.type === 'damage' || passive.effect.type === 'apply_status'
        ? counterpart ?? owner
        : owner;
    applySingleEffect(ctx, owner, recipient, passive.effect, false, recursionDepth + 1);
  }
}

function computeEffectAmount(
  ctx: TurnExecutionContext,
  actor: CombatantState,
  target: CombatantState,
  spec: {
    dice?: string;
    flat?: number;
    scalingStat?: string;
    scale?: SkillEffectSpec['scale'];
  },
  isCrit: boolean
): number {
  let amount = spec.flat ?? 0;

  if (spec.dice !== undefined) {
    const vars = computeCombatVariables(ctx.combat, actor, target);
    const scaledExpr = resolveScaledDiceExpression(spec.dice, vars, spec.scale);
    if (/^[+-]?\d+$/.test(scaledExpr.trim())) {
      amount += Number.parseInt(scaledExpr.trim(), 10);
    } else {
      const roll = unwrap(rollDice(scaledExpr, ctx.rng));
      ctx.rng = roll.nextState;
      amount += roll.total;
      if (isCrit) {
        const critRoll = unwrap(rollDice(scaledExpr, ctx.rng));
        ctx.rng = critRoll.nextState;
        amount += critRoll.total;
      }
    }
  } else if (spec.scale !== undefined) {
    const vars = computeCombatVariables(ctx.combat, actor, target);
    const rawVar = vars[spec.scale.variable];
    const scaled = rawVar * spec.scale.per;
    const minVal = spec.scale.min ?? -Infinity;
    const maxVal = spec.scale.max ?? Infinity;
    amount += Math.max(minVal, Math.min(maxVal, Math.trunc(scaled)));
  }

  if (spec.scalingStat !== undefined) {
    amount += getEffectiveStat(actor, spec.scalingStat);
  }

  return normalizeZero(amount);
}

function applySingleEffect(
  ctx: TurnExecutionContext,
  actor: CombatantState,
  target: CombatantState,
  effect: SkillEffectSpec,
  isCrit: boolean,
  recursionDepth: number
): void {
  if (effect.type === 'damage' || effect.type === 'drain') {
    if (!target.alive || target.hp <= 0) {
      return;
    }
    const rawDamage = Math.max(0, computeEffectAmount(ctx, actor, target, effect, isCrit));
    const beforeHp = target.hp;
    target.hp = clampHp(target.hp - rawDamage, target.maxHp);
    const actualDamage = beforeHp - target.hp;
    recordDamage(ctx.damageDealt, actor.id, actualDamage);

    if (effect.type === 'drain' && actualDamage > 0 && actor.alive) {
      actor.hp = clampHp(actor.hp + Math.max(1, Math.floor(actualDamage / 2)), actor.maxHp);
    }

    if (actualDamage > 0) {
      const wpRes = adjustWillpower(target.willpower, target.maxWillpower, -1);
      target.willpower = normalizeZero(wpRes.next);
      checkAndResolveWillpowerBreak(ctx, target);
    }

    if (target.hp <= 0) {
      target.alive = false;
      recordDefeat(ctx.defeatedIds, target.id);
      triggerPassivesForCombatant(ctx, 'on_kill', actor, target, recursionDepth + 1);
      for (const id of getSafeCombatantIds(ctx.combat)) {
        const ally = getSafeCombatant(ctx.combat, id);
        if (ally !== undefined && ally.alive && ally.team === target.team && ally.id !== target.id) {
          triggerPassivesForCombatant(ctx, 'on_ally_down', ally, actor, recursionDepth + 1);
        }
      }
    } else if (actualDamage > 0) {
      triggerPassivesForCombatant(ctx, 'on_damaged', target, actor, recursionDepth + 1);
    }
    triggerPassivesForCombatant(ctx, 'on_hit', actor, target, recursionDepth + 1);
    return;
  }

  if (effect.type === 'heal') {
    if (!target.alive) {
      return;
    }
    const healAmount = Math.max(0, computeEffectAmount(ctx, actor, target, effect, isCrit));
    target.hp = clampHp(target.hp + healAmount, target.maxHp);
    return;
  }

  if (effect.type === 'apply_status' && effect.statusId !== undefined) {
    if (!target.alive) {
      return;
    }
    target.statuses = applyStatusEffect(target.statuses, {
      id: effect.statusId,
      name: effect.statusId,
      remainingTurns: Math.max(1, effect.statusDuration ?? 1),
      intensity: Math.max(1, effect.statusIntensity ?? 1),
      stackPolicy: 'refresh',
      tickTiming: 'turn_end',
    });
    return;
  }

  if (effect.type === 'remove_status' && effect.statusId !== undefined) {
    target.statuses = target.statuses.filter((s) => s.id !== effect.statusId);
    return;
  }

  if (effect.type === 'restore_resource') {
    const key = effect.targetResource ?? effect.resourceKey ?? 'mp';
    if (!isSafeKey(key)) {
      return;
    }
    const restoreAmount = Math.max(0, computeEffectAmount(ctx, actor, target, effect, false));
    if (key === 'willpower') {
      const wpRes = adjustWillpower(target.willpower, target.maxWillpower, restoreAmount);
      target.willpower = normalizeZero(wpRes.next);
    } else {
      const current = getOwnNumber(target.resources, key) ?? 0;
      setOwnProperty(target.resources, key, normalizeZero(current + restoreAmount));
    }
  }
}

function spendSkillEconomy(
  ctx: TurnExecutionContext,
  actor: CombatantState,
  skill: SkillDefinition
): { ok: true } | { ok: false; code: string; reason: string } {
  if (skill.actionCost === 'action' && actor.remainingActions.action <= 0) {
    return { ok: false, code: 'NO_ACTION', reason: `Actor "${actor.id}" has no action remaining` };
  }
  if (skill.actionCost === 'bonus' && actor.remainingActions.bonus <= 0) {
    return {
      ok: false,
      code: 'NO_BONUS_ACTION',
      reason: `Actor "${actor.id}" has no bonus action remaining`,
    };
  }
  if (skill.actionCost === 'reaction' && actor.remainingActions.reaction <= 0) {
    return {
      ok: false,
      code: 'NO_REACTION',
      reason: `Actor "${actor.id}" has no reaction remaining`,
    };
  }
  if ((getOwnNumber(actor.cooldowns, skill.id) ?? 0) > 0) {
    return {
      ok: false,
      code: 'SKILL_ON_COOLDOWN',
      reason: `Skill "${skill.id}" is on cooldown`,
    };
  }

  for (const resKey of Object.keys(skill.resourceCosts)) {
    if (!isSafeKey(resKey) || !Object.hasOwn(skill.resourceCosts, resKey)) {
      continue;
    }
    const cost = getOwnNumber(skill.resourceCosts, resKey) ?? 0;
    if (cost > 0 && (getOwnNumber(actor.resources, resKey) ?? 0) < cost) {
      return {
        ok: false,
        code: 'INSUFFICIENT_RESOURCE',
        reason: `Insufficient "${resKey}" for skill "${skill.id}"`,
      };
    }
  }

  // Deduct costs
  if (skill.actionCost === 'action') {
    actor.remainingActions.action -= 1;
  } else if (skill.actionCost === 'bonus') {
    actor.remainingActions.bonus -= 1;
  } else if (skill.actionCost === 'reaction') {
    actor.remainingActions.reaction -= 1;
  }

  for (const resKey of Object.keys(skill.resourceCosts)) {
    if (!isSafeKey(resKey) || !Object.hasOwn(skill.resourceCosts, resKey)) {
      continue;
    }
    const cost = getOwnNumber(skill.resourceCosts, resKey) ?? 0;
    if (cost > 0) {
      const current = getOwnNumber(actor.resources, resKey) ?? 0;
      setOwnProperty(actor.resources, resKey, normalizeZero(current - cost));
    }
  }

  if (skill.cooldownTurns !== undefined && skill.cooldownTurns > 0) {
    setOwnProperty(actor.cooldowns, skill.id, skill.cooldownTurns);
    ctx.newlyTriggeredCooldowns.add(skill.id);
  }

  return { ok: true };
}

function executeTraditionalSkill(
  ctx: TurnExecutionContext,
  actor: CombatantState,
  skill: SkillDefinition,
  primaryTargetId?: string
): { ok: true } | { ok: false; code: string; reason: string } {
  const targetRes = resolveTraditionalTargetIds({
    combatState: ctx.combat,
    actorId: actor.id,
    skill,
    ...(primaryTargetId !== undefined ? { primaryTargetId } : {}),
  });
  if (!targetRes.ok) {
    return targetRes;
  }

  const econRes = spendSkillEconomy(ctx, actor, skill);
  if (!econRes.ok) {
    return econRes;
  }

  if (targetRes.interceptedBy !== undefined && targetRes.originalTargetId !== undefined) {
    setOwnProperty(ctx.interceptedTargets, targetRes.originalTargetId, targetRes.interceptedBy);
  }

  const ranged = isRangedSkill(skill);

  // If EffectTemplate is present, expand and execute its steps
  if (skill.effectTemplate !== undefined) {
    const primaryTargetObj =
      targetRes.targetIds[0] !== undefined
        ? getSafeCombatant(ctx.combat, targetRes.targetIds[0])
        : undefined;
    const expanded = expandEffectTemplateTargets(
      skill.effectTemplate,
      ctx.combat,
      actor,
      primaryTargetObj,
      targetRes.targetIds
    );
    for (const stepTarget of expanded.stepTargets) {
      const step = stepTarget.step;
      for (const tid of stepTarget.targetIds) {
        const target = getSafeCombatant(ctx.combat, tid);
        if (target === undefined) {
          continue;
        }
        if (step.kind === 'damage' || step.kind === 'drain') {
          applySingleEffect(
            ctx,
            actor,
            target,
            {
              type: step.kind,
              ...(step.dice !== undefined ? { dice: step.dice } : {}),
              ...(step.flat !== undefined ? { flat: step.flat } : {}),
              ...(step.scalingStat !== undefined ? { scalingStat: step.scalingStat } : {}),
              ...(step.scale !== undefined ? { scale: step.scale } : {}),
            },
            false,
            0
          );
        } else if (step.kind === 'heal') {
          applySingleEffect(
            ctx,
            actor,
            target,
            {
              type: 'heal',
              ...(step.dice !== undefined ? { dice: step.dice } : {}),
              ...(step.flat !== undefined ? { flat: step.flat } : {}),
              ...(step.scalingStat !== undefined ? { scalingStat: step.scalingStat } : {}),
              ...(step.scale !== undefined ? { scale: step.scale } : {}),
            },
            false,
            0
          );
        } else if (step.kind === 'status' && step.statusId !== undefined) {
          applySingleEffect(
            ctx,
            actor,
            target,
            {
              type: 'apply_status',
              statusId: step.statusId,
              ...(step.statusDuration !== undefined ? { statusDuration: step.statusDuration } : {}),
              ...(step.statusIntensity !== undefined
                ? { statusIntensity: step.statusIntensity }
                : {}),
            },
            false,
            0
          );
        } else if (step.kind === 'cure' && step.statusId !== undefined) {
          applySingleEffect(
            ctx,
            actor,
            target,
            {
              type: 'remove_status',
              statusId: step.statusId,
            },
            false,
            0
          );
        }
      }
    }
    ctx.executedActions.push(`skill:${skill.id}(${targetRes.targetIds.join(',')})`);
    return { ok: true };
  }

  for (const tid of targetRes.targetIds) {
    const target = getSafeCombatant(ctx.combat, tid);
    if (target === undefined || !target.alive) {
      continue;
    }

    let hit = true;
    let isCrit = false;

    if (skill.hitResolution.kind === 'attack_roll') {
      const roll = unwrap(rollDice('1d20', ctx.rng));
      ctx.rng = roll.nextState;
      const d20 = roll.rolls[0] ?? roll.total;
      const attackStat = skill.hitResolution.stat ?? 'str';
      const mod = getEffectiveStat(actor, attackStat);
      const effectiveAc = computeTraditionalEffectiveAc(ctx.combat, target.id, ranged);

      if (isFumbleNaturalRoll(d20)) {
        hit = false;
      } else if (isCriticalNaturalRoll(d20)) {
        hit = true;
        isCrit = true;
      } else {
        hit = d20 + mod >= effectiveAc;
      }
    } else if (skill.hitResolution.kind === 'save') {
      const roll = unwrap(rollDice('1d20', ctx.rng));
      ctx.rng = roll.nextState;
      const saveStat = skill.hitResolution.saveStat ?? 'dex';
      const saveMod = getEffectiveStat(target, saveStat);
      const dc = skill.hitResolution.dc ?? 12;
      hit = roll.total + saveMod < dc;
    }

    if (hit) {
      for (const effect of skill.effects) {
        applySingleEffect(ctx, actor, target, effect, isCrit, 0);
      }
    }
  }

  ctx.executedActions.push(`skill:${skill.id}(${targetRes.targetIds.join(',')})`);
  return { ok: true };
}

function executeSingleTraditionalAction(
  ctx: TurnExecutionContext,
  actor: CombatantState,
  action: ProposedCombatAction,
  registry: SkillRegistry
): { ok: true; signal: 'continue' | 'end_turn' } | { ok: false; code: string; reason: string } {
  if (action.type === 'move') {
    return {
      ok: false,
      code: 'MOVE_UNAVAILABLE_IN_TRADITIONAL',
      reason: 'Grid movement is not available in traditional combat mode',
    };
  }

  if (action.type === 'end_turn') {
    ctx.executedActions.push('end_turn');
    return { ok: true, signal: 'end_turn' };
  }

  if (action.type === 'defend') {
    const defendSkill = resolveSkillDefinition('defend', registry);
    if (defendSkill === undefined) {
      return { ok: false, code: 'UNKNOWN_SKILL', reason: 'Defend skill unavailable' };
    }
    const res = executeTraditionalSkill(ctx, actor, defendSkill, actor.id);
    return res.ok ? { ok: true, signal: 'continue' } : res;
  }

  if (action.type === 'flee') {
    if (actor.remainingActions.action <= 0) {
      return { ok: false, code: 'NO_ACTION', reason: `Actor "${actor.id}" has no action remaining` };
    }
    actor.remainingActions.action -= 1;
    const roll = unwrap(rollDice('1d20', ctx.rng));
    ctx.rng = roll.nextState;
    const dexMod = getEffectiveStat(actor, 'dex');
    if (roll.total + dexMod >= ctx.fleeDc || isCriticalNaturalRoll(roll.rolls[0] ?? 0)) {
      actor.alive = false;
      if (!ctx.combat.fledIds.includes(actor.id)) {
        ctx.combat.fledIds.push(actor.id);
      }
      ctx.executedActions.push(`flee:success(${actor.id})`);
      return { ok: true, signal: 'end_turn' };
    }
    ctx.executedActions.push(`flee:failed(${actor.id})`);
    return { ok: true, signal: 'continue' };
  }

  if (action.type === 'item') {
    if (!isSafeKey(action.itemId)) {
      return { ok: false, code: 'INVALID_ITEM_ID', reason: 'Invalid item id' };
    }
    const skill = registry.get(action.itemId);
    if (skill === undefined) {
      return {
        ok: false,
        code: 'UNKNOWN_ITEM',
        reason: `Item "${action.itemId}" is not registered`,
      };
    }

    if (actor.team === 'ally') {
      const invCount = getOwnNumber(ctx.worldState.player.inventory.items, action.itemId) ?? 0;
      const alreadyUsed = getOwnNumber(ctx.combat.expendedItems, action.itemId) ?? 0;
      if (invCount - alreadyUsed <= 0) {
        return {
          ok: false,
          code: 'ITEM_DEPLETED',
          reason: `No "${action.itemId}" remaining in inventory`,
        };
      }
    }

    const res = executeTraditionalSkill(ctx, actor, skill, action.targetId);
    if (!res.ok) {
      return res;
    }

    if (actor.team === 'ally') {
      const alreadyUsed = getOwnNumber(ctx.combat.expendedItems, action.itemId) ?? 0;
      setOwnProperty(ctx.combat.expendedItems, action.itemId, alreadyUsed + 1);
    }
    return { ok: true, signal: 'continue' };
  }

  if (action.type === 'skill') {
    const skill = resolveSkillDefinition(action.skillId, registry);
    if (skill === undefined) {
      return {
        ok: false,
        code: 'UNKNOWN_SKILL',
        reason: `Skill "${action.skillId}" is not registered`,
      };
    }
    if (
      skill.id !== 'basic_strike' &&
      skill.id !== 'defend' &&
      !actor.abilities.includes(skill.id)
    ) {
      return {
        ok: false,
        code: 'SKILL_NOT_LEARNED',
        reason: `Actor "${actor.id}" does not know skill "${skill.id}"`,
      };
    }
    const res = executeTraditionalSkill(ctx, actor, skill, action.targetId);
    return res.ok ? { ok: true, signal: 'continue' } : res;
  }

  return { ok: false, code: 'UNSUPPORTED_ACTION', reason: 'Unsupported action type' };
}

function advanceTraditionalTurnOrPhase(
  combat: TraditionalCombatState,
  actorId: string
): void {
  if (combat.turnStyle === 'initiative') {
    const order = combat.initiativeOrder;
    if (order.length === 0) {
      return;
    }
    const currentIdx = order.indexOf(actorId);
    const startIdx = currentIdx >= 0 ? currentIdx : combat.turnIndex;
    for (let offset = 1; offset <= order.length; offset += 1) {
      const nextIdx = (startIdx + offset) % order.length;
      if (startIdx + offset >= order.length) {
        combat.round += 1;
      }
      const nextId = order[nextIdx];
      if (nextId !== undefined) {
        const nextUnit = getSafeCombatant(combat, nextId);
        if (nextUnit !== undefined && nextUnit.alive && nextUnit.hp > 0) {
          combat.turnIndex = nextIdx;
          nextUnit.remainingActions = { action: 1, bonus: 1, reaction: 1 };
          return;
        }
      }
    }
    return;
  }

  // Phased mode
  setOwnProperty(combat.actedThisPhase, actorId, true);

  if (combat.activePhase === 'player') {
    const anyAllyRemaining = getSafeCombatantIds(combat).some((id) => {
      const c = getSafeCombatant(combat, id);
      return (
        c !== undefined &&
        c.team === 'ally' &&
        c.alive &&
        c.hp > 0 &&
        combat.actedThisPhase[id] !== true
      );
    });
    if (!anyAllyRemaining) {
      combat.activePhase = 'enemy';
      combat.actedThisPhase = {};
      for (const id of getSafeCombatantIds(combat)) {
        const c = getSafeCombatant(combat, id);
        if (c !== undefined && c.team !== 'ally' && c.alive && c.hp > 0) {
          c.remainingActions = { action: 1, bonus: 1, reaction: 1 };
        }
      }
    }
  } else {
    const anyEnemyRemaining = getSafeCombatantIds(combat).some((id) => {
      const c = getSafeCombatant(combat, id);
      return (
        c !== undefined &&
        c.team !== 'ally' &&
        c.alive &&
        c.hp > 0 &&
        combat.actedThisPhase[id] !== true
      );
    });
    if (!anyEnemyRemaining) {
      combat.activePhase = 'player';
      combat.round += 1;
      combat.actedThisPhase = {};
      for (const id of getSafeCombatantIds(combat)) {
        const c = getSafeCombatant(combat, id);
        if (c !== undefined && c.team === 'ally' && c.alive && c.hp > 0) {
          c.remainingActions = { action: 1, bonus: 1, reaction: 1 };
        }
      }
    }
  }
}

function buildSummaryText(summary: Omit<TraditionalOutcomeSummary, 'summaryText'>): string {
  const parts = [`Round ${summary.round} (${summary.actorId}):`];
  parts.push(
    summary.executedActions.length > 0
      ? summary.executedActions.join(', ')
      : 'no actions executed'
  );
  if (summary.defeatedIds.length > 0) {
    parts.push(`defeated=[${summary.defeatedIds.join(', ')}]`);
  }
  if (summary.encounterEnded) {
    parts.push(`encounter ended (winner=${String(summary.winnerTeam)})`);
  }
  return parts.join(' ');
}

/**
 * Build WorldState aftermath patches from a completed (or ongoing) traditional encounter:
 * syncs HP, resources, willpower, expended items, fled/surrendered/dead statuses, XP, and `clock_release`.
 */
export function buildTraditionalAftermathPatches(
  combatState: CombatState | TraditionalCombatState,
  worldState: WorldState,
  summary: Pick<TraditionalOutcomeSummary, 'encounterEnded' | 'winnerTeam' | 'summaryText'>,
  options?: BuildTraditionalAftermathOptions
): PatchOperation[] {
  const patches: PatchOperation[] = [];
  const trad = isTraditionalCombatState(combatState) ? combatState : undefined;
  const fledSet = new Set(trad?.fledIds ?? []);
  const surrenderedSet = new Set(trad?.surrenderedIds ?? []);

  for (const id of getSafeCombatantIds(combatState)) {
    const combatant = getSafeCombatant(combatState, id);
    if (combatant === undefined) {
      continue;
    }

    if (
      worldState.player.characterId === null &&
      id === worldState.player.id &&
      worldState.player.resources !== undefined
    ) {
      const hpPool = worldState.player.resources['hp'];
      if (hpPool !== undefined) {
        patches.push({
          op: 'set',
          path: 'player.resources.hp.current',
          value: clampHp(combatant.hp, hpPool.max),
        });
      }
    }

    if (!Object.hasOwn(worldState.entities.characters, id)) {
      continue;
    }
    const char = Object.getOwnPropertyDescriptor(worldState.entities.characters, id)?.value as
      | CharacterEntity
      | undefined;
    if (char === undefined) {
      continue;
    }

    if (char.resources !== undefined) {
      if (Object.hasOwn(char.resources, 'hp') && char.resources['hp'] !== undefined) {
        const hpPool = char.resources['hp'];
        patches.push({
          op: 'set',
          path: `entities.characters.${id}.resources.hp.current`,
          value: clampHp(combatant.hp, hpPool.max),
        });
      }
      if (Object.hasOwn(char.resources, 'willpower') && char.resources['willpower'] !== undefined) {
        const wpPool = char.resources['willpower'];
        patches.push({
          op: 'set',
          path: `entities.characters.${id}.resources.willpower.current`,
          value: normalizeZero(Math.max(0, Math.min(wpPool.max, combatant.willpower))),
        });
      }
      for (const rk of Object.keys(char.resources)) {
        if (
          !isSafeKey(rk) ||
          rk === 'hp' ||
          rk === 'willpower' ||
          !Object.hasOwn(char.resources, rk)
        ) {
          continue;
        }
        const pool = Object.getOwnPropertyDescriptor(char.resources, rk)?.value as
          | { current: number; max: number }
          | undefined;
        const combatRes = getOwnNumber(combatant.resources, rk);
        if (pool !== undefined && combatRes !== undefined) {
          patches.push({
            op: 'set',
            path: `entities.characters.${id}.resources.${rk}.current`,
            value: normalizeZero(Math.max(0, Math.min(pool.max, combatRes))),
          });
        }
      }
    }

    if (fledSet.has(id)) {
      patches.push(
        { op: 'set', path: `entities.characters.${id}.status`, value: 'offscreen' },
        { op: 'set', path: `entities.characters.${id}.presentInScene`, value: false }
      );
    } else if (surrenderedSet.has(id)) {
      patches.push({ op: 'set', path: `entities.characters.${id}.status`, value: 'captured' });
    } else if ((!combatant.alive || combatant.hp <= 0) && char.status !== 'dead') {
      patches.push({ op: 'set', path: `entities.characters.${id}.status`, value: 'dead' });
    }
  }

  // Sync expended consumable items
  if (trad !== undefined) {
    for (const itemId of Object.keys(trad.expendedItems)) {
      if (!isSafeKey(itemId) || !Object.hasOwn(trad.expendedItems, itemId)) {
        continue;
      }
      const spent = getOwnNumber(trad.expendedItems, itemId) ?? 0;
      if (spent > 0) {
        const prev = getOwnNumber(worldState.player.inventory.items, itemId) ?? 0;
        patches.push({
          op: 'set',
          path: `player.inventory.items.${itemId}`,
          value: normalizeZero(Math.max(0, prev - spent)),
        });
      }
    }
  }

  const xpAward = options?.xpAwardOnVictory;
  if (
    summary.encounterEnded &&
    summary.winnerTeam === 'ally' &&
    xpAward !== undefined &&
    xpAward > 0 &&
    worldState.capabilities.progression !== 'disabled'
  ) {
    for (const id of getSafeCombatantIds(combatState)) {
      const combatant = getSafeCombatant(combatState, id);
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
      const xpRes = awardExperience(char, xpAward, worldState.capabilities);
      patches.push(...xpRes.patches);
    }
  }

  patches.push({
    op: 'push',
    path: 'turnEvents.combatOutcomes',
    value: summary.summaryText,
  });

  if (summary.encounterEnded) {
    patches.push({ op: 'clock_release' });
  }

  return patches;
}

/**
 * Resolve a single combatant's turn in traditional (no-grid theater) combat.
 * Supports both `'phased'` (arbitrary ally order in Player Phase) and `'initiative'` turn styles.
 */
export function resolveTraditionalCombatTurn(
  params: ResolveTraditionalCombatTurnParams
): ResolveTraditionalCombatTurnResult {
  if (!isSafeKey(params.actorId)) {
    throw new RefereeError(`Invalid or forbidden actor id "${params.actorId}"`, {
      code: 'INVALID_ACTOR_ID',
    });
  }

  const nextCombatState = cloneTraditionalCombatState(params.combatState);
  const actor = getSafeCombatant(nextCombatState, params.actorId);
  if (actor === undefined) {
    throw new RefereeError(`Unknown combatant "${params.actorId}"`, {
      code: 'UNKNOWN_ACTOR',
    });
  }

  const roundAtTurnStart = nextCombatState.round;
  nextCombatState.triggerCountsThisTurn = {};

  const ctx: TurnExecutionContext = {
    combat: nextCombatState,
    worldState: params.worldState,
    rng: params.rng,
    executedActions: [],
    damageDealt: {},
    defeatedIds: [],
    newlyTriggeredCooldowns: new Set<string>(),
    interceptedTargets: {},
    fleeDc: params.fleeDc ?? 10,
  };

  const rejectedReasons: string[] = [];
  let salvagedPrefixCount = 0;
  let usedFallback = false;

  // Validate phased turn eligibility
  if (nextCombatState.turnStyle === 'phased') {
    const isPlayerUnit = actor.team === 'ally';
    if (nextCombatState.activePhase === 'player' && !isPlayerUnit) {
      rejectedReasons.push(`WRONG_PHASE: Cannot act with enemy "${actor.id}" during player phase`);
    } else if (nextCombatState.activePhase === 'enemy' && isPlayerUnit) {
      rejectedReasons.push(`WRONG_PHASE: Cannot act with ally "${actor.id}" during enemy phase`);
    } else if (nextCombatState.actedThisPhase[actor.id] === true) {
      rejectedReasons.push(`ALREADY_ACTED: Actor "${actor.id}" has already acted this phase`);
    }
  }

  if (rejectedReasons.length === 0) {
    if (!actor.alive || actor.hp <= 0) {
      rejectedReasons.push(`ACTOR_DEAD: Actor "${actor.id}" is defeated and skips turn`);
    } else {
      const tickStart = tickStatusEffects(actor.statuses, 'turn_start', ctx.rng);
      ctx.rng = tickStart.nextRng;
      actor.statuses = tickStart.statuses;
      applyTickEffectsToCombatant(
        actor,
        tickStart.tickDamageTotal,
        tickStart.tickHealingTotal,
        ctx.defeatedIds,
        ctx.damageDealt
      );

      if (actor.alive && actor.hp > 0) {
        triggerPassivesForCombatant(ctx, 'on_turn_start', actor, undefined, 0);
      }

      if (!actor.alive || actor.hp <= 0) {
        rejectedReasons.push(`ACTOR_DEAD: Actor "${actor.id}" fell at turn start`);
      } else if (isActorStunned(actor)) {
        rejectedReasons.push(`ACTOR_STUNNED: Actor "${actor.id}" is stunned and skips turn`);
      } else {
        let needFallback = params.proposedActions.length === 0;
        for (const action of params.proposedActions) {
          if (evaluateEncounterOutcome(nextCombatState).encounterEnded || !actor.alive || actor.hp <= 0) {
            break;
          }
          const stepRes = executeSingleTraditionalAction(ctx, actor, action, params.registry);
          if (!stepRes.ok) {
            rejectedReasons.push(`${stepRes.code}: ${stepRes.reason}`);
            salvagedPrefixCount = ctx.executedActions.length;
            needFallback = true;
            break;
          }
          if (stepRes.signal === 'end_turn') {
            break;
          }
        }

        if (
          needFallback &&
          !evaluateEncounterOutcome(nextCombatState).encounterEnded &&
          actor.alive &&
          actor.hp > 0
        ) {
          const fallbackActions = computeFallbackActions(
            nextCombatState,
            params.actorId,
            params.registry
          );
          if (fallbackActions.length > 0) {
            usedFallback = true;
            for (const fbAction of fallbackActions) {
              if (evaluateEncounterOutcome(nextCombatState).encounterEnded || !actor.alive || actor.hp <= 0) {
                break;
              }
              const fbRes = executeSingleTraditionalAction(ctx, actor, fbAction, params.registry);
              if (!fbRes.ok) {
                continue;
              }
              if (fbRes.signal === 'end_turn') {
                break;
              }
            }
          }
        }
      }

      const tickEnd = tickStatusEffects(actor.statuses, 'turn_end', ctx.rng);
      ctx.rng = tickEnd.nextRng;
      actor.statuses = tickEnd.statuses;
      if (actor.alive && actor.hp > 0) {
        applyTickEffectsToCombatant(
          actor,
          tickEnd.tickDamageTotal,
          tickEnd.tickHealingTotal,
          ctx.defeatedIds,
          ctx.damageDealt
        );
      }
      decrementCooldowns(actor, ctx.newlyTriggeredCooldowns);
    }

    const midOutcome = evaluateEncounterOutcome(nextCombatState);
    if (!midOutcome.encounterEnded) {
      advanceTraditionalTurnOrPhase(nextCombatState, params.actorId);
    }
  }

  const finalOutcome = evaluateEncounterOutcome(nextCombatState);
  if (finalOutcome.encounterEnded) {
    nextCombatState.active = false;
  }

  const baseSummary: Omit<TraditionalOutcomeSummary, 'summaryText'> = {
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
  const outcomeSummary: TraditionalOutcomeSummary = {
    ...baseSummary,
    summaryText: buildSummaryText(baseSummary),
  };

  const worldPatches = buildTraditionalAftermathPatches(
    nextCombatState,
    params.worldState,
    outcomeSummary,
    params.xpAwardOnVictory !== undefined
      ? { xpAwardOnVictory: params.xpAwardOnVictory }
      : undefined
  );

  return {
    nextCombatState,
    worldPatches,
    outcomeSummary,
    salvagedCount: salvagedPrefixCount,
    usedFallback,
    rejectedReasons: [...rejectedReasons],
    nextRng: ctx.rng,
    interceptedTargets: ctx.interceptedTargets,
  };
}

/**
 * Execute all remaining living Enemy/NPC units together during the Enemy Phase
 * of a `'phased'` traditional encounter, falling back deterministically per unit if needed.
 */
export function resolveTraditionalEnemyPhase(
  params: ResolveTraditionalEnemyPhaseParams
): ResolveTraditionalEnemyPhaseResult {
  let state = cloneTraditionalCombatState(params.combatState);
  let currentRng = params.rng;
  const turnResults: ResolveTraditionalCombatTurnResult[] = [];
  const allExecuted: string[] = [];
  const allRejected: string[] = [];
  const allDefeated: string[] = [];
  const combinedDamage: Record<string, number> = {};
  const roundAtStart = state.round;

  const unitsToAct = state.initiativeOrder.filter((id) => {
    const c = getSafeCombatant(state, id);
    return (
      c !== undefined &&
      c.team !== 'ally' &&
      c.alive &&
      c.hp > 0 &&
      state.actedThisPhase[id] !== true
    );
  });

  for (const unitId of unitsToAct) {
    if (!state.active || state.activePhase !== 'enemy') {
      break;
    }
    const unit = getSafeCombatant(state, unitId);
    if (unit === undefined || !unit.alive || unit.hp <= 0) {
      continue;
    }
    const proposed =
      isSafeKey(unitId) && Object.hasOwn(params.teamActions, unitId)
        ? (Object.getOwnPropertyDescriptor(params.teamActions, unitId)?.value as
            | readonly ProposedCombatAction[]
            | undefined) ?? []
        : [];

    const turnRes = resolveTraditionalCombatTurn({
      combatState: state,
      worldState: params.worldState,
      actorId: unitId,
      proposedActions: proposed,
      registry: params.registry,
      rng: currentRng,
      ...(params.xpAwardOnVictory !== undefined
        ? { xpAwardOnVictory: params.xpAwardOnVictory }
        : {}),
      ...(params.fleeDc !== undefined ? { fleeDc: params.fleeDc } : {}),
    });

    state = turnRes.nextCombatState;
    currentRng = turnRes.nextRng;
    turnResults.push(turnRes);
    allExecuted.push(...turnRes.outcomeSummary.executedActions);
    allRejected.push(...turnRes.rejectedReasons);
    for (const defId of turnRes.outcomeSummary.defeatedIds) {
      if (!allDefeated.includes(defId)) {
        allDefeated.push(defId);
      }
    }
    for (const dmgKey of Object.keys(turnRes.outcomeSummary.damageDealt)) {
      if (isSafeKey(dmgKey) && Object.hasOwn(turnRes.outcomeSummary.damageDealt, dmgKey)) {
        const val = getOwnNumber(turnRes.outcomeSummary.damageDealt, dmgKey) ?? 0;
        setOwnProperty(combinedDamage, dmgKey, normalizeZero((getOwnNumber(combinedDamage, dmgKey) ?? 0) + val));
      }
    }
  }

  const finalOutcome = evaluateEncounterOutcome(state);
  const baseSummary: Omit<TraditionalOutcomeSummary, 'summaryText'> = {
    round: roundAtStart,
    actorId: 'enemy_phase',
    executedActions: allExecuted,
    salvagedPrefixCount: turnResults.reduce((sum, r) => sum + r.salvagedCount, 0),
    usedFallback: turnResults.some((r) => r.usedFallback),
    rejectedReasons: allRejected,
    damageDealt: combinedDamage,
    defeatedIds: allDefeated,
    encounterEnded: finalOutcome.encounterEnded,
    winnerTeam: finalOutcome.winnerTeam,
  };
  const outcomeSummary: TraditionalOutcomeSummary = {
    ...baseSummary,
    summaryText: buildSummaryText(baseSummary),
  };

  const lastPatches =
    turnResults.length > 0
      ? turnResults[turnResults.length - 1]!.worldPatches
      : buildTraditionalAftermathPatches(
          state,
          params.worldState,
          outcomeSummary,
          params.xpAwardOnVictory !== undefined
            ? { xpAwardOnVictory: params.xpAwardOnVictory }
            : undefined
        );

  return {
    nextCombatState: state,
    worldPatches: lastPatches,
    turnResults,
    outcomeSummary,
    nextRng: currentRng,
  };
}
