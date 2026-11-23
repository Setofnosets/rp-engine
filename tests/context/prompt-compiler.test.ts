import { describe, expect, it } from 'vitest';
import type { ActiveAmbientEntry, LiveNudgeEntry } from '../../src/beats/beat-engine.js';
import {
  type ControlRoomLayer,
  resolveEffectiveControlRoomConfig,
  setSectionOverride,
  toggleCapability,
  toggleGameSystemModule,
  upsertCustomField,
} from '../../src/config/control-room-config.js';
import {
  compileNarratorPrompt,
  validateCompilePromptInput,
} from '../../src/context/prompt-compiler.js';
import { renderWorldStateBlock } from '../../src/context/state-renderer.js';
import {
  DEFAULT_TOKEN_BUDGETS,
  clipTextToTokenBudget,
  estimateTokens,
  fitItemsToBudget,
  validateTokenBudgets,
} from '../../src/context/tokenizer-budget.js';
import { isErr, isOk } from '../../src/core/result.js';
import type { ChatMessage } from '../../src/gateway/types.js';
import {
  STOCK_FREEFORM_PACK,
  STOCK_LIVING_WORLD_PACK,
  STOCK_SLICE_OF_LIFE_PACK,
  STOCK_TACTICAL_RPG_PACK,
} from '../../src/schema/stock-system-packs.js';
import type { FormDefinition } from '../../src/state/forms.js';
import {
  type CharacterEntity,
  type FactionEntity,
  type ThreatEntity,
  type WorldState,
  createWorldState,
} from '../../src/state/world-state.js';

function makeCharacter(
  id: string,
  overrides: Partial<CharacterEntity> = {}
): CharacterEntity {
  return {
    id,
    name: overrides.name ?? id,
    status: overrides.status ?? 'active',
    presentInScene: overrides.presentInScene ?? false,
    locationId: overrides.locationId ?? null,
    formId: overrides.formId ?? null,
    formGroup: overrides.formGroup ?? null,
    sections: overrides.sections ?? {},
    customFields: overrides.customFields ?? {},
    ...(overrides.progression !== undefined ? { progression: overrides.progression } : {}),
    ...(overrides.resources !== undefined ? { resources: overrides.resources } : {}),
    ...(overrides.corruption !== undefined ? { corruption: overrides.corruption } : {}),
    abilities: overrides.abilities ?? [],
    goals: overrides.goals ?? [],
    agenda: overrides.agenda ?? '',
    allegiance: overrides.allegiance ?? '',
    mood: overrides.mood ?? 'neutral',
    traits: overrides.traits ?? [],
  };
}

function makeRichRpgAndWorldState(): WorldState {
  return createWorldState({
    sessionId: 'rpg-world-test',
    turn: 12,
    capabilities: {
      ...STOCK_TACTICAL_RPG_PACK.capabilities,
      factions: true,
      clocks: 'full_sim',
    },
    clocks: {
      turn: 12,
      storyTurn: 8,
      day: 4,
      inGameDate: '2026-05-14',
      slot: 'evening',
      held: false,
    },
    player: {
      id: 'player',
      name: 'Kaelen Vance',
      characterId: null,
      locationId: 'iron_tavern',
      progression: {
        level: 5,
        xp: 1450,
        className: 'Spellblade',
        subclass: 'Arcane Duelist',
        attributes: { str: 14, int: 17 },
      },
      resources: {
        hp: { current: 38, max: 45 },
        willpower: { current: 9, max: 12 },
        stamina: { current: 75, max: 100 },
      },
      inventory: {
        items: { healing_potion: 2, runed_blade: 1 },
        currency: { gold: 320 },
      },
      sections: {
        sec_body: 'Lean build with silver-streaked hair and a crescent scar.',
        sec_equipment: 'Enchanted leather coat and runed longsword.',
        sec_combat_profile: 'AC 17 | Longsword +7 (1d8+4) | Arcane Bolt',
        sec_desires: '', // hiddenUntilSet empty -> should be skipped
      },
    },
    locations: [
      {
        id: 'iron_tavern',
        name: 'The Rusty Anvil Tavern',
        kind: 'tavern',
        status: 'contested',
        controllingFactionId: 'crimson_guild',
        connectedLocations: ['market_square'],
        discovered: true,
        tags: ['social'],
        notes: 'Warm hearth and tense whispers.',
      },
    ],
    scene: {
      location: 'The Rusty Anvil Tavern',
      locationId: 'iron_tavern',
      pinnedCharacterIds: ['lyra'],
      mood: 'tense',
      pacing: 'balanced',
      directorNudge: null,
    },
    characters: [
      makeCharacter('lyra', {
        name: 'Lyra Thorne',
        presentInScene: true,
        locationId: 'iron_tavern',
        mood: 'guarded',
        progression: { level: 4, xp: 900, className: 'Shadowweaver' },
        resources: { hp: { current: 26, max: 30 } },
        abilities: ['Shadow Step', 'Dagger Flurry'],
        sections: {
          sec_personality: 'Sharp-tongued yet fiercely loyal to old debts.',
          sec_combat_profile: 'AC 16 | Twin Daggers +6',
        },
      }),
      makeCharacter('distant_smith', {
        name: 'Bram Ironfoot',
        presentInScene: false,
        locationId: 'market_square',
        sections: {
          sec_personality: 'Gruff veteran blacksmith.',
        },
      }),
    ],
    factions: [
      {
        id: 'crimson_guild',
        name: 'Crimson Guild',
        side: 'villain',
        status: 'active',
        influence: 78,
        headquartersLocationId: 'market_square',
        goals: ['Seize dock taxes'],
      },
    ],
    threats: [
      {
        id: 'obsidian_ritual',
        name: 'Obsidian Eclipse',
        rank: 'main',
        status: 'active',
        stage: 2,
        progress: 60,
        locationId: 'iron_tavern',
        sourceFactionId: 'crimson_guild',
        agenda: 'Open the beneath-gate',
      },
    ],
    relations: {
      player: {
        lyra: {
          affinity: 42,
          maxAffinity: 100,
          label: 'reluctant ally',
          tags: ['trusted', 'debt'],
        },
      },
    },
    turnEvents: {
      combatOutcomes: ['Round 2 [Kaelen Vance]: Arcane Slash hit Raider for 14 damage (defeated)'],
      rumors: ['Crimson Guild couriers were spotted near the harbor warehouse.'],
      systemNotices: [],
    },
  });
}

