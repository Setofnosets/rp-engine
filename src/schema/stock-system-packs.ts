import {
  DEFAULT_NPC_SECTIONS,
  DEFAULT_PC_SECTIONS,
  OPTIONAL_COMBAT_PROFILE_SECTION,
  OPTIONAL_SUPERPOWERS_SECTION,
  cloneCharacterSection,
  cloneCharacterSections,
} from './character-sections.js';
import { cloneSystemPack } from './dynamic-schema-compiler.js';
import type { GameSystemModule, SystemPack } from './tracker-module.js';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) {
      for (const item of value) {
        deepFreeze(item);
      }
    } else {
      for (const propValue of Object.values(value as Record<string, unknown>)) {
        deepFreeze(propValue);
      }
    }
    Object.freeze(value);
  }
  return value;
}

function createSceneContextModule(cadence: GameSystemModule['cadence']): GameSystemModule {
  return {
    id: 'scene_context',
    name: 'Scene Context',
    description: 'Tracks current scene location, emotional atmosphere, and present characters.',
    enabled: true,
    scope: 'session',
    target: 'global',
    effectOwner: 'tracker',
    cadence,
    fields: {
      location: {
        type: 'string',
        maxLength: 120,
        default: '',
        writableByTracker: true,
        confirmPolicy: 'auto',
        description: 'Current scene setting or site name',
      },
      mood: {
        type: 'string',
        maxLength: 64,
        default: 'neutral',
        writableByTracker: true,
        confirmPolicy: 'auto',
        description: 'Current emotional tone or atmosphere of the scene',
      },
      presentCharacterIds: {
        type: 'string_list',
        maxItems: 24,
        default: [],
        writableByTracker: true,
        confirmPolicy: 'auto',
        description: 'IDs of characters actively present in the current scene',
      },
    },
    trackerInstruction:
      'Update only the active scene location, overall atmosphere mood, and present character IDs based on the latest turn.',
    narratorRule: '',
    ui: { widget: 'card', order: 1 },
  };
}

function createRelationshipAffinityModule(order: number): GameSystemModule {
  return {
    id: 'relationship_affinity',
    name: 'Relationship Affinity',
    description: 'Tracks interpersonal affinity shifts, social labels, and bond tags.',
    enabled: true,
    scope: 'session',
    target: 'npc',
    effectOwner: 'hybrid',
    cadence: 'every_turn',
    fields: {},
    trackerInstruction:
      'Propose signed affinity adjustments (-25 to +25), updated social labels, and bond tags only when an interaction meaningfully shifts a relationship.',
    narratorRule:
      'Reflect current relationship affinity and bond labels naturally through warmth, trust, guardedness, and subtext.',
    ui: { widget: 'bar', order },
  };
}

function createCalendarClockModule(order: number): GameSystemModule {
  return {
    id: 'calendar_clock',
    name: 'Calendar & Time of Day',
    description: 'Tracks narrative time-of-day transitions without full simulation agendas.',
    enabled: true,
    scope: 'session',
    target: 'global',
    effectOwner: 'hybrid',
    cadence: 'every_turn',
    fields: {
      time_of_day: {
        type: 'enum',
        options: ['morning', 'afternoon', 'evening', 'night'],
        default: 'morning',
        writableByTracker: true,
        confirmPolicy: 'auto',
        description: 'Current narrative time slot of the day',
      },
    },
    trackerInstruction:
      'Update time_of_day only when the narrative clearly transitions into morning, afternoon, evening, or night.',
    narratorRule:
      'Ground lighting, ambient atmosphere, and daily schedules in the active calendar date and time of day.',
    ui: { widget: 'badge', order },
  };
}

function createNarrativePacingModule(order: number): GameSystemModule {
  return {
    id: 'narrative_pacing',
    name: 'Narrative Pacing',
    description: 'Guides scene tempo and captures the immediate dramatic focus.',
    enabled: true,
    scope: 'session',
    target: 'global',
    effectOwner: 'tracker',
    cadence: 'every_turn',
    fields: {
      pacing: {
        type: 'enum',
        options: ['slow_burn', 'balanced', 'fast_forward'],
        default: 'balanced',
        writableByTracker: true,
        confirmPolicy: 'auto',
        description: 'Current narrative tempo',
      },
      scene_focus: {
        type: 'string',
        maxLength: 140,
        default: '',
        writableByTracker: true,
        confirmPolicy: 'auto',
        description: 'Concise note capturing the active interpersonal focus or tension',
      },
    },
    trackerInstruction:
      'Adjust pacing only if the story clearly slows down or skips ahead; keep scene_focus to one brief clause.',
    narratorRule:
      'Match prose rhythm to the active pacing mode: linger on character beats during slow_burn and advance briskly during fast_forward.',
    ui: { widget: 'tags', order },
  };
}

