import { type ValidationError, validationError } from '../core/errors.js';
import { ErrorAccumulator, type Result, err } from '../core/result.js';
import type { ModelGateway } from '../gateway/model-gateway.js';
import type { ChatMessage } from '../gateway/types.js';
import {
  type CadencePolicy,
  type DynamicFieldSpec,
  type EffectOwner,
  type GameSystemModule,
  cloneGameSystemModule,
  validateGameSystemModule,
} from '../schema/tracker-module.js';
import {
  GAME_SYSTEM_WIZARD_OUTPUT_SCHEMA,
  buildWizardSystemPrompt,
  buildWizardUserMessages,
} from './wizard-prompts.js';

/**
 * Deterministic clock or turn trigger rule attached to a generated {@link GameSystemModule}.
 */
export interface ClockTriggerRule {
  on: 'slot' | 'day' | 'turn';
  op: 'increment' | 'set' | 'clamp';
  field: string;
  value: number | string | boolean;
}

/**
 * Narrative beat suggestion emitted by the Game System Wizard.
 */
export interface WizardSuggestedBeat {
  id: string;
  class: 'nudge' | 'ambient';
  priority: number;
  when: Record<string, unknown>;
  nudge: string;
}

/**
 * Input specification passed to {@link GameSystemWizard.generateSystem}.
 */
export interface WizardGenerateRequest {
  description: string;
  effectOwner?: EffectOwner;
  target?: GameSystemModule['target'];
  loreContext?: string;
  previousDraft?: GameSystemModule;
  refinementFeedback?: string;
  customSystemPrompt?: string;
}

/**
 * Validated output returned by {@link GameSystemWizard.generateSystem}.
 */
export interface WizardGeneratedSystem {
  module: GameSystemModule;
  clockTriggers: ClockTriggerRule[];
  suggestedBeats: WizardSuggestedBeat[];
  previewCard: Record<string, unknown>;
  rawText: string;
}

interface RawWizardPayload {
  module: GameSystemModule;
  clockTriggers?: ClockTriggerRule[];
  suggestedBeats?: WizardSuggestedBeat[];
  previewCard?: Record<string, unknown>;
}

const VALID_TRIGGER_EVENTS: ReadonlySet<ClockTriggerRule['on']> = new Set(['slot', 'day', 'turn']);
const VALID_TRIGGER_OPS: ReadonlySet<ClockTriggerRule['op']> = new Set(['increment', 'set', 'clamp']);
const VALID_BEAT_CLASSES: ReadonlySet<WizardSuggestedBeat['class']> = new Set(['nudge', 'ambient']);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneUnknownValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => cloneUnknownValue(item));
  }
  if (isPlainRecord(value)) {
    const cloned: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        continue;
      }
      cloned[key] = cloneUnknownValue(entry);
    }
    return cloned;
  }
  return value;
}

function clonePlainRecord(record: Record<string, unknown>): Record<string, unknown> {
  const cloned: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      continue;
    }
    cloned[key] = cloneUnknownValue(entry);
  }
  return cloned;
}

function cloneClockTriggerRule(rule: ClockTriggerRule): ClockTriggerRule {
  return {
    on: rule.on,
    op: rule.op,
    field: rule.field,
    value: rule.value,
  };
}

function cloneSuggestedBeat(beat: WizardSuggestedBeat): WizardSuggestedBeat {
  return {
    id: beat.id,
    class: beat.class,
    priority: beat.priority,
    when: clonePlainRecord(beat.when),
    nudge: beat.nudge,
  };
}

function buildDefaultPreviewCard(module: GameSystemModule): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [fieldKey, spec] of Object.entries(module.fields)) {
    if (fieldKey === '__proto__' || fieldKey === 'constructor' || fieldKey === 'prototype') {
      continue;
    }
    fields[fieldKey] = Array.isArray(spec.default) ? [...spec.default] : spec.default;
  }
  return {
    id: module.id,
    name: module.name,
    widget: module.ui.widget,
    target: module.target,
    fields,
  };
}