describe('Tokenizer & Budget Utilities', () => {
  it('estimates tokens deterministically with whitespace normalization', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('   \n\t  ')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('hello   \n\n  world')).toBe(estimateTokens('hello world'));
  });

  it('clips text cleanly within maxTokens including ellipsis', () => {
    const longText =
      'The ancient lantern flickered across the rain-slick cobblestones while distant bells tolled midnight over the quiet harbor.';
    const clipped = clipTextToTokenBudget(longText, 10);

    expect(clipped.endsWith('...')).toBe(true);
    expect(estimateTokens(clipped)).toBeLessThanOrEqual(10);
    expect(clipTextToTokenBudget(longText, 0)).toBe('');
    expect(clipTextToTokenBudget(longText, -5)).toBe('');
    expect(clipTextToTokenBudget('Short text.', 20)).toBe('Short text.');
  });

  it('greedily fits highest-priority items and truncates an oversized first item cleanly', () => {
    const items = [
      { id: 'high', text: 'First priority item with moderate length.' },
      { id: 'mid', text: 'Second priority item that fits nicely.' },
      { id: 'low', text: 'Third item with way too much extra prose that will definitely overflow the tight remaining cap here.' },
    ];
    const fitted = fitItemsToBudget(items, 22);
    expect(fitted.included.map((i) => i.id)).toEqual(['high', 'mid']);
    expect(fitted.droppedCount).toBe(1);
    expect(fitted.usedTokens).toBeLessThanOrEqual(22);

    const oversizedOnly = [
      { id: 'giant', text: 'Word '.repeat(80).trim() },
      { id: 'second', text: 'Should drop' },
    ];
    const truncated = fitItemsToBudget(oversizedOnly, 12);
    expect(truncated.included).toHaveLength(1);
    expect(truncated.included[0]?.id).toBe('giant');
    expect(estimateTokens(truncated.included[0]!.text)).toBeLessThanOrEqual(12);
    expect(truncated.droppedCount).toBe(1);
    // Input must remain unmutated
    expect(oversizedOnly[0]?.text.length).toBeGreaterThan(100);

    const zeroBudget = fitItemsToBudget(items, 0);
    expect(zeroBudget.included).toEqual([]);
    expect(zeroBudget.droppedCount).toBe(3);
    expect(zeroBudget.usedTokens).toBe(0);
  });

  it('validates partial budgets with Result & ErrorAccumulator', () => {
    const valid = validateTokenBudgets({ state: 400, world: 200 });
    expect(isOk(valid)).toBe(true);
    if (valid.ok) {
      expect(valid.value).toEqual({
        ...DEFAULT_TOKEN_BUDGETS,
        state: 400,
        world: 200,
      });
    }

    const invalid = validateTokenBudgets({ state: -10, world: Number.NaN });
    expect(isErr(invalid)).toBe(true);
    if (!invalid.ok) {
      expect(invalid.error).toHaveLength(2);
      expect(invalid.error[0]?.path).toBe('budgets.state');
      expect(invalid.error[1]?.path).toBe('budgets.world');
    }
  });
});

