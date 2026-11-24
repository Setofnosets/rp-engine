import {
  type CombatState,
  type CombatantState,
  type ProposedCombatAction,
  getSafeCombatant,
  getSafeCombatantIds,
  setOwnProperty,
} from '../combat/action-validator.js';
import { computeFallbackActions } from '../combat/fallback-tactics.js';
import type { GridCoord } from '../combat/grid-types.js';
import type { SkillRegistry } from '../combat/skill-registry.js';
import { type ValidationError, validationError } from '../core/errors.js';
import type { ModelGateway } from '../gateway/model-gateway.js';
import type { ChatMessage } from '../gateway/types.js';

export interface ProposeNpcCombatActionsParams {
  combatState: CombatState;
  actorId: string;
  registry: SkillRegistry;
  gateway: ModelGateway;
  signal?: AbortSignal;
}

export interface ProposeNpcCombatActionsResult {
  proposedActions: ProposedCombatAction[];
  usedFallbackOnError: boolean;
  warnings: ValidationError[];
}

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const COMBAT_AGENT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['actions'],
  properties: {
    actions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type'],
        properties: {
          type: { type: 'string', enum: ['move', 'skill', 'defend', 'end_turn'] },
          to: {
            type: 'object',
            additionalProperties: false,
            required: ['x', 'y'],
            properties: {
              x: { type: 'integer' },
              y: { type: 'integer' },
            },
          },
          path: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['x', 'y'],
              properties: {
                x: { type: 'integer' },
                y: { type: 'integer' },
              },
            },
          },
          skillId: { type: 'string' },
          targetId: { type: 'string' },
          targetCoord: {
            type: 'object',
            additionalProperties: false,
            required: ['x', 'y'],
            properties: {
              x: { type: 'integer' },
              y: { type: 'integer' },
            },
          },
        },
      },
    },
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

function parseGridCoord(value: unknown): GridCoord | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }
  const x = getOwn(value, 'x');
  const y = getOwn(value, 'y');
  if (
    typeof x === 'number' &&
    Number.isInteger(x) &&
    typeof y === 'number' &&
    Number.isInteger(y)
  ) {
    return { x, y };
  }
  return undefined;
}

function getLegalSkillIds(actor: CombatantState, registry: SkillRegistry): string[] {
  const legal = new Set<string>(['basic_strike', 'defend']);
  for (const abilityId of actor.abilities) {
    if (!isSafeKey(abilityId)) {
      continue;
    }
    const cd = getOwn(actor.cooldowns, abilityId);
    if (typeof cd === 'number' && cd > 0) {
      continue;
    }
    const skill = registry.get(abilityId);
    if (skill !== undefined) {
      let affordable = true;
      for (const [resKey, cost] of Object.entries(skill.resourceCosts)) {
        if (!isSafeKey(resKey)) {
          continue;
        }
        const currentRes = getOwn(actor.resources, resKey);
        if (typeof currentRes !== 'number' || currentRes < cost) {
          affordable = false;
          break;
        }
      }
      if (affordable) {
        legal.add(abilityId);
      }
    }
  }
  return [...legal].sort();
}

function formatCombatantSnapshot(combatant: CombatantState): string {
  const resources = Object.entries(combatant.resources)
    .filter(([k]) => isSafeKey(k))
    .map(([k, v]) => `${k}:${v}`)
    .join(',');
  return `${combatant.id} (${combatant.name}, team=${combatant.team}, pos=(${combatant.coord.x},${combatant.coord.y}), hp=${combatant.hp}/${combatant.maxHp}, resources=[${resources}])`;
}

function buildCombatAgentMessages(
  combatState: CombatState,
  actor: CombatantState,
  legalSkillIds: readonly string[]
): ChatMessage[] {
  const aliveIds = getSafeCombatantIds(combatState).sort();
  const snapshots: string[] = [];
  for (const id of aliveIds) {
    const c = getSafeCombatant(combatState, id);
    if (c !== undefined && c.alive) {
      snapshots.push(formatCombatantSnapshot(c));
    }
  }

  const gridSummary =
    combatState.grid !== null
      ? `${combatState.grid.width}x${combatState.grid.height}`
      : 'traditional (no grid)';

  return [
    {
      role: 'system',
      content: [
        'You are the NPC tactical combat agent. Propose legal combat actions for the active actor.',
        'Respond ONLY with JSON matching the schema.',
        `Mode: ${combatState.mode}, Grid: ${gridSummary}, Round: ${combatState.round}`,
        `Active actor: ${formatCombatantSnapshot(actor)}`,
        `Remaining movement: ${actor.remainingMovement}, action=${actor.remainingActions.action}, bonus=${actor.remainingActions.bonus}`,
        `Legal skill IDs: ${legalSkillIds.join(', ')}`,
      ].join('\n'),
    },
    {
      role: 'user',
      content: ['Combatants:', ...snapshots].join('\n'),
    },
  ];
}

