import { type ValidationError } from '../core/errors.js';
import { ErrorAccumulator, type Result, ok } from '../core/result.js';
import {
  type CadencePolicy,
  type ConfirmPolicy,
  cloneCadencePolicy,
  validateCadencePolicy,
  validateConfirmPolicy,
} from './tracker-module.js';

export type CharacterSectionFieldType = 'prose' | 'bullet_list' | 'stat_block';

export interface CharacterSectionDef {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  fieldType: CharacterSectionFieldType;
  hiddenUntilSet?: boolean;
  writableByTracker: boolean;
  confirmPolicy?: ConfirmPolicy;
  cadence: CadencePolicy;
}

export type SheetPresetId =
  | 'realistic-modern'
  | 'dnd-adventurer'
  | 'superhero-dossier'
  | 'intimate-profile';

export interface SheetPreset {
  id: SheetPresetId;
  name: string;
  description: string;
  pcCoreSections: CharacterSectionDef[];
  npcCoreSections: CharacterSectionDef[];
}

const VALID_FIELD_TYPES: ReadonlySet<CharacterSectionFieldType> = new Set([
  'prose',
  'bullet_list',
  'stat_block',
]);

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

/**
 * Default modular character sheet sections for NPCs.
 */
export const DEFAULT_NPC_SECTIONS: CharacterSectionDef[] = deepFreeze([
  {
    id: 'sec_species',
    name: 'Species',
    description:
      'Biological species, ancestry, subtype, and gender — static identity recorded once when the NPC is introduced.',
    icon: '🧬',
    color: '#0ea5e9',
    fieldType: 'prose',
    writableByTracker: true,
    confirmPolicy: 'auto',
    cadence: 'every_turn',
  },
  {
    id: 'sec_body',
    name: 'Body',
    description:
      'Signature physical look: build, age, face, hair, eyes, skin, scars, and natural posture. Exclude transient outfits or carried items.',
    icon: '👁️',
    color: '#d4a940',
    fieldType: 'prose',
    writableByTracker: true,
    confirmPolicy: 'auto',
    cadence: 'every_turn',
  },
  {
    id: 'sec_equipment',
    name: 'Worn Equipment',
    description:
      'Currently worn attire and visibly carried gear — clothing, accessories, tools, and held items explicitly shown in the scene.',
    icon: '🎽',
    color: '#f59e0b',
    fieldType: 'prose',
    writableByTracker: true,
    confirmPolicy: 'auto',
    cadence: 'every_turn',
  },
  {
    id: 'sec_personality',
    name: 'Personality',
    description:
      'Stable temperament, values, and interpersonal drives — not momentary mood or passing stress.',
    icon: '🧠',
    color: '#8b5cf6',
    fieldType: 'prose',
    writableByTracker: true,
    confirmPolicy: 'auto',
    cadence: 'every_turn',
  },
  {
    id: 'sec_background',
    name: 'Brief Background',
    description:
      'Standing role, origin, and formative history rather than their immediate part in the current scene.',
    icon: '📜',
    color: '#3b82f6',
    fieldType: 'prose',
    writableByTracker: true,
    confirmPolicy: 'auto',
    cadence: 'every_turn',
  },
  {
    id: 'sec_habits',
    name: 'Habits & Behaviors',
    description:
      'Recurring mannerisms, daily routines, speech tics, and recognizable behavioral patterns.',
    icon: '🔄',
    color: '#10b981',
    fieldType: 'prose',
    writableByTracker: true,
    confirmPolicy: 'auto',
    cadence: 'every_turn',
  },
  {
    id: 'sec_strengths',
    name: 'Strengths',
    description:
      'Concise bullet phrases capturing notable skills, talents, and personal virtues. Specific and grounded in observed scenes.',
    icon: '⚡',
    color: '#22c55e',
    fieldType: 'bullet_list',
    writableByTracker: true,
    confirmPolicy: 'auto',
    cadence: 'every_turn',
  },
  {
    id: 'sec_flaws',
    name: 'Flaws',
    description:
      'Concise bullet phrases capturing notable blind spots, bad habits, and character flaws. Specific and honest without artificial symmetry.',
    icon: '⚠️',
    color: '#ef4444',
    fieldType: 'bullet_list',
    writableByTracker: true,
    confirmPolicy: 'auto',
    cadence: 'every_turn',
  },
]);