describe('Slice-of-Life vs Tactical RPG & Module Gating', () => {
  it('immediately removes all HP/XP/Level/Class/Faction/Combat tokens when switching config from Tactical RPG to Slice-of-Life', () => {
    const state = makeRichRpgAndWorldState();

    // Tactical config (with factions also enabled to verify faction tokens drop in slice-of-life)
    const tacticalConfig = resolveEffectiveControlRoomConfig(STOCK_TACTICAL_RPG_PACK, {
      capabilities: { factions: true },
      combatRules: {
        customRules: { flanking: 'Flanking grants +2 to attack rolls.' },
      },
    });
    const sliceConfig = resolveEffectiveControlRoomConfig(STOCK_SLICE_OF_LIFE_PACK);

    const tacticalCompiled = compileNarratorPrompt({
      state,
      config: tacticalConfig,
      cardPersona: {
        name: 'Chronicle Narrator',
        description: 'Gritty fantasy narrator.',
      },
      recentTranscript: [],
      latestInput: 'I raise my blade and watch Lyra closely.',
    });

    const tacticalStateText = tacticalCompiled.renderedSections['state'] ?? '';
    const tacticalRulesText = tacticalCompiled.renderedSections['game_system_rules'] ?? '';
    const tacticalCombatText = tacticalCompiled.renderedSections['combat_outcome'] ?? '';

    expect(tacticalStateText).toContain('Lv 5 Spellblade');
    expect(tacticalStateText).toContain('XP 1450');
    expect(tacticalStateText).toContain('HP 38/45');
    expect(tacticalStateText).toContain('healing_potion x2');
    expect(tacticalStateText).toContain('Crimson Guild');
    expect(tacticalStateText).toContain('Obsidian Eclipse');
    expect(tacticalStateText).toContain('Shadow Step');
    expect(tacticalStateText).toContain('Combat Profile');
    expect(tacticalCombatText).toContain('Arcane Slash hit Raider for 14 damage');
    expect(tacticalRulesText).toContain('Tactical Grid Combat');
    expect(tacticalRulesText).toContain('Flanking grants +2');

    // Switch config to stock-slice-of-life on the exact same WorldState
    const sliceCompiled = compileNarratorPrompt({
      state,
      config: sliceConfig,
      cardPersona: {
        name: 'Chronicle Narrator',
        description: 'Grounded drama narrator.',
      },
      recentTranscript: [],
      latestInput: 'I pour two glasses and ask Lyra why she came back.',
    });

    const sliceStateText = sliceCompiled.renderedSections['state'] ?? '';
    const sliceRulesText = sliceCompiled.renderedSections['game_system_rules'] ?? '';
    const sliceSystemText = sliceCompiled.renderedSections['system'] ?? '';

    // Zero tokens from combat/progression/factions
    expect(sliceCompiled.tokenBreakdown['combat_outcome']).toBe(0);
    expect(sliceCompiled.renderedSections['combat_outcome']).toBeUndefined();

    for (const forbidden of [
      'HP',
      'XP',
      'Lv ',
      'Level',
      'Spellblade',
      'Shadowweaver',
      'Willpower',
      'Stamina',
      'Crimson Guild',
      'Obsidian Eclipse',
      'Combat Profile',
      'Shadow Step',
      'Dagger Flurry',
      'healing_potion',
      'Arcane Slash',
      '[COMBAT_OUTCOME]',
      'Flanking',
      'harbor warehouse',
    ]) {
      expect(sliceStateText).not.toContain(forbidden);
      expect(sliceRulesText).not.toContain(forbidden);
      expect(sliceSystemText).not.toContain(forbidden);
    }

    // Core slice-of-life elements remain intact
    expect(sliceStateText).toContain('The Rusty Anvil Tavern');
    expect(sliceStateText).toContain('Kaelen Vance');
    expect(sliceStateText).toContain('Lyra Thorne');
    expect(sliceStateText).toContain('reluctant ally');
    expect(sliceStateText).toContain('Lean build with silver-streaked hair');
    expect(sliceStateText).toContain('Sharp-tongued yet fiercely loyal');
    expect(sliceStateText).not.toContain('Desires'); // hiddenUntilSet empty skipped
  });

  it('produces 0 tokens for disabled GameSystemModules and disabled clocks', () => {
    const baseState = createWorldState({
      capabilities: {
        ...STOCK_SLICE_OF_LIFE_PACK.capabilities,
        clocks: 'disabled',
      },
      player: {
        name: 'Elena',
        customFields: {
          sanity: 45,
          secret_meter: 99,
        },
      },
      customFields: {
        weather_custom: 'Heavy fog',
      },
    });

    let layer: ControlRoomLayer = {};
    layer = upsertCustomField(layer, 'sanity_mod', 'sanity', {
      type: 'meter',
      min: 0,
      max: 100,
      default: 100,
      writableByTracker: true,
    });
    layer = {
      ...layer,
      gameSystemOverrides: {
        ...(layer.gameSystemOverrides ?? {}),
        sanity_mod: {
          ...(layer.gameSystemOverrides?.['sanity_mod'] ?? {}),
          target: 'player',
          narratorRule: 'Describe mounting dread when sanity falls below 50.',
          enabled: false,
        },
        weather_mod: {
          createIfMissing: true,
          target: 'global',
          enabled: true,
          fields: {
            weather_custom: {
              type: 'string',
              default: 'Clear',
              writableByTracker: true,
            },
          },
          narratorRule: 'Weave active weather_custom conditions into scene atmosphere.',
        },
      },
    };
    layer = toggleGameSystemModule(layer, 'relationship_affinity', false, STOCK_SLICE_OF_LIFE_PACK);

    const config = resolveEffectiveControlRoomConfig(STOCK_SLICE_OF_LIFE_PACK, undefined, layer);
    const compiled = compileNarratorPrompt({
      state: baseState,
      config,
      cardPersona: { name: 'Drama', description: 'Modern drama' },
      recentTranscript: [],
      latestInput: 'I check my phone.',
    });

    const stateText = compiled.renderedSections['state'] ?? '';
    const rulesText = compiled.renderedSections['game_system_rules'] ?? '';

    expect(stateText).not.toContain('Time:'); // clocks === 'disabled'
    expect(stateText).not.toContain('sanity');
    expect(stateText).not.toContain('secret_meter'); // undeclared raw customField not dumped
    expect(stateText).toContain('weather_custom: Heavy fog');
    expect(rulesText).not.toContain('mounting dread');
    expect(rulesText).not.toContain('relationship affinity');
    expect(rulesText).toContain('weather_custom conditions');
  });
});