function sanitizeProposedActions(
  rawActions: unknown,
  legalSkillSet: ReadonlySet<string>,
  warnings: ValidationError[]
): ProposedCombatAction[] {
  if (!Array.isArray(rawActions)) {
    warnings.push(
      validationError('actions', 'INVALID_TYPE', 'Combat agent response missing actions array')
    );
    return [];
  }

  const actions: ProposedCombatAction[] = [];

  for (let i = 0; i < rawActions.length; i += 1) {
    const raw = rawActions[i];
    if (!isPlainRecord(raw)) {
      warnings.push(validationError(`actions[${i}]`, 'INVALID_TYPE', 'Action entry must be an object'));
      continue;
    }

    const type = getOwn(raw, 'type');
    if (type === 'defend') {
      actions.push({ type: 'defend' });
      continue;
    }

    if (type === 'end_turn') {
      actions.push({ type: 'end_turn' });
      continue;
    }

    if (type === 'move') {
      const to = parseGridCoord(getOwn(raw, 'to'));
      const rawPath = getOwn(raw, 'path');
      let path: GridCoord[] | undefined;
      if (Array.isArray(rawPath)) {
        const coords = rawPath.map(parseGridCoord);
        if (coords.length > 0 && coords.every((c): c is GridCoord => c !== undefined)) {
          path = coords;
        }
      }
      if (to === undefined && path === undefined) {
        warnings.push(
          validationError(`actions[${i}]`, 'INVALID_MOVE', 'Move action missing valid coordinates')
        );
        continue;
      }
      actions.push({
        type: 'move',
        ...(to !== undefined ? { to } : {}),
        ...(path !== undefined ? { path } : {}),
      });
      continue;
    }

    if (type === 'skill') {
      const skillId = getOwn(raw, 'skillId');
      if (typeof skillId !== 'string' || !isSafeKey(skillId) || !legalSkillSet.has(skillId)) {
        warnings.push(
          validationError(
            `actions[${i}].skillId`,
            'ILLEGAL_SKILL',
            `Filtered illegal or unavailable skill "${String(skillId)}"`
          )
        );
        continue;
      }
      const targetId = getOwn(raw, 'targetId');
      const targetCoord = parseGridCoord(getOwn(raw, 'targetCoord'));
      actions.push({
        type: 'skill',
        skillId,
        ...(typeof targetId === 'string' && isSafeKey(targetId) && targetId.trim().length > 0
          ? { targetId: targetId.trim() }
          : {}),
        ...(targetCoord !== undefined ? { targetCoord } : {}),
      });
      continue;
    }

    warnings.push(
      validationError(`actions[${i}].type`, 'INVALID_ACTION_TYPE', `Unsupported action type "${String(type)}"`)
    );
  }

  return actions;
}

/**
 * Ask the combat_agent role to propose tactical actions for an NPC combatant, degrading cleanly
 * to an empty array (`usedFallbackOnError: true`) on error so deterministic fallback tactics run.
 */
export async function proposeNpcCombatActions(
  params: ProposeNpcCombatActionsParams
): Promise<ProposeNpcCombatActionsResult> {
  const actor = getSafeCombatant(params.combatState, params.actorId);
  if (actor === undefined || !actor.alive) {
    return {
      proposedActions: [],
      usedFallbackOnError: true,
      warnings: [
        validationError(
          'actorId',
          'INVALID_ACTOR',
          `Actor "${params.actorId}" is absent or defeated`
        ),
      ],
    };
  }

  const legalSkillIds = getLegalSkillIds(actor, params.registry);
  const legalSkillSet = new Set(legalSkillIds);

  const gatewayRes = await params.gateway.generateStructured<unknown>({
    role: 'combat_agent',
    messages: buildCombatAgentMessages(params.combatState, actor, legalSkillIds),
    schema: COMBAT_AGENT_SCHEMA,
    schemaName: 'npc_combat_actions',
    signal: params.signal,
  });

  if (!gatewayRes.ok) {
    return {
      proposedActions: [],
      usedFallbackOnError: true,
      warnings: [...gatewayRes.error],
    };
  }

  const data = gatewayRes.value.data;
  const warnings: ValidationError[] = [];
  if (!isPlainRecord(data)) {
    warnings.push(
      validationError('response', 'INVALID_TYPE', 'Combat agent response was not an object')
    );
    return {
      proposedActions: [],
      usedFallbackOnError: true,
      warnings,
    };
  }

  const proposedActions = sanitizeProposedActions(
    getOwn(data, 'actions'),
    legalSkillSet,
    warnings
  );

  if (proposedActions.length === 0) {
    return {
      proposedActions: [],
      usedFallbackOnError: true,
      warnings,
    };
  }

  return {
    proposedActions,
    usedFallbackOnError: false,
    warnings,
  };
}