function createEpisodicChronicleModule(order: number): GameSystemModule {
  return {
    id: 'episodic_chronicle',
    name: 'Episodic Chronicle',
    description: 'Archives milestone story events for long-term memory recall.',
    enabled: true,
    scope: 'session',
    target: 'global',
    effectOwner: 'tracker',
    cadence: { everyNTurns: 5 },
    fields: {
      milestone_note: {
        type: 'string',
        maxLength: 240,
        default: '',
        writableByTracker: true,
        confirmPolicy: 'batch_confirm',
        description: 'Brief milestone summary of a major narrative turning point',
      },
    },
    trackerInstruction:
      'Record a concise milestone_note only when a lasting turning point or memorable event occurred; otherwise leave it empty.',
    narratorRule:
      'Honor continuity with archived chronicle milestones whenever past events, places, or participants resurface.',
    ui: { widget: 'card', order },
  };
}

/**
 * Stock Pack 1: Minimal freeform chat with Tier 0 scene-only context and manual-only tracking.
 */
export const STOCK_FREEFORM_PACK: SystemPack = deepFreeze({
  spec: 'system-pack/0.1',
  id: 'stock-freeform',
  name: 'Freeform (Minimal Chat)',
  description:
    'Minimalist freeform chat pack with Tier 0 scene context only. Zero stats, zero sheet bloat, and zero automatic tracker overhead.',
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
  gameSystems: [createSceneContextModule('manual_only')],
  blockOrder: ['SCENE'],
  syspromptSectionOrder: ['system', 'persona', 'card', 'state', 'transcript_window', 'latest_input'],
});

/**
 * Stock Pack 2: Realistic slice-of-life, drama, and romance with zero RPG mechanics.
 */
export const STOCK_SLICE_OF_LIFE_PACK: SystemPack = deepFreeze({
  spec: 'system-pack/0.1',
  id: 'stock-slice-of-life',
  name: 'Slice of Life (Drama & Romance)',
  description:
    'Tier 0 scene-only pack tailored for realistic drama, everyday life, and romance: tracks modular character sheets, attire, relationships, calendar time, and narrative pacing without RPG numbers or maps.',
  capabilities: {
    spatialMode: 'scene_only',
    combatMode: 'disabled',
    progression: 'disabled',
    clocks: 'calendar_only',
    factions: false,
    beats: false,
    relationships: true,
    chronicle: true,
  },
  pcCoreSections: cloneCharacterSections(DEFAULT_PC_SECTIONS),
  npcCoreSections: cloneCharacterSections(DEFAULT_NPC_SECTIONS),
  gameSystems: [
    createSceneContextModule('every_turn'),
    createRelationshipAffinityModule(2),
    createCalendarClockModule(3),
    createNarrativePacingModule(4),
    createEpisodicChronicleModule(5),
  ],
  blockOrder: ['SCENE', 'CHARACTER', 'RELATIONSHIPS', 'TIME', 'PACING', 'CHRONICLE'],
  syspromptSectionOrder: [
    'system',
    'narrative_pacing',
    'game_system_rules',
    'persona',
    'card',
    'state',
    'world',
    'transcript_window',
    'latest_input',
  ],
});

/**
 * Stock Pack 3: Deterministic tactical grid combat and RPG progression.
 */