function validateClockTriggers(
  triggers: unknown,
  moduleFields: Record<string, DynamicFieldSpec>,
  acc: ErrorAccumulator
): ClockTriggerRule[] {
  if (triggers === undefined) {
    return [];
  }
  if (!Array.isArray(triggers)) {
    acc.add('clockTriggers', 'INVALID_TYPE', 'clockTriggers must be an array');
    return [];
  }

  const normalized: ClockTriggerRule[] = [];
  for (let i = 0; i < triggers.length; i += 1) {
    const raw = triggers[i];
    const itemAcc = acc.scope(`clockTriggers[${i}]`);

    if (!isPlainRecord(raw)) {
      itemAcc.add('', 'INVALID_TYPE', 'Clock trigger entry must be an object');
      continue;
    }

    const on = raw['on'];
    if (typeof on !== 'string' || !VALID_TRIGGER_EVENTS.has(on as ClockTriggerRule['on'])) {
      itemAcc.add('on', 'INVALID_TRIGGER_EVENT', `Invalid clock trigger event "${String(on)}"`);
    }

    const op = raw['op'];
    if (typeof op !== 'string' || !VALID_TRIGGER_OPS.has(op as ClockTriggerRule['op'])) {
      itemAcc.add('op', 'INVALID_TRIGGER_OP', `Invalid clock trigger op "${String(op)}"`);
    }

    const field = raw['field'];
    let targetSpec: DynamicFieldSpec | undefined;
    if (typeof field !== 'string' || field.trim().length === 0) {
      itemAcc.add('field', 'REQUIRED', 'Clock trigger field must be a non-empty string');
    } else if (!Object.prototype.hasOwnProperty.call(moduleFields, field)) {
      itemAcc.add(
        'field',
        'UNKNOWN_TRIGGER_FIELD',
        `Clock trigger references nonexistent field "${field}"`
      );
    } else {
      targetSpec = moduleFields[field];
    }

    const value = raw['value'];
    const isValidValueType =
      (typeof value === 'number' && Number.isFinite(value)) ||
      typeof value === 'string' ||
      typeof value === 'boolean';
    if (!isValidValueType) {
      itemAcc.add(
        'value',
        'INVALID_TRIGGER_VALUE',
        'Clock trigger value must be a finite number, string, or boolean'
      );
    } else if (op === 'increment' || op === 'clamp') {
      if (typeof value !== 'number') {
        itemAcc.add(
          'value',
          'INVALID_TRIGGER_VALUE',
          `Clock trigger with op "${String(op)}" requires a numeric value`
        );
      } else if (
        targetSpec !== undefined &&
        targetSpec.type !== 'meter' &&
        targetSpec.type !== 'counter'
      ) {
        itemAcc.add(
          'op',
          'INVALID_TRIGGER_OP',
          `Clock trigger op "${String(op)}" requires a numeric field (meter or counter), got "${targetSpec.type}"`
        );
      }
    }

    if (!itemAcc.hasErrors()) {
      normalized.push(
        cloneClockTriggerRule({
          on: on as ClockTriggerRule['on'],
          op: op as ClockTriggerRule['op'],
          field: field as string,
          value: value as number | string | boolean,
        })
      );
    }
  }

  return normalized;
}

