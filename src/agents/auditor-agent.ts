import { type ValidationError, validationError } from '../core/errors.js';
import type { ModelGateway } from '../gateway/model-gateway.js';
import type { AgentRole, ChatMessage } from '../gateway/types.js';
import type { FormIndex } from '../state/forms.js';
import type { PatchBatch, PatchOperation } from '../state/patch.js';
import type { CharacterEntity, CharacterStatus, WorldState } from '../state/world-state.js';

export type AuditorSeverity = 'info' | 'warning' | 'error';

export type AuditorRuleCode =
  | 'INACTIVE_CHARACTER_IN_SCENE'
  | 'FORM_GROUP_EXCLUSIVITY_VIOLATION'
  | 'CANON_POV_DUPLICATE_IN_SCENE'
  | 'RESOURCE_OUT_OF_BOUNDS'
  | 'LLM_CONTINUITY_NOTE';

export interface AuditorFinding {
  readonly code: AuditorRuleCode;
  readonly severity: AuditorSeverity;
  readonly path: string;
  readonly message: string;
  readonly entityId?: string;
  readonly autoCorrected: boolean;
}

export interface DeterministicAuditResult {
  readonly findings: readonly AuditorFinding[];
  readonly correctivePatches: readonly PatchOperation[];
}

export interface RunAuditorPassParams {
  readonly state: WorldState;
  readonly formIndex?: FormIndex;
  readonly gateway?: ModelGateway;
  readonly useLlmPass?: boolean;
  readonly llmCadenceTurns?: number;
  readonly llmRole?: AgentRole;
  readonly recentExchangeText?: string;
  readonly signal?: AbortSignal;
}

export interface RunAuditorPassResult {
  readonly findings: readonly AuditorFinding[];
  readonly correctivePatches: readonly PatchOperation[];
  readonly proposedBatch: PatchBatch | null;
  readonly skippedLlmByCadence: boolean;
  readonly warnings: readonly ValidationError[];
}

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const EXCLUDED_SCENE_STATUSES: ReadonlySet<CharacterStatus> = new Set([
  'dead',
  'captured',
  'imprisoned',
]);

const AUDITOR_LLM_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['notes'],
  properties: {
    notes: {
      type: 'array',
      maxItems: 6,
      items: { type: 'string', maxLength: 240 },
    },
  },
};

function isSafeKey(key: string): boolean {
  return key.length > 0 && !FORBIDDEN_KEYS.has(key);
}

function getOwn<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  if (!record || !isSafeKey(key) || !Object.hasOwn(record, key)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(record, key)?.value as T | undefined;
}

function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}

