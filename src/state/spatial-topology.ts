import { type ValidationError, validationError } from '../core/errors.js';
import { type Result, err, ok } from '../core/result.js';
import type { SpatialMode } from '../schema/tracker-module.js';

/**
 * Known operational statuses for a {@link LocationEntity}, extensible via string values.
 */
export type LocationStatus = 'normal' | 'contested' | 'destroyed' | 'locked' | (string & {});

/**
 * Spatial node in the WorldState location graph (used by Tier 1 emergent and Tier 2 authored modes).
 */
export interface LocationEntity {
  id: string;
  name: string;
  kind: string;
  status: LocationStatus;
  controllingFactionId: string | null;
  connectedLocations: string[];
  discovered: boolean;
  tags: string[];
  notes: string;
}

/**
 * Output returned by {@link registerOrResolveEmergentLocation}.
 */
export interface EmergentLocationResolution {
  nextLocations: Record<string, LocationEntity>;
  locationId: string;
  created: boolean;
}

/**
 * Validated travel destination resolved by {@link validateTravelTarget}.
 */
export interface TravelTargetResolution {
  targetId: string | null;
  targetName: string;
}

const FNV1A_OFFSET_BASIS = 0x811c9dc5;
const FNV1A_PRIME = 0x01000193;

function fnv1a32(input: string): number {
  let hash = FNV1A_OFFSET_BASIS;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    hash = Math.imul(hash ^ (code & 0xff), FNV1A_PRIME) >>> 0;
    hash = Math.imul(hash ^ ((code >>> 8) & 0xff), FNV1A_PRIME) >>> 0;
  }
  return hash >>> 0;
}

function setRecordEntry<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function cloneLocationEntity(location: LocationEntity): LocationEntity {
  return {
    id: location.id,
    name: location.name,
    kind: location.kind,
    status: location.status,
    controllingFactionId: location.controllingFactionId,
    connectedLocations: [...location.connectedLocations],
    discovered: location.discovered,
    tags: [...location.tags],
    notes: location.notes,
  };
}

function cloneLocationsRecord(
  locations: Record<string, LocationEntity>
): Record<string, LocationEntity> {
  const cloned: Record<string, LocationEntity> = {};
  for (const [id, location] of Object.entries(locations)) {
    setRecordEntry(cloned, id, cloneLocationEntity(location));
  }
  return cloned;
}

function findMatchingLocation(
  locations: Record<string, LocationEntity>,
  idOrName: string,
  allowSlugFallback: boolean
): LocationEntity | undefined {
  const trimmed = idOrName.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  if (Object.hasOwn(locations, trimmed)) {
    return locations[trimmed];
  }

  const normalizedName = trimmed.toLowerCase();
  const sortedKeys = Object.keys(locations).sort();
  for (const key of sortedKeys) {
    const candidate = locations[key];
    if (candidate && candidate.name.trim().toLowerCase() === normalizedName) {
      return candidate;
    }
  }

  if (allowSlugFallback) {
    const slug = slugifyLocationName(trimmed);
    if (Object.hasOwn(locations, slug)) {
      return locations[slug];
    }
  }

  return undefined;
}

function addBidirectionalConnection(
  locations: Record<string, LocationEntity>,
  locationAId: string,
  locationBId: string
): void {
  if (locationAId === locationBId) {
    return;
  }
  if (!Object.hasOwn(locations, locationAId) || !Object.hasOwn(locations, locationBId)) {
    return;
  }
  const locA = locations[locationAId];
  const locB = locations[locationBId];
  if (!locA || !locB) {
    return;
  }
  if (!locA.connectedLocations.includes(locationBId)) {
    locA.connectedLocations.push(locationBId);
  }
  if (!locB.connectedLocations.includes(locationAId)) {
    locB.connectedLocations.push(locationAId);
  }
}

function normalizeMatchText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function tokenizeNormalized(value: string): string[] {
  return value.split(/[^a-z0-9]+/).filter((token) => token.length > 0);
}

/**
 * Convert a human-readable location name into a deterministic kebab-case slug ID.
 * Falls back to a deterministic FNV-1a hash slug for non-Latin names and `'location'` for blanks.
 */