function validateSuggestedBeats(
  beats: unknown,
  acc: ErrorAccumulator
): WizardSuggestedBeat[] {
  if (beats === undefined) {
    return [];
  }
  if (!Array.isArray(beats)) {
    acc.add('suggestedBeats', 'INVALID_TYPE', 'suggestedBeats must be an array');
    return [];
  }

  const normalized: WizardSuggestedBeat[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < beats.length; i += 1) {
    const raw = beats[i];
    const itemAcc = acc.scope(`suggestedBeats[${i}]`);

    if (!isPlainRecord(raw)) {
      itemAcc.add('', 'INVALID_TYPE', 'Suggested beat entry must be an object');
      continue;
    }

    const id = raw['id'];
    if (typeof id !== 'string' || id.trim().length === 0) {
      itemAcc.add('id', 'REQUIRED', 'Suggested beat id must be a non-empty string');
    } else if (seenIds.has(id)) {
      itemAcc.add('id', 'DUPLICATE_BEAT_ID', `Duplicate suggested beat id "${id}"`);
    } else {
      seenIds.add(id);
    }

    const beatClass = raw['class'];
    if (
      typeof beatClass !== 'string' ||
      !VALID_BEAT_CLASSES.has(beatClass as WizardSuggestedBeat['class'])
    ) {
      itemAcc.add('class', 'INVALID_BEAT_CLASS', `Invalid beat class "${String(beatClass)}"`);
    }

    const priority = raw['priority'];
    if (typeof priority !== 'number' || !Number.isFinite(priority)) {
      itemAcc.add('priority', 'INVALID_NUMBER', 'Suggested beat priority must be a finite number');
    }

    const when = raw['when'];
    if (!isPlainRecord(when)) {
      itemAcc.add('when', 'INVALID_TYPE', 'Suggested beat when condition must be a plain object');
    }

    const nudge = raw['nudge'];
    if (typeof nudge !== 'string' || nudge.trim().length === 0) {
      itemAcc.add('nudge', 'REQUIRED', 'Suggested beat nudge must be a non-empty string');
    }

    if (!itemAcc.hasErrors()) {
      normalized.push(
        cloneSuggestedBeat({
          id: id as string,
          class: beatClass as WizardSuggestedBeat['class'],
          priority: priority as number,
          when: when as Record<string, unknown>,
          nudge: nudge as string,
        })
      );
    }
  }

  return normalized;
}

function formatCadence(cadence: CadencePolicy): string {
  if (typeof cadence === 'string') {
    return cadence;
  }
  return `every ${cadence.everyNTurns} turns`;
}

function formatFieldSpecSummary(spec: DynamicFieldSpec): string {
  const access = spec.writableByTracker ? 'tracker-writable' : 'engine-locked';
  switch (spec.type) {
    case 'meter':
      return `meter [${spec.min}..${spec.max}], default=${spec.default} (${access})`;
    case 'counter': {
      const bounds =
        spec.min !== undefined || spec.max !== undefined
          ? ` [${spec.min ?? '-inf'}..${spec.max ?? '+inf'}]`
          : '';
      return `counter${bounds}, default=${spec.default} (${access})`;
    }
    case 'enum':
      return `enum (${spec.options.join(' | ')}), default=${spec.default} (${access})`;
    case 'boolean':
      return `boolean, default=${String(spec.default)} (${access})`;
    case 'string':
      return `string, default=${JSON.stringify(spec.default)} (${access})`;
    case 'string_list':
      return `string_list, default=${JSON.stringify(spec.default)} (${access})`;
  }
}

/**
 * In-engine Game System Wizard converting natural-language mechanic descriptions
 * into validated {@link GameSystemModule} definitions, deterministic clock triggers,
 * suggested narrative beats, and HUD preview cards.
 */
export class GameSystemWizard {
  private readonly gateway: ModelGateway;

  constructor(gateway: ModelGateway) {
    this.gateway = gateway;
  }

  /**
   * Generate (or iteratively refine) a game system specification via the configured
   * `'game_system_wizard'` model role and validate all module, trigger, and beat invariants.
   */
  async generateSystem(
    req: WizardGenerateRequest,
    signal?: AbortSignal
  ): Promise<Result<WizardGeneratedSystem, ValidationError[]>> {
    if (req.description.trim().length === 0 && req.previousDraft === undefined) {
      return err([
        validationError(
          'description',
          'REQUIRED',
          'Wizard request description must be a non-empty string when no previousDraft is provided'
        ),
      ]);
    }

    const effectOwner: EffectOwner = req.effectOwner ?? req.previousDraft?.effectOwner ?? 'hybrid';
    const systemPrompt = buildWizardSystemPrompt({
      effectOwner,
      ...(req.customSystemPrompt !== undefined
        ? { customPromptOverride: req.customSystemPrompt }
        : {}),
    });
    const userMessages = buildWizardUserMessages(req);
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...userMessages,
    ];