export const STOCK_TACTICAL_RPG_PACK: SystemPack = deepFreeze({
  spec: 'system-pack/0.1',
  id: 'stock-tactical-rpg',
  name: 'Tactical RPG (Grid & Progression)',
  description:
    'Deterministic tactical grid combat and RPG leveling pack with emergent location discovery, HP/willpower/stamina pools, XP/class progression, skill outcomes, and adventurer sheets.',
  capabilities: {
    spatialMode: 'emergent',
    combatMode: 'tactical_grid',
    progression: 'rpg_levels',
    clocks: 'calendar_only',
    factions: false,
    beats: true,
    relationships: true,
    chronicle: true,
  },
  pcCoreSections: [
    ...cloneCharacterSections(DEFAULT_PC_SECTIONS),
    cloneCharacterSection(OPTIONAL_COMBAT_PROFILE_SECTION),
  ],
  npcCoreSections: [
    ...cloneCharacterSections(DEFAULT_NPC_SECTIONS),
    cloneCharacterSection(OPTIONAL_COMBAT_PROFILE_SECTION),
  ],
  gameSystems: [
    createSceneContextModule('every_turn'),
    {
      id: 'tactical_combat',
      name: 'Tactical Grid Combat',
      description: 'Engine-adjudicated tactical grid encounters and post-combat aftermath.',
      enabled: true,
      scope: 'session',
      target: 'player',
      effectOwner: 'engine',
      cadence: 'on_combat_end',
      fields: {
        hp: {
          type: 'meter',
          min: 0,
          max: 9999,
          default: 20,
          writableByTracker: false,
          confirmPolicy: 'locked',
          description: 'Current hit points (engine-owned)',
        },
        willpower: {
          type: 'meter',
          min: 0,
          max: 100,
          default: 10,
          writableByTracker: false,
          confirmPolicy: 'locked',
          description: 'Current willpower resource (engine-owned)',
        },
        stamina: {
          type: 'meter',
          min: 0,
          max: 100,
          default: 100,
          writableByTracker: false,
          confirmPolicy: 'locked',
          description: 'Current stamina resource (engine-owned)',
        },
        combat_aftermath: {
          type: 'string',
          maxLength: 240,
          default: '',
          writableByTracker: true,
          confirmPolicy: 'auto',
          description: 'Concise aftermath summary when combat concludes',
        },
      },
      trackerInstruction:
        'When combat concludes, summarize the immediate battlefield aftermath in combat_aftermath without altering HP or tactical stats.',
      narratorRule:
        'Narrate tactical actions and injuries strictly from [COMBAT_OUTCOME]; never fabricate damage numbers, misses, or resource recovery.',
      ui: { widget: 'bar', order: 2 },
    },
    {
      id: 'rpg_progression',
      name: 'RPG Progression',
      description: 'Deterministic level, XP, class, and currency progression.',
      enabled: true,
      scope: 'session',
      target: 'player',
      effectOwner: 'engine',
      cadence: 'on_combat_end',
      fields: {
        level: {
          type: 'counter',
          min: 1,
          default: 1,
          writableByTracker: false,
          confirmPolicy: 'locked',
          description: 'Character level (engine-owned)',
        },
        xp: {
          type: 'counter',
          min: 0,
          default: 0,
          writableByTracker: false,
          confirmPolicy: 'locked',
          description: 'Accumulated experience points (engine-owned)',
        },
        class: {
          type: 'string',
          maxLength: 64,
          default: 'Adventurer',
          writableByTracker: false,
          confirmPolicy: 'locked',
          description: 'Character class or profession (engine-owned)',
        },
        gold: {
          type: 'counter',
          min: 0,
          default: 0,
          writableByTracker: false,
          confirmPolicy: 'locked',
          description: 'Party currency balance (engine-owned)',
        },
      },
      trackerInstruction: '',
      narratorRule:
        'Respect character level, class capabilities, and equipped gear shown in [STATE]; the engine computes XP and level-ups.',
      ui: { widget: 'badge', order: 3 },
    },
    createRelationshipAffinityModule(4),
    createCalendarClockModule(5),
    createEpisodicChronicleModule(6),
  ],
  blockOrder: [
    'SCENE',
    'CHARACTER',
    'PARTY',
    'INVENTORY',
    'ABILITIES',
    'SPELLS',
    'XP',
    'RELATIONSHIPS',
    'TIME',
    'CHRONICLE',
  ],
  syspromptSectionOrder: [
    'system',
    'narrative_pacing',
    'game_system_rules',
    'persona',
    'card',
    'state',
    'combat_outcome',
    'plot',
    'world',
    'transcript_window',
    'latest_input',
  ],
});

/**
 * Stock Pack 4: Full living-world simulation with authored map, factions, clocks, and beat ledger.
 */