function compareIdsDeterministic(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

function resolveCharacterFormGroup(
  character: CharacterEntity | undefined,
  formIndex?: FormIndex
): string | null {
  if (!character) {
    return null;
  }
  if (typeof character.formGroup === 'string' && character.formGroup.trim().length > 0) {
    return character.formGroup;
  }
  if (character.formId !== null && formIndex !== undefined) {
    return formIndex.byId.get(character.formId)?.formGroup ?? null;
  }
  return null;
}

/**
 * Run fast deterministic state invariant checks on a {@link WorldState}:
 * (a) dead/captured/imprisoned NPCs excluded from `scene.presentCharacterIds`,
 * (b) `formGroup` exclusivity intact in `scene.presentCharacterIds`,
 * (c) `player.canonCharacterId` NPC duplicate & same-formGroup members excluded from `scene.presentCharacterIds`,
 * (d) resource `current` within `[0, max]`.
 */
export function runDeterministicStateAudit(
  worldState: WorldState,
  formIndex?: FormIndex
): DeterministicAuditResult {
  const findings: AuditorFinding[] = [];
  const correctivePatches: PatchOperation[] = [];

  const canonCharacterId = worldState.player.canonCharacterId ?? null;
  const canonCharacter =
    canonCharacterId !== null
      ? getOwn(worldState.entities.characters, canonCharacterId)
      : undefined;
  const canonFormGroup = resolveCharacterFormGroup(canonCharacter, formIndex);

  const keptPresentIds: string[] = [];
  const removedPresentIds: string[] = [];
  const seenPresentIds = new Set<string>();
  const seenFormGroups = new Map<string, string>();

  for (const charId of worldState.scene.presentCharacterIds) {
    if (!isSafeKey(charId)) {
      removedPresentIds.push(charId);
      continue;
    }

    const character = getOwn(worldState.entities.characters, charId);

    // (a) Dead / captured / imprisoned NPCs excluded from scene presence
    if (character && EXCLUDED_SCENE_STATUSES.has(character.status)) {
      findings.push({
        code: 'INACTIVE_CHARACTER_IN_SCENE',
        severity: 'error',
        path: 'scene.presentCharacterIds',
        entityId: charId,
        message: `Character "${charId}" with status "${character.status}" cannot be present in scene.`,
        autoCorrected: true,
      });
      removedPresentIds.push(charId);
      continue;
    }

    // (c) Canon POV player duplicate & same-formGroup members excluded from scene presence
    const charFormGroup = resolveCharacterFormGroup(character, formIndex);
    if (canonCharacterId !== null && charId === canonCharacterId) {
      findings.push({
        code: 'CANON_POV_DUPLICATE_IN_SCENE',
        severity: 'error',
        path: 'scene.presentCharacterIds',
        entityId: charId,
        message: `Canon POV character "${charId}" cannot appear as an NPC duplicate in scene.presentCharacterIds.`,
        autoCorrected: true,
      });
      removedPresentIds.push(charId);
      continue;
    }
    if (canonFormGroup !== null && charFormGroup === canonFormGroup) {
      findings.push({
        code: 'CANON_POV_DUPLICATE_IN_SCENE',
        severity: 'error',
        path: 'scene.presentCharacterIds',
        entityId: charId,
        message: `Character "${charId}" shares formGroup "${canonFormGroup}" with canon POV "${canonCharacterId}" and cannot appear in scene.presentCharacterIds.`,
        autoCorrected: true,
      });
      removedPresentIds.push(charId);
      continue;
    }

    // (b) formGroup exclusivity intact in scene.presentCharacterIds
    if (charFormGroup !== null) {
      const existingHolder = seenFormGroups.get(charFormGroup);
      if (existingHolder !== undefined && existingHolder !== charId) {
        findings.push({
          code: 'FORM_GROUP_EXCLUSIVITY_VIOLATION',
          severity: 'error',
          path: 'scene.presentCharacterIds',
          entityId: charId,
          message: `Character "${charId}" violates formGroup "${charFormGroup}" exclusivity (already represented by "${existingHolder}").`,
          autoCorrected: true,
        });
        removedPresentIds.push(charId);
        continue;
      }
      seenFormGroups.set(charFormGroup, charId);
    }

    if (!seenPresentIds.has(charId)) {
      seenPresentIds.add(charId);
      keptPresentIds.push(charId);
    }
  }

  if (
    removedPresentIds.length > 0 ||
    keptPresentIds.length !== worldState.scene.presentCharacterIds.length
  ) {
    correctivePatches.push({
      op: 'set',
      path: 'scene.presentCharacterIds',
      value: keptPresentIds,
    });
    const uniqueRemoved = [...new Set(removedPresentIds)].sort(compareIdsDeterministic);
    for (const removedId of uniqueRemoved) {
      if (isSafeKey(removedId) && getOwn(worldState.entities.characters, removedId)?.presentInScene) {
        correctivePatches.push({
          op: 'entity_patch',
          collection: 'characters',
          entityId: removedId,
          patch: { presentInScene: false },
        });
      }
    }
  }

  // (d) Resource pool bounds [0, max] on player and all characters
  if (worldState.player.resources) {
    const poolKeys = Object.keys(worldState.player.resources)
      .filter(isSafeKey)
      .sort(compareIdsDeterministic);
    for (const poolKey of poolKeys) {
      const pool = getOwn(worldState.player.resources, poolKey);
      if (!pool) {
        continue;
      }
      const effectiveMax = pool.max < 0 ? 0 : normalizeZero(pool.max);
      if (
        !Number.isFinite(pool.current) ||
        pool.current < 0 ||
        pool.current > effectiveMax ||
        Object.is(pool.current, -0)
      ) {
        const clamped = Number.isFinite(pool.current)
          ? normalizeZero(Math.min(effectiveMax, Math.max(0, pool.current)))
          : 0;
        findings.push({
          code: 'RESOURCE_OUT_OF_BOUNDS',
          severity: 'warning',
          path: `player.resources.${poolKey}.current`,
          message: `Player resource "${poolKey}" (${pool.current}) outside [0, ${effectiveMax}]; clamped to ${clamped}.`,
          autoCorrected: true,
        });
        correctivePatches.push({
          op: 'set',
          path: `player.resources.${poolKey}.current`,
          value: clamped,
        });
      }
    }
  }

  const charIds = Object.keys(worldState.entities.characters)
    .filter(isSafeKey)
    .sort(compareIdsDeterministic);
  for (const charId of charIds) {
    const character = getOwn(worldState.entities.characters, charId);
    if (!character?.resources) {
      continue;
    }
    const poolKeys = Object.keys(character.resources)
      .filter(isSafeKey)
      .sort(compareIdsDeterministic);
    for (const poolKey of poolKeys) {
      const pool = getOwn(character.resources, poolKey);
      if (!pool) {
        continue;
      }
      const effectiveMax = pool.max < 0 ? 0 : normalizeZero(pool.max);
      if (
        !Number.isFinite(pool.current) ||
        pool.current < 0 ||
        pool.current > effectiveMax ||
        Object.is(pool.current, -0)
      ) {
        const clamped = Number.isFinite(pool.current)
          ? normalizeZero(Math.min(effectiveMax, Math.max(0, pool.current)))
          : 0;
        findings.push({
          code: 'RESOURCE_OUT_OF_BOUNDS',
          severity: 'warning',
          path: `entities.characters.${charId}.resources.${poolKey}.current`,
          entityId: charId,
          message: `Character "${charId}" resource "${poolKey}" (${pool.current}) outside [0, ${effectiveMax}]; clamped to ${clamped}.`,
          autoCorrected: true,
        });
        correctivePatches.push({
          op: 'set',
          path: `entities.characters.${charId}.resources.${poolKey}.current`,
          value: clamped,
        });
      }
    }
  }

  return {
    findings,
    correctivePatches,
  };
}

/**
 * Run post-turn state auditing: always executes {@link runDeterministicStateAudit},
 * and optionally performs a cadence-throttled LLM continuity audit when enabled.
 */
export async function runAuditorPass(
  params: RunAuditorPassParams
): Promise<RunAuditorPassResult> {
  const deterministic = runDeterministicStateAudit(params.state, params.formIndex);
  const findings: AuditorFinding[] = [...deterministic.findings];
  const warnings: ValidationError[] = [];

  let skippedLlmByCadence = true;
  const cadence =
    params.llmCadenceTurns !== undefined &&
    Number.isInteger(params.llmCadenceTurns) &&
    params.llmCadenceTurns >= 1
      ? params.llmCadenceTurns
      : 5;

  if (
    params.useLlmPass === true &&
    params.gateway !== undefined &&
    params.state.meta.turn > 0 &&
    params.state.meta.turn % cadence === 0
  ) {
    const role: AgentRole = params.llmRole ?? 'storyline_planner';
    if (params.gateway.resolveConnection(role).ok) {
      skippedLlmByCadence = false;
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content:
            'You are a continuity auditor for an interactive RPG state machine. Return JSON with concise continuity notes if any contradictions exist, or an empty notes array.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            turn: params.state.meta.turn,
            day: params.state.clocks.day,
            slot: params.state.clocks.slot,
            location: params.state.scene.location,
            presentCharacterIds: params.state.scene.presentCharacterIds,
            recentExchange: params.recentExchangeText ?? '',
          }),
        },
      ];

      const llmRes = await params.gateway.generateStructured<{ notes?: unknown }>({
        role,
        messages,
        schema: AUDITOR_LLM_SCHEMA,
        schemaName: 'auditor_continuity_notes',
        signal: params.signal,
      });

      if (!llmRes.ok) {
        warnings.push(
          validationError('auditor.llm', 'AUDITOR_LLM_FAILED', 'Optional LLM continuity audit failed')
        );
      } else if (Array.isArray(llmRes.value.data?.notes)) {
        for (const rawNote of llmRes.value.data.notes) {
          if (typeof rawNote === 'string' && rawNote.trim().length > 0) {
            findings.push({
              code: 'LLM_CONTINUITY_NOTE',
              severity: 'warning',
              path: 'auditor.continuity',
              message: rawNote.trim(),
              autoCorrected: false,
            });
          }
        }
      }
    }
  }

  const proposedBatch: PatchBatch | null =
    deterministic.correctivePatches.length > 0
      ? {
          eventId: `turn:${params.state.meta.turn}:auditor`,
          source: 'engine',
          operations: deterministic.correctivePatches,
          reason: `Auditor auto-correction (${deterministic.findings.length} finding(s))`,
        }
      : null;

  return {
    findings,
    correctivePatches: deterministic.correctivePatches,
    proposedBatch,
    skippedLlmByCadence,
    warnings,
  };
}