    const gatewayResult = await this.gateway.generateStructured<RawWizardPayload>({
      role: 'game_system_wizard',
      messages,
      schema: GAME_SYSTEM_WIZARD_OUTPUT_SCHEMA,
      schemaName: 'game_system_wizard_output',
      ...(signal !== undefined ? { signal } : {}),
    });

    if (!gatewayResult.ok) {
      return gatewayResult;
    }

    const { data, rawText } = gatewayResult.value;
    const acc = new ErrorAccumulator();

    const validatedModule = acc.absorb(validateGameSystemModule(data.module, 'module'));
    const moduleFields =
      validatedModule !== undefined && isPlainRecord(validatedModule.fields)
        ? validatedModule.fields
        : isPlainRecord(data.module?.fields)
          ? data.module.fields
          : {};

    const clockTriggers = validateClockTriggers(data.clockTriggers, moduleFields, acc);
    const suggestedBeats = validateSuggestedBeats(data.suggestedBeats, acc);

    let previewCard: Record<string, unknown>;
    if (data.previewCard === undefined) {
      previewCard =
        validatedModule !== undefined ? buildDefaultPreviewCard(validatedModule) : {};
    } else if (!isPlainRecord(data.previewCard)) {
      acc.add('previewCard', 'INVALID_TYPE', 'previewCard must be a plain object');
      previewCard = {};
    } else {
      previewCard = clonePlainRecord(data.previewCard);
    }

    if (acc.hasErrors() || validatedModule === undefined) {
      return err([...acc.errors]);
    }

    return acc.toResult({
      module: cloneGameSystemModule(validatedModule),
      clockTriggers,
      suggestedBeats,
      previewCard,
      rawText,
    });
  }

  /**
   * Render a human-readable summary of a generated module's HUD card, narrator rule,
   * tracker guidance, clock triggers, and suggested beats.
   */
  renderPreviewSummary(generated: WizardGeneratedSystem): string {
    const { module, clockTriggers, suggestedBeats, previewCard } = generated;
    const lines: string[] = [];

    lines.push(`=== ${module.name} (${module.id}) ===`);
    if (module.description !== undefined && module.description.trim().length > 0) {
      lines.push(module.description.trim());
    }
    lines.push(
      `Scope: ${module.scope} | Target: ${module.target} | Owner: ${module.effectOwner} | Cadence: ${formatCadence(module.cadence)} | Widget: ${module.ui.widget}`
    );

    lines.push('');
    lines.push('HUD Preview Card:');
    const previewKeys = Object.keys(previewCard);
    if (previewKeys.length === 0) {
      lines.push('  (empty)');
    } else {
      for (const [key, value] of Object.entries(previewCard)) {
        lines.push(`  - ${key}: ${JSON.stringify(value)}`);
      }
    }

    lines.push('');
    lines.push('Fields:');
    const fieldEntries = Object.entries(module.fields);
    if (fieldEntries.length === 0) {
      lines.push('  (none)');
    } else {
      for (const [fieldKey, spec] of fieldEntries) {
        lines.push(`  - ${fieldKey}: ${formatFieldSpecSummary(spec)}`);
      }
    }

    lines.push('');
    lines.push(
      `Narrator Rule: ${module.narratorRule.trim().length > 0 ? module.narratorRule.trim() : '(none)'}`
    );
    lines.push(
      `Tracker Instruction: ${module.trackerInstruction.trim().length > 0 ? module.trackerInstruction.trim() : '(none)'}`
    );

    lines.push('');
    lines.push('Clock Triggers:');
    if (clockTriggers.length === 0) {
      lines.push('  (none)');
    } else {
      for (const trigger of clockTriggers) {
        lines.push(
          `  - [${trigger.on}] ${trigger.field} ${trigger.op} ${JSON.stringify(trigger.value)}`
        );
      }
    }

    lines.push('');
    lines.push('Suggested Beats:');
    if (suggestedBeats.length === 0) {
      lines.push('  (none)');
    } else {
      for (const beat of suggestedBeats) {
        lines.push(
          `  - [${beat.class}] ${beat.id} (priority ${beat.priority}) when ${JSON.stringify(beat.when)}: ${beat.nudge}`
        );
      }
    }

    return lines.join('\n');
  }
}