describe('Tier 0-2 State Renderer Features', () => {
  it('honors blockOrder, clock formatting dials, active formId, and Tier 1/2 location status', () => {
    const forms: FormDefinition[] = [
      {
        id: 'form_civilian',
        formGroup: 'vigilante_duo',
        characterId: 'hero_npc',
        displayName: 'Leila Mercer',
      },
      {
        id: 'form_hero',
        formGroup: 'vigilante_duo',
        characterId: 'hero_npc_alt',
        displayName: 'Kestrel',
      },
    ];

    const state = createWorldState({
      capabilities: STOCK_LIVING_WORLD_PACK.capabilities,
      clocks: {
        day: 3,
        inGameDate: '2026-05-14',
        slot: 'afternoon',
        held: true,
        holdReason: 'Rooftop standoff',
      },
      locations: [
        {
          id: 'skybridge',
          name: 'Apex Skybridge',
          kind: 'landmark',
          status: 'contested',
          controllingFactionId: 'vanguard',
          connectedLocations: [],
          discovered: true,
          tags: [],
          notes: '',
        },
      ],
      scene: {
        location: 'Ignored Tier 0 label',
        locationId: 'skybridge',
        pinnedCharacterIds: ['hero_npc_alt'],
        mood: 'electric',
        pacing: 'fast_forward',
      },
      factions: [
        {
          id: 'vanguard',
          name: 'Vanguard Corp',
          side: 'villain',
          status: 'active',
          influence: 84,
          headquartersLocationId: 'skybridge',
          goals: [],
        },
      ],
      characters: [
        makeCharacter('hero_npc', {
          name: 'Leila Mercer',
          locationId: 'skybridge',
          formId: 'form_civilian',
          formGroup: 'vigilante_duo',
        }),
        makeCharacter('hero_npc_alt', {
          name: 'Kestrel',
          locationId: 'skybridge',
          formId: 'form_hero',
          formGroup: 'vigilante_duo',
        }),
      ],
      turnEvents: {
        rumors: ['Rumor A', 'Rumor B', 'Rumor C', 'Rumor D'],
      },
    });

    const config = resolveEffectiveControlRoomConfig(STOCK_LIVING_WORLD_PACK, undefined, {
      blockOrder: ['TIME', 'FACTIONS', 'SCENE', 'CHARACTER', 'PARTY'],
      tuningDials: {
        use24hTime: true,
        useDdMmYyFormat: true,
      },
    });

    const rendered = renderWorldStateBlock({
      state,
      config,
      formDefinitions: forms,
    });

    // Clock formatted with 24h + DD/MM/YYYY + hold
    expect(rendered).toContain('Time: 14/05/2026 · 14:00 · HELD (Rooftop standoff)');
    // Tier 1/2 location name + status + controlling faction
    expect(rendered).toContain('Scene: Apex Skybridge (contested) [controlled by Vanguard Corp]');
    // Form exclusivity: pinned Kestrel wins over Leila Mercer
    expect(rendered).toContain('Kestrel | [form: Kestrel (form_hero)]');
    expect(rendered).not.toContain('Leila Mercer');
    // Up to 3 rumors max
    expect(rendered).toContain('Rumor A');
    expect(rendered).toContain('Rumor B');
    expect(rendered).toContain('Rumor C');
    expect(rendered).not.toContain('Rumor D');
    // blockOrder honored: TIME comes before FACTIONS, which comes before SCENE
    expect(rendered.indexOf('Time:')).toBeLessThan(rendered.indexOf('- Faction:'));
    expect(rendered.indexOf('- Faction:')).toBeLessThan(rendered.indexOf('Scene:'));
  });
});

