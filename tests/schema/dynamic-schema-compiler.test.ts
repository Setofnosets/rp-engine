import { describe, expect, it } from 'vitest';
import { isErr, isOk } from '../../src/core/result.js';
import {
  DEFAULT_NPC_SECTIONS,
  DEFAULT_PC_SECTIONS,
  OPTIONAL_COMBAT_PROFILE_SECTION,
  OPTIONAL_DESIRES_SECTION,
  SHEET_PRESETS,
  getSheetPreset,
  validateCharacterSectionDef,
  validateCharacterSectionList,
} from '../../src/schema/character-sections.js';
import {
  type EffectiveSystemConfig,
  compileActiveTrackerSchema,
  isCadenceDue,
  validateEffectiveSystemConfig,
  validateSystemPack,
} from '../../src/schema/dynamic-schema-compiler.js';
import {
  STOCK_FREEFORM_PACK,
  STOCK_LIVING_WORLD_PACK,
  STOCK_SLICE_OF_LIFE_PACK,
  STOCK_TACTICAL_RPG_PACK,
  getStockSystemPack,
} from '../../src/schema/stock-system-packs.js';
import {
  type GameSystemModule,
  validateCadencePolicy,
  validateDynamicFieldSpec,
  validateGameSystemModule,
} from '../../src/schema/tracker-module.js';

function assertAllObjectsDisallowAdditionalProperties(node: unknown, path = 'root'): void {
  if (node === null || typeof node !== 'object') {
    return;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      assertAllObjectsDisallowAdditionalProperties(node[i], `${path}[${i}]`);
    }
    return;
  }
  const obj = node as Record<string, unknown>;
  if (obj['type'] === 'object') {
    expect(obj['additionalProperties'], `${path} should set additionalProperties: false`).toBe(
      false
    );
  }
  for (const [key, value] of Object.entries(obj)) {
    assertAllObjectsDisallowAdditionalProperties(value, `${path}.${key}`);
  }
}

function createAllDisabledConfig(overrides: Partial<EffectiveSystemConfig> = {}): EffectiveSystemConfig {
  return {
    capabilities: {
      spatialMode: 'scene_only',
      combatMode: 'disabled',
      progression: 'disabled',
      clocks: 'disabled',
      factions: false,
      beats: false,
      relationships: false,
      chronicle: false,
    },
    pcCoreSections: [],
    npcCoreSections: [],
    gameSystems: [],
    blockOrder: [],
    syspromptSectionOrder: [],
    ...overrides,
  };
}

describe('isCadenceDue', () => {
  it('handles every_turn, on_clock_advance, on_combat_end, and manual_only', () => {
    expect(
      isCadenceDue('every_turn', {
        turn: 1,
        clockAdvancedThisTurn: false,
        combatEndedThisTurn: false,
      })
    ).toBe(true);

    expect(
      isCadenceDue('on_clock_advance', {
        turn: 2,
        clockAdvancedThisTurn: false,
        combatEndedThisTurn: false,
      })
    ).toBe(false);
    expect(
      isCadenceDue('on_clock_advance', {
        turn: 2,
        clockAdvancedThisTurn: true,
        combatEndedThisTurn: false,
      })
    ).toBe(true);

    expect(
      isCadenceDue('on_combat_end', {
        turn: 2,
        clockAdvancedThisTurn: false,
        combatEndedThisTurn: false,
      })
    ).toBe(false);
    expect(
      isCadenceDue('on_combat_end', {
        turn: 2,
        clockAdvancedThisTurn: false,
        combatEndedThisTurn: true,
      })
    ).toBe(true);

    expect(
      isCadenceDue('manual_only', {
        turn: 3,
        clockAdvancedThisTurn: true,
        combatEndedThisTurn: true,
      })
    ).toBe(false);
    expect(
      isCadenceDue('manual_only', {
        turn: 3,
        clockAdvancedThisTurn: false,
        combatEndedThisTurn: false,
        manualTrigger: true,
      })
    ).toBe(true);
  });

  it('filters everyNTurns accurately across turns 0 through 9 and rejects invalid intervals', () => {
    const dueTurns: number[] = [];
    for (let turn = 0; turn <= 9; turn += 1) {
      if (
        isCadenceDue(
          { everyNTurns: 3 },
          { turn, clockAdvancedThisTurn: false, combatEndedThisTurn: false }
        )
      ) {
        dueTurns.push(turn);
      }
    }
    expect(dueTurns).toEqual([3, 6, 9]);

    expect(
      isCadenceDue(
        { everyNTurns: 0 },
        { turn: 3, clockAdvancedThisTurn: false, combatEndedThisTurn: false }
      )
    ).toBe(false);
    expect(
      isCadenceDue(
        { everyNTurns: -2 },
        { turn: 2, clockAdvancedThisTurn: false, combatEndedThisTurn: false }
      )
    ).toBe(false);
    expect(
      isCadenceDue(
        { everyNTurns: 1.5 },
        { turn: 3, clockAdvancedThisTurn: false, combatEndedThisTurn: false }
      )
    ).toBe(false);
  });
});