/**
 * Default modular character sheet sections for the player character (PC).
 */
export const DEFAULT_PC_SECTIONS: CharacterSectionDef[] = deepFreeze([
  {
    id: 'sec_species',
    name: 'Species',
    description:
      'Species, ethnicity, and gender grounded in the character card and player profile; weave into natural prose.',
    icon: '🧬',
    color: '#0ea5e9',
    fieldType: 'prose',
    writableByTracker: false,
    confirmPolicy: 'locked',
    cadence: 'manual_only',
  },
  {
    id: 'sec_body',
    name: 'Body',
    description:
      'Physical features: build, height, hair, eyes, skin tone, distinguishing marks, and posture. Exclude worn clothing and carried gear.',
    icon: '👁️',
    color: '#d4a940',
    fieldType: 'prose',
    writableByTracker: true,
    confirmPolicy: 'batch_confirm',
    cadence: 'every_turn',
  },
  {
    id: 'sec_equipment',
    name: 'Worn Equipment',
    description:
      'Currently worn attire and visibly carried gear — clothing, accessories, tools, and held items as they change during play.',
    icon: '🎽',
    color: '#f59e0b',
    fieldType: 'prose',
    writableByTracker: true,
    confirmPolicy: 'auto',
    cadence: 'every_turn',
  },
  {
    id: 'sec_personality',
    name: 'Personality',
    description:
      'Core temperament, social demeanor, and emotional tendencies grounded in the character profile.',
    icon: '🧠',
    color: '#8b5cf6',
    fieldType: 'prose',
    writableByTracker: true,
    confirmPolicy: 'batch_confirm',
    cadence: 'every_turn',
  },
  {
    id: 'sec_background',
    name: 'Background',
    description:
      'Backstory context grounded in the character card and established history. Frozen unless explicitly revised.',
    icon: '📜',
    color: '#3b82f6',
    fieldType: 'prose',
    writableByTracker: false,
    confirmPolicy: 'locked',
    cadence: 'manual_only',
  },
  {
    id: 'sec_habits',
    name: 'Habits & Behaviors',
    description: 'Recurring mannerisms, habits, quirks, and behavioral patterns shown in play.',
    icon: '🔄',
    color: '#10b981',
    fieldType: 'prose',
    writableByTracker: true,
    confirmPolicy: 'batch_confirm',
    cadence: 'every_turn',
  },
  {
    id: 'sec_strengths',
    name: 'Strengths',
    description:
      'Concise bullet phrases capturing notable strengths, aptitudes, and virtues demonstrated by the character.',
    icon: '⚡',
    color: '#22c55e',
    fieldType: 'bullet_list',
    writableByTracker: true,
    confirmPolicy: 'batch_confirm',
    cadence: 'every_turn',
  },
  {
    id: 'sec_flaws',
    name: 'Flaws',
    description:
      'Concise bullet phrases capturing notable weaknesses, bad habits, and character flaws demonstrated by the character.',
    icon: '⚠️',
    color: '#ef4444',
    fieldType: 'bullet_list',
    writableByTracker: true,
    confirmPolicy: 'batch_confirm',
    cadence: 'every_turn',
  },
]);

/**
 * Optional combat stat-block section enabled by tactical/combat system packs.
 */
export const OPTIONAL_COMBAT_PROFILE_SECTION: CharacterSectionDef = deepFreeze({
  id: 'sec_combat_profile',
  name: 'Combat Profile',
  description:
    'Hidden until set — full combatant stat block covering defensive ratings, vitality pools, saves, weapons, tactical abilities, and spells.',
  icon: '🤺',
  color: '#38bdf8',
  fieldType: 'stat_block',
  hiddenUntilSet: true,
  writableByTracker: true,
  confirmPolicy: 'batch_confirm',
  cadence: 'every_turn',
});

