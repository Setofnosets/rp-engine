import type { ProposedCombatAction } from '../combat/action-validator.js';
import type { GridCoord } from '../combat/grid-types.js';
import { type ValidationError, validationError } from '../core/errors.js';
import type { ModelGateway } from '../gateway/model-gateway.js';
import type { ChatMessage } from '../gateway/types.js';
import type { WorldState } from '../state/world-state.js';

export type SlashCommandName =
  | 'travel'
  | 'rest'
  | 'hold_clock'
  | 'release_clock'
  | 'play_as'
  | 'move'
  | 'attack'
  | 'skill'
  | 'defend'
  | 'end_turn';

export type ParsedPlayerIntent =
  | { kind: 'chat'; text: string }
  | {
      kind: 'command';
      command: SlashCommandName;
      args: Record<string, string | number | boolean | undefined>;
      rawText: string;
    }
  | { kind: 'combat_actions'; actions: ProposedCombatAction[]; rawText: string };

export interface ParsePlayerIntentParams {
  input: string;
  state: WorldState;
  inCombat: boolean;
  gateway?: ModelGateway;
  allowLlmFallback?: boolean;
  availableLocationIds?: readonly string[];
  availableSkillIds?: readonly string[];
  signal?: AbortSignal;
}

export interface ParsePlayerIntentResult {
  intent: ParsedPlayerIntent;
  usedLlm: boolean;
  warnings: ValidationError[];
}

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const INTENT_PARSER_SCHEMA: Record<string, unknown> = {
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

function parseMoveCoords(rest: string): { x: number; y: number } | null {
  const cleaned = rest.trim();
  if (cleaned.length === 0) {
    return null;
  }
  const match = /^(-?\d+)\s*[,\s]\s*(-?\d+)$/.exec(cleaned);
  if (!match) {
    return null;
  }
  const x = Number(match[1]);
  const y = Number(match[2]);
  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    return null;
  }
  return { x, y };
}