describe('compileActiveTrackerSchema', () => {
  it('compiles stock-slice-of-life with zero references to hp, xp, level, class, factions, or combat', () => {
    const compiled = compileActiveTrackerSchema(STOCK_SLICE_OF_LIFE_PACK, {
      turn: 1,
      clockAdvancedThisTurn: false,
      combatEndedThisTurn: false,
    });

    expect(compiled.trackerJsonSchema).not.toBeNull();
    assertAllObjectsDisallowAdditionalProperties(compiled.trackerJsonSchema);

    const serializedSchema = JSON.stringify(compiled.trackerJsonSchema);
    const forbiddenPattern = /\b(hp|xp|level|class|factions|combat)\b/i;

    expect(serializedSchema).not.toMatch(forbiddenPattern);
    expect(compiled.activeTrackerInstructions.join('\n')).not.toMatch(forbiddenPattern);
    expect(compiled.activeNarratorRules.join('\n')).not.toMatch(forbiddenPattern);
    expect([...compiled.fieldPolicyMap.keys()].join('\n')).not.toMatch(forbiddenPattern);

    const rootProps = (compiled.trackerJsonSchema as Record<string, unknown>)[
      'properties'
    ] as Record<string, unknown>;
    expect(rootProps['scene']).toBeDefined();
    expect(rootProps['custom_fields']).toBeDefined();
    expect(rootProps['pc_sections']).toBeDefined();
    expect(rootProps['npc_sections']).toBeDefined();
    expect(rootProps['relationships']).toBeDefined();
    expect(rootProps['progression']).toBeUndefined();
    expect(rootProps['combat']).toBeUndefined();
    expect(rootProps['factions']).toBeUndefined();
  });

  it('returns null for stock-freeform on normal turns when only manual modules exist, and minimal scene fields on manual trigger', () => {
    const autoTurn = compileActiveTrackerSchema(STOCK_FREEFORM_PACK, {
      turn: 1,
      clockAdvancedThisTurn: false,
      combatEndedThisTurn: false,
    });
    expect(autoTurn.trackerJsonSchema).toBeNull();
    expect(autoTurn.dueModuleIds).toEqual([]);
    expect(autoTurn.activeTrackerInstructions).toEqual([]);
    expect(autoTurn.fieldPolicyMap.has('scene.location')).toBe(true);
    expect(autoTurn.fieldPolicyMap.has('scene.mood')).toBe(true);

    const manualTurn = compileActiveTrackerSchema(STOCK_FREEFORM_PACK, {
      turn: 1,
      clockAdvancedThisTurn: false,
      combatEndedThisTurn: false,
      manualTrigger: true,
    });
    expect(manualTurn.trackerJsonSchema).not.toBeNull();
    assertAllObjectsDisallowAdditionalProperties(manualTurn.trackerJsonSchema);
    const props = (manualTurn.trackerJsonSchema as Record<string, unknown>)[
      'properties'
    ] as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(['scene']);
    expect(manualTurn.dueModuleIds).toEqual(['scene_context']);
  });

  it('dynamically compiles a custom sanity GameSystemModule (meter 0..100) into schema, narrator rules, and fieldPolicyMap', () => {
    const sanityModule: GameSystemModule = {
      id: 'sanity',
      name: 'Sanity & Dread',
      description: 'Tracks psychological composure against cosmic dread.',
      enabled: true,
      scope: 'session',
      target: 'global',
      effectOwner: 'tracker',
      cadence: 'every_turn',
      fields: {
        sanity: {
          type: 'meter',
          min: 0,
          max: 100,
          default: 100,
          writableByTracker: true,
          confirmPolicy: 'auto',
          description: 'Mental composure from 0 (shattered) to 100 (steady)',
        },
        hallucinating: {
          type: 'boolean',
          default: false,
          writableByTracker: true,
          confirmPolicy: 'batch_confirm',
        },
      },
      trackerInstruction: 'Lower sanity when characters witness uncanny phenomena.',
      narratorRule: 'When sanity drops below 40, weave subtle sensory unreliability into prose.',
      ui: { widget: 'bar', order: 10 },
    };

    const basePack = getStockSystemPack('stock-slice-of-life')!;
    basePack.gameSystems.push(sanityModule);

    const compiled = compileActiveTrackerSchema(basePack, {
      turn: 1,
      clockAdvancedThisTurn: false,
      combatEndedThisTurn: false,
    });

    expect(compiled.trackerJsonSchema).not.toBeNull();
    assertAllObjectsDisallowAdditionalProperties(compiled.trackerJsonSchema);

    const rootProps = (compiled.trackerJsonSchema as Record<string, unknown>)[
      'properties'
    ] as Record<string, unknown>;
    const customFieldsSchema = rootProps['custom_fields'] as Record<string, unknown>;
    const customProps = customFieldsSchema['properties'] as Record<string, unknown>;
    expect(customProps['sanity']).toEqual({
      type: 'number',
      minimum: 0,
      maximum: 100,
      description: 'Mental composure from 0 (shattered) to 100 (steady)',
    });
    expect(customProps['hallucinating']).toEqual({
      type: 'boolean',
    });

    expect(compiled.activeNarratorRules).toContain(sanityModule.narratorRule);
    expect(compiled.activeTrackerInstructions).toContain(sanityModule.trackerInstruction);
    expect(compiled.dueModuleIds).toContain('sanity');

    const sanityPolicy = compiled.fieldPolicyMap.get('custom_fields.sanity');
    expect(sanityPolicy).toBeDefined();
    expect(sanityPolicy?.moduleId).toBe('sanity');
    expect(sanityPolicy?.writableByTracker).toBe(true);
    expect(sanityPolicy?.confirmPolicy).toBe('auto');
    expect(sanityPolicy?.spec).toEqual(sanityModule.fields['sanity']);
  });

  it('filters modules by cadence (everyNTurns, on_clock_advance, manual_only) while preserving fieldPolicyMap on non-due turns', () => {
    const every3Module: GameSystemModule = {
      id: 'stamina_audit',
      name: 'Stamina Audit',
      enabled: true,
      scope: 'session',
      target: 'player',
      effectOwner: 'tracker',
      cadence: { everyNTurns: 3 },
      fields: {
        fatigue_level: {
          type: 'enum',
          options: ['fresh', 'winded', 'exhausted'],
          default: 'fresh',
          writableByTracker: true,
          confirmPolicy: 'auto',
        },
      },
      trackerInstruction: 'Assess fatigue_level every third turn.',
      narratorRule: 'Mention physical fatigue when exhausted.',
      ui: { widget: 'badge', order: 1 },
    };

    const clockModule: GameSystemModule = {
      id: 'weather_shift',
      name: 'Weather Shift',
      enabled: true,
      scope: 'session',
      target: 'global',
      effectOwner: 'tracker',
      cadence: 'on_clock_advance',
      fields: {
        weather: {
          type: 'string',
          maxLength: 40,
          default: 'clear',
          writableByTracker: true,
          confirmPolicy: 'auto',
        },
      },
      trackerInstruction: 'Update weather when the clock advances.',
      narratorRule: 'Reflect current weather in atmospheric details.',
      ui: { widget: 'badge', order: 2 },
    };

    const manualModule: GameSystemModule = {
      id: 'location_notes',
      name: 'Location Notes',
      enabled: true,
      scope: 'session',
      target: 'location',
      effectOwner: 'tracker',
      cadence: 'manual_only',
      fields: {
        tags: {
          type: 'string_list',
          maxItems: 5,
          default: [],
          writableByTracker: true,
          confirmPolicy: 'always_confirm',
        },
      },
      trackerInstruction: 'Extract site tags only when manually requested.',
      narratorRule: '',
      ui: { widget: 'tags', order: 3 },
    };

    const config = createAllDisabledConfig({
      gameSystems: [every3Module, clockModule, manualModule],
    });

    // Turn 1: none are due -> trackerJsonSchema must be null, but fieldPolicyMap & narrator rules stay populated!
    const turn1 = compileActiveTrackerSchema(config, {
      turn: 1,
      clockAdvancedThisTurn: false,
      combatEndedThisTurn: false,
    });
    expect(turn1.trackerJsonSchema).toBeNull();
    expect(turn1.dueModuleIds).toEqual([]);
    expect(turn1.activeTrackerInstructions).toEqual([]);
    expect(turn1.activeNarratorRules).toEqual([
      'Mention physical fatigue when exhausted.',
      'Reflect current weather in atmospheric details.',
    ]);
    expect(turn1.fieldPolicyMap.has('entities.characters.player.custom_fields.fatigue_level')).toBe(
      true
    );
    expect(turn1.fieldPolicyMap.has('custom_fields.weather')).toBe(true);
    expect(turn1.fieldPolicyMap.has('entities.locations.*.custom_fields.tags')).toBe(true);

    // Turn 2 with clock advance: only clockModule is due
    const turn2Clock = compileActiveTrackerSchema(config, {
      turn: 2,
      clockAdvancedThisTurn: true,
      combatEndedThisTurn: false,
    });
    expect(turn2Clock.dueModuleIds).toEqual(['weather_shift']);
    expect(turn2Clock.activeTrackerInstructions).toEqual([
      'Update weather when the clock advances.',
    ]);
    assertAllObjectsDisallowAdditionalProperties(turn2Clock.trackerJsonSchema);
    const t2Props = (turn2Clock.trackerJsonSchema as Record<string, unknown>)[
      'properties'
    ] as Record<string, unknown>;
    expect(Object.keys(t2Props)).toEqual(['custom_fields']);

    // Turn 3 without clock advance: only every3Module is due
    const turn3 = compileActiveTrackerSchema(config, {
      turn: 3,
      clockAdvancedThisTurn: false,
      combatEndedThisTurn: false,
    });
    expect(turn3.dueModuleIds).toEqual(['stamina_audit']);
    const t3Props = (turn3.trackerJsonSchema as Record<string, unknown>)[
      'properties'
    ] as Record<string, unknown>;
    expect(Object.keys(t3Props)).toEqual(['player_custom_fields']);

    // Turn 4 with manualTrigger: only manualModule is due
    const turn4Manual = compileActiveTrackerSchema(config, {
      turn: 4,
      clockAdvancedThisTurn: false,
      combatEndedThisTurn: false,
      manualTrigger: true,
    });
    expect(turn4Manual.dueModuleIds).toEqual(['location_notes']);
    const t4Props = (turn4Manual.trackerJsonSchema as Record<string, unknown>)[
      'properties'
    ] as Record<string, unknown>;
    expect(Object.keys(t4Props)).toEqual(['location_custom_fields']);
  });

  it('compiles all DynamicFieldSpec variants and target scopes while omitting locked/non-writable fields from JSON Schema', () => {
    const npcMod: GameSystemModule = {
      id: 'npc_secrets',
      name: 'NPC Secrets',
      enabled: true,
      scope: 'session',
      target: 'npc',
      effectOwner: 'hybrid',
      cadence: 'every_turn',
      fields: {
        suspicion_steps: {
          type: 'counter',
          min: 0,
          max: 10,
          default: 0,
          writableByTracker: true,
          confirmPolicy: 'auto',
        },
        pinned_secret: {
          type: 'string',
          default: 'hidden',
          writableByTracker: true,
          confirmPolicy: 'locked',
        },
        engine_flag: {
          type: 'boolean',
          default: false,
          writableByTracker: false,
        },
      },
      trackerInstruction: 'Track suspicion steps for present NPCs.',
      narratorRule: '',
      ui: { widget: 'badge', order: 1 },
    };

    const config = createAllDisabledConfig({
      pcCoreSections: [DEFAULT_PC_SECTIONS[0]!, DEFAULT_PC_SECTIONS[2]!], // species (non-writable) + equipment (writable)
      npcCoreSections: [DEFAULT_NPC_SECTIONS[6]!, OPTIONAL_COMBAT_PROFILE_SECTION], // strengths (bullet_list) + combat profile (should be gated out!)
      gameSystems: [npcMod],
    });

    const compiled = compileActiveTrackerSchema(config, {
      turn: 1,
      clockAdvancedThisTurn: false,
      combatEndedThisTurn: false,
    });

    assertAllObjectsDisallowAdditionalProperties(compiled.trackerJsonSchema);
    const props = (compiled.trackerJsonSchema as Record<string, unknown>)['properties'] as Record<
      string,
      unknown
    >;

    // Locked / non-writable NPC fields omitted from JSON Schema, but registered in fieldPolicyMap
    const npcCustomItems = (props['npc_custom_fields'] as Record<string, unknown>)[
      'items'
    ] as Record<string, unknown>;
    const npcCustomItemProps = npcCustomItems['properties'] as Record<string, unknown>;
    expect(Object.keys(npcCustomItemProps)).toEqual(['characterId', 'suspicion_steps']);
    expect(npcCustomItemProps['suspicion_steps']).toEqual({
      type: 'integer',
      minimum: 0,
      maximum: 10,
    });

    expect(
      compiled.fieldPolicyMap.get('entities.characters.*.custom_fields.pinned_secret')?.confirmPolicy
    ).toBe('locked');
    expect(
      compiled.fieldPolicyMap.get('entities.characters.*.custom_fields.pinned_secret')
        ?.writableByTracker
    ).toBe(false);
    expect(
      compiled.fieldPolicyMap.get('entities.characters.*.custom_fields.engine_flag')
        ?.writableByTracker
    ).toBe(false);

    // PC sec_species (writableByTracker: false) omitted from JSON Schema, present in fieldPolicyMap
    const pcSectionProps = (props['pc_sections'] as Record<string, unknown>)[
      'properties'
    ] as Record<string, unknown>;
    expect(Object.keys(pcSectionProps)).toEqual(['sec_equipment']);
    expect(
      compiled.fieldPolicyMap.get('entities.characters.player.sections.sec_species')
        ?.writableByTracker
    ).toBe(false);

    // OPTIONAL_COMBAT_PROFILE_SECTION excluded because combatMode is 'disabled'
    const npcSectionItems = (props['npc_sections'] as Record<string, unknown>)['items'] as Record<
      string,
      unknown
    >;
    const npcSectionProps = npcSectionItems['properties'] as Record<string, unknown>;
    expect(Object.keys(npcSectionProps)).toEqual(['characterId', 'sec_strengths']);
    expect(compiled.fieldPolicyMap.has('entities.characters.*.sections.sec_combat_profile')).toBe(
      false
    );
  });

  it('produces deterministic output independent of input module order and does not mutate input config', () => {
    const modA: GameSystemModule = {
      id: 'mod_a',
      name: 'Module A',
      enabled: true,
      scope: 'session',
      target: 'global',
      effectOwner: 'tracker',
      cadence: 'every_turn',
      fields: {
        alpha: { type: 'boolean', default: false, writableByTracker: true },
      },
      trackerInstruction: 'Track alpha.',
      narratorRule: 'Rule A.',
      ui: { widget: 'badge', order: 2 },
    };
    const modB: GameSystemModule = {
      id: 'mod_b',
      name: 'Module B',
      enabled: true,
      scope: 'session',
      target: 'global',
      effectOwner: 'tracker',
      cadence: 'every_turn',
      fields: {
        beta: { type: 'string', default: '', writableByTracker: true },
      },
      trackerInstruction: 'Track beta.',
      narratorRule: 'Rule B.',
      ui: { widget: 'badge', order: 1 },
    };

    const config1 = createAllDisabledConfig({ gameSystems: [modA, modB] });
    const config2 = createAllDisabledConfig({ gameSystems: [modB, modA] });

    const res1 = compileActiveTrackerSchema(config1, {
      turn: 1,
      clockAdvancedThisTurn: false,
      combatEndedThisTurn: false,
    });
    const res2 = compileActiveTrackerSchema(config2, {
      turn: 1,
      clockAdvancedThisTurn: false,
      combatEndedThisTurn: false,
    });

    expect(res1.dueModuleIds).toEqual(['mod_b', 'mod_a']);
    expect(res1.dueModuleIds).toEqual(res2.dueModuleIds);
    expect(res1.activeNarratorRules).toEqual(['Rule B.', 'Rule A.']);
    expect(res1.activeNarratorRules).toEqual(res2.activeNarratorRules);
    expect(res1.activeTrackerInstructions).toEqual(['Track beta.', 'Track alpha.']);
    expect(res1.activeTrackerInstructions).toEqual(res2.activeTrackerInstructions);

    // Verify mutating compiled output does not mutate original module spec
    const compiledSpec = res1.fieldPolicyMap.get('custom_fields.alpha')!.spec;
    compiledSpec.writableByTracker = false;
    expect(modA.fields['alpha']?.writableByTracker).toBe(true);
  });

  it('compiles tactical-rpg and living-world subsystem policies properly', () => {
    const rpgTurn = compileActiveTrackerSchema(STOCK_TACTICAL_RPG_PACK, {
      turn: 1,
      clockAdvancedThisTurn: false,
      combatEndedThisTurn: true,
    });
    expect(rpgTurn.fieldPolicyMap.get('entities.characters.*.resources.hp')?.writableByTracker).toBe(
      false
    );
    expect(
      rpgTurn.fieldPolicyMap.get('entities.characters.*.progression.xp')?.writableByTracker
    ).toBe(false);
    expect(rpgTurn.dueModuleIds).toContain('tactical_combat');
    expect(rpgTurn.fieldPolicyMap.has('entities.characters.*.sections.sec_combat_profile')).toBe(
      true
    );

    const livingTurn = compileActiveTrackerSchema(STOCK_LIVING_WORLD_PACK, {
      turn: 1,
      clockAdvancedThisTurn: true,
      combatEndedThisTurn: false,
    });
    expect(livingTurn.dueModuleIds).toContain('dual_world_clock');
    expect(livingTurn.dueModuleIds).toContain('faction_agendas');
    expect(livingTurn.dueModuleIds).toContain('form_identities');
    assertAllObjectsDisallowAdditionalProperties(livingTurn.trackerJsonSchema);
    const livingProps = (livingTurn.trackerJsonSchema as Record<string, unknown>)[
      'properties'
    ] as Record<string, unknown>;
    const factionsSchema = livingProps['factions'] as Record<string, unknown>;
    expect(factionsSchema['type']).toBe('object');
    expect(
      (factionsSchema['properties'] as Record<string, unknown>)['rumor_hook']
    ).toBeDefined();
    expect(livingTurn.fieldPolicyMap.get('factions.rumor_hook')?.writableByTracker).toBe(true);
    expect(livingTurn.fieldPolicyMap.get('entities.factions.*.influence')?.writableByTracker).toBe(
      false
    );
    expect(livingTurn.fieldPolicyMap.get('entities.threats.*.progress')?.writableByTracker).toBe(
      false
    );
  });

  it('supports implicit relationships capability and respects relationship lock overrides', () => {
    const implicitRelConfig = createAllDisabledConfig({
      capabilities: {
        spatialMode: 'scene_only',
        combatMode: 'disabled',
        progression: 'disabled',
        clocks: 'disabled',
        factions: false,
        beats: false,
        relationships: true,
        chronicle: false,
      },
    });
    const implicitRes = compileActiveTrackerSchema(implicitRelConfig, {
      turn: 1,
      clockAdvancedThisTurn: false,
      combatEndedThisTurn: false,
    });
    expect(implicitRes.dueModuleIds).toEqual(['relationships']);
    assertAllObjectsDisallowAdditionalProperties(implicitRes.trackerJsonSchema);

    const lockedAffinityConfig = createAllDisabledConfig({
      capabilities: {
        spatialMode: 'scene_only',
        combatMode: 'disabled',
        progression: 'disabled',
        clocks: 'disabled',
        factions: false,
        beats: false,
        relationships: true,
        chronicle: false,
      },
      gameSystems: [
        {
          id: 'relationship_affinity',
          name: 'Locked Affinity',
          enabled: true,
          scope: 'session',
          target: 'npc',
          effectOwner: 'engine',
          cadence: 'every_turn',
          fields: {
            affinity: {
              type: 'meter',
              min: -100,
              max: 100,
              default: 0,
              writableByTracker: false,
              confirmPolicy: 'locked',
            },
          },
          trackerInstruction: 'Only update labels and tags.',
          narratorRule: '',
          ui: { widget: 'bar', order: 1 },
        },
      ],
    });
    const lockedRes = compileActiveTrackerSchema(lockedAffinityConfig, {
      turn: 1,
      clockAdvancedThisTurn: false,
      combatEndedThisTurn: false,
    });
    const relProps = (
      (
        (
          (lockedRes.trackerJsonSchema as Record<string, unknown>)['properties'] as Record<
            string,
            unknown
          >
        )['relationships'] as Record<string, unknown>
      )['items'] as Record<string, unknown>
    )['properties'] as Record<string, unknown>;
    expect(relProps['affinityDelta']).toBeUndefined();
    expect(relProps['label']).toBeDefined();
    expect(lockedRes.fieldPolicyMap.get('relations.*.*.affinity')?.writableByTracker).toBe(false);
  });
});