/**
 * Optional intimate preferences and boundaries section.
 */
export const OPTIONAL_DESIRES_SECTION: CharacterSectionDef = deepFreeze({
  id: 'sec_desires',
  name: 'Desires',
  description:
    'Optional personal preferences and boundaries: likes, dislikes, sensitivities, and firm limits. Leave omitted unless explicitly established in play.',
  icon: '💗',
  color: '#c96b8e',
  fieldType: 'prose',
  hiddenUntilSet: true,
  writableByTracker: true,
  confirmPolicy: 'batch_confirm',
  cadence: 'every_turn',
});

/**
 * Optional cybernetic augmentation bullet-list section.
 */
export const OPTIONAL_CYBERWARE_SECTION: CharacterSectionDef = deepFreeze({
  id: 'sec_cyberware',
  name: 'Cyberware',
  description:
    'Installed cybernetic implants, neural links, and hardware augmentations with visible trade-offs.',
  icon: '🦾',
  color: '#06b6d4',
  fieldType: 'bullet_list',
  hiddenUntilSet: true,
  writableByTracker: true,
  confirmPolicy: 'batch_confirm',
  cadence: 'every_turn',
});

/**
 * Optional superpower and dual-identity dossier section.
 */
export const OPTIONAL_SUPERPOWERS_SECTION: CharacterSectionDef = deepFreeze({
  id: 'sec_superpowers',
  name: 'Superpowers',
  description:
    'Metahuman powers, signature techniques, power limits, and active civilian or costumed persona notes.',
  icon: '🦸',
  color: '#6366f1',
  fieldType: 'prose',
  hiddenUntilSet: true,
  writableByTracker: true,
  confirmPolicy: 'batch_confirm',
  cadence: 'every_turn',
});

/**
 * Deep-clone a single {@link CharacterSectionDef}.
 */
export function cloneCharacterSection(section: CharacterSectionDef): CharacterSectionDef {
  return {
    ...section,
    cadence: cloneCadencePolicy(section.cadence),
  };
}

/**
 * Deep-clone a list of {@link CharacterSectionDef} descriptors.
 */
export function cloneCharacterSections(
  sections: readonly CharacterSectionDef[]
): CharacterSectionDef[] {
  return sections.map(cloneCharacterSection);
}

/**
 * Built-in character sheet presets selectable by System Packs or users.
 */
export const SHEET_PRESETS: Record<SheetPresetId, SheetPreset> = deepFreeze({
  'realistic-modern': {
    id: 'realistic-modern',
    name: 'Realistic Modern Persona',
    description:
      'Grounded contemporary character dossier focusing on appearance, attire, personality, habits, strengths, and flaws.',
    pcCoreSections: cloneCharacterSections(DEFAULT_PC_SECTIONS),
    npcCoreSections: cloneCharacterSections(DEFAULT_NPC_SECTIONS),
  },
  'dnd-adventurer': {
    id: 'dnd-adventurer',
    name: 'D&D Adventurer Sheet',
    description:
      'Classic fantasy adventurer sheet adding an expandable Combat Profile stat block alongside core narrative sections.',
    pcCoreSections: [
      ...cloneCharacterSections(DEFAULT_PC_SECTIONS),
      cloneCharacterSection(OPTIONAL_COMBAT_PROFILE_SECTION),
    ],
    npcCoreSections: [
      ...cloneCharacterSections(DEFAULT_NPC_SECTIONS),
      cloneCharacterSection(OPTIONAL_COMBAT_PROFILE_SECTION),
    ],
  },
  'superhero-dossier': {
    id: 'superhero-dossier',
    name: 'Superhero Dossier',
    description:
      'Living-world vigilante and metahuman dossier featuring Superpowers and Combat Profile sections.',
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
  },
  'intimate-profile': {
    id: 'intimate-profile',
    name: 'Intimate Profile',
    description:
      'Relationship-focused character sheet adding an optional, hidden-until-set Desires and boundaries section.',
    pcCoreSections: [
      ...cloneCharacterSections(DEFAULT_PC_SECTIONS),
      cloneCharacterSection(OPTIONAL_DESIRES_SECTION),
    ],
    npcCoreSections: [
      ...cloneCharacterSections(DEFAULT_NPC_SECTIONS),
      cloneCharacterSection(OPTIONAL_DESIRES_SECTION),
    ],
  },
});