function parseSlashCommand(
  input: string,
  availableLocationIds?: readonly string[],
  availableSkillIds?: readonly string[]
): { intent: ParsedPlayerIntent; warnings: ValidationError[] } {
  const trimmed = input.trim();
  const spaceIndex = trimmed.search(/\s/);
  const rawCommand = (spaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex)).toLowerCase();
  const rest = spaceIndex === -1 ? '' : trimmed.slice(spaceIndex + 1).trim();
  const warnings: ValidationError[] = [];

  switch (rawCommand) {
    case 'travel': {
      if (rest.length === 0) {
        warnings.push(
          validationError('input', 'MISSING_ARGUMENT', 'Command /travel requires a location ID')
        );
        return { intent: { kind: 'chat', text: input }, warnings };
      }
      if (availableLocationIds !== undefined && !availableLocationIds.includes(rest)) {
        warnings.push(
          validationError(
            'locationId',
            'UNKNOWN_LOCATION',
            `Location "${rest}" is not in availableLocationIds`
          )
        );
      }
      return {
        intent: {
          kind: 'command',
          command: 'travel',
          args: { locationId: rest },
          rawText: input,
        },
        warnings,
      };
    }

    case 'rest':
      return {
        intent: {
          kind: 'command',
          command: 'rest',
          args: {},
          rawText: input,
        },
        warnings,
      };

    case 'hold-clock':
    case 'hold_clock':
      return {
        intent: {
          kind: 'command',
          command: 'hold_clock',
          args: rest.length > 0 ? { reason: rest } : {},
          rawText: input,
        },
        warnings,
      };

    case 'release-clock':
    case 'release_clock':
      return {
        intent: {
          kind: 'command',
          command: 'release_clock',
          args: {},
          rawText: input,
        },
        warnings,
      };

    case 'play-as':
    case 'play_as': {
      if (rest.length === 0) {
        warnings.push(
          validationError('input', 'MISSING_ARGUMENT', 'Command /play-as requires a character ID')
        );
        return { intent: { kind: 'chat', text: input }, warnings };
      }
      return {
        intent: {
          kind: 'command',
          command: 'play_as',
          args: { characterId: rest },
          rawText: input,
        },
        warnings,
      };
    }

    case 'move': {
      const coords = parseMoveCoords(rest);
      if (coords === null) {
        warnings.push(
          validationError('input', 'INVALID_ARGUMENT', 'Command /move requires integer coordinates x,y')
        );
        return { intent: { kind: 'chat', text: input }, warnings };
      }
      return {
        intent: {
          kind: 'command',
          command: 'move',
          args: { x: coords.x, y: coords.y },
          rawText: input,
        },
        warnings,
      };
    }

    case 'attack': {
      if (rest.length === 0) {
        warnings.push(
          validationError('input', 'MISSING_ARGUMENT', 'Command /attack requires a target ID')
        );
        return { intent: { kind: 'chat', text: input }, warnings };
      }
      const targetId = rest.split(/\s+/)[0] ?? '';
      return {
        intent: {
          kind: 'command',
          command: 'attack',
          args: { targetId },
          rawText: input,
        },
        warnings,
      };
    }

    case 'skill': {
      if (rest.length === 0) {
        warnings.push(
          validationError('input', 'MISSING_ARGUMENT', 'Command /skill requires a skill ID')
        );
        return { intent: { kind: 'chat', text: input }, warnings };
      }
      const parts = rest.split(/\s+/);
      const skillId = parts[0] ?? '';
      const targetId = parts[1];
      if (availableSkillIds !== undefined && !availableSkillIds.includes(skillId)) {
        warnings.push(
          validationError('skillId', 'UNKNOWN_SKILL', `Skill "${skillId}" is not in availableSkillIds`)
        );
      }
      return {
        intent: {
          kind: 'command',
          command: 'skill',
          args: targetId !== undefined ? { skillId, targetId } : { skillId },
          rawText: input,
        },
        warnings,
      };
    }

    case 'defend':
      return {
        intent: {
          kind: 'command',
          command: 'defend',
          args: {},
          rawText: input,
        },
        warnings,
      };

    case 'end-turn':
    case 'end_turn':
      return {
        intent: {
          kind: 'command',
          command: 'end_turn',
          args: {},
          rawText: input,
        },
        warnings,
      };

    default:
      warnings.push(
        validationError('input', 'UNKNOWN_SLASH_COMMAND', `Unknown slash command "/${rawCommand}"`)
      );
      return { intent: { kind: 'chat', text: input }, warnings };
  }
}

function buildIntentMessages(
  input: string,
  state: WorldState,
  availableSkillIds?: readonly string[]
): ChatMessage[] {
  const skillsLine =
    availableSkillIds !== undefined && availableSkillIds.length > 0
      ? availableSkillIds.join(', ')
      : 'basic_strike, defend';
  const presentCharacters = state.scene.presentCharacterIds.join(', ') || 'none';

  return [
    {
      role: 'system',
      content: [
        'You are the combat intent parser. Convert the player text into an ordered array of ProposedCombatAction JSON objects.',
        'If the player text is purely narrative dialogue/chat with no tactical action, return { "actions": [] }.',
        `Available skill IDs: ${skillsLine}`,
        `Present character IDs: ${presentCharacters}`,
      ].join('\n'),
    },
    {
      role: 'user',
      content: input,
    },
  ];
}