describe('Strict Budget Enforcement (25 chars, 6 factions, 50 ambient beats)', () => {
  it('never exceeds state: 250 and world: 120 caps while prioritizing present NPCs and high-priority beats', () => {
    const characters: CharacterEntity[] = [];
    // 20 offscreen characters + 5 present characters (2 pinned)
    for (let i = 1; i <= 20; i += 1) {
      characters.push(
        makeCharacter(`offscreen_${String(i).padStart(2, '0')}`, {
          name: `Offscreen Citizen ${i}`,
          presentInScene: false,
          locationId: 'elsewhere',
          sections: { sec_personality: 'Verbose background '.repeat(10).trim() },
        })
      );
    }
    for (let i = 1; i <= 5; i += 1) {
      characters.push(
        makeCharacter(`present_${i}`, {
          name: `Present Ally ${i}`,
          presentInScene: true,
          locationId: 'plaza',
          mood: 'alert',
          sections: {
            sec_personality:
              'Carries an overly long biographical paragraph that should yield to core cast lines when tight.',
          },
        })
      );
    }

    const factions: FactionEntity[] = Array.from({ length: 6 }, (_, idx) => ({
      id: `faction_${idx + 1}`,
      name: `Syndicate Division ${idx + 1}`,
      side: 'neutral',
      status: 'active',
      influence: 50 + idx * 5,
      headquartersLocationId: null,
      goals: ['Control trade routes across the outer district'],
    }));

    const threats: ThreatEntity[] = [
      {
        id: 'threat_main',
        name: 'Iron Leviathan',
        rank: 'main',
        status: 'active',
        stage: 3,
        progress: 85,
        locationId: 'other_place',
        sourceFactionId: 'faction_6',
        agenda: 'Crush defenses',
      },
    ];

    const state = createWorldState({
      capabilities: {
        ...STOCK_LIVING_WORLD_PACK.capabilities,
        progression: 'rpg_levels',
        combatMode: 'tactical_grid',
      },
      locations: [
        {
          id: 'plaza',
          name: 'Central Plaza',
          kind: 'hub',
          status: 'normal',
          controllingFactionId: null,
          connectedLocations: ['elsewhere', 'other_place'],
          discovered: true,
          tags: [],
          notes: '',
        },
        {
          id: 'elsewhere',
          name: 'Outer Ward',
          kind: 'district',
          status: 'normal',
          controllingFactionId: null,
          connectedLocations: ['plaza'],
          discovered: true,
          tags: [],
          notes: '',
        },
        {
          id: 'other_place',
          name: 'Iron Citadel',
          kind: 'fortress',
          status: 'contested',
          controllingFactionId: 'faction_6',
          connectedLocations: ['plaza'],
          discovered: true,
          tags: [],
          notes: '',
        },
      ],
      scene: {
        location: 'Central Plaza',
        locationId: 'plaza',
        pinnedCharacterIds: ['present_4', 'present_2'],
        mood: 'charged',
        pacing: 'balanced',
      },
      player: {
        name: 'Avery',
        progression: { level: 3, xp: 400, className: 'Vanguard' },
        resources: { hp: { current: 30, max: 30 } },
        sections: {
          sec_background: 'Long player history '.repeat(30).trim(),
        },
      },
      characters,
      factions,
      threats,
      turnEvents: {
        rumors: ['Rumor one about harbor', 'Rumor two about gates', 'Rumor three about vault'],
      },
    });

    const activeAmbient: ActiveAmbientEntry[] = Array.from({ length: 50 }, (_, idx) => ({
      beatId: `amb_${String(idx + 1).padStart(2, '0')}`,
      lore: `Lore snippet #${idx + 1}: Ancient treaty clause governing district ${idx + 1}.`,
    }));

    const recentTranscript: ChatMessage[] = Array.from({ length: 12 }, (_, idx) => ({
      role: idx % 2 === 0 ? 'user' : 'assistant',
      content: `Transcript turn ${idx + 1} with realistic dialogue spanning multiple clauses and observations.`,
    }));

    const config = resolveEffectiveControlRoomConfig(STOCK_LIVING_WORLD_PACK, {
      capabilities: { progression: 'rpg_levels', combatMode: 'tactical_grid' },
    });

    const compiled = compileNarratorPrompt({
      state,
      config,
      cardPersona: {
        name: 'Living World GM',
        description: 'Simulates a bustling metropolis.',
      },
      activeAmbient,
      recentTranscript,
      latestInput: 'I scan the plaza for allies.',
      budgets: {
        state: 250,
        world: 120,
        totalMaxTokens: 1200,
      },
    });

    const stateSection = compiled.renderedSections['state'] ?? '';
    const worldSection = compiled.renderedSections['world'] ?? '';

    expect(estimateTokens(stateSection)).toBeLessThanOrEqual(250);
    expect(compiled.tokenBreakdown['state']).toBeLessThanOrEqual(250);
    expect(estimateTokens(worldSection)).toBeLessThanOrEqual(120);
    expect(compiled.tokenBreakdown['world']).toBeLessThanOrEqual(120);
    expect(compiled.totalEstimatedTokens).toBeLessThanOrEqual(1200);
    expect(compiled.droppedItemsCount).toBeGreaterThan(0);

    // Pinned & present NPCs prioritized; offscreen NPCs excluded
    expect(stateSection).toContain('Present Ally 4');
    expect(stateSection).toContain('Present Ally 2');
    expect(stateSection).not.toContain('Offscreen Citizen');

    // High-priority ambient beats (earliest indices) included over tail beats
    expect(worldSection).toContain('amb_01');
    expect(worldSection).toContain('amb_02');
    expect(worldSection).not.toContain('amb_50');

    // Latest user input is always the final message
    const lastMsg = compiled.messages[compiled.messages.length - 1];
    expect(lastMsg).toEqual({
      role: 'user',
      content: 'I scan the plaza for allies.',
    });
  });
});