describe('Schema validators & sheet presets', () => {
  it('validates dynamic fields, modules, character sections, and configs using Result/ErrorAccumulator', () => {
    expect(isErr(validateDynamicFieldSpec(null as unknown as never))).toBe(true);
    expect(isErr(validateCharacterSectionDef(undefined as unknown as never))).toBe(true);
    expect(isErr(validateGameSystemModule(null as unknown as never))).toBe(true);
    expect(isErr(validateSystemPack(null as unknown as never))).toBe(true);
    expect(isErr(validateEffectiveSystemConfig(null as unknown as never))).toBe(true);

    const dottedFieldModule = validateGameSystemModule({
      id: 'bad_key_mod',
      name: 'Bad Key',
      enabled: true,
      scope: 'session',
      target: 'global',
      effectOwner: 'tracker',
      cadence: 'every_turn',
      fields: {
        'bad.key': { type: 'boolean', default: false, writableByTracker: true },
      },
      trackerInstruction: '',
      narratorRule: '',
      ui: { widget: 'badge', order: 1 },
    });
    expect(isErr(dottedFieldModule)).toBe(true);
    const badMeter = validateDynamicFieldSpec({
      type: 'meter',
      min: 100,
      max: 10,
      default: 50,
      writableByTracker: true,
    });
    expect(isErr(badMeter)).toBe(true);

    const badEnum = validateDynamicFieldSpec({
      type: 'enum',
      options: ['a', 'a'],
      default: 'b',
      writableByTracker: true,
    });
    expect(isErr(badEnum)).toBe(true);

    const badCadence = validateCadencePolicy({ everyNTurns: 0 });
    expect(isErr(badCadence)).toBe(true);

    const badSection = validateCharacterSectionDef({
      ...OPTIONAL_DESIRES_SECTION,
      id: '',
      name: '',
    });
    expect(isErr(badSection)).toBe(true);

    const duplicateSections = validateCharacterSectionList([
      OPTIONAL_DESIRES_SECTION,
      OPTIONAL_DESIRES_SECTION,
    ]);
    expect(isErr(duplicateSections)).toBe(true);

    const badModule = validateGameSystemModule({
      id: '',
      name: '',
      enabled: true,
      scope: 'session',
      target: 'global',
      effectOwner: 'tracker',
      cadence: 'every_turn',
      fields: {
        bad_str: {
          type: 'string',
          maxLength: 3,
          default: 'too-long',
          writableByTracker: true,
        },
      },
      trackerInstruction: '',
      narratorRule: '',
      ui: { widget: 'bar', order: Number.NaN },
    });
    expect(isErr(badModule)).toBe(true);

    const collidingConfig = createAllDisabledConfig({
      gameSystems: [
        {
          id: 'mod1',
          name: 'M1',
          enabled: true,
          scope: 'session',
          target: 'global',
          effectOwner: 'tracker',
          cadence: 'every_turn',
          fields: { shared: { type: 'boolean', default: false, writableByTracker: true } },
          trackerInstruction: '',
          narratorRule: '',
          ui: { widget: 'badge', order: 1 },
        },
        {
          id: 'mod2',
          name: 'M2',
          enabled: true,
          scope: 'session',
          target: 'global',
          effectOwner: 'tracker',
          cadence: 'every_turn',
          fields: { shared: { type: 'boolean', default: false, writableByTracker: true } },
          trackerInstruction: '',
          narratorRule: '',
          ui: { widget: 'badge', order: 2 },
        },
      ],
    });
    expect(isErr(validateEffectiveSystemConfig(collidingConfig))).toBe(true);
  });

  it('provides all 4 sheet presets with isolated clones and prototype-safe lookups', () => {
    expect(Object.keys(SHEET_PRESETS)).toEqual([
      'realistic-modern',
      'dnd-adventurer',
      'superhero-dossier',
      'intimate-profile',
    ]);

    expect(getSheetPreset('constructor')).toBeUndefined();
    expect(getSheetPreset('unknown')).toBeUndefined();

    const intimate = getSheetPreset('intimate-profile');
    expect(intimate).toBeDefined();
    expect(intimate?.npcCoreSections.some((s) => s.id === 'sec_desires')).toBe(true);

    // Mutating returned preset must not leak to subsequent calls
    intimate!.npcCoreSections.pop();
    expect(getSheetPreset('intimate-profile')?.npcCoreSections.some((s) => s.id === 'sec_desires')).toBe(
      true
    );

    const validPack = validateSystemPack(STOCK_SLICE_OF_LIFE_PACK);
    expect(isOk(validPack)).toBe(true);
  });
});
