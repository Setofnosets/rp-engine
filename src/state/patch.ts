import type { CharacterEntity, ChronicleEntry } from './world-state.js';

/**
 * Valid origins of a state mutation batch in Referee.
 */
export const PATCH_SOURCES = Object.freeze([
  'engine',
  'player',
  'user_director',
  'tracker',
  'script',
  'combat',
  'agenda',
  'beat',
] as const);

/**
 * Origin / authority that emitted a {@link PatchBatch}.
 */
export type PatchSource = (typeof PATCH_SOURCES)[number];

/**
 * Valid entity collection keys on `WorldState.entities`.
 */
export type EntityCollectionName = 'characters' | 'factions' | 'threats' | 'locations';

/**
 * Atomic patch operation discriminated union applied by {@link applyPatchBatch}.
 */
export type PatchOperation =
  | { op: 'set'; path: string; value: unknown }
  | { op: 'increment'; path: string; delta: number }
  | { op: 'clamp'; path: string; min: number; max: number }
  | { op: 'push'; path: string; value: unknown }
  | { op: 'remove'; path: string; value: unknown }
  | {
      op: 'section_patch';
      target: 'player' | { characterId: string };
      sectionId: string;
      value: string | string[];
    }
  | {
      op: 'custom_field_patch';
      target: 'global' | 'player' | { characterId: string };
      fieldId: string;
      value: unknown;
    }
  | {
      op: 'entity_patch';
      collection: EntityCollectionName;
      entityId: string;
      patch: Record<string, unknown>;
    }
  | { op: 'form_transform'; characterId: string; targetFormId: string }
  | { op: 'emergent_location_visit'; locationName: string }
  | {
      op: 'chronicle_append';
      entry: Omit<ChronicleEntry, 'id' | 'turn' | 'day' | 'date'> & { id?: string };
    }
  | {
      op: 'clock_advance';
      mechanicalTurns?: number;
      storySlots?: number;
      forceIgnoreHold?: boolean;
    }
  | { op: 'clock_hold'; reason: string }
  | { op: 'clock_release' }
  | { op: 'route_lock'; routeId: string; lockFlag: string }
  | {
      op: 'character_upsert';
      characterId: string;
      character: Partial<Omit<CharacterEntity, 'id'>> & { name: string };
      mergeIfExists?: boolean;
    };

/**
 * Ordered batch of {@link PatchOperation} items applied atomically as a single event.
 */
export interface PatchBatch {
  eventId: string;
  source: PatchSource;
  operations: readonly PatchOperation[];
  reason?: string;
}