describe('Director Nudge, [COMBAT_OUTCOME], Chronicle, CYOA, Overrides & Determinism', () => {
  it('injects Director Nudge even in Slice-of-Life and prioritizes Gate before Nudges in [PLOT]', () => {
    const state = createWorldState({
      capabilities: STOCK_TACTICAL_RPG_PACK.capabilities,
      scene: {
        location: 'Obsidian Vault',
        locationId: 'vault',
        directorNudge: 'Have the vault seal begin trembling on this turn.',
      },
      turnEvents: {
        combatOutcomes: ['Round 1 [Hero]: Shield Bash stunned Sentinel for 1 turn.'],
      },
    });

    const liveNudges: LiveNudgeEntry[] = [
      { beatId: 'nudge_low', class: 'nudge', text: 'Foreshadow the missing key.' },
      { beatId: 'gate_main', class: 'gate', text: 'Sentinel demands the cipher phrase.' },
    ];

    const config = resolveEffectiveControlRoomConfig(STOCK_TACTICAL_RPG_PACK);
    const compiled = compileNarratorPrompt({
      state,
      config,
      cardPersona: { name: 'GM', description: 'Fantasy campaign.' },
      liveNudges,
      recentTranscript: [],
      latestInput: 'I step toward the altar.',
    });

    const plot = compiled.renderedSections['plot'] ?? '';
    expect(plot).toContain('[Gate · gate_main]');
    expect(plot).toContain('[Director Nudge] Have the vault seal begin trembling on this turn.');
    expect(plot).toContain('[Nudge · nudge_low] Foreshadow the missing key.');
    // Gate appears before Director Nudge and regular Nudge
    expect(plot.indexOf('gate_main')).toBeLessThan(plot.indexOf('Director Nudge'));
    expect(plot.indexOf('Director Nudge')).toBeLessThan(plot.indexOf('nudge_low'));
    expect(compiled.renderedSections['combat_outcome']).toContain('Shield Bash stunned Sentinel');

    // Also works when switching to Slice-of-Life (beats disabled, plot omitted from syspromptSectionOrder)
    const sliceConfig = resolveEffectiveControlRoomConfig(STOCK_SLICE_OF_LIFE_PACK);
    const sliceCompiled = compileNarratorPrompt({
      state,
      config: sliceConfig,
      cardPersona: { name: 'Drama', description: 'Slice of life.' },
      liveNudges,
      recentTranscript: [],
      latestInput: 'I look around.',
    });
    expect(sliceCompiled.renderedSections['plot']).toContain('[Director Nudge]');
    expect(sliceCompiled.renderedSections['plot']).not.toContain('gate_main');
    expect(sliceCompiled.renderedSections['combat_outcome']).toBeUndefined();
  });

  it('injects relevant getRelevantChronicleEntries memories and loreContents into [WORLD]', () => {
    const state = createWorldState({
      capabilities: STOCK_LIVING_WORLD_PACK.capabilities,
      locations: [
        {
          id: 'clocktower',
          name: 'Old Clocktower',
          kind: 'ruin',
          status: 'normal',
          controllingFactionId: null,
          connectedLocations: ['harbor'],
          discovered: true,
          tags: [],
          notes: '',
        },
        {
          id: 'harbor',
          name: 'Harbor Docks',
          kind: 'district',
          status: 'normal',
          controllingFactionId: null,
          connectedLocations: ['clocktower'],
          discovered: true,
          tags: [],
          notes: '',
        },
      ],
      scene: {
        location: 'Old Clocktower',
        locationId: 'clocktower',
      },
      characters: [
        makeCharacter('mira', {
          name: 'Mira Vance',
          locationId: 'clocktower',
          presentInScene: true,
        }),
      ],
      chronicleEvents: [
        {
          id: 'chr_1',
          turn: 3,
          day: 1,
          date: '2026-05-01',
          title: 'Clocktower Pact',
          category: 'event',
          summary: 'Mira swore an oath atop the Old Clocktower to protect the astral lens.',
          locationId: 'clocktower',
          involvedEntityIds: ['mira'],
          keywords: ['lens', 'oath'],
        },
        {
          id: 'chr_unrelated',
          turn: 2,
          day: 1,
          date: '2026-05-01',
          title: 'Harbor Fish Market',
          category: 'world',
          summary: 'Tuna prices dropped at the docks.',
          locationId: 'harbor',
          involvedEntityIds: ['dockworker'],
          keywords: ['fish'],
        },
      ],
    });

    const loreMap = new Map<string, string>([
      ['lore/astral_lens.md', 'The Astral Lens resonates whenever starlight hits the spire.'],
    ]);

    const config = resolveEffectiveControlRoomConfig(STOCK_LIVING_WORLD_PACK);
    const compiled = compileNarratorPrompt({
      state,
      config,
      cardPersona: { name: 'GM', description: 'Mystery campaign.' },
      activeAmbient: [{ beatId: 'amb_lens', lore: 'lore/astral_lens.md' }],
      loreContents: loreMap,
      recentTranscript: [{ role: 'assistant', content: 'Mira glances toward the astral lens.' }],
      latestInput: 'Ask Mira about our oath.',
    });

    const world = compiled.renderedSections['world'] ?? '';
    expect(world).toContain('Astral Lens resonates');
    expect(world).toContain('Clocktower Pact');
    expect(world).toContain('Mira swore an oath');
    expect(world).not.toContain('Harbor Fish Market');
  });

  it('supports CYOA toggle, narrativePacing, unlocked section overrides, script injections, and section ordering', () => {
    const state = createWorldState({
      capabilities: STOCK_SLICE_OF_LIFE_PACK.capabilities,
      scene: { location: 'Cafe Solaris' },
    });

    // 1) Locked basePrompts should NOT override 'system'
    const lockedLayer: ControlRoomLayer = {
      basePrompts: { system: 'SHOULD BE IGNORED WHILE LOCKED' },
      unlockedPromptSections: { system: false },
      tuningDials: { cyoaEnabled: false, narrativePacing: 'slow_burn' },
    };
    const lockedConfig = resolveEffectiveControlRoomConfig(
      STOCK_SLICE_OF_LIFE_PACK,
      undefined,
      lockedLayer
    );
    const lockedResult = compileNarratorPrompt({
      state,
      config: lockedConfig,
      cardPersona: { name: 'Cafe Host', description: 'Cozy romance.' },
      recentTranscript: [],
      latestInput: 'I order espresso.',
    });
    expect(lockedResult.renderedSections['system']).not.toContain('SHOULD BE IGNORED WHILE LOCKED');
    expect(lockedResult.renderedSections['system']).toContain('Referee engine');
    expect(lockedResult.renderedSections['system']).not.toContain('CYOA');
    expect(lockedResult.renderedSections['narrative_pacing']).toContain('slow_burn');

    // 2) Unlocked section override via setSectionOverride + CYOA enabled + script prompt
    let unlockedLayer: ControlRoomLayer = setSectionOverride(
      {},
      'system',
      'Custom Noir Referee Instructions.'
    );
    unlockedLayer = {
      ...unlockedLayer,
      syspromptSectionOrder: ['state', 'system', 'card', 'transcript_window', 'latest_input'],
      tuningDials: { cyoaEnabled: true, narrativePacing: 'fast_forward' },
    };
    const unlockedConfig = resolveEffectiveControlRoomConfig(
      STOCK_FREEFORM_PACK,
      undefined,
      unlockedLayer
    );
    const unlockedResult = compileNarratorPrompt({
      state,
      config: unlockedConfig,
      cardPersona: { name: 'Detective', description: 'Noir investigator.' },
      injectedScriptPrompts: [{ section: 'script_clue', text: 'Remember the rain-soaked letter.' }],
      recentTranscript: [{ role: 'user', content: 'Previous line.' }],
      latestInput: 'I check the envelope.',
    });

    expect(unlockedResult.renderedSections['system']).toBe('Custom Noir Referee Instructions.');
    expect(unlockedResult.renderedSections['cyoa']).toContain('CYOA');
    expect(unlockedResult.renderedSections['script_clue']).toBe('Remember the rain-soaked letter.');

    const sysContent = unlockedResult.messages[0]?.content ?? '';
    // Reordered: [STATE] appears before Custom Noir Referee Instructions
    expect(sysContent.indexOf('[STATE]')).toBeLessThan(
      sysContent.indexOf('Custom Noir Referee Instructions.')
    );
  });

  it('produces byte-identical outputs across repeated invocations and resists prototype pollution', () => {
    const state = makeRichRpgAndWorldState();
    const maliciousFields: Record<string, unknown> = {};
    Object.defineProperty(maliciousFields, '__proto__', {
      value: { polluted: true },
      enumerable: true,
      configurable: true,
    });
    state.customFields = maliciousFields;

    const config = resolveEffectiveControlRoomConfig(STOCK_TACTICAL_RPG_PACK);
    const input = {
      state,
      config,
      cardPersona: {
        name: 'Narrator',
        description: 'Deterministic world runner.',
        scenario: 'Evening in the contested tavern.',
      },
      liveNudges: [{ beatId: 'b1', class: 'nudge' as const, text: 'Keep tension steady.' }],
      activeAmbient: [{ beatId: 'a1', lore: 'lore/tavern.md' }],
      loreContents: {
        'lore/tavern.md': 'The Rusty Anvil sits atop old catacombs.',
      },
      injectedScriptPrompts: [
        { section: '__proto__', text: 'Ignored evil section' },
        { section: 'world', text: 'Bells chime at dusk.' },
      ],
      recentTranscript: [
        { role: 'user' as const, content: 'I step inside.' },
        { role: 'assistant' as const, content: 'Smoke curls toward the rafters.' },
      ],
      latestInput: 'I approach Lyra.',
    };

    const run1 = compileNarratorPrompt(input);
    const run2 = compileNarratorPrompt(input);

    expect(JSON.stringify(run1)).toBe(JSON.stringify(run2));
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.hasOwn(run1.renderedSections, '__proto__')).toBe(false);
    expect(Object.hasOwn(run1.tokenBreakdown, '__proto__')).toBe(false);

    const validationOk = validateCompilePromptInput(input);
    expect(isOk(validationOk)).toBe(true);
  });

  it('maintains contiguous recency in recentTranscript, sheds system bloat under ultra-tight totalMaxTokens, and falls back to persona when card is omitted', () => {
    const state = makeRichRpgAndWorldState();
    const stateSnapshot = JSON.stringify(state);

    const config = resolveEffectiveControlRoomConfig(STOCK_TACTICAL_RPG_PACK, undefined, {
      syspromptSectionOrder: ['system', 'persona', 'state', 'world', 'transcript_window', 'latest_input'],
    });

    const recentTranscript: ChatMessage[] = [
      { role: 'user', content: 'Turn 1: Old message that is quite short.' },
      {
        role: 'assistant',
        content:
          'Turn 2: Very long narrative passage that overflows the remaining transcript window budget completely so it must stop history expansion right here. '.repeat(
            4
          ),
      },
      { role: 'user', content: 'Turn 3: Recent turn right before latest.' },
      { role: 'assistant', content: 'Turn 4: Most recent assistant response.' },
    ];

    const tightResult = compileNarratorPrompt({
      state,
      config,
      cardPersona: {
        name: 'Archivist',
        description: 'Keeps the persona alive when card is omitted.',
      },
      activeAmbient: [{ beatId: 'amb_1', lore: 'Long lore entry '.repeat(40) }],
      recentTranscript,
      latestInput: 'What happens next?',
      budgets: {
        state: 180,
        world: 120,
        totalMaxTokens: 450,
      },
    });

    // Persona slot receives cardPersona fallback when 'card' is not in syspromptSectionOrder
    expect(tightResult.renderedSections['persona']).toContain('Archivist');
    expect(tightResult.totalEstimatedTokens).toBeLessThanOrEqual(450);

    // Contiguous recency: Turn 2 overflows so Turn 1 must NOT be included even though Turn 1 is short
    const transcriptTexts = tightResult.messages
      .filter((m) => m.role !== 'system')
      .map((m) => m.content);
    expect(transcriptTexts[transcriptTexts.length - 1]).toBe('What happens next?');
    expect(transcriptTexts.some((t) => t.startsWith('Turn 1:'))).toBe(false);
    expect(transcriptTexts.some((t) => t.startsWith('Turn 4:'))).toBe(true);

    // Ultra-tight totalMaxTokens sheds lower-priority sections cleanly while staying under cap
    const ultraTight = compileNarratorPrompt({
      state,
      config,
      cardPersona: { name: 'Archivist', description: 'Short persona.' },
      activeAmbient: [{ beatId: 'amb_1', lore: 'Long lore entry '.repeat(40) }],
      recentTranscript,
      latestInput: 'What happens next?',
      budgets: { totalMaxTokens: 160 },
    });
    expect(ultraTight.totalEstimatedTokens).toBeLessThanOrEqual(160);

    // Zero budget state renders empty string cleanly
    expect(renderWorldStateBlock({ state, config, maxTokens: 0 })).toBe('');

    // Validate input rejects malformed payloads cleanly via Result
    const badRes = validateCompilePromptInput({
      state,
      config,
      cardPersona: { name: 'A', description: 'B' },
      recentTranscript: 'not-an-array' as unknown as ChatMessage[],
      latestInput: 'Hi',
      budgets: { state: -1 },
    });
    expect(isErr(badRes)).toBe(true);

    // Input WorldState remains completely unmutated
    expect(JSON.stringify(state)).toBe(stateSnapshot);
  });
});