export function slugifyLocationName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return 'location';
  }

  const ascii = trimmed
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’`]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (ascii.length > 0) {
    return ascii;
  }

  return `loc-${fnv1a32(trimmed).toString(16).padStart(8, '0')}`;
}

/**
 * Resolve an existing location or create a newly discovered Tier 1 emergent node,
 * automatically linking a bidirectional edge to `previousLocationId` when present.
 * Never mutates the input `locations` map or its entities.
 */
export function registerOrResolveEmergentLocation(
  locations: Record<string, LocationEntity>,
  locationName: string,
  previousLocationId: string | null
): EmergentLocationResolution {
  const nextLocations = cloneLocationsRecord(locations);
  const cleanName = locationName.trim() || 'Unknown Location';

  const existing = findMatchingLocation(nextLocations, cleanName, true);
  if (existing) {
    if (previousLocationId !== null) {
      addBidirectionalConnection(nextLocations, existing.id, previousLocationId);
    }
    return {
      nextLocations,
      locationId: existing.id,
      created: false,
    };
  }

  const locationId = slugifyLocationName(cleanName);
  const newNode: LocationEntity = {
    id: locationId,
    name: cleanName,
    kind: 'emergent',
    status: 'normal',
    controllingFactionId: null,
    connectedLocations: [],
    discovered: true,
    tags: [],
    notes: '',
  };

  setRecordEntry(nextLocations, locationId, newNode);
  if (previousLocationId !== null) {
    addBidirectionalConnection(nextLocations, locationId, previousLocationId);
  }

  return {
    nextLocations,
    locationId,
    created: true,
  };
}

/**
 * Validate whether `targetLocationIdOrName` is a valid travel destination under the active
 * 3-tier {@link SpatialMode}:
 * - Tier 0 (`scene_only`): always succeeds using `targetName` (`targetId: null`).
 * - Tier 1 (`emergent`): resolves existing locations or allows unregistered new names.
 * - Tier 2 (`authored_graph`): enforces target existence in `locations` and adjacency from `fromLocationId` when set.
 */
export function validateTravelTarget(
  spatialMode: SpatialMode,
  locations: Record<string, LocationEntity>,
  fromLocationId: string | null,
  targetLocationIdOrName: string
): Result<TravelTargetResolution, ValidationError[]> {
  if (typeof targetLocationIdOrName !== 'string' || targetLocationIdOrName.trim().length === 0) {
    return err([
      validationError(
        'target',
        'EMPTY_TRAVEL_TARGET',
        'Travel target must be a non-empty location ID or name'
      ),
    ]);
  }

  const trimmed = targetLocationIdOrName.trim();

  switch (spatialMode) {
    case 'scene_only':
      return ok({
        targetId: null,
        targetName: trimmed,
      });

    case 'emergent': {
      const existing = findMatchingLocation(locations, trimmed, true);
      if (existing) {
        return ok({
          targetId: existing.id,
          targetName: existing.name,
        });
      }
      return ok({
        targetId: null,
        targetName: trimmed,
      });
    }

    case 'authored_graph': {
      const target = findMatchingLocation(locations, trimmed, false);
      if (!target) {
        return err([
          validationError(
            'target',
            'UNKNOWN_LOCATION',
            `Location "${trimmed}" does not exist in authored locations`
          ),
        ]);
      }

      if (fromLocationId !== null) {
        if (!Object.hasOwn(locations, fromLocationId)) {
          return err([
            validationError(
              'fromLocationId',
              'UNKNOWN_ORIGIN_LOCATION',
              `Origin location "${fromLocationId}" does not exist in authored locations`
            ),
          ]);
        }
        const origin = locations[fromLocationId];
        if (
          origin &&
          target.id !== fromLocationId &&
          !origin.connectedLocations.includes(target.id)
        ) {
          return err([
            validationError(
              'target',
              'UNREACHABLE_LOCATION',
              `Location "${target.id}" is not connected to "${fromLocationId}"`
            ),
          ]);
        }
      }

      return ok({
        targetId: target.id,
        targetName: target.name,
      });
    }

    default: {
      const exhaustive: never = spatialMode;
      return err([
        validationError(
          'spatialMode',
          'INVALID_SPATIAL_MODE',
          `Unsupported spatialMode "${String(exhaustive)}"`
        ),
      ]);
    }
  }
}

/**
 * Evaluate whether the current scene matches a location predicate under the active {@link SpatialMode}.
 * - Tier 0 (`scene_only`): normalized case-insensitive substring or full-token match on `scene.location`.
 * - Tier 1/2 (`emergent` | `authored_graph`): matches `scene.locationId` or tags on the resolved {@link LocationEntity}.
 */
export function matchesLocationPredicate(
  spatialMode: SpatialMode,
  scene: { location: string; locationId: string | null },
  locations: Record<string, LocationEntity>,
  target: string
): boolean {
  const trimmedTarget = target.trim();
  if (trimmedTarget.length === 0) {
    return false;
  }

  if (spatialMode === 'scene_only') {
    const normalizedTarget = normalizeMatchText(trimmedTarget);
    const normalizedScene = normalizeMatchText(scene.location);
    if (normalizedScene.length === 0 || normalizedTarget.length === 0) {
      return false;
    }
    if (normalizedScene.includes(normalizedTarget)) {
      return true;
    }
    const targetTokens = tokenizeNormalized(normalizedTarget);
    if (targetTokens.length === 0) {
      return false;
    }
    const sceneTokens = new Set(tokenizeNormalized(normalizedScene));
    return targetTokens.every((token) => sceneTokens.has(token));
  }

  if (scene.locationId === null || scene.locationId.length === 0) {
    return false;
  }

  const targetLower = trimmedTarget.toLowerCase();
  if (scene.locationId.trim().toLowerCase() === targetLower) {
    return true;
  }

  const location = Object.hasOwn(locations, scene.locationId)
    ? locations[scene.locationId]
    : undefined;
  if (!location) {
    return false;
  }

  return location.tags.some((tag) => tag.trim().toLowerCase() === targetLower);
}