export interface ProposePhasedTeamActionsParams {
  combatState: CombatState;
  unitsToAct: readonly string[];
  registry: SkillRegistry;
  gateway: ModelGateway;
  signal?: AbortSignal;
}

export interface PhasedUnitActionProposal {
  unitId: string;
  proposedActions: ProposedCombatAction[];
  usedFallback: boolean;
}

export interface ProposePhasedTeamActionsResult {
  teamActions: Record<string, ProposedCombatAction[]>;
  unitResults: PhasedUnitActionProposal[];
  usedFallbackForAny: boolean;
  warnings: ValidationError[];
}

const PHASED_TEAM_ACTIONS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['unitActions'],
  properties: {
    unitActions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['unitId', 'actions'],
        properties: {
          unitId: { type: 'string' },
          actions: COMBAT_AGENT_SCHEMA['properties']
            ? (COMBAT_AGENT_SCHEMA['properties'] as Record<string, unknown>)['actions']
            : { type: 'array' },
        },
      },
    },
  },
};

function buildPhasedTeamAgentMessages(
  combatState: CombatState,
  actors: readonly CombatantState[],
  legalSkillMap: ReadonlyMap<string, readonly string[]>
): ChatMessage[] {
  const aliveIds = getSafeCombatantIds(combatState).sort();
  const snapshots: string[] = [];
  for (const id of aliveIds) {
    const c = getSafeCombatant(combatState, id);
    if (c !== undefined && c.alive && c.hp > 0) {
      const rowTag = c.formationRow !== undefined ? `, row=${c.formationRow}` : '';
      snapshots.push(`${formatCombatantSnapshot(c)}${rowTag}`);
    }
  }

  const unitCatalog = actors.map((actor) => {
    const skills = legalSkillMap.get(actor.id) ?? ['basic_strike', 'defend'];
    return `- ${actor.id}: action=${actor.remainingActions.action}, bonus=${actor.remainingActions.bonus}, legalSkills=[${skills.join(', ')}]`;
  });

  return [
    {
      role: 'system',
      content: [
        'You are the tactical combat AI for a phased Enemy/NPC turn.',
        'Propose a batched JSON array of actions for every unit listed in unitsToAct.',
        'Respond ONLY with JSON matching the schema.',
        `Mode: ${combatState.mode}, Round: ${combatState.round}`,
        'Units to act:',
        ...unitCatalog,
      ].join('\n'),
    },
    {
      role: 'user',
      content: ['Combatants:', ...snapshots].join('\n'),
    },
  ];
}

function buildFallbackTeamResult(
  combatState: CombatState,
  actors: readonly CombatantState[],
  registry: SkillRegistry,
  warnings: ValidationError[]
): ProposePhasedTeamActionsResult {
  const teamActions: Record<string, ProposedCombatAction[]> = {};
  const unitResults: PhasedUnitActionProposal[] = [];

  for (const actor of actors) {
    const fb = computeFallbackActions(combatState, actor.id, registry);
    setOwnProperty(teamActions, actor.id, fb);
    unitResults.push({
      unitId: actor.id,
      proposedActions: fb,
      usedFallback: true,
    });
  }

  return {
    teamActions,
    unitResults,
    usedFallbackForAny: actors.length > 0,
    warnings,
  };
}

/**
 * Propose batched actions for all `unitsToAct` in a phased Enemy/NPC phase,
 * validating each unit's actions against its legal skills and falling back
 * deterministically via `computeFallbackActions` for any missing or invalid unit.
 */