export const STOCK_LIVING_WORLD_PACK: SystemPack = deepFreeze({
  spec: 'system-pack/0.1',
  id: 'stock-living-world',
  name: 'Living World (Factions & Agendas)',
  description:
    'Multi-faction world simulation pack featuring Tier 2 authored location graphs, Dual World Clock with time holds, off-screen faction/threat agendas, multi-form identities, and canon beat tracking.',
  capabilities: {
    spatialMode: 'authored_graph',
    combatMode: 'traditional',
    progression: 'disabled',
    clocks: 'full_sim',
    factions: true,
    beats: true,
    relationships: true,
    chronicle: true,
  },
  pcCoreSections: [
    ...cloneCharacterSections(DEFAULT_PC_SECTIONS),
    cloneCharacterSection(OPTIONAL_SUPERPOWERS_SECTION),
    cloneCharacterSection(OPTIONAL_COMBAT_PROFILE_SECTION),
  ],
  npcCoreSections: [
    ...cloneCharacterSections(DEFAULT_NPC_SECTIONS),
    cloneCharacterSection(OPTIONAL_SUPERPOWERS_SECTION),
    cloneCharacterSection(OPTIONAL_COMBAT_PROFILE_SECTION),
  ],
  gameSystems: [
    createSceneContextModule('every_turn'),
    {
      id: 'dual_world_clock',
      name: 'Dual World Clock',
      description: 'Dual mechanical/narrative calendar clock with scene time-hold hints.',
      enabled: true,
      scope: 'session',
      target: 'global',
      effectOwner: 'hybrid',
      cadence: 'on_clock_advance',
      fields: {
        clock_hold_recommended: {
          type: 'boolean',
          default: false,
          writableByTracker: true,
          confirmPolicy: 'batch_confirm',
          description: 'Suggest holding fiction time during an ongoing crisis or scene',
        },
      },
      trackerInstruction:
        'Set clock_hold_recommended to true only when an uninterrupted confrontation or conversation should freeze fiction time.',
      narratorRule:
        'Follow the authoritative Dual World Clock day, date, time slot, and hold state; never jump days forward unilaterally in prose.',
      ui: { widget: 'badge', order: 2 },
    },
    {
      id: 'faction_agendas',
      name: 'Faction Agendas & Threats',
      description: 'Tracks off-screen faction influence, threats, and emergent street rumors.',
      enabled: true,
      scope: 'session',
      target: 'global',
      effectOwner: 'hybrid',
      cadence: 'on_clock_advance',
      fields: {
        rumor_hook: {
          type: 'string',
          maxLength: 200,
          default: '',
          writableByTracker: true,
          confirmPolicy: 'auto',
          description: 'Brief public rumor reflecting off-screen faction or threat movements',
        },
      },
      trackerInstruction:
        'When the world clock advances, record a brief street-level rumor_hook reflecting visible faction or threat activity.',
      narratorRule:
        'Reflect faction control, headquarters presence, and escalating threat stages shown in [STATE] and off-screen rumors.',
      ui: { widget: 'card', order: 3 },
    },
    {
      id: 'form_identities',
      name: 'Multi-Form Identities',
      description: 'Tracks active persona forms and secret-identity exposure for multi-form cast.',
      enabled: true,
      scope: 'session',
      target: 'npc',
      effectOwner: 'hybrid',
      cadence: 'every_turn',
      fields: {
        active_form: {
          type: 'string',
          maxLength: 64,
          default: '',
          writableByTracker: true,
          confirmPolicy: 'batch_confirm',
          description: 'Currently active persona or transformation form ID',
        },
        cover_intact: {
          type: 'boolean',
          default: true,
          writableByTracker: true,
          confirmPolicy: 'batch_confirm',
          description: 'Whether the character civilian/secret cover remains intact',
        },
      },
      trackerInstruction:
        'Record active_form shifts and whether a multi-form character secret cover was compromised this turn.',
      narratorRule:
        'Enforce strict persona exclusivity: never allow two forms of the same character to appear simultaneously in a scene.',
      ui: { widget: 'tags', order: 4 },
    },
    createRelationshipAffinityModule(5),
    createEpisodicChronicleModule(6),
  ],
  blockOrder: [
    'SCENE',
    'CHARACTER',
    'FACTIONS',
    'THREATS',
    'RELATIONSHIPS',
    'TIME',
    'BEATS',
    'CHRONICLE',
  ],
  syspromptSectionOrder: [
    'system',
    'narrative_pacing',
    'game_system_rules',
    'persona',
    'card',
    'state',
    'combat_outcome',
    'plot',
    'world',
    'transcript_window',
    'latest_input',
  ],
});

export type StockSystemPackId =
  | 'stock-freeform'
  | 'stock-slice-of-life'
  | 'stock-tactical-rpg'
  | 'stock-living-world';

/**
 * Registry of all 4 built-in Stock System Packs keyed by canonical pack ID.
 */
export const STOCK_SYSTEM_PACKS: Record<StockSystemPackId, SystemPack> = deepFreeze({
  'stock-freeform': STOCK_FREEFORM_PACK,
  'stock-slice-of-life': STOCK_SLICE_OF_LIFE_PACK,
  'stock-tactical-rpg': STOCK_TACTICAL_RPG_PACK,
  'stock-living-world': STOCK_LIVING_WORLD_PACK,
});

/**
 * Retrieve a deep-cloned built-in {@link SystemPack} by ID, or `undefined` if not found.
 */
export function getStockSystemPack(id: string): SystemPack | undefined {
  if (!Object.hasOwn(STOCK_SYSTEM_PACKS, id)) {
    return undefined;
  }
  return cloneSystemPack(STOCK_SYSTEM_PACKS[id as StockSystemPackId]);
}