/**
 * Retrieve a deep-cloned {@link SheetPreset} by ID, or `undefined` if unknown.
 */
export function getSheetPreset(id: string): SheetPreset | undefined {
  if (!Object.hasOwn(SHEET_PRESETS, id)) {
    return undefined;
  }
  const preset = SHEET_PRESETS[id as SheetPresetId];
  return {
    ...preset,
    pcCoreSections: cloneCharacterSections(preset.pcCoreSections),
    npcCoreSections: cloneCharacterSections(preset.npcCoreSections),
  };
}

/**
 * Validate a single {@link CharacterSectionDef}.
 */
export function validateCharacterSectionDef(
  section: CharacterSectionDef,
  path = 'section'
): Result<CharacterSectionDef, ValidationError[]> {
  const acc = new ErrorAccumulator(path);

  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    acc.add('', 'INVALID_TYPE', 'CharacterSectionDef must be a non-null object');
    return acc.toResult(section);
  }

  if (typeof section.id !== 'string' || section.id.trim().length === 0) {
    acc.add('id', 'REQUIRED', 'CharacterSectionDef id must be a non-empty string');
  }
  if (typeof section.name !== 'string' || section.name.trim().length === 0) {
    acc.add('name', 'REQUIRED', 'CharacterSectionDef name must be a non-empty string');
  }
  if (typeof section.description !== 'string') {
    acc.add('description', 'INVALID_TYPE', 'CharacterSectionDef description must be a string');
  }
  if (typeof section.icon !== 'string') {
    acc.add('icon', 'INVALID_TYPE', 'CharacterSectionDef icon must be a string');
  }
  if (typeof section.color !== 'string' || section.color.trim().length === 0) {
    acc.add('color', 'REQUIRED', 'CharacterSectionDef color must be a non-empty string');
  }
  if (!VALID_FIELD_TYPES.has(section.fieldType)) {
    acc.add(
      'fieldType',
      'INVALID_FIELD_TYPE',
      `Invalid fieldType "${String(section.fieldType)}"`
    );
  }
  if (typeof section.writableByTracker !== 'boolean') {
    acc.add('writableByTracker', 'INVALID_TYPE', 'writableByTracker must be a boolean');
  }
  if (section.confirmPolicy !== undefined) {
    acc.absorb(validateConfirmPolicy(section.confirmPolicy, 'confirmPolicy'));
  }
  acc.absorb(validateCadencePolicy(section.cadence, 'cadence'));

  return acc.toResult(section);
}

/**
 * Validate an ordered list of {@link CharacterSectionDef} items, including duplicate ID detection.
 */
export function validateCharacterSectionList(
  sections: readonly CharacterSectionDef[],
  path = 'sections'
): Result<readonly CharacterSectionDef[], ValidationError[]> {
  const acc = new ErrorAccumulator(path);
  if (!Array.isArray(sections)) {
    acc.add('', 'INVALID_TYPE', 'Character sections must be an array');
    return acc.toResult(sections);
  }

  const seenIds = new Set<string>();
  for (let i = 0; i < sections.length; i += 1) {
    const section = sections[i];
    if (section === undefined) {
      continue;
    }
    acc.absorb(validateCharacterSectionDef(section, `[${i}]`));
    if (typeof section.id === 'string' && section.id.trim().length > 0) {
      if (seenIds.has(section.id)) {
        acc.add(`[${i}].id`, 'DUPLICATE_SECTION_ID', `Duplicate section id "${section.id}"`);
      } else {
        seenIds.add(section.id);
      }
    }
  }

  return acc.toResult(sections);
}

export type { Result };
export { ok };
