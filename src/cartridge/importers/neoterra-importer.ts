import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { BeatDefinition, BeatEffect, BeatFlexibility } from '../../beats/beat-ledger.js';
import type { ComparisonOp, PredicateAst } from '../../beats/predicate-ast.js';
import type { BeatRoleSpec } from '../../beats/role-binder.js';
import type {
  EndingBranchOption,
  EndingDefinition,
  RouteDefinition,
} from '../../beats/routes-and-endings.js';
import { type ValidationError, validationError } from '../../core/errors.js';
import { ErrorAccumulator, type Result, err, ok } from '../../core/result.js';
import { parseIsoDate } from '../../core/world-clock.js';
import type { FormDefinition } from '../../state/forms.js';
import type { LocationEntity } from '../../state/spatial-topology.js';
import {
  CHARACTER_STATUSES,
  FACTION_SIDES,
  FACTION_STATUSES,
  THREAT_RANKS,
  type CharacterEntity,
  type CharacterStatus,
  type FactionEntity,
  type FactionSide,
  type FactionStatus,
  type ThreatEntity,
  type ThreatRank,
} from '../../state/world-state.js';
import { type AgendaConfig, DEFAULT_AGENDA_CONFIG } from '../../world/agendas.js';
import {
  type CartridgeBundle,
  getSafeProperty,
  isPlainObject,
  isUnsafeRecordKey,
  scanObjectForUnsafeKeys,
  setSafeProperty,
  validateCartridgeStructure,
} from '../cartridge-schema.js';

export interface NeoTerraImportData {
  season: unknown;
  factions?: unknown;
  locations?: unknown;
  agendas?: unknown;
  characters?: unknown;
  formGroups?: unknown;
}

const VALID_CHAR_STATUSES = new Set<string>(CHARACTER_STATUSES);
const VALID_FACTION_SIDES = new Set<string>(FACTION_SIDES);
const VALID_FACTION_STATUSES = new Set<string>(FACTION_STATUSES);
const VALID_THREAT_RANKS = new Set<string>(THREAT_RANKS);

function sanitizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeJsonValue);
  }
  if (value !== null && typeof value === 'object' && isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(value)) {
      if (isUnsafeRecordKey(key)) {
        continue;
      }
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (desc !== undefined) {
        setSafeProperty(out, key, sanitizeJsonValue(desc.value));
      }
    }
    return out;
  }
  return value;
}

function getOwnValue(obj: Record<string, unknown>, key: string): unknown {
  if (isUnsafeRecordKey(key) || !Object.hasOwn(obj, key)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(obj, key)?.value;
}

function getOwnString(obj: Record<string, unknown>, key: string): string | undefined {
  const val = getOwnValue(obj, key);
  return typeof val === 'string' ? val : undefined;
}

function getOwnNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const val = getOwnValue(obj, key);
  return typeof val === 'number' && Number.isFinite(val) ? val : undefined;
}

function getOwnBoolean(obj: Record<string, unknown>, key: string): boolean | undefined {
  const val = getOwnValue(obj, key);
  return typeof val === 'boolean' ? val : undefined;
}

function getStringArray(obj: Record<string, unknown>, key: string): string[] {
  const val = getOwnValue(obj, key);
  if (!Array.isArray(val)) {
    return [];
  }
  return val.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function sanitizeIdentifier(raw: string, fallback: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || isUnsafeRecordKey(trimmed)) {
    return fallback;
  }
  return trimmed;
}

function sanitizeFlagName(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (cleaned.length === 0 || isUnsafeRecordKey(cleaned)) {
    return 'flag_value';
  }
  return cleaned;
}

