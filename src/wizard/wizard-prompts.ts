import type { ChatMessage } from '../gateway/types.js';
import type { EffectOwner } from '../schema/tracker-module.js';
import type { WizardGenerateRequest } from './game-system-wizard.js';

const CONFIRM_POLICY_SCHEMA: Record<string, unknown> = {
  type: 'string',
  enum: ['auto', 'batch_confirm', 'always_confirm', 'locked'],
};

const DYNAMIC_FIELD_SPEC_SCHEMA: Record<string, unknown> = {
  anyOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'min', 'max', 'default', 'writableByTracker'],
      properties: {
        type: { type: 'string', enum: ['meter'] },
        min: { type: 'number' },
        max: { type: 'number' },
        default: { type: 'number' },
        writableByTracker: { type: 'boolean' },
        confirmPolicy: CONFIRM_POLICY_SCHEMA,
        description: { type: 'string' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'default', 'writableByTracker'],
      properties: {
        type: { type: 'string', enum: ['counter'] },
        min: { type: 'integer' },
        max: { type: 'integer' },
        default: { type: 'integer' },
        writableByTracker: { type: 'boolean' },
        confirmPolicy: CONFIRM_POLICY_SCHEMA,
        description: { type: 'string' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'options', 'default', 'writableByTracker'],
      properties: {
        type: { type: 'string', enum: ['enum'] },
        options: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
        },
        default: { type: 'string' },
        writableByTracker: { type: 'boolean' },
        confirmPolicy: CONFIRM_POLICY_SCHEMA,
        description: { type: 'string' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'default', 'writableByTracker'],
      properties: {
        type: { type: 'string', enum: ['boolean'] },
        default: { type: 'boolean' },
        writableByTracker: { type: 'boolean' },
        confirmPolicy: CONFIRM_POLICY_SCHEMA,
        description: { type: 'string' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'default', 'writableByTracker'],
      properties: {
        type: { type: 'string', enum: ['string'] },
        maxLength: { type: 'integer', minimum: 0 },
        default: { type: 'string' },
        writableByTracker: { type: 'boolean' },
        confirmPolicy: CONFIRM_POLICY_SCHEMA,
        description: { type: 'string' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'default', 'writableByTracker'],
      properties: {
        type: { type: 'string', enum: ['string_list'] },
        maxItems: { type: 'integer', minimum: 0 },
        default: {
          type: 'array',
          items: { type: 'string' },
        },
        writableByTracker: { type: 'boolean' },
        confirmPolicy: CONFIRM_POLICY_SCHEMA,
        description: { type: 'string' },
      },
    },
  ],
};

const CLOCK_TRIGGER_RULE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['on', 'op', 'field', 'value'],
  properties: {
    on: { type: 'string', enum: ['slot', 'day', 'turn'] },
    op: { type: 'string', enum: ['increment', 'set', 'clamp'] },
    field: { type: 'string', minLength: 1 },
    value: {
      type: ['number', 'string', 'boolean'],
    },
  },
};

const SUGGESTED_BEAT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'class', 'priority', 'when', 'nudge'],
  properties: {
    id: { type: 'string', minLength: 1 },
    class: { type: 'string', enum: ['nudge', 'ambient'] },
    priority: { type: 'number' },
    when: { type: 'object' },
    nudge: { type: 'string', minLength: 1 },
  },
};

/**
 * Strict JSON Schema describing the structured output expected from the Game System Wizard LLM.
 */