function sanitizeParsedCombatActions(
  rawActions: unknown,
  availableSkillIds: readonly string[] | undefined,
  warnings: ValidationError[]
): ProposedCombatAction[] {
  if (!Array.isArray(rawActions)) {
    warnings.push(
      validationError('actions', 'INVALID_TYPE', 'Intent parser output did not contain an actions array')
    );
    return [];
  }

  const allowedSkills = availableSkillIds !== undefined ? new Set(availableSkillIds) : undefined;
  const parsed: ProposedCombatAction[] = [];

  for (let i = 0; i < rawActions.length; i += 1) {
    const raw = rawActions[i];
    if (!isPlainRecord(raw)) {
      warnings.push(validationError(`actions[${i}]`, 'INVALID_TYPE', 'Combat action must be an object'));
      continue;
    }

    const type = getOwn(raw, 'type');
    if (type === 'defend') {
      parsed.push({ type: 'defend' });
      continue;
    }

    if (type === 'end_turn') {
      parsed.push({ type: 'end_turn' });
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
          validationError(`actions[${i}]`, 'INVALID_MOVE', 'Move action requires valid integer "to" or "path"')
        );
        continue;
      }
      parsed.push({
        type: 'move',
        ...(to !== undefined ? { to } : {}),
        ...(path !== undefined ? { path } : {}),
      });
      continue;
    }

    if (type === 'skill') {
      const skillId = getOwn(raw, 'skillId');
      if (typeof skillId !== 'string' || !isSafeKey(skillId) || skillId.trim().length === 0) {
        warnings.push(
          validationError(`actions[${i}].skillId`, 'INVALID_SKILL', 'Skill action requires non-empty skillId')
        );
        continue;
      }
      const trimmedSkillId = skillId.trim();
      if (allowedSkills !== undefined && !allowedSkills.has(trimmedSkillId)) {
        warnings.push(
          validationError(
            `actions[${i}].skillId`,
            'UNKNOWN_SKILL',
            `Filtered unknown skill "${trimmedSkillId}"`
          )
        );
        continue;
      }
      const targetId = getOwn(raw, 'targetId');
      const targetCoord = parseGridCoord(getOwn(raw, 'targetCoord'));
      parsed.push({
        type: 'skill',
        skillId: trimmedSkillId,
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

  return parsed;
}

/**
 * Parse player input deterministically via slash commands first, falling back to optional
 * structured LLM combat intent extraction only during active combat.
 */
export async function parsePlayerIntent(
  params: ParsePlayerIntentParams
): Promise<ParsePlayerIntentResult> {
  const trimmed = params.input.trim();

  if (trimmed.startsWith('/')) {
    const slashResult = parseSlashCommand(
      params.input,
      params.availableLocationIds,
      params.availableSkillIds
    );
    return {
      intent: slashResult.intent,
      usedLlm: false,
      warnings: slashResult.warnings,
    };
  }

  if (params.inCombat && params.allowLlmFallback === true && params.gateway !== undefined) {
    const gatewayRes = await params.gateway.generateStructured<{ actions?: unknown }>({
      role: 'intent_parser',
      messages: buildIntentMessages(params.input, params.state, params.availableSkillIds),
      schema: INTENT_PARSER_SCHEMA,
      schemaName: 'combat_intent_parser',
      signal: params.signal,
    });

    if (!gatewayRes.ok) {
      return {
        intent: { kind: 'chat', text: params.input },
        usedLlm: true,
        warnings: [...gatewayRes.error],
      };
    }

    const warnings: ValidationError[] = [];
    const data = gatewayRes.value.data;
    if (!isPlainRecord(data)) {
      warnings.push(
        validationError('response', 'INVALID_TYPE', 'Intent parser output was not an object')
      );
      return {
        intent: { kind: 'chat', text: params.input },
        usedLlm: true,
        warnings,
      };
    }

    const actions = sanitizeParsedCombatActions(
      getOwn(data, 'actions'),
      params.availableSkillIds,
      warnings
    );

    if (actions.length === 0) {
      return {
        intent: { kind: 'chat', text: params.input },
        usedLlm: true,
        warnings,
      };
    }

    return {
      intent: { kind: 'combat_actions', actions, rawText: params.input },
      usedLlm: true,
      warnings,
    };
  }

  return {
    intent: { kind: 'chat', text: params.input },
    usedLlm: false,
    warnings: [],
  };
}