export async function proposePhasedTeamActions(
  params: ProposePhasedTeamActionsParams
): Promise<ProposePhasedTeamActionsResult> {
  const warnings: ValidationError[] = [];
  const validActors: CombatantState[] = [];
  const seen = new Set<string>();

  for (const unitId of params.unitsToAct) {
    if (!isSafeKey(unitId) || seen.has(unitId)) {
      continue;
    }
    const actor = getSafeCombatant(params.combatState, unitId);
    if (actor === undefined || !actor.alive || actor.hp <= 0) {
      warnings.push(
        validationError(
          'unitsToAct',
          'INVALID_ACTOR',
          `Actor "${unitId}" is absent or defeated`
        )
      );
      continue;
    }
    seen.add(unitId);
    validActors.push(actor);
  }

  if (validActors.length === 0) {
    return {
      teamActions: {},
      unitResults: [],
      usedFallbackForAny: false,
      warnings,
    };
  }

  const legalSkillMap = new Map<string, string[]>();
  const legalSkillSetMap = new Map<string, Set<string>>();
  for (const actor of validActors) {
    const legal = getLegalSkillIds(actor, params.registry);
    legalSkillMap.set(actor.id, legal);
    legalSkillSetMap.set(actor.id, new Set(legal));
  }

  const gatewayRes = await params.gateway.generateStructured<unknown>({
    role: 'combat_agent',
    messages: buildPhasedTeamAgentMessages(params.combatState, validActors, legalSkillMap),
    schema: PHASED_TEAM_ACTIONS_SCHEMA,
    schemaName: 'phased_team_combat_actions',
    signal: params.signal,
  });

  if (!gatewayRes.ok) {
    return buildFallbackTeamResult(params.combatState, validActors, params.registry, [
      ...warnings,
      ...gatewayRes.error,
    ]);
  }

  const data = gatewayRes.value.data;
  if (!isPlainRecord(data)) {
    warnings.push(
      validationError('response', 'INVALID_TYPE', 'Phased combat agent response was not an object')
    );
    return buildFallbackTeamResult(params.combatState, validActors, params.registry, warnings);
  }

  const rawUnitActions = getOwn(data, 'unitActions');
  if (!Array.isArray(rawUnitActions)) {
    warnings.push(
      validationError('unitActions', 'INVALID_TYPE', 'Phased combat agent response missing unitActions array')
    );
    return buildFallbackTeamResult(params.combatState, validActors, params.registry, warnings);
  }

  const proposedByUnit = new Map<string, ProposedCombatAction[]>();
  for (let i = 0; i < rawUnitActions.length; i += 1) {
    const entry = rawUnitActions[i];
    if (!isPlainRecord(entry)) {
      warnings.push(validationError(`unitActions[${i}]`, 'INVALID_TYPE', 'Unit action entry must be an object'));
      continue;
    }
    const rawUnitId = getOwn(entry, 'unitId');
    if (typeof rawUnitId !== 'string' || !isSafeKey(rawUnitId) || !legalSkillSetMap.has(rawUnitId)) {
      warnings.push(
        validationError(
          `unitActions[${i}].unitId`,
          'UNKNOWN_UNIT',
          `Ignored unknown unitId "${String(rawUnitId)}"`
        )
      );
      continue;
    }
    if (proposedByUnit.has(rawUnitId)) {
      continue;
    }
    const legalSet = legalSkillSetMap.get(rawUnitId) as ReadonlySet<string>;
    const sanitized = sanitizeProposedActions(getOwn(entry, 'actions'), legalSet, warnings);
    if (sanitized.length > 0) {
      proposedByUnit.set(rawUnitId, sanitized);
    }
  }

  const teamActions: Record<string, ProposedCombatAction[]> = {};
  const unitResults: PhasedUnitActionProposal[] = [];
  let usedFallbackForAny = false;

  for (const actor of validActors) {
    const proposed = proposedByUnit.get(actor.id);
    if (proposed !== undefined && proposed.length > 0) {
      setOwnProperty(teamActions, actor.id, proposed);
      unitResults.push({
        unitId: actor.id,
        proposedActions: proposed,
        usedFallback: false,
      });
    } else {
      usedFallbackForAny = true;
      const fb = computeFallbackActions(params.combatState, actor.id, params.registry);
      setOwnProperty(teamActions, actor.id, fb);
      unitResults.push({
        unitId: actor.id,
        proposedActions: fb,
        usedFallback: true,
      });
    }
  }

  return {
    teamActions,
    unitResults,
    usedFallbackForAny,
    warnings,
  };
}