export const GAME_SYSTEM_WIZARD_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['module'],
  properties: {
    module: {
      type: 'object',
      additionalProperties: false,
      required: [
        'id',
        'name',
        'enabled',
        'scope',
        'target',
        'effectOwner',
        'cadence',
        'fields',
        'trackerInstruction',
        'narratorRule',
        'ui',
      ],
      properties: {
        id: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1 },
        description: { type: 'string' },
        enabled: { type: 'boolean' },
        scope: { type: 'string', enum: ['global', 'session'] },
        target: { type: 'string', enum: ['global', 'player', 'npc', 'location'] },
        effectOwner: { type: 'string', enum: ['engine', 'tracker', 'hybrid'] },
        cadence: {
          anyOf: [
            {
              type: 'string',
              enum: ['every_turn', 'on_clock_advance', 'on_combat_end', 'manual_only'],
            },
            {
              type: 'object',
              additionalProperties: false,
              required: ['everyNTurns'],
              properties: {
                everyNTurns: { type: 'integer', minimum: 1 },
              },
            },
          ],
        },
        fields: {
          type: 'object',
          additionalProperties: DYNAMIC_FIELD_SPEC_SCHEMA,
        },
        trackerInstruction: { type: 'string' },
        narratorRule: { type: 'string' },
        ui: {
          type: 'object',
          additionalProperties: false,
          required: ['widget', 'order'],
          properties: {
            widget: { type: 'string', enum: ['bar', 'badge', 'tags', 'card', 'hidden'] },
            order: { type: 'number' },
          },
        },
      },
    },
    clockTriggers: {
      type: 'array',
      items: CLOCK_TRIGGER_RULE_SCHEMA,
    },
    suggestedBeats: {
      type: 'array',
      items: SUGGESTED_BEAT_SCHEMA,
    },
    previewCard: {
      type: 'object',
    },
  },
};

function describeEffectOwnerPolicy(effectOwner: EffectOwner): string {
  switch (effectOwner) {
    case 'engine':
      return [
        '- Ownership mode: "engine". Deterministic engine logic and clockTriggers own state changes.',
        '- Set `effectOwner` to "engine" and prefer `writableByTracker: false` with `confirmPolicy: "locked"` on engine-driven fields unless a narrative override is strictly needed.',
        '- Capture periodic decay, resets, or clamping in `clockTriggers`.',
      ].join('\n');
    case 'tracker':
      return [
        '- Ownership mode: "tracker". The LLM State Tracker owns state transitions from turn events.',
        '- Set `effectOwner` to "tracker" and set `writableByTracker: true` with an explicit `confirmPolicy` ("auto", "batch_confirm", or "always_confirm") on tracked fields.',
        '- Write clear, bounded `trackerInstruction` guidance explaining when and how each field changes.',
      ].join('\n');
    case 'hybrid':
      return [
        '- Ownership mode: "hybrid". Deterministic `clockTriggers` handle predictable time/turn ticks while the State Tracker handles narrative/action-driven changes.',
        '- Set `effectOwner` to "hybrid". Use `writableByTracker: true` on fields the tracker may adjust (such as eating, drinking, resting, or action effects) and pair them with `clockTriggers` for steady slot/day/turn ticks.',
      ].join('\n');
  }
}

/**
 * Construct the Architect system prompt instructing the LLM to emit a valid JSON object
 * conforming to {@link GAME_SYSTEM_WIZARD_OUTPUT_SCHEMA}.
 */
export function buildWizardSystemPrompt(options: {
  effectOwner: EffectOwner;
  customPromptOverride?: string;
}): string {
  if (
    options.customPromptOverride !== undefined &&
    options.customPromptOverride.trim().length > 0
  ) {
    return options.customPromptOverride;
  }

  return [
    'You are the Referee Engine Game System Architect.',
    'Translate the user\'s natural-language mechanic description into a concrete, valid GameSystemModule specification with optional deterministic clockTriggers, optional suggestedBeats, and a previewCard.',
    '',
    'Output Format:',
    '- Respond ONLY with a single valid JSON object matching GAME_SYSTEM_WIZARD_OUTPUT_SCHEMA (no markdown fences, no commentary).',
    '- Top-level keys: `module` (required), `clockTriggers` (optional array), `suggestedBeats` (optional array), `previewCard` (optional object).',
    '',
    'Ownership & Field Policy:',
    describeEffectOwnerPolicy(options.effectOwner),
    '',
    'Module Specification Rules:',
    '- `module.id`: concise snake_case identifier (letters, digits, underscores, or hyphens).',
    '- `module.name`: clear human-readable title; `module.enabled`: `true`.',
    '- `module.scope`: "global" or "session".',
    '- `module.target`: "global", "player", "npc", or "location".',
    '- `module.cadence`: "every_turn", "on_clock_advance", "on_combat_end", "manual_only", or { "everyNTurns": <positive integer> }.',
    '- `module.fields`: record keyed by `/^[a-zA-Z0-9_-]+$/`. Every field MUST match one of:',
    '  1. meter: { "type": "meter", "min": number, "max": number, "default": number, "writableByTracker": boolean, "confirmPolicy"?: ..., "description"?: string } (min <= default <= max)',
    '  2. counter: { "type": "counter", "min"?: integer, "max"?: integer, "default": integer, "writableByTracker": boolean, ... }',
    '  3. enum: { "type": "enum", "options": string[], "default": string, "writableByTracker": boolean, ... } (non-empty options; default in options)',
    '  4. boolean: { "type": "boolean", "default": boolean, "writableByTracker": boolean, ... }',
    '  5. string: { "type": "string", "maxLength"?: integer, "default": string, "writableByTracker": boolean, ... }',
    '  6. string_list: { "type": "string_list", "maxItems"?: integer, "default": string[], "writableByTracker": boolean, ... }',
    '- `module.trackerInstruction`: actionable instructions for the State Tracker describing when to update writable fields.',
    '- `module.narratorRule`: actionable prose guidance for the Narrator describing how to reflect the module state.',
    '- `module.ui`: { "widget": "bar" | "badge" | "tags" | "card" | "hidden", "order": number }.',
    '',
    'Clock Triggers & Suggested Beats:',
    '- Each entry in `clockTriggers` has { "on": "slot" | "day" | "turn", "op": "increment" | "set" | "clamp", "field": string, "value": number | string | boolean }.',
    '- Every `field` referenced in `clockTriggers` MUST exist as a key in `module.fields`.',
    '- Each entry in `suggestedBeats` has { "id": string, "class": "nudge" | "ambient", "priority": number, "when": object, "nudge": string }.',
    '- `previewCard`: compact object showing sample HUD state (e.g. title, widget, and initial field values).',
  ].join('\n');
}