function stripCharsPrefix(filePath: string): string {
  return filePath.replace(/^Chars[\\/]/i, '').replace(/\\/g, '/');
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

async function readJsonFile(
  filePath: string,
  required: boolean,
  acc: ErrorAccumulator,
  fieldPath: string
): Promise<unknown> {
  let rawText: string;
  try {
    rawText = await readFile(filePath, 'utf8');
  } catch (error) {
    if (!required && isEnoent(error)) {
      return undefined;
    }
    const message = error instanceof Error ? error.message : 'Unable to read file';
    acc.add(fieldPath, 'FILE_READ_ERROR', `Failed to read "${filePath}": ${message}`);
    return undefined;
  }

  try {
    const parsed = JSON.parse(rawText) as unknown;
    scanObjectForUnsafeKeys(parsed, acc.scope(fieldPath));
    return sanitizeJsonValue(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Malformed JSON';
    acc.add(fieldPath, 'INVALID_JSON', `Failed to parse "${filePath}": ${message}`);
    return undefined;
  }
}

function buildFactions(
  rawFactionsData: unknown,
  rawSeasonFactions: unknown
): Record<string, FactionEntity> {
  const factions: Record<string, FactionEntity> = {};

  const list = Array.isArray(rawFactionsData)
    ? rawFactionsData
    : isPlainObject(rawFactionsData) && Array.isArray(getOwnValue(rawFactionsData, 'factions'))
      ? (getOwnValue(rawFactionsData, 'factions') as unknown[])
      : [];

  for (const item of list) {
    if (!isPlainObject(item)) {
      continue;
    }
    const id = getOwnString(item, 'id')?.trim();
    if (!id || isUnsafeRecordKey(id)) {
      continue;
    }
    const rawSide = getOwnString(item, 'side') ?? 'neutral';
    const side: FactionSide = VALID_FACTION_SIDES.has(rawSide) ? (rawSide as FactionSide) : 'neutral';
    const rawStatus = getOwnString(item, 'status') ?? 'active';
    const status: FactionStatus = VALID_FACTION_STATUSES.has(rawStatus)
      ? (rawStatus as FactionStatus)
      : 'active';
    const influence = Math.min(100, Math.max(0, getOwnNumber(item, 'influence') ?? 50));
    const hq = getOwnString(item, 'headquartersLocationId')?.trim() ?? null;
    setSafeProperty(factions, id, {
      id,
      name: getOwnString(item, 'name')?.trim() || id,
      side,
      status,
      influence,
      headquartersLocationId: hq && hq.length > 0 ? hq : null,
      goals: getStringArray(item, 'goals'),
    });
  }

  if (Array.isArray(rawSeasonFactions)) {
    for (const item of rawSeasonFactions) {
      if (!isPlainObject(item)) {
        continue;
      }
      const id = getOwnString(item, 'id')?.trim();
      if (!id || isUnsafeRecordKey(id)) {
        continue;
      }
      const existing = Object.hasOwn(factions, id)
        ? (Object.getOwnPropertyDescriptor(factions, id)?.value as FactionEntity | undefined)
        : undefined;

      const rawSide = getOwnString(item, 'side');
      const side: FactionSide =
        rawSide && VALID_FACTION_SIDES.has(rawSide)
          ? (rawSide as FactionSide)
          : existing?.side ?? 'neutral';
      const rawStatus = getOwnString(item, 'status');
      const status: FactionStatus =
        rawStatus && VALID_FACTION_STATUSES.has(rawStatus)
          ? (rawStatus as FactionStatus)
          : existing?.status ?? 'active';
      const rawInf = getOwnNumber(item, 'influence');
      const influence = Math.min(100, Math.max(0, rawInf ?? existing?.influence ?? 50));
      const goals = getStringArray(item, 'goals');

      setSafeProperty(factions, id, {
        id,
        name: getOwnString(item, 'name')?.trim() || existing?.name || id,
        side,
        status,
        influence,
        headquartersLocationId:
          getOwnString(item, 'headquartersLocationId')?.trim() ??
          existing?.headquartersLocationId ??
          null,
        goals: goals.length > 0 ? goals : existing?.goals ?? [],
      });
    }
  }

  return factions;
}

function buildLocations(
  rawLocationsData: unknown,
  factions: Readonly<Record<string, FactionEntity>>
): Record<string, LocationEntity> {
  const locations: Record<string, LocationEntity> = {};
  const list = Array.isArray(rawLocationsData)
    ? rawLocationsData
    : isPlainObject(rawLocationsData) && Array.isArray(getOwnValue(rawLocationsData, 'locations'))
      ? (getOwnValue(rawLocationsData, 'locations') as unknown[])
      : [];

  const validLocIds = new Set<string>();
  for (const item of list) {
    if (isPlainObject(item)) {
      const id = getOwnString(item, 'id')?.trim();
      if (id && !isUnsafeRecordKey(id)) {
        validLocIds.add(id);
      }
    }
  }

  for (const item of list) {
    if (!isPlainObject(item)) {
      continue;
    }
    const id = getOwnString(item, 'id')?.trim();
    if (!id || isUnsafeRecordKey(id)) {
      continue;
    }

    const rawFactionId = getOwnString(item, 'factionId')?.trim() ?? null;
    const controllingFactionId =
      rawFactionId && Object.hasOwn(factions, rawFactionId) ? rawFactionId : null;

    const rawConnections = getStringArray(item, 'connections').filter(
      (connId) => connId !== id && validLocIds.has(connId)
    );
    const dedupConnections = Array.from(new Set(rawConnections));

    const tags = getStringArray(item, 'tags');
    const district = getOwnString(item, 'district')?.trim();
    if (district && !tags.includes(district)) {
      tags.push(district);
    }

    const isVirtual = getOwnBoolean(item, 'virtual') === true;

    setSafeProperty(locations, id, {
      id,
      name: getOwnString(item, 'name')?.trim() || id,
      kind: getOwnString(item, 'kind')?.trim() || 'district',
      status: getOwnString(item, 'defaultStatus')?.trim() || 'normal',
      controllingFactionId,
      connectedLocations: dedupConnections,
      discovered: !isVirtual,
      tags,
      notes: getOwnString(item, 'description')?.trim() || '',
    });
  }

  // Ensure faction HQ references exist in locations
  for (const facId of Object.keys(factions)) {
    const fac = Object.getOwnPropertyDescriptor(factions, facId)?.value as FactionEntity | undefined;
    if (fac && fac.headquartersLocationId !== null && !Object.hasOwn(locations, fac.headquartersLocationId)) {
      fac.headquartersLocationId = null;
    }
  }

  return locations;
}

function buildThreats(
  rawSeasonThreats: unknown,
  locations: Readonly<Record<string, LocationEntity>>,
  factions: Readonly<Record<string, FactionEntity>>
): Record<string, ThreatEntity> {
  const threats: Record<string, ThreatEntity> = {};
  if (!Array.isArray(rawSeasonThreats)) {
    return threats;
  }

  for (const item of rawSeasonThreats) {
    if (!isPlainObject(item)) {
      continue;
    }
    const id = getOwnString(item, 'id')?.trim();
    if (!id || isUnsafeRecordKey(id)) {
      continue;
    }
    const rawRank = getOwnString(item, 'rank') ?? 'main';
    const rank: ThreatRank = VALID_THREAT_RANKS.has(rawRank) ? (rawRank as ThreatRank) : 'main';
    const progress = Math.min(100, Math.max(0, getOwnNumber(item, 'progress') ?? 0));
    const stages = getStringArray(item, 'stages');
    const rawStage = getOwnNumber(item, 'stage');
    const computedStage =
      rawStage !== undefined && Number.isInteger(rawStage) && rawStage >= 0
        ? rawStage
        : stages.length > 0
          ? Math.min(stages.length - 1, Math.floor((progress / 100) * stages.length))
          : Math.floor(progress / 25);

    const rawLocId = getOwnString(item, 'locationId')?.trim() ?? null;
    const locationId = rawLocId && Object.hasOwn(locations, rawLocId) ? rawLocId : null;
    const rawFacId = getOwnString(item, 'sourceFactionId')?.trim() ?? null;
    const sourceFactionId = rawFacId && Object.hasOwn(factions, rawFacId) ? rawFacId : null;

    setSafeProperty(threats, id, {
      id,
      name: getOwnString(item, 'name')?.trim() || id,
      rank,
      status: 'active',
      stage: computedStage,
      progress,
      locationId,
      sourceFactionId,
      agenda: getOwnString(item, 'agenda')?.trim() || '',
    });
  }

  return threats;
}

interface ParsedCharacterData {
  entriesById: Map<string, Record<string, unknown>>;
  entryIdByCardPath: Map<string, string>;
  profilesById: Map<string, Record<string, unknown>>;
}

function parseCharactersPayload(rawCharacters: unknown): ParsedCharacterData {
  const entriesById = new Map<string, Record<string, unknown>>();
  const entryIdByCardPath = new Map<string, string>();
  const profilesById = new Map<string, Record<string, unknown>>();

  const registerEntry = (entry: Record<string, unknown>): void => {
    const id = getOwnString(entry, 'id')?.trim();
    if (!id || isUnsafeRecordKey(id)) {
      return;
    }
    entriesById.set(id, entry);
    const cardPath = getOwnString(entry, 'cardPath') ?? getOwnString(entry, 'file');
    if (cardPath) {
      entryIdByCardPath.set(cardPath.replace(/\\/g, '/'), id);
      entryIdByCardPath.set(stripCharsPrefix(cardPath), id);
    }
  };

  const registerProfilesObj = (profilesObj: Record<string, unknown>): void => {
    for (const id of Object.keys(profilesObj)) {
      if (isUnsafeRecordKey(id)) {
        continue;
      }
      const val = getOwnValue(profilesObj, id);
      if (isPlainObject(val)) {
        profilesById.set(id, val);
      }
    }
  };

  if (Array.isArray(rawCharacters)) {
    for (const item of rawCharacters) {
      if (isPlainObject(item)) {
        registerEntry(item);
      }
    }
  } else if (isPlainObject(rawCharacters)) {
    const rawEntries = getOwnValue(rawCharacters, 'entries');
    if (Array.isArray(rawEntries)) {
      for (const item of rawEntries) {
        if (isPlainObject(item)) {
          registerEntry(item);
        }
      }
    }
    const rawProfiles = getOwnValue(rawCharacters, 'profiles');
    if (isPlainObject(rawProfiles)) {
      registerProfilesObj(rawProfiles);
    }
    const rawIndex = getOwnValue(rawCharacters, 'index');
    if (isPlainObject(rawIndex) && Array.isArray(getOwnValue(rawIndex, 'entries'))) {
      for (const item of getOwnValue(rawIndex, 'entries') as unknown[]) {
        if (isPlainObject(item)) {
          registerEntry(item);
        }
      }
    } else if (Array.isArray(rawIndex)) {
      for (const item of rawIndex) {
        if (isPlainObject(item)) {
          registerEntry(item);
        }
      }
    }
  }

  return { entriesById, entryIdByCardPath, profilesById };
}

function buildProfileSections(profile: Record<string, unknown> | undefined): Record<string, string | string[]> {
  const sections: Record<string, string | string[]> = {};
  if (!profile) {
    return sections;
  }
  const species = getOwnString(profile, 'species')?.trim();
  const gender = getOwnString(profile, 'gender')?.trim();
  if (species || gender) {
    setSafeProperty(sections, 'sec_species', [species, gender].filter(Boolean).join(' — '));
  }
  const appearance = getOwnString(profile, 'appearance')?.trim();
  if (appearance) {
    setSafeProperty(sections, 'sec_body', appearance);
  }
  const attire = getOwnString(profile, 'attire')?.trim();
  if (attire) {
    setSafeProperty(sections, 'sec_equipment', attire);
  }
  const personality = getOwnString(profile, 'personality')?.trim();
  if (personality) {
    setSafeProperty(sections, 'sec_personality', personality);
  }
  const background = getOwnString(profile, 'background')?.trim();
  if (background) {
    setSafeProperty(sections, 'sec_background', background);
  }
  const abilities = getOwnString(profile, 'abilities')?.trim();
  if (abilities) {
    setSafeProperty(sections, 'sec_superpowers', abilities);
  }
  return sections;
}

function buildCharactersAndForms(
  season: Record<string, unknown>,
  seasonId: string,
  parsedChars: ParsedCharacterData,
  rawFormGroups: unknown,
  locations: Readonly<Record<string, LocationEntity>>,
  startLocationId: string | null
): { characters: Record<string, CharacterEntity>; forms: FormDefinition[] } {
  const characters: Record<string, CharacterEntity> = {};
  const forms: FormDefinition[] = [];
  const formById = new Map<string, FormDefinition>();

  const rosterRaw = getOwnValue(season, 'roster');
  const rosterEntries = Array.isArray(rosterRaw)
    ? rosterRaw.filter((r): r is Record<string, unknown> => isPlainObject(r))
    : [];

  // Collect all character IDs that must exist in initialEntities.characters
  const requiredCharIds = new Set<string>();
  const rosterLocByChar = new Map<string, string | null>();
  const rosterFormByChar = new Map<string, string | null>();

  for (const r of rosterEntries) {
    const cid = getOwnString(r, 'characterId')?.trim();
    if (!cid || isUnsafeRecordKey(cid)) {
      continue;
    }
    requiredCharIds.add(cid);
    const loc = getOwnString(r, 'locationId')?.trim() ?? null;
    rosterLocByChar.set(cid, loc && Object.hasOwn(locations, loc) ? loc : null);
    const fid = getOwnString(r, 'formId')?.trim() ?? null;
    rosterFormByChar.set(cid, fid);
  }

  const defaultPcId = getOwnString(season, 'defaultPlayerCharacterId')?.trim();
  if (defaultPcId && !isUnsafeRecordKey(defaultPcId)) {
    requiredCharIds.add(defaultPcId);
  }

  // Also scan canonBeats for actorIds, character-status, form-active, and relationship-affinity
  const collectIdsFromBeats = (rawBeats: unknown): void => {
    if (!Array.isArray(rawBeats)) {
      return;
    }
    for (const b of rawBeats) {
      if (!isPlainObject(b)) {
        continue;
      }
      const conds = getOwnValue(b, 'conditions');
      if (isPlainObject(conds)) {
        for (const aid of getStringArray(conds, 'actorIds')) {
          if (!isUnsafeRecordKey(aid)) {
            requiredCharIds.add(aid);
          }
        }
      }
      const comp = getOwnValue(b, 'completion');
      if (isPlainObject(comp) && Array.isArray(getOwnValue(comp, 'predicates'))) {
        for (const p of getOwnValue(comp, 'predicates') as unknown[]) {
          if (!isPlainObject(p)) {
            continue;
          }
          const cid = getOwnString(p, 'characterId')?.trim();
          if (cid && !isUnsafeRecordKey(cid)) {
            requiredCharIds.add(cid);
          }
        }
      }
    }
  };
  collectIdsFromBeats(getOwnValue(season, 'canonBeats'));

  // Build forms from formGroups matching this season or any required character
  const groupList = Array.isArray(rawFormGroups)
    ? rawFormGroups
    : isPlainObject(rawFormGroups) && Array.isArray(getOwnValue(rawFormGroups, 'groups'))
      ? (getOwnValue(rawFormGroups, 'groups') as unknown[])
      : [];

  const baseCharForGroup = new Map<string, string>();
  const formsInGroup = new Map<string, string[]>();

  for (const g of groupList) {
    if (!isPlainObject(g)) {
      continue;
    }
    const groupId = getOwnString(g, 'id')?.trim();
    if (!groupId || isUnsafeRecordKey(groupId)) {
      continue;
    }
    const gSeason = getOwnString(g, 'seasonId')?.trim();
    const basePath = getOwnString(g, 'base')?.trim() ?? '';
    const baseEntryId =
      parsedChars.entryIdByCardPath.get(basePath) ??
      parsedChars.entryIdByCardPath.get(stripCharsPrefix(basePath));

    if (gSeason && gSeason !== seasonId && !(baseEntryId && requiredCharIds.has(baseEntryId))) {
      continue;
    }

    if (!baseEntryId || !requiredCharIds.has(baseEntryId)) {
      continue;
    }

    baseCharForGroup.set(groupId, baseEntryId);
    const memberPaths = getStringArray(g, 'members');
    const memberIds: string[] = [];

    for (const mPath of memberPaths) {
      const mId =
        parsedChars.entryIdByCardPath.get(mPath) ??
        parsedChars.entryIdByCardPath.get(stripCharsPrefix(mPath));
      if (mId && !isUnsafeRecordKey(mId) && !memberIds.includes(mId)) {
        memberIds.push(mId);
      }
    }
    if (!memberIds.includes(baseEntryId)) {
      memberIds.unshift(baseEntryId);
    }
    formsInGroup.set(groupId, memberIds);

    for (const formId of memberIds) {
      if (formById.has(formId)) {
        continue;
      }
      const entry = parsedChars.entriesById.get(formId);
      const profile = parsedChars.profilesById.get(formId);
      const displayName =
        (entry ? getOwnString(entry, 'displayName') ?? getOwnString(entry, 'dataName') : undefined) ??
        (profile ? getOwnString(profile, 'name') : undefined) ??
        formId;
      const formDef: FormDefinition = {
        id: formId,
        formGroup: groupId,
        characterId: baseEntryId,
        displayName,
        ...(profile && getOwnString(profile, 'personality')
          ? { description: getOwnString(profile, 'personality') }
          : {}),
        ...(profile ? { traits: getStringArray(profile, 'traits') } : {}),
        ...(profile ? { sections: buildProfileSections(profile) } : {}),
      };
      formById.set(formId, formDef);
      forms.push(formDef);
    }
  }

  // Ensure any form-active predicates in canonBeats also have valid FormDefinitions
  const rawCanonBeats = getOwnValue(season, 'canonBeats');
  if (Array.isArray(rawCanonBeats)) {
    for (const b of rawCanonBeats) {
      if (!isPlainObject(b)) continue;
      const comp = getOwnValue(b, 'completion');
      if (!isPlainObject(comp) || !Array.isArray(getOwnValue(comp, 'predicates'))) continue;
      for (const p of getOwnValue(comp, 'predicates') as unknown[]) {
        if (!isPlainObject(p) || getOwnString(p, 'kind') !== 'form-active') continue;
        const cid = getOwnString(p, 'characterId')?.trim();
        const fid = getOwnString(p, 'formId')?.trim();
        if (!cid || !fid || isUnsafeRecordKey(cid) || isUnsafeRecordKey(fid)) continue;
        requiredCharIds.add(cid);
        if (!formById.has(fid)) {
          const entry = parsedChars.entriesById.get(fid);
          const profile = parsedChars.profilesById.get(fid);
          const gId =
            (entry ? getOwnString(entry, 'formGroup')?.trim() : undefined) || `group.${cid}`;
          const displayName =
            (entry ? getOwnString(entry, 'displayName') ?? getOwnString(entry, 'dataName') : undefined) ||
            fid;
          const formDef: FormDefinition = {
            id: fid,
            formGroup: gId,
            characterId: cid,
            displayName,
            ...(profile ? { sections: buildProfileSections(profile) } : {}),
          };
          formById.set(fid, formDef);
          forms.push(formDef);
        }
      }
    }
  }

  // Link legalTargets within each formGroup
  for (const memberIds of formsInGroup.values()) {
    for (const fid of memberIds) {
      const formDef = formById.get(fid);
      if (formDef) {
        const targets = memberIds.filter((other) => other !== fid);
        if (targets.length > 0) {
          formDef.legalTargets = targets;
        }
      }
    }
  }

  // Build CharacterEntity records
  const sortedCharIds = Array.from(requiredCharIds).sort();
  for (const cid of sortedCharIds) {
    const entry = parsedChars.entriesById.get(cid);
    const profile = parsedChars.profilesById.get(cid);
    const name =
      (entry ? getOwnString(entry, 'displayName') ?? getOwnString(entry, 'dataName') : undefined) ??
      (profile ? getOwnString(profile, 'name') : undefined) ??
      cid;

    const locationId = rosterLocByChar.get(cid) ?? startLocationId;
    const requestedFormId = rosterFormByChar.get(cid) ?? cid;
    const formDef = formById.get(requestedFormId);
    const resolvedFormId = formDef && formDef.characterId === cid ? formDef.id : null;
    const formGroup =
      formDef?.formGroup ??
      (entry ? getOwnString(entry, 'formGroup')?.trim() ?? null : null);

    const rawStatus = entry ? getOwnString(entry, 'status')?.trim() : undefined;
    const status: CharacterStatus =
      rawStatus && VALID_CHAR_STATUSES.has(rawStatus) ? (rawStatus as CharacterStatus) : 'active';

    const side = entry ? getOwnString(entry, 'side')?.trim() : undefined;
    const allegiance =
      (profile ? getOwnString(profile, 'faction')?.trim() : undefined) || side || 'neutral';

    setSafeProperty(characters, cid, {
      id: cid,
      name,
      status,
      presentInScene: locationId !== null && locationId === startLocationId,
      locationId,
      formId: resolvedFormId,
      formGroup,
      sections: buildProfileSections(profile),
      customFields: {},
      abilities: [],
      goals: profile ? getStringArray(profile, 'goals') : [],
      agenda: '',
      allegiance,
      mood: 'neutral',
      traits: profile ? getStringArray(profile, 'traits') : [],
    });
  }

  return { characters, forms };
}

function buildAgendaConfig(
  rawAgendas: unknown,
  seasonId: string
): AgendaConfig {
  const defaultsObj =
    isPlainObject(rawAgendas) && isPlainObject(getOwnValue(rawAgendas, 'defaults'))
      ? (getOwnValue(rawAgendas, 'defaults') as Record<string, unknown>)
      : {};
  const seasonsObj =
    isPlainObject(rawAgendas) && isPlainObject(getOwnValue(rawAgendas, 'seasons'))
      ? (getOwnValue(rawAgendas, 'seasons') as Record<string, unknown>)
      : {};
  const seasonAgenda = isPlainObject(getOwnValue(seasonsObj, seasonId))
    ? (getOwnValue(seasonsObj, seasonId) as Record<string, unknown>)
    : {};

  const seasonRumors = getStringArray(seasonAgenda, 'rumorTemplates');
  const defaultRumors = getStringArray(defaultsObj, 'rumorTemplates');
  const rumorTemplates =
    seasonRumors.length > 0
      ? seasonRumors
      : defaultRumors.length > 0
        ? defaultRumors
        : [...DEFAULT_AGENDA_CONFIG.rumorTemplates];

  return {
    factionInfluencePerDay:
      getOwnNumber(defaultsObj, 'factionInfluencePerDay') ??
      DEFAULT_AGENDA_CONFIG.factionInfluencePerDay,
    mainThreatProgressPerDay:
      getOwnNumber(defaultsObj, 'mainThreatProgressPerDay') ??
      DEFAULT_AGENDA_CONFIG.mainThreatProgressPerDay,
    secondaryThreatProgressPerDay:
      getOwnNumber(defaultsObj, 'secondaryThreatProgressPerDay') ??
      DEFAULT_AGENDA_CONFIG.secondaryThreatProgressPerDay,
    maxFactionDeltaPerTick:
      getOwnNumber(defaultsObj, 'maxFactionDeltaPerTick') ??
      DEFAULT_AGENDA_CONFIG.maxFactionDeltaPerTick,
    maxNpcMovesPerTick:
      getOwnNumber(defaultsObj, 'maxNpcMovesPerTick') ?? DEFAULT_AGENDA_CONFIG.maxNpcMovesPerTick,
    maxDaysPerTick:
      getOwnNumber(defaultsObj, 'maxDaysPerTick') ?? DEFAULT_AGENDA_CONFIG.maxDaysPerTick,
    rumorsPerTick:
      getOwnNumber(defaultsObj, 'rumorsPerTick') ?? DEFAULT_AGENDA_CONFIG.rumorsPerTick,
    ...(DEFAULT_AGENDA_CONFIG.threatStageThresholds
      ? { threatStageThresholds: [...DEFAULT_AGENDA_CONFIG.threatStageThresholds] }
      : {}),
    rumorTemplates,
  };
}

function normalizeComparisonOp(raw: unknown, fallback: ComparisonOp = '=='): ComparisonOp {
  if (
    raw === '==' ||
    raw === '!=' ||
    raw === '<' ||
    raw === '<=' ||
    raw === '>' ||
    raw === '>=' ||
    raw === 'in' ||
    raw === 'contains'
  ) {
    return raw;
  }
  return fallback;
}

function translateNeoTerraCompletionPredicate(
  pred: Record<string, unknown>,
  context: {
    threats: Readonly<Record<string, ThreatEntity>>;
    factions: Readonly<Record<string, FactionEntity>>;
    locations: Readonly<Record<string, LocationEntity>>;
    characters: Readonly<Record<string, CharacterEntity>>;
    playerId: string;
  }
): PredicateAst | null {
  const kind = getOwnString(pred, 'kind')?.trim();
  switch (kind) {
    case 'event-tag': {
      const tag = getOwnString(pred, 'tag')?.trim() || 'event';
      return { flag: `event_${sanitizeFlagName(tag)}`, value: true };
    }
    case 'form-active': {
      const characterId = getOwnString(pred, 'characterId')?.trim();
      const formId = getOwnString(pred, 'formId')?.trim();
      if (!characterId || !formId) {
        return null;
      }
      return { form_active: { character: characterId, form: formId } };
    }
    case 'character-status': {
      const characterId = getOwnString(pred, 'characterId')?.trim();
      if (!characterId || !Object.hasOwn(context.characters, characterId)) {
        return null;
      }
      const statuses = getStringArray(pred, 'statuses');
      const singleStatus = getOwnString(pred, 'status')?.trim();
      if (statuses.length === 1) {
        return { entity: ['characters', characterId, 'status'], op: '==', value: statuses[0]! };
      }
      if (statuses.length > 1) {
        return { entity: ['characters', characterId, 'status'], op: 'in', value: statuses };
      }
      if (singleStatus) {
        return { entity: ['characters', characterId, 'status'], op: '==', value: singleStatus };
      }
      return null;
    }
    case 'location-control': {
      const locationId = getOwnString(pred, 'locationId')?.trim();
      const factionId = getOwnString(pred, 'factionId')?.trim();
      if (!locationId || !factionId || !Object.hasOwn(context.locations, locationId)) {
        return null;
      }
      return {
        entity: ['locations', locationId, 'controllingFactionId'],
        op: '==',
        value: factionId,
      };
    }
    case 'threat-stage': {
      const explicitThreat = getOwnString(pred, 'threatId')?.trim();
      const threatKeys = Object.keys(context.threats);
      const threatId =
        explicitThreat && Object.hasOwn(context.threats, explicitThreat)
          ? explicitThreat
          : threatKeys[0];
      if (!threatId) {
        return null;
      }
      const stage = getOwnNumber(pred, 'stage') ?? getOwnNumber(pred, 'value') ?? 1;
      const op = normalizeComparisonOp(getOwnValue(pred, 'op'), '>=');
      return { entity: ['threats', threatId, 'stage'], op, value: stage };
    }
    case 'relationship-affinity': {
      const fromId =
        getOwnString(pred, 'fromId')?.trim() ||
        getOwnString(pred, 'characterId')?.trim() ||
        context.playerId;
      const toId =
        getOwnString(pred, 'toId')?.trim() ||
        getOwnString(pred, 'targetId')?.trim() ||
        Object.keys(context.characters)[0];
      if (!toId) {
        return null;
      }
      const op = normalizeComparisonOp(getOwnValue(pred, 'op'), '>=');
      const val = getOwnNumber(pred, 'value') ?? getOwnNumber(pred, 'min') ?? 1;
      return { relation: [fromId, toId], field: 'affinity', op, value: val };
    }
    case 'beat-resolved': {
      const beatId = getOwnString(pred, 'beatId')?.trim();
      if (!beatId) {
        return null;
      }
      return { beat: beatId, status: ['resolved', 'adapted'] };
    }
    case 'flag': {
      const rawFlag = getOwnString(pred, 'flag')?.trim();
      if (!rawFlag) {
        return null;
      }
      const value = getOwnBoolean(pred, 'value') ?? true;
      return { flag: sanitizeFlagName(rawFlag), value };
    }
    default:
      return null;
  }
}

function translateBeatList(
  rawBeats: unknown,
  options: {
    routeId?: string;
    routeLockFlag?: string;
    turnOffset: number;
    existingBeatIds: ReadonlySet<string>;
    locations: Readonly<Record<string, LocationEntity>>;
    characters: Readonly<Record<string, CharacterEntity>>;
    factions: Readonly<Record<string, FactionEntity>>;
    threats: Readonly<Record<string, ThreatEntity>>;
    playerId: string;
  }
): BeatDefinition[] {
  if (!Array.isArray(rawBeats)) {
    return [];
  }

  const out: BeatDefinition[] = [];
  const mainThreatId = Object.keys(options.threats)[0];

  for (let i = 0; i < rawBeats.length; i += 1) {
    const raw = rawBeats[i];
    if (!isPlainObject(raw)) {
      continue;
    }
    const id = sanitizeIdentifier(getOwnString(raw, 'id') ?? '', `beat_${i + 1}`);
    const order = getOwnNumber(raw, 'order') ?? (i + 1) * 10;
    const rawFlex = getOwnString(raw, 'flexibility')?.trim();
    const flexibility: BeatFlexibility =
      rawFlex === 'strict' || rawFlex === 'adaptable' || rawFlex === 'optional'
        ? rawFlex
        : 'adaptable';
    const act = getOwnString(raw, 'act')?.trim();
    const title = getOwnString(raw, 'title')?.trim() || id;
    const description = getOwnString(raw, 'description')?.trim() || '';
    const rewriteHints = getOwnString(raw, 'rewriteHints')?.trim() || '';

    const rawConds = getOwnValue(raw, 'conditions');
    const conds = isPlainObject(rawConds) ? rawConds : {};

    const requires = getStringArray(conds, 'requiresBeats').filter(
      (req) => req !== id && options.existingBeatIds.has(req)
    );

    const whenClauses: PredicateAst[] = [];
    const rawTurnRange = getOwnValue(conds, 'turnRange');
    if (Array.isArray(rawTurnRange) && typeof rawTurnRange[0] === 'number' && rawTurnRange[0] > 0) {
      whenClauses.push({ clock: 'turn', op: '>=', value: Math.floor(rawTurnRange[0]) });
    }

    const locationIds = getStringArray(conds, 'locationIds').filter((locId) =>
      Object.hasOwn(options.locations, locId)
    );
    if (locationIds.length === 1) {
      whenClauses.push({ at: locationIds[0]! });
    } else if (locationIds.length > 1) {
      whenClauses.push({ any: locationIds.map((locId) => ({ at: locId })) });
    }

    const condThreatStage = getOwnNumber(conds, 'threatStage');
    if (condThreatStage !== undefined && mainThreatId) {
      whenClauses.push({
        entity: ['threats', mainThreatId, 'stage'],
        op: '>=',
        value: condThreatStage,
      });
    }

    const when: PredicateAst =
      whenClauses.length === 0
        ? { clock: 'turn', op: '>=', value: 0 }
        : whenClauses.length === 1
          ? whenClauses[0]!
          : { all: whenClauses };

    const rawCompletion = getOwnValue(raw, 'completion');
    const compObj = isPlainObject(rawCompletion) ? rawCompletion : {};
    const rawPreds = getOwnValue(compObj, 'predicates');
    const untilClauses: PredicateAst[] = [];
    if (Array.isArray(rawPreds)) {
      for (const p of rawPreds) {
        if (!isPlainObject(p)) {
          continue;
        }
        const translated = translateNeoTerraCompletionPredicate(p, {
          threats: options.threats,
          factions: options.factions,
          locations: options.locations,
          characters: options.characters,
          playerId: options.playerId,
        });
        if (translated) {
          untilClauses.push(translated);
        }
      }
    }

    const until: PredicateAst | undefined =
      untilClauses.length === 0
        ? undefined
        : untilClauses.length === 1
          ? untilClauses[0]!
          : { all: untilClauses };

    const roles: Record<string, BeatRoleSpec> = {};
    const actorIds = getStringArray(conds, 'actorIds').filter((cid) =>
      Object.hasOwn(options.characters, cid)
    );
    for (let aIdx = 0; aIdx < actorIds.length; aIdx += 1) {
      const roleKey = aIdx === 0 ? 'lead' : `actor_${aIdx + 1}`;
      setSafeProperty(roles, roleKey, {
        default: actorIds[aIdx]!,
        ...(flexibility !== 'strict'
          ? { fallbackQuery: { collection: 'characters', where: { status: 'active' } } }
          : {}),
      });
    }

    const rawDeadlineTurns = getOwnNumber(raw, 'deadlineTurns');
    const deadlineConsequence = getOwnString(raw, 'deadlineConsequence')?.trim();
    let deadline: PredicateAst | undefined;
    let onDeadline: BeatEffect[] | undefined;

    if (rawDeadlineTurns !== undefined && rawDeadlineTurns > 0 && flexibility !== 'optional') {
      const effectiveTurn = options.turnOffset + Math.floor(rawDeadlineTurns);
      const turnPred: PredicateAst = { clock: 'turn', op: '>=', value: effectiveTurn };
      deadline = options.routeLockFlag
        ? { all: [{ flag: options.routeLockFlag, value: true }, turnPred] }
        : turnPred;

      onDeadline = [
        {
          chronicle: {
            category: 'event',
            title: `${title} — Deadline`,
            summary: deadlineConsequence || `${title} deadline passed.`,
          },
        },
      ];
    }

    const nudgeText = [title, description, rewriteHints].filter((s) => s.length > 0).join(' — ');
    const beatClass = flexibility === 'optional' ? 'nudge' : 'gate';

    out.push({
      id,
      ...(act ? { act } : {}),
      class: beatClass,
      flexibility,
      priority: Math.max(1, 1000 - Math.round(order)),
      ...(options.routeId ? { route: options.routeId } : {}),
      ...(requires.length > 0 ? { requires } : {}),
      ...(Object.keys(roles).length > 0 ? { roles } : {}),
      when,
      ...(until ? { until } : {}),
      ...(deadline ? { deadline, deadlinePolicy: 'close' as const } : {}),
      ...(onDeadline ? { on_deadline: onDeadline } : {}),
      nudge: nudgeText,
      once: true,
    });
  }

  return out;
}

/**
 * Import an assembled set of NeoTerra JSON objects (`season`, `factions`, `locations`,
 * `agendas`, `characters`, `formGroups`) into a validated Tier 2 {@link CartridgeBundle}.
 */
export function importNeoTerraSeasonFromData(
  data: NeoTerraImportData
): Result<CartridgeBundle, ValidationError[]> {
  const acc = new ErrorAccumulator();

  if (!isPlainObject(data)) {
    return err([validationError('', 'INVALID_TYPE', 'NeoTerra data input must be a plain object')]);
  }
  scanObjectForUnsafeKeys(data, acc);
  if (acc.hasErrors()) {
    return err([...acc.errors]);
  }

  const sanitizedData = sanitizeJsonValue(data) as NeoTerraImportData;
  if (!isPlainObject(sanitizedData.season)) {
    return err([validationError('season', 'INVALID_TYPE', 'season payload must be a plain object')]);
  }
  const season = sanitizedData.season;

  const seasonId = sanitizeIdentifier(getOwnString(season, 'id') ?? '', 'neoterra-season');
  const title = getOwnString(season, 'title')?.trim() || seasonId;
  const premise = getOwnString(season, 'premise')?.trim() || '';
  const toneNotes = getOwnString(season, 'toneNotes')?.trim() || '';
  const anchorDateRaw = getOwnString(season, 'anchorDate')?.trim();
  const anchorDate = anchorDateRaw && parseIsoDate(anchorDateRaw) ? anchorDateRaw : null;

  const factions = buildFactions(sanitizedData.factions, getOwnValue(season, 'factions'));
  const locations = buildLocations(sanitizedData.locations, factions);
  const threats = buildThreats(getOwnValue(season, 'threats'), locations, factions);

  const rawStartLoc = getOwnString(season, 'startLocationId')?.trim() ?? null;
  const startLocationId =
    rawStartLoc && Object.hasOwn(locations, rawStartLoc)
      ? rawStartLoc
      : Object.keys(locations)[0] ?? null;

  const parsedChars = parseCharactersPayload(sanitizedData.characters);
  const { characters, forms } = buildCharactersAndForms(
    season,
    seasonId,
    parsedChars,
    sanitizedData.formGroups,
    locations,
    startLocationId
  );

  const defaultPcId = getOwnString(season, 'defaultPlayerCharacterId')?.trim() ?? null;
  const playerCharacterId =
    defaultPcId && Object.hasOwn(characters, defaultPcId) ? defaultPcId : null;
  const playerChar = playerCharacterId
    ? (Object.getOwnPropertyDescriptor(characters, playerCharacterId)?.value as
        | CharacterEntity
        | undefined)
    : undefined;
  const playerId = playerChar?.id ?? 'player';
  const playerName = playerChar?.name ?? 'Protagonist';

  const agendas = buildAgendaConfig(sanitizedData.agendas, seasonId);

  const rawCanonBeats = getOwnValue(season, 'canonBeats');
  const mainBeatIdSet = new Set<string>();
  if (Array.isArray(rawCanonBeats)) {
    for (const b of rawCanonBeats) {
      if (isPlainObject(b)) {
        const bid = getOwnString(b, 'id')?.trim();
        if (bid && !isUnsafeRecordKey(bid)) {
          mainBeatIdSet.add(bid);
        }
      }
    }
  }

  const mainBeats = translateBeatList(rawCanonBeats, {
    turnOffset: 0,
    existingBeatIds: mainBeatIdSet,
    locations,
    characters,
    factions,
    threats,
    playerId,
  });

  const finalDeadlineObj = isPlainObject(getOwnValue(season, 'finalDeadline'))
    ? (getOwnValue(season, 'finalDeadline') as Record<string, unknown>)
    : {};
  const finalDeadlineTurns = Math.max(1, Math.floor(getOwnNumber(finalDeadlineObj, 'turns') ?? 90));

  const routes: RouteDefinition[] = [];
  const endings: EndingDefinition[] = [];
  const allBeats: BeatDefinition[] = [...mainBeats];

  // Translate main season completion ending
  const rawEpilogue = isPlainObject(getOwnValue(season, 'epilogue'))
    ? (getOwnValue(season, 'epilogue') as Record<string, unknown>)
    : {};
  const epilogueTitle = getOwnString(rawEpilogue, 'title')?.trim() || `${title} Epilogue`;
  const epilogueParagraphs = getStringArray(rawEpilogue, 'paragraphs');
  const epilogueTemplate =
    epilogueParagraphs.length > 0
      ? `# ${epilogueTitle}\n\n${epilogueParagraphs.join('\n\n')}`
      : `# ${epilogueTitle}\n\n${premise || 'The season reaches its conclusion.'}`;

  const lastMainGate = [...mainBeats].reverse().find((b) => b.class === 'gate') ?? mainBeats[mainBeats.length - 1];
  const safeSeasonMark = sanitizeFlagName(seasonId);

  if (lastMainGate) {
    endings.push({
      id: `${seasonId}.ending.resolution`,
      priority: 10,
      when: { beat: lastMainGate.id, status: ['resolved', 'adapted'] },
      epilogue: { template: epilogueTemplate },
      mark: `ending_${safeSeasonMark}_resolution`,
    });
  }

  // Translate postVictory routes, beats, and villain-victory terminal deadline ending
  const rawPostVictory = getOwnValue(season, 'postVictory');
  const postVictoryObj = isPlainObject(rawPostVictory) ? rawPostVictory : undefined;
  const villainBranches: EndingBranchOption[] = [];

  if (postVictoryObj) {
    const branchSpecs: Array<{
      key: 'resistance' | 'join-villain';
      routeId: string;
      lockFlag: string;
      activeFlag: string;
      priority: number;
    }> = [
      {
        key: 'resistance',
        routeId: `${seasonId}.post-victory.resistance`,
        lockFlag: `route_${safeSeasonMark}_post_resistance`,
        activeFlag: `post_victory_${safeSeasonMark}_resistance_chosen`,
        priority: 2,
      },
      {
        key: 'join-villain',
        routeId: `${seasonId}.post-victory.join-villain`,
        lockFlag: `route_${safeSeasonMark}_post_join_villain`,
        activeFlag: `post_victory_${safeSeasonMark}_join_chosen`,
        priority: 1,
      },
    ];

    for (const spec of branchSpecs) {
      const branchRaw = getOwnValue(postVictoryObj, spec.key);
      if (!isPlainObject(branchRaw)) {
        continue;
      }
      const branchTitle = getOwnString(branchRaw, 'title')?.trim() || spec.key;
      routes.push({
        id: spec.routeId,
        group: `${seasonId}-post-victory`,
        lock: spec.lockFlag,
        priority: spec.priority,
        when: {
          all: [
            { clock: 'turn', op: '>=', value: finalDeadlineTurns },
            { flag: spec.activeFlag, value: true },
          ],
        },
        announce: `${branchTitle} begins.`,
      });

      villainBranches.push({
        id: spec.key,
        label: branchTitle,
        activateRoute: spec.routeId,
        routeGroup: `${seasonId}-post-victory`,
        patch: { [`flags.${spec.activeFlag}`]: true },
        targetArc: 'post-victory',
      });

      const rawBranchBeats = getOwnValue(branchRaw, 'beats');
      const branchBeatIds = new Set<string>(mainBeatIdSet);
      if (Array.isArray(rawBranchBeats)) {
        for (const bb of rawBranchBeats) {
          if (isPlainObject(bb)) {
            const bbid = getOwnString(bb, 'id')?.trim();
            if (bbid && !isUnsafeRecordKey(bbid)) {
              branchBeatIds.add(bbid);
            }
          }
        }
      }

      const branchBeats = translateBeatList(rawBranchBeats, {
        routeId: spec.routeId,
        routeLockFlag: spec.lockFlag,
        turnOffset: finalDeadlineTurns,
        existingBeatIds: branchBeatIds,
        locations,
        characters,
        factions,
        threats,
        playerId,
      });
      allBeats.push(...branchBeats);

      const lastBranchBeat = branchBeats[branchBeats.length - 1];
      if (lastBranchBeat) {
        endings.push({
          id: `${seasonId}.ending.post-${spec.key}`,
          route: spec.routeId,
          priority: 20,
          when: { beat: lastBranchBeat.id, status: ['resolved', 'adapted'] },
          epilogue: { template: `${branchTitle} reaches its conclusion.` },
          mark: `ending_${safeSeasonMark}_post_${sanitizeFlagName(spec.key)}`,
        });
      }
    }
  }

  endings.push({
    id: `${seasonId}.ending.villain-victory`,
    priority: 5,
    when: { clock: 'turn', op: '>=', value: finalDeadlineTurns },
    epilogue: { template: epilogueTemplate },
    mark: `ending_${safeSeasonMark}_villain_victory`,
    ...(villainBranches.length > 0 ? { branches: villainBranches } : {}),
  });

  const loreFiles: Record<string, string> = {};
  if (premise.length > 0 || toneNotes.length > 0) {
    setSafeProperty(
      loreFiles,
      'lore/season-overview.md',
      [`# ${title}`, premise, toneNotes ? `## Tone Notes\n${toneNotes}` : '']
        .filter((s) => s.length > 0)
        .join('\n\n')
    );
  }

  const personaName = playerChar ? playerChar.name : title;
  const personaDescription = [premise, toneNotes].filter((s) => s.length > 0).join('\n\n');

  const presentCharacterIds = Object.values(characters)
    .filter((c) => c.presentInScene)
    .map((c) => c.id)
    .sort();

  const bundle: CartridgeBundle = {
    rootDir: null,
    card: {
      spec: 'cartridge/0.1',
      id: `neoterra-${seasonId}`,
      version: '1.0.0',
      title,
      author: 'NeoTerra Framework',
      description: premise || `NeoTerra season ${seasonId}`,
      recommendedSystemPack: 'stock-living-world',
      persona: {
        name: personaName,
        description: personaDescription,
        ...(premise.length > 0 ? { scenario: premise } : {}),
        ...(toneNotes.length > 0 ? { systemPrompt: toneNotes } : {}),
      },
    },
    initialState: {
      schemaVersion: 2,
      clocks: {
        turn: 0,
        storyTurn: 0,
        day: 1,
        inGameDate: anchorDate,
        slotsPerDay: ['morning', 'afternoon', 'evening', 'night'],
        slot: 'morning',
        held: false,
        holdReason: null,
        timers: {},
      },
      scene: {
        location: startLocationId
          ? (getSafeProperty(locations, startLocationId)?.name ?? startLocationId)
          : '',
        locationId: startLocationId,
        presentCharacterIds,
        pinnedCharacterIds: [],
        mood: 'tense',
        pacing: 'balanced',
        directorNudge: null,
      },
      player: {
        id: playerId,
        name: playerName,
        characterId: playerCharacterId,
        locationId: startLocationId,
        customFields: {},
        sections: playerChar ? { ...playerChar.sections } : {},
        inventory: { items: {}, currency: {} },
      },
    },
    initialEntities: {
      characters,
      factions,
      threats,
      locations,
      forms,
    },
    agendas,
    beats: allBeats,
    routes,
    endings,
    loreFiles,
    endingPromptFiles: {},
    scriptFiles: {},
  };

  return validateCartridgeStructure(bundle);
}

/**
 * Load and import a NeoTerra season directory (`seasons/<seasonId>.json`, `factions.json`,
 * `locations.json`, `agendas.json`, `characters/index.json`, `characters/profiles.json`,
 * and `form-groups.json`) into a validated {@link CartridgeBundle}.
 */
export async function importNeoTerraSeasonFromDirectory(
  dataRootDir: string,
  seasonId = 's1'
): Promise<Result<CartridgeBundle, ValidationError[]>> {
  if (typeof dataRootDir !== 'string' || dataRootDir.trim().length === 0) {
    return err([validationError('dataRootDir', 'REQUIRED', 'dataRootDir must be a non-empty path')]);
  }
  const trimmedSeasonId = typeof seasonId === 'string' ? seasonId.trim() : '';
  if (
    trimmedSeasonId.length === 0 ||
    isUnsafeRecordKey(trimmedSeasonId) ||
    !/^[a-zA-Z0-9_-]+$/.test(trimmedSeasonId)
  ) {
    return err([
      validationError(
        'seasonId',
        'INVALID_SEASON_ID',
        'seasonId must be a safe alphanumeric identifier (letters, digits, hyphens, underscores)'
      ),
    ]);
  }

  const acc = new ErrorAccumulator();
  const safeSeasonFile = `${trimmedSeasonId}.json`;

  const [season, factions, locations, agendas, charIndex, charProfiles, formGroups] =
    await Promise.all([
      readJsonFile(path.join(dataRootDir, 'seasons', safeSeasonFile), true, acc, 'season'),
      readJsonFile(path.join(dataRootDir, 'factions.json'), false, acc, 'factions'),
      readJsonFile(path.join(dataRootDir, 'locations.json'), false, acc, 'locations'),
      readJsonFile(path.join(dataRootDir, 'agendas.json'), false, acc, 'agendas'),
      readJsonFile(path.join(dataRootDir, 'characters', 'index.json'), false, acc, 'characters.index'),
      readJsonFile(path.join(dataRootDir, 'characters', 'profiles.json'), false, acc, 'characters.profiles'),
      readJsonFile(path.join(dataRootDir, 'form-groups.json'), false, acc, 'formGroups'),
    ]);

  if (acc.hasErrors()) {
    return err([...acc.errors]);
  }

  const charactersCombined: Record<string, unknown> = {};
  if (charIndex !== undefined) {
    setSafeProperty(charactersCombined, 'index', charIndex);
  }
  if (isPlainObject(charProfiles) && isPlainObject(getOwnValue(charProfiles, 'profiles'))) {
    setSafeProperty(charactersCombined, 'profiles', getOwnValue(charProfiles, 'profiles'));
  }

  return importNeoTerraSeasonFromData({
    season,
    factions,
    locations,
    agendas,
    characters: charactersCombined,
    formGroups,
  });
}