function buildInitialPromptBlock(request: WizardGenerateRequest): string {
  const lines: string[] = [];

  if (request.description.trim().length > 0) {
    lines.push(`Design Goal:\n${request.description.trim()}`);
  } else if (request.previousDraft !== undefined) {
    lines.push(
      `Existing System Context:\nRefine module "${request.previousDraft.name}" (${request.previousDraft.id}).`
    );
  }

  const constraints: string[] = [];
  if (request.effectOwner !== undefined) {
    constraints.push(`- Preferred effectOwner: ${request.effectOwner}`);
  }
  if (request.target !== undefined) {
    constraints.push(`- Target entity scope: ${request.target}`);
  }
  if (constraints.length > 0) {
    lines.push(`Constraints:\n${constraints.join('\n')}`);
  }

  if (request.loreContext !== undefined && request.loreContext.trim().length > 0) {
    lines.push(`Lore & Setting Context:\n${request.loreContext.trim()}`);
  }

  lines.push(
    'Generate a complete, schema-valid JSON response with `module`, `clockTriggers`, `suggestedBeats`, and `previewCard`.'
  );

  return lines.join('\n\n');
}

/**
 * Build conversational user/assistant messages for either initial system generation
 * or iterative refinement of a previous {@link GameSystemModule} draft.
 */
export function buildWizardUserMessages(request: WizardGenerateRequest): ChatMessage[] {
  const initialContent = buildInitialPromptBlock(request);

  if (request.previousDraft === undefined) {
    return [{ role: 'user', content: initialContent }];
  }

  const feedbackText =
    request.refinementFeedback !== undefined && request.refinementFeedback.trim().length > 0
      ? request.refinementFeedback.trim()
      : 'Refine and improve the previous module draft while preserving valid schema structure.';

  const refinementLines: string[] = [
    `Refinement Feedback:\n${feedbackText}`,
  ];

  const overrideConstraints: string[] = [];
  if (request.effectOwner !== undefined) {
    overrideConstraints.push(`- Ensure effectOwner is "${request.effectOwner}".`);
  }
  if (request.target !== undefined) {
    overrideConstraints.push(`- Ensure module target is "${request.target}".`);
  }
  if (overrideConstraints.length > 0) {
    refinementLines.push(`Updated Constraints:\n${overrideConstraints.join('\n')}`);
  }

  refinementLines.push(
    'Return the complete updated JSON object (`module`, `clockTriggers`, `suggestedBeats`, and `previewCard`) incorporating this feedback.'
  );

  return [
    { role: 'user', content: initialContent },
    {
      role: 'assistant',
      content: JSON.stringify({ module: request.previousDraft }, null, 2),
    },
    { role: 'user', content: refinementLines.join('\n\n') },
  ];
}
