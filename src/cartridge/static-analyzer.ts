import {
  type BeatDefinition,
  type BeatEffect,
  type BeatLedgerState,
  type RequiresPolicy,
  cloneBeatLedger,
  createInitialBeatLedger,
  isTerminalBeatStatus,
} from '../beats/beat-ledger.js';
import {
  type BeatStatus,
  type ComparisonOp,
  type EntityCollection,
  type PredicateAst,
  isUnsafePropertyKey,
} from '../beats/predicate-ast.js';
import { compareValues, evaluatePredicate } from '../beats/predicate-evaluator.js';
import { type BoundRoleResult, bindBeatRoles, interpolateBeatTemplate } from '../beats/role-binder.js';
import {
  type EndingDefinition,
  type RouteDefinition,
} from '../beats/routes-and-endings.js';
import { validateEffectTemplate } from '../combat/effect-templates.js';
import { PASSIVE_TRIGGER_HOOKS } from '../combat/passives-and-willpower.js';
import { createDefaultSkillCatalog } from '../combat/skill-registry.js';
import { type ValidationError, validationError } from '../core/errors.js';
import { ErrorAccumulator } from '../core/result.js';
import { getStockSystemPack } from '../schema/stock-system-packs.js';
import { type SystemCapabilities } from '../schema/tracker-module.js';
import { validateCharacterCardSheet } from '../state/character-card-sheet.js';
import {
  type FormDefinition,
  type FormTransitionRule,
  buildFormIndex,
  validateFormTransitionRules,
} from '../state/forms.js';
import { type PatchOperation } from '../state/patch.js';
import { applyPatchBatch } from '../state/reducer.js';
import { type LocationEntity } from '../state/spatial-topology.js';
import {
  type CharacterEntity,
  type FactionEntity,
  type ThreatEntity,
  type WorldState,
  createWorldState,
} from '../state/world-state.js';
import {
  type CartridgeBundle,
  type CartridgeCombatConfig,
  getSafeProperty,
  isPlainObject,
  isUnsafeRecordKey,
  setSafeProperty,
} from './cartridge-schema.js';

export interface StaticAnalysisReport {
  ok: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
  reachableBeatIds: string[];
  unreachableBeatIds: string[];
  reachableEndingIds: string[];
  unreachableEndingIds: string[];
  deadlockStatesDetected: boolean;
}

export interface AnalyzeCartridgeOptions {
  maxExploreStates?: number;
  maxTurns?: number;
}

const DEFAULT_MAX_EXPLORE_STATES = 512;
const DEFAULT_MAX_TURNS = 1000;
const MAX_DNF_BRANCHES = 64;
const DEFAULT_ROUTE_GROUP = 'default';

function compareStringsLexicographic(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function normalizeRelativeRefPath(rawPath: string): string | null {
  const trimmed = rawPath.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.startsWith('/') || /^[a-zA-Z]:/.test(trimmed)) {
    return null;
  }
  const segments = trimmed.split('/');
  for (const seg of segments) {
    if (seg === '..' || seg === '.' || seg.length === 0 || isUnsafeRecordKey(seg)) {
      return null;
    }
  }
  return trimmed;
}

function hasResolvedFile(
  files: Readonly<Record<string, string>>,
  refPath: string,
  defaultDirPrefix: string
): boolean {
  const normalized = normalizeRelativeRefPath(refPath);
  if (normalized === null) {
    return false;
  }
  if (getSafeProperty(files, normalized) !== undefined) {
    return true;
  }
  if (!normalized.startsWith(`${defaultDirPrefix}/`)) {
    if (getSafeProperty(files, `${defaultDirPrefix}/${normalized}`) !== undefined) {
      return true;
    }
  }
  return false;
}

function hasResolvedScriptRef(
  scriptFiles: Readonly<Record<string, string>>,
  declaredScriptIds: ReadonlySet<string>,
  scriptRef: string
): boolean {
  const normalized = normalizeRelativeRefPath(scriptRef);
  if (normalized === null) {
    return false;
  }
  if (declaredScriptIds.has(scriptRef) || declaredScriptIds.has(normalized)) {
    return true;
  }
  const candidates = [
    normalized,
    normalized.endsWith('.js') ? normalized : `${normalized}.js`,
    normalized.startsWith('scripts/') ? normalized : `scripts/${normalized}`,
    normalized.startsWith('scripts/')
      ? normalized.endsWith('.js')
        ? normalized
        : `${normalized}.js`
      : normalized.endsWith('.js')
        ? `scripts/${normalized}`
        : `scripts/${normalized}.js`,
  ];
  for (const candidate of candidates) {
    if (getSafeProperty(scriptFiles, candidate) !== undefined) {
      return true;
    }
  }
  return false;
}

function mergeRecordMaps<T>(
  base: Readonly<Record<string, T>> | undefined,
  overlay: Readonly<Record<string, T>> | undefined
): Record<string, T> {
  const merged: Record<string, T> = {};
  if (base) {
    for (const key of Object.keys(base)) {
      const val = getSafeProperty(base, key);
      if (val !== undefined) {
        setSafeProperty(merged, key, val);
      }
    }
  }
  if (overlay) {
    for (const key of Object.keys(overlay)) {
      const val = getSafeProperty(overlay, key);
      if (val !== undefined) {
        setSafeProperty(merged, key, val);
      }
    }
  }
  return merged;
}

function inferEffectiveCapabilities(bundle: CartridgeBundle): SystemCapabilities {
  const packId = bundle.card?.recommendedSystemPack ?? 'stock-slice-of-life';
  const stockPack = getStockSystemPack(packId);
  const baseCaps: SystemCapabilities = stockPack
    ? { ...stockPack.capabilities }
    : {
        spatialMode: 'scene_only',
        combatMode: 'disabled',
        progression: 'disabled',
        clocks: 'calendar_only',
        factions: false,
        beats: false,
        relationships: true,
        chronicle: true,
      };

  const stateCaps = bundle.initialState?.capabilities;
  const overrideCaps = bundle.systemOverrides?.capabilities;

  return {
    spatialMode:
      overrideCaps?.spatialMode ?? stateCaps?.spatialMode ?? baseCaps.spatialMode,
    combatMode:
      overrideCaps?.combatMode ?? stateCaps?.combatMode ?? baseCaps.combatMode,
    progression:
      overrideCaps?.progression ?? stateCaps?.progression ?? baseCaps.progression,
    clocks: overrideCaps?.clocks ?? stateCaps?.clocks ?? baseCaps.clocks,
    factions: overrideCaps?.factions ?? stateCaps?.factions ?? baseCaps.factions,
    beats: overrideCaps?.beats ?? stateCaps?.beats ?? baseCaps.beats,
    relationships:
      overrideCaps?.relationships ?? stateCaps?.relationships ?? baseCaps.relationships,
    chronicle: overrideCaps?.chronicle ?? stateCaps?.chronicle ?? baseCaps.chronicle,
  };
}

/**
 * Detect dependency cycles in the beat `requires` DAG using deterministic 3-color DFS (BR-5).
 *
 * Returns a {@link ValidationError} for each detected cycle, reporting the exact cycle path
 * (e.g. `beatA -> beatB -> beatA`).
 */
export function detectBeatCycles(beats: readonly BeatDefinition[]): ValidationError[] {
  if (!Array.isArray(beats) || beats.length === 0) {
    return [];
  }

  const adj = new Map<string, string[]>();
  const validIds: string[] = [];

  for (const beat of beats) {
    if (
      !beat ||
      typeof beat.id !== 'string' ||
      beat.id.trim().length === 0 ||
      isUnsafePropertyKey(beat.id)
    ) {
      continue;
    }
    if (!adj.has(beat.id)) {
      adj.set(beat.id, []);
      validIds.push(beat.id);
    }
  }

  validIds.sort(compareStringsLexicographic);

  for (const beat of beats) {
    if (!beat || !adj.has(beat.id) || !Array.isArray(beat.requires)) {
      continue;
    }
    const deps = adj.get(beat.id)!;
    for (const reqId of beat.requires) {
      if (typeof reqId === 'string' && adj.has(reqId) && !deps.includes(reqId)) {
        deps.push(reqId);
      }
    }
  }

  const UNVISITED = 0;
  const VISITING = 1;
  const VISITED = 2;
  const state = new Map<string, number>();
  for (const id of validIds) {
    state.set(id, UNVISITED);
  }

  const stack: string[] = [];
  const errors: ValidationError[] = [];
  const seenCycles = new Set<string>();

  const dfs = (node: string): void => {
    state.set(node, VISITING);
    stack.push(node);

    const neighbors = adj.get(node) ?? [];
    for (const dep of neighbors) {
      const depState = state.get(dep) ?? UNVISITED;
      if (depState === VISITING) {
        const idx = stack.indexOf(dep);
        if (idx !== -1) {
          const cycleNodes = [...stack.slice(idx), dep];
          const cyclePath = cycleNodes.join(' -> ');
          const ringNodes = cycleNodes.slice(0, -1);
          const minNode = [...ringNodes].sort(compareStringsLexicographic)[0] ?? node;
          const minIdx = ringNodes.indexOf(minNode);
          const canonicalRing = [
            ...ringNodes.slice(minIdx),
            ...ringNodes.slice(0, minIdx),
          ].join('->');
          if (!seenCycles.has(canonicalRing)) {
            seenCycles.add(canonicalRing);
            errors.push(
              validationError(
                `beats.${node}.requires`,
                'BEAT_CYCLE_DETECTED',
                `Beat dependency cycle detected: ${cyclePath}`
              )
            );
          }
        }
      } else if (depState === UNVISITED) {
        dfs(dep);
      }
    }

    stack.pop();
    state.set(node, VISITED);
  };

  for (const id of validIds) {
    if (state.get(id) === UNVISITED) {
      dfs(id);
    }
  }

  return errors;
}

const VALID_PASSIVE_HOOKS: ReadonlySet<string> = new Set(PASSIVE_TRIGGER_HOOKS);

function validateLocationGeometry(geometry: unknown, gAcc: ErrorAccumulator): void {
  if (!isPlainObject(geometry)) {
    gAcc.add('', 'INVALID_TYPE', 'Location.geometry must be a plain object');
    return;
  }
  const x = Object.getOwnPropertyDescriptor(geometry, 'x')?.value;
  const y = Object.getOwnPropertyDescriptor(geometry, 'y')?.value;
  if (typeof x !== 'number' || !Number.isFinite(x)) {
    gAcc.add('x', 'INVALID_TYPE', 'Location.geometry.x must be a finite number');
  }
  if (typeof y !== 'number' || !Number.isFinite(y)) {
    gAcc.add('y', 'INVALID_TYPE', 'Location.geometry.y must be a finite number');
  }
  const polygon = Object.getOwnPropertyDescriptor(geometry, 'polygon')?.value;
  if (polygon !== undefined) {
    if (!Array.isArray(polygon)) {
      gAcc.add('polygon', 'INVALID_TYPE', 'Location.geometry.polygon must be an array');
    } else {
      for (let i = 0; i < polygon.length; i += 1) {
        const pt = polygon[i];
        if (
          !Array.isArray(pt) ||
          pt.length !== 2 ||
          typeof pt[0] !== 'number' ||
          !Number.isFinite(pt[0]) ||
          typeof pt[1] !== 'number' ||
          !Number.isFinite(pt[1])
        ) {
          gAcc.add(
            `polygon[${i}]`,
            'INVALID_TYPE',
            `Location.geometry.polygon[${i}] must be a [number, number] tuple of finite numbers`
          );
        }
      }
    }
  }
  const mapRef = Object.getOwnPropertyDescriptor(geometry, 'mapRef')?.value;
  if (mapRef !== undefined) {
    if (!isPlainObject(mapRef)) {
      gAcc.add('mapRef', 'INVALID_TYPE', 'Location.geometry.mapRef must be a plain object');
    } else {
      const layer = Object.getOwnPropertyDescriptor(mapRef, 'layer')?.value;
      const id = Object.getOwnPropertyDescriptor(mapRef, 'id')?.value;
      if (typeof layer !== 'string' || layer.trim().length === 0) {
        gAcc.add('mapRef.layer', 'REQUIRED', 'Location.geometry.mapRef.layer must be a non-empty string');
      }
      if (typeof id !== 'string' || id.trim().length === 0) {
        gAcc.add('mapRef.id', 'REQUIRED', 'Location.geometry.mapRef.id must be a non-empty string');
      }
    }
  }
}

function validatePassiveDefinitions(passives: unknown, pAcc: ErrorAccumulator): void {
  if (!Array.isArray(passives)) {
    pAcc.add('', 'INVALID_TYPE', 'passives must be an array');
    return;
  }
  const seenIds = new Set<string>();
  for (let i = 0; i < passives.length; i += 1) {
    const raw = passives[i];
    const itemAcc = pAcc.scope(`[${i}]`);
    if (!isPlainObject(raw)) {
      itemAcc.add('', 'INVALID_TYPE', 'PassiveDefinition must be a plain object');
      continue;
    }
    const id = Object.getOwnPropertyDescriptor(raw, 'id')?.value;
    if (typeof id !== 'string' || id.trim().length === 0) {
      itemAcc.add('id', 'REQUIRED', 'PassiveDefinition.id must be a non-empty string');
    } else if (isUnsafeRecordKey(id)) {
      itemAcc.add('id', 'UNSAFE_KEY', `Unsafe passive id "${id}"`);
    } else if (seenIds.has(id)) {
      itemAcc.add('id', 'DUPLICATE_ID', `Duplicate passive id "${id}"`);
    } else {
      seenIds.add(id);
    }

    const name = Object.getOwnPropertyDescriptor(raw, 'name')?.value;
    if (typeof name !== 'string' || name.trim().length === 0) {
      itemAcc.add('name', 'REQUIRED', 'PassiveDefinition.name must be a non-empty string');
    }

    const hook = Object.getOwnPropertyDescriptor(raw, 'hook')?.value;
    if (typeof hook !== 'string' || !VALID_PASSIVE_HOOKS.has(hook)) {
      itemAcc.add('hook', 'INVALID_VALUE', `Invalid passive hook "${String(hook)}"`);
    }

    const priority = Object.getOwnPropertyDescriptor(raw, 'priority')?.value;
    if (typeof priority !== 'number' || !Number.isFinite(priority)) {
      itemAcc.add('priority', 'INVALID_TYPE', 'PassiveDefinition.priority must be a finite number');
    }

    const effect = Object.getOwnPropertyDescriptor(raw, 'effect')?.value;
    if (!isPlainObject(effect) || typeof Object.getOwnPropertyDescriptor(effect, 'type')?.value !== 'string') {
      itemAcc.add('effect', 'INVALID_TYPE', 'PassiveDefinition.effect must be an object with string "type"');
    }
  }
}

function validateCombatConfigRefs(
  combat: CartridgeCombatConfig,
  knownSkillIds: ReadonlySet<string>,
  formById: ReadonlyMap<string, FormDefinition>,
  hasForms: boolean,
  validateSkillRefs: boolean,
  cAcc: ErrorAccumulator
): void {
  const summonIds = new Set<string>();
  if (isPlainObject(combat.summons)) {
    for (const key of Object.keys(combat.summons)) {
      if (!isUnsafeRecordKey(key)) {
        summonIds.add(key);
      }
    }
    for (const [summonKey, summonTpl] of Object.entries(combat.summons)) {
      if (isUnsafeRecordKey(summonKey) || !summonTpl) {
        continue;
      }
      if (validateSkillRefs && Array.isArray(summonTpl.abilities)) {
        for (let i = 0; i < summonTpl.abilities.length; i += 1) {
          const skillId = summonTpl.abilities[i];
          if (typeof skillId === 'string' && !knownSkillIds.has(skillId)) {
            cAcc.add(
              `summons.${summonKey}.abilities[${i}]`,
              'UNKNOWN_SKILL_ID',
              `Summon "${summonKey}" references unknown skill "${skillId}"`
            );
          }
        }
      }
      if (summonTpl.passives !== undefined) {
        validatePassiveDefinitions(
          summonTpl.passives,
          cAcc.scope(`summons.${summonKey}.passives`)
        );
      }
    }
  }

  const formLoadoutIds = new Set<string>();
  if (isPlainObject(combat.formLoadouts)) {
    for (const key of Object.keys(combat.formLoadouts)) {
      if (!isUnsafeRecordKey(key)) {
        formLoadoutIds.add(key);
      }
    }
    for (const [loadoutKey, loadout] of Object.entries(combat.formLoadouts)) {
      if (isUnsafeRecordKey(loadoutKey) || !loadout) {
        continue;
      }
      if (validateSkillRefs && Array.isArray(loadout.abilities)) {
        for (let i = 0; i < loadout.abilities.length; i += 1) {
          const skillId = loadout.abilities[i];
          if (typeof skillId === 'string' && !knownSkillIds.has(skillId)) {
            cAcc.add(
              `formLoadouts.${loadoutKey}.abilities[${i}]`,
              'UNKNOWN_SKILL_ID',
              `Form loadout "${loadoutKey}" references unknown skill "${skillId}"`
            );
          }
        }
      }
      if (loadout.passives !== undefined) {
        validatePassiveDefinitions(
          loadout.passives,
          cAcc.scope(`formLoadouts.${loadoutKey}.passives`)
        );
      }
      if (loadout.persistFormIdToWorld !== undefined) {
        if (
          typeof loadout.persistFormIdToWorld !== 'string' ||
          loadout.persistFormIdToWorld.trim().length === 0
        ) {
          cAcc.add(
            `formLoadouts.${loadoutKey}.persistFormIdToWorld`,
            'INVALID_TYPE',
            `Form loadout "${loadoutKey}" persistFormIdToWorld must be a non-empty string`
          );
        } else if (hasForms && !formById.has(loadout.persistFormIdToWorld)) {
          cAcc.add(
            `formLoadouts.${loadoutKey}.persistFormIdToWorld`,
            'UNKNOWN_FORM_REF',
            `Form loadout "${loadoutKey}" persistFormIdToWorld references unknown form "${loadout.persistFormIdToWorld}"`
          );
        }
      }
    }
  }

  if (isPlainObject(combat.effectTemplates)) {
    for (const [tplKey, tpl] of Object.entries(combat.effectTemplates)) {
      if (isUnsafeRecordKey(tplKey)) {
        continue;
      }
      const tplRes = validateEffectTemplate(tpl);
      if (!tplRes.ok) {
        cAcc.scope(`effectTemplates.${tplKey}`).addAll(tplRes.error);
        continue;
      }
      const validTpl = tplRes.value;
      if (validateSkillRefs && !knownSkillIds.has(validTpl.skillId)) {
        cAcc.add(
          `effectTemplates.${tplKey}.skillId`,
          'UNKNOWN_SKILL_ID',
          `Effect template "${tplKey}" references unknown skill "${validTpl.skillId}"`
        );
      }
      for (let i = 0; i < validTpl.steps.length; i += 1) {
        const step = validTpl.steps[i];
        if (!step) continue;
        if (
          step.kind === 'summon' &&
          typeof step.summonId === 'string' &&
          summonIds.size > 0 &&
          !summonIds.has(step.summonId)
        ) {
          cAcc.add(
            `effectTemplates.${tplKey}.steps[${i}].summonId`,
            'UNKNOWN_SUMMON_REF',
            `Effect template "${tplKey}" step ${i} references unknown summon "${step.summonId}"`
          );
        }
        if (
          step.kind === 'transform' &&
          typeof step.formLoadoutId === 'string' &&
          formLoadoutIds.size > 0 &&
          !formLoadoutIds.has(step.formLoadoutId)
        ) {
          cAcc.add(
            `effectTemplates.${tplKey}.steps[${i}].formLoadoutId`,
            'UNKNOWN_FORM_LOADOUT_REF',
            `Effect template "${tplKey}" step ${i} references unknown formLoadout "${step.formLoadoutId}"`
          );
        }
      }
    }
  }
}

function analyzeFormRuleWarnings(bundle: CartridgeBundle): ValidationError[] {
  const formRules = bundle.initialEntities?.formRules;
  if (!Array.isArray(formRules) || formRules.length === 0) {
    return [];
  }

  const forms = bundle.initialEntities?.forms ?? [];
  const characters = mergeRecordMaps<CharacterEntity>(
    bundle.initialState?.entities?.characters,
    bundle.initialEntities?.characters
  );

  const warnings: ValidationError[] = [];
  const rulesByGroup = new Map<string, FormTransitionRule[]>();
  const formsByGroup = new Map<string, Set<string>>();

  for (const form of forms) {
    if (!form || typeof form.id !== 'string' || typeof form.formGroup !== 'string') {
      continue;
    }
    let set = formsByGroup.get(form.formGroup);
    if (!set) {
      set = new Set();
      formsByGroup.set(form.formGroup, set);
    }
    set.add(form.id);
  }

  for (const rule of formRules) {
    if (!rule || typeof rule.formGroup !== 'string') {
      continue;
    }
    let list = rulesByGroup.get(rule.formGroup);
    if (!list) {
      list = [];
      rulesByGroup.set(rule.formGroup, list);
    }
    list.push(rule);
  }

  const initialFormsByGroup = new Map<string, Set<string>>();
  for (const char of Object.values(characters)) {
    if (!char || typeof char.formId !== 'string') continue;
    for (const form of forms) {
      if (form && form.id === char.formId) {
        let set = initialFormsByGroup.get(form.formGroup);
        if (!set) {
          set = new Set();
          initialFormsByGroup.set(form.formGroup, set);
        }
        set.add(form.id);
      }
    }
  }

  const sortedGroups = [...rulesByGroup.keys()].sort(compareStringsLexicographic);
  for (const group of sortedGroups) {
    const groupRules = rulesByGroup.get(group) ?? [];
    const groupForms = formsByGroup.get(group) ?? new Set<string>();

    // 1. Detect cycles in form transition rules within this formGroup
    const adj = new Map<string, string[]>();
    for (const fId of groupForms) {
      adj.set(fId, []);
    }
    for (const rule of groupRules) {
      if (typeof rule.toFormId !== 'string' || typeof rule.fromFormId !== 'string') {
        continue;
      }
      if (rule.fromFormId === '*') {
        for (const fId of groupForms) {
          if (fId !== rule.toFormId) {
            const list = adj.get(fId) ?? [];
            if (!list.includes(rule.toFormId)) list.push(rule.toFormId);
            adj.set(fId, list);
          }
        }
      } else {
        const list = adj.get(rule.fromFormId) ?? [];
        if (!list.includes(rule.toFormId)) list.push(rule.toFormId);
        adj.set(rule.fromFormId, list);
      }
    }

    const sortedNodes = [...adj.keys()].sort(compareStringsLexicographic);
    for (const list of adj.values()) {
      list.sort(compareStringsLexicographic);
    }

    const UNVISITED = 0;
    const VISITING = 1;
    const VISITED = 2;
    const visitState = new Map<string, number>();
    const stack: string[] = [];
    const seenCycleKeys = new Set<string>();

    const dfs = (node: string): void => {
      visitState.set(node, VISITING);
      stack.push(node);
      for (const next of adj.get(node) ?? []) {
        const st = visitState.get(next) ?? UNVISITED;
        if (st === VISITING) {
          const idx = stack.indexOf(next);
          if (idx !== -1) {
            const ring = stack.slice(idx);
            const minNode = [...ring].sort(compareStringsLexicographic)[0] ?? next;
            const minIdx = ring.indexOf(minNode);
            const canonical = [...ring.slice(minIdx), ...ring.slice(0, minIdx)].join('->');
            if (!seenCycleKeys.has(canonical)) {
              seenCycleKeys.add(canonical);
              warnings.push(
                validationError(
                  'initialEntities.formRules',
                  'FORM_RULE_CYCLE',
                  `Form transition rule cycle detected in formGroup "${group}": ${[...ring, next].join(' -> ')}`
                )
              );
            }
          }
        } else if (st === UNVISITED) {
          dfs(next);
        }
      }
      stack.pop();
      visitState.set(node, VISITED);
    };

    for (const node of sortedNodes) {
      if ((visitState.get(node) ?? UNVISITED) === UNVISITED) {
        dfs(node);
      }
    }

    // 2. Detect unreachable form rules (fromFormId cannot be reached from initial forms or '*' rules)
    if (groupForms.size > 0) {
      const reachableForms = new Set<string>(initialFormsByGroup.get(group) ?? []);
      if (reachableForms.size === 0) {
        const firstForm = [...groupForms].sort(compareStringsLexicographic)[0];
        if (firstForm !== undefined) {
          reachableForms.add(firstForm);
        }
      }
      for (const rule of groupRules) {
        if (rule.fromFormId === '*') {
          reachableForms.add(rule.toFormId);
        }
      }
      let changed = true;
      while (changed) {
        changed = false;
        for (const rule of groupRules) {
          if (
            rule.fromFormId !== '*' &&
            reachableForms.has(rule.fromFormId) &&
            !reachableForms.has(rule.toFormId)
          ) {
            reachableForms.add(rule.toFormId);
            changed = true;
          }
        }
      }
      for (const rule of groupRules) {
        if (rule.fromFormId !== '*' && !reachableForms.has(rule.fromFormId)) {
          warnings.push(
            validationError(
              `initialEntities.formRules.${rule.id}`,
              'UNREACHABLE_FORM_RULE',
              `Form transition rule "${rule.id}" in formGroup "${group}" has unreachable fromFormId "${rule.fromFormId}"`
            )
          );
        }
      }
    }
  }

  return warnings;
}

/**
 * Validate cross-file references across a {@link CartridgeBundle}:
 * - Beat `requires` and `route` references
 * - Predicate `entity`, `at` (Tier 2 location/tag), `beat`, `flag`, `counter`, `relation`, `custom_field`, `form_active` refs
 * - Character `locationId`, `formId`, and tactical `abilities` skill IDs
 * - Faction `headquartersLocationId`, Threat `locationId`/`sourceFactionId`, Location `connectedLocations`/`controllingFactionId`
 * - Ending `route`, `branches[].activateRoute`, `epilogue.promptPath`
 * - Referenced lore (`beat.lore`, `inject`) and script (`card.scripts`, `script`) files
 */
export function validateCrossFileReferences(bundle: CartridgeBundle): ValidationError[] {
  const acc = new ErrorAccumulator();

  if (!bundle || typeof bundle !== 'object') {
    return [validationError('', 'INVALID_TYPE', 'CartridgeBundle must be a non-null object')];
  }

  const effectiveCaps = inferEffectiveCapabilities(bundle);
  const isTier2 = effectiveCaps.spatialMode === 'authored_graph';

  const characters = mergeRecordMaps<CharacterEntity>(
    bundle.initialState?.entities?.characters,
    bundle.initialEntities?.characters
  );
  const factions = mergeRecordMaps<FactionEntity>(
    bundle.initialState?.entities?.factions,
    bundle.initialEntities?.factions
  );
  const threats = mergeRecordMaps<ThreatEntity>(
    bundle.initialState?.entities?.threats,
    bundle.initialEntities?.threats
  );
  const locations = mergeRecordMaps<LocationEntity>(
    bundle.initialState?.entities?.locations,
    bundle.initialEntities?.locations
  );

  const forms = bundle.initialEntities?.forms ?? [];
  const formById = new Map<string, FormDefinition>();
  for (const form of forms) {
    if (form && typeof form.id === 'string' && form.id.trim().length > 0 && !formById.has(form.id)) {
      formById.set(form.id, form);
    }
  }

  const locationLookupLower = new Set<string>();
  const locationTagLookupLower = new Set<string>();
  for (const [locId, loc] of Object.entries(locations)) {
    locationLookupLower.add(locId.trim().toLowerCase());
    if (loc && Array.isArray(loc.tags)) {
      for (const tag of loc.tags) {
        if (typeof tag === 'string' && tag.trim().length > 0) {
          locationTagLookupLower.add(tag.trim().toLowerCase());
        }
      }
    }
  }

  const beatIds = new Set<string>();
  for (const beat of bundle.beats ?? []) {
    if (beat && typeof beat.id === 'string' && beat.id.trim().length > 0 && !isUnsafeRecordKey(beat.id)) {
      beatIds.add(beat.id);
    }
  }

  const routeIds = new Set<string>();
  for (const route of bundle.routes ?? []) {
    if (route && typeof route.id === 'string' && route.id.trim().length > 0 && !isUnsafeRecordKey(route.id)) {
      routeIds.add(route.id);
    }
  }

  const defaultCatalog = createDefaultSkillCatalog();
  const knownSkillIds = new Set<string>(defaultCatalog.list().map((s) => s.id));
  if (bundle.combat?.skills) {
    for (const skill of bundle.combat.skills) {
      if (skill && typeof skill.id === 'string' && skill.id.trim().length > 0) {
        knownSkillIds.add(skill.id);
      }
    }
  }
  const validateSkillRefs =
    effectiveCaps.combatMode === 'tactical_grid' || bundle.combat?.skills !== undefined;

  const loreFiles = isPlainObject(bundle.loreFiles) ? bundle.loreFiles : {};
  const scriptFiles = isPlainObject(bundle.scriptFiles) ? bundle.scriptFiles : {};
  const endingPromptFiles = isPlainObject(bundle.endingPromptFiles)
    ? bundle.endingPromptFiles
    : {};

  const declaredScriptIds = new Set<string>();
  if (Array.isArray(bundle.card?.scripts)) {
    for (let i = 0; i < bundle.card.scripts.length; i += 1) {
      const manifest = bundle.card.scripts[i];
      if (!manifest || typeof manifest.scriptId !== 'string') {
        continue;
      }
      declaredScriptIds.add(manifest.scriptId);
      if (!hasResolvedScriptRef(scriptFiles, new Set(), manifest.scriptId)) {
        acc.add(
          `card.scripts[${i}].scriptId`,
          'MISSING_SCRIPT_FILE',
          `Referenced script "${manifest.scriptId}" does not exist in scriptFiles`
        );
      }
    }
  }

  const hasEntityInCollection = (coll: EntityCollection, entityId: string): boolean => {
    switch (coll) {
      case 'characters':
        return getSafeProperty(characters, entityId) !== undefined;
      case 'factions':
        return getSafeProperty(factions, entityId) !== undefined;
      case 'threats':
        return getSafeProperty(threats, entityId) !== undefined;
      case 'locations':
        return getSafeProperty(locations, entityId) !== undefined;
    }
  };

  const playerId = bundle.initialState?.player?.id ?? 'player';

  const validatePredicateRefs = (
    ast: PredicateAst | undefined,
    pAcc: ErrorAccumulator
  ): void => {
    if (!ast || typeof ast !== 'object') {
      return;
    }

    if ('all' in ast && Array.isArray(ast.all)) {
      for (let i = 0; i < ast.all.length; i += 1) {
        validatePredicateRefs(ast.all[i], pAcc.scope(`all[${i}]`));
      }
      return;
    }
    if ('any' in ast && Array.isArray(ast.any)) {
      for (let i = 0; i < ast.any.length; i += 1) {
        validatePredicateRefs(ast.any[i], pAcc.scope(`any[${i}]`));
      }
      return;
    }
    if ('not' in ast && ast.not) {
      validatePredicateRefs(ast.not, pAcc.scope('not'));
      return;
    }

    if ('flag' in ast) {
      if (
        typeof ast.flag !== 'string' ||
        ast.flag.trim().length === 0 ||
        isUnsafeRecordKey(ast.flag) ||
        ast.flag.includes('.')
      ) {
        pAcc.add('flag', 'INVALID_FLAG_REF', `Invalid flag reference "${String(ast.flag)}"`);
      }
      return;
    }

    if ('counter' in ast) {
      if (
        typeof ast.counter !== 'string' ||
        ast.counter.trim().length === 0 ||
        isUnsafeRecordKey(ast.counter) ||
        ast.counter.includes('.')
      ) {
        pAcc.add(
          'counter',
          'INVALID_COUNTER_REF',
          `Invalid counter reference "${String(ast.counter)}"`
        );
      }
      return;
    }

    if ('beat' in ast) {
      if (typeof ast.beat !== 'string' || !beatIds.has(ast.beat)) {
        pAcc.add('beat', 'UNKNOWN_BEAT_REF', `Predicate references unknown beat "${String(ast.beat)}"`);
      }
      return;
    }

    if ('at' in ast) {
      if (isTier2 && typeof ast.at === 'string') {
        const normalized = ast.at.trim().toLowerCase();
        if (
          !locationLookupLower.has(normalized) &&
          !locationTagLookupLower.has(normalized)
        ) {
          pAcc.add(
            'at',
            'UNKNOWN_LOCATION_REF',
            `Tier 2 location predicate references unknown location or tag "${ast.at}"`
          );
        }
      }
      return;
    }

    if ('entity' in ast && Array.isArray(ast.entity) && ast.entity.length === 3) {
      const [coll, entityId] = ast.entity;
      if (
        (coll === 'characters' ||
          coll === 'factions' ||
          coll === 'threats' ||
          coll === 'locations') &&
        typeof entityId === 'string' &&
        !hasEntityInCollection(coll, entityId)
      ) {
        pAcc.add(
          'entity[1]',
          'UNKNOWN_ENTITY_REF',
          `Predicate references unknown entity "${coll}.${entityId}"`
        );
      }
      return;
    }

    if ('custom_field' in ast) {
      if (
        ast.target !== undefined &&
        ast.target !== 'global' &&
        ast.target !== 'player' &&
        getSafeProperty(characters, ast.target) === undefined
      ) {
        pAcc.add(
          'target',
          'UNKNOWN_CHARACTER_REF',
          `custom_field predicate references unknown character "${ast.target}"`
        );
      }
      return;
    }

    if ('relation' in ast && Array.isArray(ast.relation) && ast.relation.length === 2) {
      const [fromId, toId] = ast.relation;
      const isKnownRelEntity = (id: string): boolean =>
        id === 'player' ||
        id === playerId ||
        getSafeProperty(characters, id) !== undefined ||
        getSafeProperty(factions, id) !== undefined;

      if (typeof fromId === 'string' && !isKnownRelEntity(fromId)) {
        pAcc.add(
          'relation[0]',
          'UNKNOWN_RELATION_ENTITY_REF',
          `Relation predicate references unknown entity "${fromId}"`
        );
      }
      if (typeof toId === 'string' && !isKnownRelEntity(toId)) {
        pAcc.add(
          'relation[1]',
          'UNKNOWN_RELATION_ENTITY_REF',
          `Relation predicate references unknown entity "${toId}"`
        );
      }
      return;
    }

    if ('form_active' in ast && ast.form_active) {
      const { character, form } = ast.form_active;
      if (getSafeProperty(characters, character) === undefined) {
        pAcc.add(
          'form_active.character',
          'UNKNOWN_CHARACTER_REF',
          `form_active references unknown character "${character}"`
        );
      }
      if (forms.length > 0) {
        const formDef = formById.get(form);
        if (!formDef || formDef.characterId !== character) {
          pAcc.add(
            'form_active.form',
            'UNKNOWN_FORM_REF',
            `form_active references unknown form "${form}" for character "${character}"`
          );
        }
      }
      return;
    }

    if ('character' in ast && 'form' in ast) {
      if (getSafeProperty(characters, ast.character) === undefined) {
        pAcc.add(
          'character',
          'UNKNOWN_CHARACTER_REF',
          `Form predicate references unknown character "${ast.character}"`
        );
      }
      if (forms.length > 0) {
        const formDef = formById.get(ast.form);
        if (!formDef || formDef.characterId !== ast.character) {
          pAcc.add(
            'form',
            'UNKNOWN_FORM_REF',
            `Form predicate references unknown form "${ast.form}" for character "${ast.character}"`
          );
        }
      }
    }
  };

  // 1. Validate beat cross-references
  const beats = bundle.beats ?? [];
  for (let i = 0; i < beats.length; i += 1) {
    const beat = beats[i];
    if (!beat || typeof beat !== 'object') {
      continue;
    }
    const bAcc = acc.scope(`beats[${i}]`);

    if (Array.isArray(beat.requires)) {
      for (let j = 0; j < beat.requires.length; j += 1) {
        const reqId = beat.requires[j];
        if (typeof reqId !== 'string' || reqId.trim().length === 0) {
          bAcc.add(`requires[${j}]`, 'INVALID_ID', 'requires entry must be a non-empty string');
        } else if (reqId === beat.id) {
          bAcc.add(`requires[${j}]`, 'SELF_DEPENDENCY', `Beat "${beat.id}" cannot require itself`);
        } else if (!beatIds.has(reqId)) {
          bAcc.add(
            `requires[${j}]`,
            'UNKNOWN_BEAT_REF',
            `Beat "${beat.id}" requires unknown beat "${reqId}"`
          );
        }
      }
    }

    if (beat.route !== undefined && !routeIds.has(beat.route)) {
      bAcc.add('route', 'UNKNOWN_ROUTE_REF', `Beat "${beat.id}" references unknown route "${beat.route}"`);
    }

    if (typeof beat.lore === 'string' && !beat.lore.includes('{{')) {
      if (!hasResolvedFile(loreFiles, beat.lore, 'lore')) {
        bAcc.add('lore', 'MISSING_LORE_FILE', `Beat "${beat.id}" references missing lore "${beat.lore}"`);
      }
    }

    if (beat.roles && isPlainObject(beat.roles)) {
      for (const [roleKey, roleSpec] of Object.entries(beat.roles)) {
        if (!roleSpec || typeof roleSpec.default !== 'string') {
          continue;
        }
        const preferred = roleSpec.fallbackQuery?.collection;
        const found = preferred
          ? hasEntityInCollection(preferred, roleSpec.default)
          : hasEntityInCollection('characters', roleSpec.default) ||
            hasEntityInCollection('factions', roleSpec.default) ||
            hasEntityInCollection('locations', roleSpec.default);
        if (!found) {
          bAcc.add(
            `roles.${roleKey}.default`,
            'UNKNOWN_ENTITY_REF',
            `Beat role "${roleKey}" default "${roleSpec.default}" does not exist in initialEntities`
          );
        }
      }
    }

    validatePredicateRefs(beat.when, bAcc.scope('when'));
    validatePredicateRefs(beat.until, bAcc.scope('until'));
    validatePredicateRefs(beat.impossible_when, bAcc.scope('impossible_when'));
    validatePredicateRefs(beat.deadline, bAcc.scope('deadline'));

    const hooks = [
      { name: 'on_entry', list: beat.on_entry },
      { name: 'on_resolve', list: beat.on_resolve },
      { name: 'on_deadline', list: beat.on_deadline },
      { name: 'on_short_circuit', list: beat.on_short_circuit },
      { name: 'on_abort', list: beat.on_abort },
    ] as const;

    for (const hook of hooks) {
      if (!Array.isArray(hook.list)) {
        continue;
      }
      for (let j = 0; j < hook.list.length; j += 1) {
        const eff = hook.list[j];
        if (!eff || typeof eff !== 'object') {
          continue;
        }
        const eAcc = bAcc.scope(`${hook.name}[${j}]`);

        if ('inject' in eff && typeof eff.inject === 'string' && !eff.inject.includes('{{')) {
          if (!hasResolvedFile(loreFiles, eff.inject, 'lore')) {
            eAcc.add('inject', 'MISSING_LORE_FILE', `Beat effect references missing lore "${eff.inject}"`);
          }
        }
        if ('script' in eff && typeof eff.script === 'string' && !eff.script.includes('{{')) {
          if (!hasResolvedScriptRef(scriptFiles, declaredScriptIds, eff.script)) {
            eAcc.add('script', 'MISSING_SCRIPT_FILE', `Beat effect references missing script "${eff.script}"`);
          }
        }
        if ('entity_patch' in eff && eff.entity_patch) {
          const ep = eff.entity_patch;
          if (
            typeof ep.entityId === 'string' &&
            !ep.entityId.includes('{{') &&
            !hasEntityInCollection(ep.collection, ep.entityId)
          ) {
            eAcc.add(
              'entity_patch.entityId',
              'UNKNOWN_ENTITY_REF',
              `entity_patch references unknown entity "${ep.collection}.${ep.entityId}"`
            );
          }
        }
        if ('set' in eff && isPlainObject(eff.set)) {
          for (const [key, val] of Object.entries(eff.set)) {
            if (key.startsWith('flags.') && typeof val !== 'boolean') {
              eAcc.add(`set.${key}`, 'INVALID_FLAG_VALUE', `Flag set "${key}" must be boolean`);
            }
            if (key.startsWith('counters.') && (typeof val !== 'number' || !Number.isFinite(val))) {
              eAcc.add(
                `set.${key}`,
                'INVALID_COUNTER_VALUE',
                `Counter set "${key}" must be a finite number`
              );
            }
          }
        }
      }
    }
  }

  // 2. Validate route predicates
  const routes = bundle.routes ?? [];
  for (let i = 0; i < routes.length; i += 1) {
    const route = routes[i];
    if (!route || typeof route !== 'object') {
      continue;
    }
    validatePredicateRefs(route.when, acc.scope(`routes[${i}].when`));
  }

  // 3. Validate ending references & predicates
  const endings = bundle.endings ?? [];
  for (let i = 0; i < endings.length; i += 1) {
    const ending = endings[i];
    if (!ending || typeof ending !== 'object') {
      continue;
    }
    const eAcc = acc.scope(`endings[${i}]`);
    if (ending.route !== undefined && !routeIds.has(ending.route)) {
      eAcc.add('route', 'UNKNOWN_ROUTE_REF', `Ending "${ending.id}" references unknown route "${ending.route}"`);
    }
    if (ending.epilogue && typeof ending.epilogue.promptPath === 'string') {
      if (!hasResolvedFile(endingPromptFiles, ending.epilogue.promptPath, 'assets/endings')) {
        eAcc.add(
          'epilogue.promptPath',
          'MISSING_ENDING_PROMPT_FILE',
          `Ending "${ending.id}" references missing prompt file "${ending.epilogue.promptPath}"`
        );
      }
    }
    validatePredicateRefs(ending.when, eAcc.scope('when'));
    if (Array.isArray(ending.branches)) {
      for (let j = 0; j < ending.branches.length; j += 1) {
        const branch = ending.branches[j];
        if (branch && branch.activateRoute !== undefined && !routeIds.has(branch.activateRoute)) {
          eAcc.add(
            `branches[${j}].activateRoute`,
            'UNKNOWN_ROUTE_REF',
            `Ending branch "${branch.id}" references unknown route "${branch.activateRoute}"`
          );
        }
      }
    }
  }

  // 4. Validate entity cross-references
  for (const [charId, char] of Object.entries(characters)) {
    if (!char) {
      continue;
    }
    if (
      isTier2 &&
      char.locationId !== null &&
      char.locationId !== undefined &&
      getSafeProperty(locations, char.locationId) === undefined
    ) {
      acc.add(
        `initialEntities.characters.${charId}.locationId`,
        'UNRESOLVED_LOCATION',
        `Character "${charId}" locationId "${char.locationId}" does not resolve in locations`
      );
    }
    if (char.formId !== null && char.formId !== undefined && forms.length > 0) {
      const formDef = formById.get(char.formId);
      if (!formDef || formDef.characterId !== charId) {
        acc.add(
          `initialEntities.characters.${charId}.formId`,
          'UNKNOWN_FORM_REF',
          `Character "${charId}" references unknown formId "${char.formId}"`
        );
      }
    }
    if (validateSkillRefs && Array.isArray(char.abilities)) {
      for (let i = 0; i < char.abilities.length; i += 1) {
        const abilityId = char.abilities[i];
        if (typeof abilityId === 'string' && !knownSkillIds.has(abilityId)) {
          acc.add(
            `initialEntities.characters.${charId}.abilities[${i}]`,
            'UNKNOWN_SKILL_ID',
            `Character "${charId}" references unknown skill "${abilityId}"`
          );
        }
      }
    }
    if (char.cardSheet !== undefined) {
      const sheetRes = validateCharacterCardSheet(
        char.cardSheet,
        `initialEntities.characters.${charId}.cardSheet`
      );
      if (!sheetRes.ok) {
        acc.addAll(sheetRes.error);
      }
    }
  }

  for (const [factionId, faction] of Object.entries(factions)) {
    if (!faction) {
      continue;
    }
    if (
      isTier2 &&
      faction.headquartersLocationId !== null &&
      faction.headquartersLocationId !== undefined &&
      getSafeProperty(locations, faction.headquartersLocationId) === undefined
    ) {
      acc.add(
        `initialEntities.factions.${factionId}.headquartersLocationId`,
        'UNRESOLVED_LOCATION',
        `Faction "${factionId}" headquartersLocationId "${faction.headquartersLocationId}" does not resolve in locations`
      );
    }
  }

  for (const [threatId, threat] of Object.entries(threats)) {
    if (!threat) {
      continue;
    }
    if (
      isTier2 &&
      threat.locationId !== null &&
      threat.locationId !== undefined &&
      getSafeProperty(locations, threat.locationId) === undefined
    ) {
      acc.add(
        `initialEntities.threats.${threatId}.locationId`,
        'UNRESOLVED_LOCATION',
        `Threat "${threatId}" locationId "${threat.locationId}" does not resolve in locations`
      );
    }
    if (
      threat.sourceFactionId !== null &&
      threat.sourceFactionId !== undefined &&
      getSafeProperty(factions, threat.sourceFactionId) === undefined
    ) {
      acc.add(
        `initialEntities.threats.${threatId}.sourceFactionId`,
        'UNKNOWN_FACTION_REF',
        `Threat "${threatId}" references unknown sourceFactionId "${threat.sourceFactionId}"`
      );
    }
  }

  for (const [locId, loc] of Object.entries(locations)) {
    if (!loc) {
      continue;
    }
    if (isTier2 && Array.isArray(loc.connectedLocations)) {
      for (let i = 0; i < loc.connectedLocations.length; i += 1) {
        const connId = loc.connectedLocations[i];
        if (connId === locId) {
          acc.add(
            `initialEntities.locations.${locId}.connectedLocations[${i}]`,
            'SELF_CONNECTED_LOCATION',
            `Location "${locId}" cannot connect to itself`
          );
        } else if (
          typeof connId === 'string' &&
          getSafeProperty(locations, connId) === undefined
        ) {
          acc.add(
            `initialEntities.locations.${locId}.connectedLocations[${i}]`,
            'UNRESOLVED_LOCATION',
            `Location "${locId}" connectedLocations references unknown location "${connId}"`
          );
        }
      }
    }
    if (
      loc.controllingFactionId !== null &&
      loc.controllingFactionId !== undefined &&
      getSafeProperty(factions, loc.controllingFactionId) === undefined
    ) {
      acc.add(
        `initialEntities.locations.${locId}.controllingFactionId`,
        'UNKNOWN_FACTION_REF',
        `Location "${locId}" controllingFactionId "${loc.controllingFactionId}" does not exist in factions`
      );
    }
    if (loc.geometry !== undefined) {
      validateLocationGeometry(loc.geometry, acc.scope(`initialEntities.locations.${locId}.geometry`));
    }
    if (loc.connectionsMeta !== undefined) {
      if (!isPlainObject(loc.connectionsMeta)) {
        acc.add(
          `initialEntities.locations.${locId}.connectionsMeta`,
          'INVALID_TYPE',
          `Location "${locId}" connectionsMeta must be a plain object`
        );
      } else {
        for (const targetId of Object.keys(loc.connectionsMeta)) {
          if (isUnsafeRecordKey(targetId)) {
            acc.add(
              `initialEntities.locations.${locId}.connectionsMeta.${targetId}`,
              'UNSAFE_KEY',
              `Unsafe key "${targetId}" in connectionsMeta`
            );
            continue;
          }
          if (targetId === locId) {
            acc.add(
              `initialEntities.locations.${locId}.connectionsMeta.${targetId}`,
              'SELF_CONNECTED_LOCATION',
              `Location "${locId}" connectionsMeta cannot target itself`
            );
          } else if (isTier2 && getSafeProperty(locations, targetId) === undefined) {
            acc.add(
              `initialEntities.locations.${locId}.connectionsMeta.${targetId}`,
              'UNRESOLVED_LOCATION',
              `Location "${locId}" connectionsMeta references unknown location "${targetId}"`
            );
          }
        }
      }
    }
    if (loc.hiddenAssets !== undefined) {
      if (!isPlainObject(loc.hiddenAssets)) {
        acc.add(
          `initialEntities.locations.${locId}.hiddenAssets`,
          'INVALID_TYPE',
          `Location "${locId}" hiddenAssets must be a plain object`
        );
      } else {
        for (const [assetKey, asset] of Object.entries(loc.hiddenAssets)) {
          if (isUnsafeRecordKey(assetKey)) {
            acc.add(
              `initialEntities.locations.${locId}.hiddenAssets.${assetKey}`,
              'UNSAFE_KEY',
              `Unsafe key "${assetKey}" in hiddenAssets`
            );
            continue;
          }
          if (
            asset &&
            typeof asset.linkedLocationId === 'string' &&
            asset.linkedLocationId.trim().length > 0 &&
            isTier2 &&
            getSafeProperty(locations, asset.linkedLocationId) === undefined
          ) {
            acc.add(
              `initialEntities.locations.${locId}.hiddenAssets.${assetKey}.linkedLocationId`,
              'UNRESOLVED_LOCATION',
              `Hidden asset "${asset.id}" in location "${locId}" references unknown linkedLocationId "${asset.linkedLocationId}"`
            );
          }
        }
      }
    }
  }

  for (let i = 0; i < forms.length; i += 1) {
    const form = forms[i];
    if (!form) {
      continue;
    }
    if (getSafeProperty(characters, form.characterId) === undefined) {
      acc.add(
        `initialEntities.forms[${i}].characterId`,
        'UNKNOWN_CHARACTER_REF',
        `Form "${form.id}" references unknown characterId "${form.characterId}"`
      );
    }
    if (Array.isArray(form.legalTargets)) {
      for (let j = 0; j < form.legalTargets.length; j += 1) {
        const targetId = form.legalTargets[j];
        if (typeof targetId === 'string' && !formById.has(targetId)) {
          acc.add(
            `initialEntities.forms[${i}].legalTargets[${j}]`,
            'UNKNOWN_FORM_REF',
            `Form "${form.id}" legalTargets references unknown form "${targetId}"`
          );
        }
      }
    }
  }

  const formRules = bundle.initialEntities?.formRules;
  if (formRules !== undefined) {
    const formIndex = forms.length > 0 ? buildFormIndex(forms) : undefined;
    const formRulesRes = validateFormTransitionRules(
      formRules,
      formIndex,
      'initialEntities.formRules'
    );
    if (!formRulesRes.ok) {
      acc.addAll(formRulesRes.error);
    }
    if (Array.isArray(formRules)) {
      for (let i = 0; i < formRules.length; i += 1) {
        const rule = formRules[i];
        if (!rule || typeof rule !== 'object') {
          continue;
        }
        validatePredicateRefs(rule.when, acc.scope(`initialEntities.formRules[${i}].when`));
        if (Array.isArray(rule.secretIdentity?.knownByCharacterIds)) {
          for (let j = 0; j < rule.secretIdentity.knownByCharacterIds.length; j += 1) {
            const cid = rule.secretIdentity.knownByCharacterIds[j];
            if (typeof cid === 'string' && getSafeProperty(characters, cid) === undefined) {
              acc.add(
                `initialEntities.formRules[${i}].secretIdentity.knownByCharacterIds[${j}]`,
                'UNKNOWN_CHARACTER_REF',
                `FormTransitionRule "${rule.id}" secretIdentity references unknown character "${cid}"`
              );
            }
          }
        }
      }
    }
  }

  // 5. Validate initialState references & skillOverrides
  const initState = bundle.initialState;
  if (initState) {
    if (
      initState.player?.characterId !== undefined &&
      initState.player.characterId !== null &&
      getSafeProperty(characters, initState.player.characterId) === undefined
    ) {
      acc.add(
        'initialState.player.characterId',
        'UNRESOLVED_CHARACTER',
        `player.characterId "${initState.player.characterId}" does not exist in characters`
      );
    }
    if (isTier2) {
      if (
        initState.player?.locationId !== undefined &&
        initState.player.locationId !== null &&
        getSafeProperty(locations, initState.player.locationId) === undefined
      ) {
        acc.add(
          'initialState.player.locationId',
          'UNRESOLVED_LOCATION',
          `player.locationId "${initState.player.locationId}" does not exist in locations`
        );
      }
      if (
        initState.scene?.locationId !== undefined &&
        initState.scene.locationId !== null &&
        getSafeProperty(locations, initState.scene.locationId) === undefined
      ) {
        acc.add(
          'initialState.scene.locationId',
          'UNRESOLVED_LOCATION',
          `scene.locationId "${initState.scene.locationId}" does not exist in locations`
        );
      }
    }
    if (Array.isArray(initState.scene?.presentCharacterIds)) {
      for (let i = 0; i < initState.scene.presentCharacterIds.length; i += 1) {
        const cid = initState.scene.presentCharacterIds[i];
        if (typeof cid === 'string' && getSafeProperty(characters, cid) === undefined) {
          acc.add(
            `initialState.scene.presentCharacterIds[${i}]`,
            'UNRESOLVED_CHARACTER',
            `scene.presentCharacterIds references unknown character "${cid}"`
          );
        }
      }
    }
    if (Array.isArray(initState.scene?.pinnedCharacterIds)) {
      for (let i = 0; i < initState.scene.pinnedCharacterIds.length; i += 1) {
        const cid = initState.scene.pinnedCharacterIds[i];
        if (typeof cid === 'string' && getSafeProperty(characters, cid) === undefined) {
          acc.add(
            `initialState.scene.pinnedCharacterIds[${i}]`,
            'UNRESOLVED_CHARACTER',
            `scene.pinnedCharacterIds references unknown character "${cid}"`
          );
        }
      }
    }
  }

  if (validateSkillRefs && bundle.systemOverrides?.combatRules?.skillOverrides) {
    for (const skillId of Object.keys(bundle.systemOverrides.combatRules.skillOverrides)) {
      if (!knownSkillIds.has(skillId)) {
        acc.add(
          `systemOverrides.combatRules.skillOverrides.${skillId}`,
          'UNKNOWN_SKILL_ID',
          `skillOverrides references unknown skill "${skillId}"`
        );
      }
    }
  }

  if (bundle.combat !== undefined) {
    validateCombatConfigRefs(
      bundle.combat,
      knownSkillIds,
      formById,
      forms.length > 0,
      true,
      acc.scope('combat')
    );
  }

  return [...acc.errors];
}

// ---------------------------------------------------------------------------
// Symbolic Predicate Satisfiability Solver for BR-7 Graph Verification
// ---------------------------------------------------------------------------

interface NumericInterval {
  min: number;
  minInclusive: boolean;
  max: number;
  maxInclusive: boolean;
  forbidden: Set<number>;
}

interface SymbolicAssignment {
  flags: Map<string, boolean>;
  numbers: Map<string, NumericInterval>;
  requiredSlots: Set<string>;
  forbiddenSlots: Set<string>;
  requiredLocations: Set<string>;
  forbiddenLocations: Set<string>;
  requiredMentions: Set<string>;
  forbiddenMentions: Set<string>;
  requiredForms: Map<string, string>;
  forbiddenForms: Map<string, Set<string>>;
  eqValues: Map<string, unknown>;
  neqValues: Map<string, unknown[]>;
}

interface SatisfiabilityEnv {
  state: WorldState;
  beatStatuses: ReadonlyMap<string, BeatStatus>;
  routeLockToRoute: ReadonlyMap<string, RouteDefinition>;
  endingMarks: ReadonlySet<string>;
  spatialMode: SystemCapabilities['spatialMode'];
  formsByChar: ReadonlyMap<string, ReadonlySet<string>>;
  maxTurnsBudget: number | undefined;
  initialDay: number;
  initialTurn: number;
  initialStoryTurn: number;
}

function createEmptyAssignment(): SymbolicAssignment {
  return {
    flags: new Map(),
    numbers: new Map(),
    requiredSlots: new Set(),
    forbiddenSlots: new Set(),
    requiredLocations: new Set(),
    forbiddenLocations: new Set(),
    requiredMentions: new Set(),
    forbiddenMentions: new Set(),
    requiredForms: new Map(),
    forbiddenForms: new Map(),
    eqValues: new Map(),
    neqValues: new Map(),
  };
}

function cloneAssignment(src: SymbolicAssignment): SymbolicAssignment {
  const numbers = new Map<string, NumericInterval>();
  for (const [k, iv] of src.numbers.entries()) {
    numbers.set(k, {
      min: iv.min,
      minInclusive: iv.minInclusive,
      max: iv.max,
      maxInclusive: iv.maxInclusive,
      forbidden: new Set(iv.forbidden),
    });
  }
  const forbiddenForms = new Map<string, Set<string>>();
  for (const [k, s] of src.forbiddenForms.entries()) {
    forbiddenForms.set(k, new Set(s));
  }
  const neqValues = new Map<string, unknown[]>();
  for (const [k, arr] of src.neqValues.entries()) {
    neqValues.set(k, [...arr]);
  }
  return {
    flags: new Map(src.flags),
    numbers,
    requiredSlots: new Set(src.requiredSlots),
    forbiddenSlots: new Set(src.forbiddenSlots),
    requiredLocations: new Set(src.requiredLocations),
    forbiddenLocations: new Set(src.forbiddenLocations),
    requiredMentions: new Set(src.requiredMentions),
    forbiddenMentions: new Set(src.forbiddenMentions),
    requiredForms: new Map(src.requiredForms),
    forbiddenForms,
    eqValues: new Map(src.eqValues),
    neqValues,
  };
}

function invertComparisonOp(op: ComparisonOp): ComparisonOp | null {
  switch (op) {
    case '==':
      return '!=';
    case '!=':
      return '==';
    case '<':
      return '>=';
    case '<=':
      return '>';
    case '>':
      return '<=';
    case '>=':
      return '<';
    case 'in':
    case 'contains':
      return null;
  }
}

function isIntervalConsistent(iv: NumericInterval): boolean {
  if (iv.min > iv.max) {
    return false;
  }
  if (iv.min === iv.max) {
    if (!iv.minInclusive || !iv.maxInclusive) {
      return false;
    }
    if (iv.forbidden.has(iv.min)) {
      return false;
    }
  }
  return true;
}

function applyNumericConstraint(
  assignment: SymbolicAssignment,
  key: string,
  op: ComparisonOp,
  value: number,
  initialMin?: number,
  initialMax?: number
): boolean {
  let iv = assignment.numbers.get(key);
  if (!iv) {
    iv = {
      min: initialMin ?? Number.NEGATIVE_INFINITY,
      minInclusive: true,
      max: initialMax ?? Number.POSITIVE_INFINITY,
      maxInclusive: true,
      forbidden: new Set(),
    };
    assignment.numbers.set(key, iv);
  }

  switch (op) {
    case '==': {
      if (value > iv.min || (value === iv.min && iv.minInclusive)) {
        iv.min = value;
        iv.minInclusive = true;
      } else {
        return false;
      }
      if (value < iv.max || (value === iv.max && iv.maxInclusive)) {
        iv.max = value;
        iv.maxInclusive = true;
      } else {
        return false;
      }
      break;
    }
    case '!=': {
      iv.forbidden.add(value);
      break;
    }
    case '>': {
      if (value > iv.min) {
        iv.min = value;
        iv.minInclusive = false;
      } else if (value === iv.min) {
        iv.minInclusive = false;
      }
      break;
    }
    case '>=': {
      if (value > iv.min) {
        iv.min = value;
        iv.minInclusive = true;
      }
      break;
    }
    case '<': {
      if (value < iv.max) {
        iv.max = value;
        iv.maxInclusive = false;
      } else if (value === iv.max) {
        iv.maxInclusive = false;
      }
      break;
    }
    case '<=': {
      if (value < iv.max) {
        iv.max = value;
        iv.maxInclusive = true;
      }
      break;
    }
    default:
      break;
  }

  return isIntervalConsistent(iv);
}

function applyEqualityConstraint(
  assignment: SymbolicAssignment,
  key: string,
  op: ComparisonOp,
  value: unknown
): boolean {
  if (op === '==') {
    if (assignment.eqValues.has(key)) {
      if (JSON.stringify(assignment.eqValues.get(key)) !== JSON.stringify(value)) {
        return false;
      }
    }
    const neqs = assignment.neqValues.get(key);
    if (neqs && neqs.some((v) => JSON.stringify(v) === JSON.stringify(value))) {
      return false;
    }
    assignment.eqValues.set(key, value);
    return true;
  }
  if (op === '!=') {
    if (assignment.eqValues.has(key)) {
      if (JSON.stringify(assignment.eqValues.get(key)) === JSON.stringify(value)) {
        return false;
      }
    }
    const neqs = assignment.neqValues.get(key) ?? [];
    neqs.push(value);
    assignment.neqValues.set(key, neqs);
    return true;
  }
  return true;
}

function matchesLocationPattern(
  loc: LocationEntity,
  patternLower: string
): boolean {
  if (loc.id.trim().toLowerCase() === patternLower) {
    return true;
  }
  return loc.tags.some((t) => t.trim().toLowerCase() === patternLower);
}

function checkLocationConsistency(
  assignment: SymbolicAssignment,
  env: SatisfiabilityEnv
): boolean {
  if (env.spatialMode === 'authored_graph') {
    const locs = Object.values(env.state.entities.locations);
    if (assignment.requiredLocations.size === 0 && assignment.forbiddenLocations.size === 0) {
      return true;
    }
    return locs.some((loc) => {
      for (const req of assignment.requiredLocations) {
        if (!matchesLocationPattern(loc, req)) {
          return false;
        }
      }
      for (const forb of assignment.forbiddenLocations) {
        if (matchesLocationPattern(loc, forb)) {
          return false;
        }
      }
      return true;
    });
  }

  for (const req of assignment.requiredLocations) {
    if (assignment.forbiddenLocations.has(req)) {
      return false;
    }
  }
  return true;
}

function solveAst(
  ast: PredicateAst,
  negated: boolean,
  current: SymbolicAssignment,
  env: SatisfiabilityEnv
): SymbolicAssignment[] {
  if ('not' in ast) {
    return solveAst(ast.not, !negated, current, env);
  }

  if ('all' in ast) {
    if (!negated) {
      let branches: SymbolicAssignment[] = [current];
      for (const child of ast.all) {
        const nextBranches: SymbolicAssignment[] = [];
        for (const br of branches) {
          const solved = solveAst(child, false, cloneAssignment(br), env);
          for (const s of solved) {
            nextBranches.push(s);
            if (nextBranches.length >= MAX_DNF_BRANCHES) {
              break;
            }
          }
          if (nextBranches.length >= MAX_DNF_BRANCHES) {
            break;
          }
        }
        branches = nextBranches;
        if (branches.length === 0) {
          return [];
        }
      }
      return branches;
    }
    // !(all [...]) === any [!...]
    const out: SymbolicAssignment[] = [];
    for (const child of ast.all) {
      const solved = solveAst(child, true, cloneAssignment(current), env);
      for (const s of solved) {
        out.push(s);
        if (out.length >= MAX_DNF_BRANCHES) {
          return out;
        }
      }
    }
    return out;
  }

  if ('any' in ast) {
    if (!negated) {
      const out: SymbolicAssignment[] = [];
      for (const child of ast.any) {
        const solved = solveAst(child, false, cloneAssignment(current), env);
        for (const s of solved) {
          out.push(s);
          if (out.length >= MAX_DNF_BRANCHES) {
            return out;
          }
        }
      }
      return out;
    }
    // !(any [...]) === all [!...]
    let branches: SymbolicAssignment[] = [current];
    for (const child of ast.any) {
      const nextBranches: SymbolicAssignment[] = [];
      for (const br of branches) {
        const solved = solveAst(child, true, cloneAssignment(br), env);
        for (const s of solved) {
          nextBranches.push(s);
          if (nextBranches.length >= MAX_DNF_BRANCHES) {
            break;
          }
        }
        if (nextBranches.length >= MAX_DNF_BRANCHES) {
          break;
        }
      }
      branches = nextBranches;
      if (branches.length === 0) {
        return [];
      }
    }
    return branches;
  }

  if ('flag' in ast) {
    const desired = (ast.value ?? true) !== negated;
    if (env.routeLockToRoute.has(ast.flag) || env.endingMarks.has(ast.flag)) {
      const actual = getSafeProperty(env.state.flags, ast.flag) === true;
      return actual === desired ? [current] : [];
    }
    const existing = current.flags.get(ast.flag);
    if (existing !== undefined) {
      return existing === desired ? [current] : [];
    }
    current.flags.set(ast.flag, desired);
    return [current];
  }

  if ('counter' in ast) {
    const effectiveOp = negated ? invertComparisonOp(ast.op) : ast.op;
    if (effectiveOp === null) {
      return [current];
    }
    const ok = applyNumericConstraint(
      current,
      `counter:${ast.counter}`,
      effectiveOp,
      ast.value
    );
    return ok ? [current] : [];
  }

  if ('clock' in ast) {
    if (
      ast.clock === 'day' ||
      ast.clock === 'turn' ||
      ast.clock === 'story_turn' ||
      ast.clock === 'storyTurn'
    ) {
      let actualClock: number;
      if (ast.clock === 'day') {
        actualClock = env.state.clocks.day;
      } else if (ast.clock === 'turn') {
        actualClock = env.state.clocks.turn;
      } else {
        actualClock = env.state.clocks.storyTurn;
      }
      const matches = compareValues(actualClock, ast.op, ast.value);
      return matches !== negated ? [current] : [];
    }

    const effectiveOp = negated ? invertComparisonOp(ast.op) : ast.op;
    if (effectiveOp === null) {
      return [current];
    }

    const axisKey = `clock:timer:${ast.clock}`;
    const currentVal = getSafeProperty(env.state.clocks.timers, ast.clock)?.current ?? 0;
    const maxBound = env.maxTurnsBudget !== undefined ? env.maxTurnsBudget : undefined;

    const ok = applyNumericConstraint(
      current,
      axisKey,
      effectiveOp,
      ast.value,
      currentVal,
      maxBound
    );
    return ok ? [current] : [];
  }

  if ('slot' in ast) {
    const normSlot = ast.slot.trim().toLowerCase();
    if (!negated) {
      if (current.requiredSlots.size > 0 && !current.requiredSlots.has(normSlot)) {
        return [];
      }
      if (current.forbiddenSlots.has(normSlot)) {
        return [];
      }
      current.requiredSlots.add(normSlot);
    } else {
      if (current.requiredSlots.has(normSlot)) {
        return [];
      }
      current.forbiddenSlots.add(normSlot);
    }
    return [current];
  }

  if ('at' in ast) {
    const normLoc = ast.at.trim().toLowerCase();
    if (!negated) {
      current.requiredLocations.add(normLoc);
    } else {
      current.forbiddenLocations.add(normLoc);
    }
    return checkLocationConsistency(current, env) ? [current] : [];
  }

  if ('beat' in ast) {
    const actual = env.beatStatuses.get(ast.beat);
    let matches = false;
    if (actual !== undefined) {
      matches = Array.isArray(ast.status)
        ? ast.status.includes(actual)
        : actual === ast.status;
    }
    return (matches !== negated) ? [current] : [];
  }

  if ('form_active' in ast || ('character' in ast && 'form' in ast)) {
    const charId = 'form_active' in ast ? ast.form_active.character : ast.character;
    const formId = 'form_active' in ast ? ast.form_active.form : ast.form;
    const knownForms = env.formsByChar.get(charId);
    if (knownForms && !knownForms.has(formId)) {
      return negated ? [current] : [];
    }
    if (!negated) {
      const existing = current.requiredForms.get(charId);
      if (existing !== undefined && existing !== formId) {
        return [];
      }
      if (current.forbiddenForms.get(charId)?.has(formId)) {
        return [];
      }
      current.requiredForms.set(charId, formId);
    } else {
      if (current.requiredForms.get(charId) === formId) {
        return [];
      }
      let set = current.forbiddenForms.get(charId);
      if (!set) {
        set = new Set();
        current.forbiddenForms.set(charId, set);
      }
      set.add(formId);
    }
    return [current];
  }

  if ('relation' in ast) {
    const key = `relation:${ast.relation[0]}.${ast.relation[1]}.${ast.field}`;
    const effectiveOp = negated ? invertComparisonOp(ast.op) : ast.op;
    if (effectiveOp === null) {
      return [current];
    }
    if (ast.field === 'affinity' && typeof ast.value === 'number') {
      return applyNumericConstraint(current, key, effectiveOp, ast.value, -100, 100)
        ? [current]
        : [];
    }
    return applyEqualityConstraint(current, key, effectiveOp, ast.value) ? [current] : [];
  }

  if ('entity' in ast) {
    const [coll, id, fieldPath] = ast.entity;
    const key = `entity:${coll}.${id}.${fieldPath}`;
    const effectiveOp = negated ? invertComparisonOp(ast.op) : ast.op;
    if (effectiveOp === null) {
      return [current];
    }
    if (typeof ast.value === 'number') {
      return applyNumericConstraint(current, key, effectiveOp, ast.value) ? [current] : [];
    }
    return applyEqualityConstraint(current, key, effectiveOp, ast.value) ? [current] : [];
  }

  if ('custom_field' in ast) {
    const key = `cf:${ast.target ?? 'global'}.${ast.custom_field}`;
    const effectiveOp = negated ? invertComparisonOp(ast.op) : ast.op;
    if (effectiveOp === null) {
      return [current];
    }
    if (typeof ast.value === 'number') {
      return applyNumericConstraint(current, key, effectiveOp, ast.value) ? [current] : [];
    }
    return applyEqualityConstraint(current, key, effectiveOp, ast.value) ? [current] : [];
  }

  if ('mentions' in ast) {
    const sig = ast.mentions.join('|').toLowerCase();
    if (!negated) {
      if (current.forbiddenMentions.has(sig)) {
        return [];
      }
      current.requiredMentions.add(sig);
    } else {
      if (current.requiredMentions.has(sig)) {
        return [];
      }
      current.forbiddenMentions.add(sig);
    }
    return [current];
  }

  // any_entity, count_entities
  return [current];
}

function canSatisfyPredicate(ast: PredicateAst, env: SatisfiabilityEnv): boolean {
  const solutions = solveAst(ast, false, createEmptyAssignment(), env);
  return solutions.length > 0;
}

function resolveEffectSetPath(key: string, value: unknown): string {
  if (key.includes('.')) {
    return key;
  }
  if (typeof value === 'boolean') {
    return `flags.${key}`;
  }
  if (typeof value === 'number') {
    return `counters.${key}`;
  }
  return `customFields.${key}`;
}

function resolveEffectIncrementPath(key: string): string {
  return key.includes('.') ? key : `counters.${key}`;
}

function compileBeatEffectsForSimulation(
  beatId: string,
  effects: readonly BeatEffect[] | undefined,
  boundRoles: Readonly<Record<string, BoundRoleResult>>,
  state: WorldState
): PatchOperation[] {
  if (!effects || effects.length === 0) {
    return [];
  }
  const ops: PatchOperation[] = [];
  const involvedEntityIds = Array.from(
    new Set(
      Object.values(boundRoles)
        .filter((b) => b !== undefined)
        .map((b) => b.entityId)
    )
  ).sort(compareStringsLexicographic);

  for (const eff of effects) {
    if ('op' in eff) {
      ops.push(eff);
      continue;
    }
    if ('set' in eff && isPlainObject(eff.set)) {
      const keys = Object.keys(eff.set)
        .filter((k) => !isUnsafeRecordKey(k))
        .sort(compareStringsLexicographic);
      for (const key of keys) {
        const val = Object.getOwnPropertyDescriptor(eff.set, key)?.value;
        const resolved =
          typeof val === 'string' ? interpolateBeatTemplate(val, boundRoles) : val;
        ops.push({
          op: 'set',
          path: resolveEffectSetPath(key, resolved),
          value: resolved,
        });
      }
    }
    if ('increment' in eff && isPlainObject(eff.increment)) {
      const keys = Object.keys(eff.increment)
        .filter((k) => !isUnsafeRecordKey(k))
        .sort(compareStringsLexicographic);
      for (const key of keys) {
        const delta = Object.getOwnPropertyDescriptor(eff.increment, key)?.value;
        if (typeof delta === 'number' && Number.isFinite(delta)) {
          ops.push({
            op: 'increment',
            path: resolveEffectIncrementPath(key),
            delta,
          });
        }
      }
    }
    if ('entity_patch' in eff && eff.entity_patch) {
      const ep = eff.entity_patch;
      ops.push({
        op: 'entity_patch',
        collection: ep.collection,
        entityId: interpolateBeatTemplate(ep.entityId, boundRoles),
        patch: ep.patch,
      });
    }
    if ('chronicle' in eff && eff.chronicle) {
      ops.push({
        op: 'chronicle_append',
        entry: {
          category: eff.chronicle.category,
          title: interpolateBeatTemplate(eff.chronicle.title, boundRoles),
          summary: interpolateBeatTemplate(eff.chronicle.summary, boundRoles),
          locationId: state.scene.locationId,
          involvedEntityIds,
          keywords: ['beat', beatId],
        },
      });
    }
  }
  return ops;
}

function applyEffectsToWorldState(
  state: WorldState,
  beatId: string,
  phase: string,
  effects: readonly BeatEffect[] | undefined,
  boundRoles: Readonly<Record<string, BoundRoleResult>>
): WorldState {
  const ops = compileBeatEffectsForSimulation(beatId, effects, boundRoles, state);
  if (ops.length === 0) {
    return state;
  }
  const res = applyPatchBatch(state, {
    eventId: `sim:${beatId}:${phase}:t${state.meta.turn}`,
    source: 'beat',
    operations: ops,
  });
  return res.ok ? res.value.nextState : state;
}

function collectClockMilestones(
  beats: readonly BeatDefinition[],
  routes: readonly RouteDefinition[],
  endings: readonly EndingDefinition[],
  initialDay: number,
  initialTurn: number,
  initialStoryTurn: number,
  maxTurns: number
): { days: number[]; turns: number[]; storyTurns: number[] } {
  const days = new Set<number>();
  const turns = new Set<number>();
  const storyTurns = new Set<number>();

  const visitAst = (ast: PredicateAst | undefined): void => {
    if (!ast || typeof ast !== 'object') {
      return;
    }
    if ('all' in ast && Array.isArray(ast.all)) {
      for (const child of ast.all) visitAst(child);
      return;
    }
    if ('any' in ast && Array.isArray(ast.any)) {
      for (const child of ast.any) visitAst(child);
      return;
    }
    if ('not' in ast) {
      visitAst(ast.not);
      return;
    }
    if ('clock' in ast && typeof ast.value === 'number' && Number.isFinite(ast.value)) {
      const candidates = [ast.value - 1, ast.value, ast.value + 1];
      if (ast.clock === 'day') {
        for (const v of candidates) {
          if (v > initialDay && v <= initialDay + maxTurns) {
            days.add(Math.ceil(v));
          }
        }
      } else if (ast.clock === 'turn') {
        for (const v of candidates) {
          if (v > initialTurn && v <= initialTurn + maxTurns) {
            turns.add(Math.ceil(v));
          }
        }
      } else if (ast.clock === 'story_turn' || ast.clock === 'storyTurn') {
        for (const v of candidates) {
          if (v > initialStoryTurn && v <= initialStoryTurn + maxTurns) {
            storyTurns.add(Math.ceil(v));
          }
        }
      }
    }
  };

  for (const beat of beats) {
    visitAst(beat.when);
    visitAst(beat.until);
    visitAst(beat.impossible_when);
    visitAst(beat.deadline);
  }
  for (const route of routes) {
    visitAst(route.when);
  }
  for (const ending of endings) {
    visitAst(ending.when);
  }

  return {
    days: [...days].sort((a, b) => a - b),
    turns: [...turns].sort((a, b) => a - b),
    storyTurns: [...storyTurns].sort((a, b) => a - b),
  };
}

function collectBeatRefsFromAst(ast: PredicateAst | undefined, refs: Set<string>): void {
  if (!ast || typeof ast !== 'object') {
    return;
  }
  if ('all' in ast && Array.isArray(ast.all)) {
    for (const c of ast.all) collectBeatRefsFromAst(c, refs);
    return;
  }
  if ('any' in ast && Array.isArray(ast.any)) {
    for (const c of ast.any) collectBeatRefsFromAst(c, refs);
    return;
  }
  if ('not' in ast) {
    collectBeatRefsFromAst(ast.not, refs);
    return;
  }
  if ('beat' in ast && typeof ast.beat === 'string') {
    refs.add(ast.beat);
  }
}

function areRequiresSatisfiedInMap(
  beat: BeatDefinition,
  beatStatuses: ReadonlyMap<string, BeatStatus>
): boolean {
  if (!beat.requires || beat.requires.length === 0) {
    return true;
  }
  const policy: RequiresPolicy = beat.requiresPolicy ?? 'terminal_completed';
  for (const reqId of beat.requires) {
    const st = beatStatuses.get(reqId);
    if (st === undefined) {
      return false;
    }
    if (policy === 'any_terminal') {
      if (!isTerminalBeatStatus(st)) {
        return false;
      }
    } else if (st !== 'resolved' && st !== 'adapted') {
      return false;
    }
  }
  return true;
}

function buildInitialSimulationWorldState(
  bundle: CartridgeBundle,
  effectiveCaps: SystemCapabilities
): WorldState | null {
  const initState = bundle.initialState ?? {};
  const characters = mergeRecordMaps<CharacterEntity>(
    initState.entities?.characters,
    bundle.initialEntities?.characters
  );
  const factions = mergeRecordMaps<FactionEntity>(
    initState.entities?.factions,
    bundle.initialEntities?.factions
  );
  const threats = mergeRecordMaps<ThreatEntity>(
    initState.entities?.threats,
    bundle.initialEntities?.threats
  );
  const locations = mergeRecordMaps<LocationEntity>(
    initState.entities?.locations,
    bundle.initialEntities?.locations
  );

  // Force beats capability enabled during graph simulation when cartridge defines beats/routes/endings.
  const simCaps: SystemCapabilities = {
    ...effectiveCaps,
    beats: true,
  };

  const options = {
    sessionId: initState.meta?.sessionId ?? 'static-analysis',
    capabilities: {
      ...simCaps,
      // Defer Tier 2 location validation to validateCrossFileReferences so broken refs don't throw here.
      spatialMode: 'scene_only' as const,
    },
    turn: initState.meta?.turn ?? initState.clocks?.turn ?? 0,
    arc: initState.meta?.arc ?? 'season',
    endingStatus: initState.meta?.endingStatus ?? 'none',
    activeEndingId: initState.meta?.activeEndingId ?? null,
    player: initState.player,
    scene: initState.scene,
    clocks: initState.clocks,
    flags: initState.flags ? { ...initState.flags } : {},
    counters: initState.counters ? { ...initState.counters } : {},
    customFields: initState.customFields ? { ...initState.customFields } : {},
    relations: initState.relations,
    characters,
    factions,
    threats,
    locations,
  };

  try {
    const state = createWorldState(options);
    state.capabilities.spatialMode = simCaps.spatialMode;
    return state;
  } catch {
    // Fallback: sanitize broken player/scene character refs if initialState had invalid references.
    try {
      const safePlayer = initState.player
        ? {
            ...initState.player,
            characterId:
              initState.player.characterId &&
              getSafeProperty(characters, initState.player.characterId) !== undefined
                ? initState.player.characterId
                : null,
          }
        : undefined;
      const safeScene = initState.scene
        ? {
            ...initState.scene,
            presentCharacterIds: (initState.scene.presentCharacterIds ?? []).filter(
              (cid) => getSafeProperty(characters, cid) !== undefined
            ),
            pinnedCharacterIds: (initState.scene.pinnedCharacterIds ?? []).filter(
              (cid) => getSafeProperty(characters, cid) !== undefined
            ),
          }
        : undefined;

      const state = createWorldState({
        ...options,
        player: safePlayer,
        scene: safeScene,
      });
      state.capabilities.spatialMode = simCaps.spatialMode;
      return state;
    } catch {
      return null;
    }
  }
}

interface ExploreNode {
  index: number;
  state: WorldState;
  ledger: BeatLedgerState;
  beatStatuses: Map<string, BeatStatus>;
  lockedByGroup: Map<string, string>;
  endingTriggered: string | null;
  expanded: boolean;
  canReachEndingDirectly: boolean;
  children: number[];
}

function computeNodeKey(
  state: WorldState,
  beatStatuses: ReadonlyMap<string, BeatStatus>,
  ledger: BeatLedgerState,
  lockedByGroup: ReadonlyMap<string, string>,
  endingTriggered: string | null,
  significantBeatIds: readonly string[]
): string {
  const beatParts = significantBeatIds
    .map((id) => {
      const st = beatStatuses.get(id) ?? 'dormant';
      const rec = getSafeProperty(ledger.records, id);
      const df = rec?.deadlineFired ? '1' : '0';
      const ef = rec?.entryEffectsFired ? '1' : '0';
      return `${id}:${st}:${df}:${ef}`;
    })
    .join(',');

  const routeParts = [...lockedByGroup.entries()]
    .sort((a, b) => compareStringsLexicographic(a[0], b[0]))
    .map(([g, r]) => `${g}=${r}`)
    .join(',');

  const flagParts = Object.keys(state.flags)
    .filter((k) => !isUnsafeRecordKey(k))
    .sort(compareStringsLexicographic)
    .map((k) => `${k}=${String(getSafeProperty(state.flags, k))}`)
    .join(',');

  const counterParts = Object.keys(state.counters)
    .filter((k) => !isUnsafeRecordKey(k))
    .sort(compareStringsLexicographic)
    .map((k) => `${k}=${String(getSafeProperty(state.counters, k))}`)
    .join(',');

  const customParts = Object.keys(state.customFields)
    .filter((k) => !isUnsafeRecordKey(k))
    .sort(compareStringsLexicographic)
    .map((k) => `${k}=${JSON.stringify(getSafeProperty(state.customFields, k))}`)
    .join(',');

  return [
    `e:${endingTriggered ?? ''}`,
    `g:${ledger.liveGateId ?? ''}`,
    `c:${state.clocks.day}:${state.clocks.turn}:${state.clocks.storyTurn}`,
    `r:${routeParts}`,
    `b:${beatParts}`,
    `f:${flagParts}`,
    `n:${counterParts}`,
    `cf:${customParts}`,
  ].join('|');
}

/**
 * Perform bounded symbolic + BFS state-space verification (BR-7) over a {@link CartridgeBundle}.
 *
 * Detects:
 * - Beat `requires` dependency cycles (BR-5)
 * - Cross-file reference errors
 * - Unreachable gates, beats, and endings (including endings requiring mutually exclusive routes in the same group)
 * - Non-ending deadlock states where no gate or ending can become eligible
 */
export function analyzeCartridgeGraph(
  bundle: CartridgeBundle,
  options: AnalyzeCartridgeOptions = {}
): StaticAnalysisReport {
  const maxExploreStates = Math.max(
    1,
    Math.floor(options.maxExploreStates ?? DEFAULT_MAX_EXPLORE_STATES)
  );
  const maxTurns = Math.max(1, Math.floor(options.maxTurns ?? DEFAULT_MAX_TURNS));

  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];

  if (!bundle || typeof bundle !== 'object') {
    return {
      ok: false,
      errors: [validationError('', 'INVALID_TYPE', 'CartridgeBundle must be a non-null object')],
      warnings: [],
      reachableBeatIds: [],
      unreachableBeatIds: [],
      reachableEndingIds: [],
      unreachableEndingIds: [],
      deadlockStatesDetected: false,
    };
  }

  errors.push(...detectBeatCycles(bundle.beats ?? []));
  errors.push(...validateCrossFileReferences(bundle));
  warnings.push(...analyzeFormRuleWarnings(bundle));

  const beats = [...(bundle.beats ?? [])];
  const routes = [...(bundle.routes ?? [])];
  const endings = [...(bundle.endings ?? [])];

  // Fast path: minimal Tier 0 cartridge with zero beats and zero endings
  if (beats.length === 0 && endings.length === 0 && routes.length === 0) {
    return {
      ok: errors.length === 0,
      errors,
      warnings,
      reachableBeatIds: [],
      unreachableBeatIds: [],
      reachableEndingIds: [],
      unreachableEndingIds: [],
      deadlockStatesDetected: false,
    };
  }

  const effectiveCaps = inferEffectiveCapabilities(bundle);
  if (beats.length > 0 && !effectiveCaps.beats) {
    warnings.push(
      validationError(
        'card.recommendedSystemPack',
        'BEATS_CAPABILITY_DISABLED',
        'Cartridge defines beats while effective SystemPack capabilities.beats is false'
      )
    );
  }

  const initialWorld = buildInitialSimulationWorldState(bundle, effectiveCaps);
  if (initialWorld === null) {
    return {
      ok: false,
      errors:
        errors.length > 0
          ? errors
          : [
              validationError(
                'initialState',
                'INVALID_INITIAL_STATE',
                'Unable to construct simulation WorldState from cartridge initial state'
              ),
            ],
      warnings,
      reachableBeatIds: [],
      unreachableBeatIds: beats.map((b) => b.id),
      reachableEndingIds: [],
      unreachableEndingIds: endings.map((e) => e.id),
      deadlockStatesDetected: false,
    };
  }
  const initialLedger = createInitialBeatLedger(beats);

  const routeById = new Map<string, RouteDefinition>();
  const routeLockToRoute = new Map<string, RouteDefinition>();
  for (const route of routes) {
    if (route && typeof route.id === 'string' && !routeById.has(route.id)) {
      routeById.set(route.id, route);
    }
    if (route && typeof route.lock === 'string' && !routeLockToRoute.has(route.lock)) {
      routeLockToRoute.set(route.lock, route);
    }
  }

  const endingMarks = new Set<string>();
  for (const ending of endings) {
    if (ending && typeof ending.mark === 'string') {
      endingMarks.add(ending.mark);
    }
  }

  const formsByChar = new Map<string, Set<string>>();
  if (bundle.initialEntities?.forms) {
    for (const form of bundle.initialEntities.forms) {
      if (!form) continue;
      let set = formsByChar.get(form.characterId);
      if (!set) {
        set = new Set();
        formsByChar.set(form.characterId, set);
      }
      set.add(form.id);
    }
  }

  // Classify graph-significant beats vs leaf observational beats
  const referencedBeatIds = new Set<string>();
  for (const beat of beats) {
    if (beat.requires) {
      for (const reqId of beat.requires) referencedBeatIds.add(reqId);
    }
    collectBeatRefsFromAst(beat.when, referencedBeatIds);
    collectBeatRefsFromAst(beat.until, referencedBeatIds);
    collectBeatRefsFromAst(beat.impossible_when, referencedBeatIds);
    collectBeatRefsFromAst(beat.deadline, referencedBeatIds);
  }
  for (const route of routes) {
    collectBeatRefsFromAst(route.when, referencedBeatIds);
  }
  for (const ending of endings) {
    collectBeatRefsFromAst(ending.when, referencedBeatIds);
  }

  const hasMutatingEffects = (list: readonly BeatEffect[] | undefined): boolean =>
    Array.isArray(list) && list.length > 0;

  const significantBeats: BeatDefinition[] = [];
  const leafBeats: BeatDefinition[] = [];
  for (const beat of beats) {
    const isSignificant =
      beat.class === 'gate' ||
      referencedBeatIds.has(beat.id) ||
      beat.deadline !== undefined ||
      beat.impossible_when !== undefined ||
      hasMutatingEffects(beat.on_entry) ||
      hasMutatingEffects(beat.on_resolve) ||
      hasMutatingEffects(beat.on_deadline) ||
      hasMutatingEffects(beat.on_short_circuit) ||
      hasMutatingEffects(beat.on_abort);

    if (isSignificant) {
      significantBeats.push(beat);
    } else {
      leafBeats.push(beat);
    }
  }

  const significantBeatIds = significantBeats
    .map((b) => b.id)
    .sort(compareStringsLexicographic);

  const milestones = collectClockMilestones(
    beats,
    routes,
    endings,
    initialWorld.clocks.day,
    initialWorld.clocks.turn,
    initialWorld.clocks.storyTurn,
    maxTurns
  );

  // Determine initial locked routes (if initialState.flags pre-locks any)
  const initialLockedByGroup = new Map<string, string>();
  for (const route of routes) {
    const group = route.group ?? DEFAULT_ROUTE_GROUP;
    if (!initialLockedByGroup.has(group) && getSafeProperty(initialWorld.flags, route.lock) === true) {
      initialLockedByGroup.set(group, route.id);
    }
  }

  const initialBeatStatuses = new Map<string, BeatStatus>();
  for (const beat of beats) {
    initialBeatStatuses.set(beat.id, 'dormant');
  }

  const makeEnv = (
    state: WorldState,
    beatStatuses: ReadonlyMap<string, BeatStatus>
  ): SatisfiabilityEnv => ({
    state,
    beatStatuses,
    routeLockToRoute,
    endingMarks,
    spatialMode: effectiveCaps.spatialMode,
    formsByChar,
    maxTurnsBudget: options.maxTurns,
    initialDay: initialWorld.clocks.day,
    initialTurn: initialWorld.clocks.turn,
    initialStoryTurn: initialWorld.clocks.storyTurn,
  });

  const reachableBeatSet = new Set<string>();
  const reachableEndingSet = new Set<string>();

  const nodes: ExploreNode[] = [];
  const visitedKeys = new Map<string, number>();
  const queue: number[] = [];

  const enqueueState = (
    parentIdx: number | null,
    state: WorldState,
    ledger: BeatLedgerState,
    beatStatuses: Map<string, BeatStatus>,
    lockedByGroup: Map<string, string>,
    endingTriggered: string | null
  ): void => {
    const key = computeNodeKey(
      state,
      beatStatuses,
      ledger,
      lockedByGroup,
      endingTriggered,
      significantBeatIds
    );
    const existingIdx = visitedKeys.get(key);
    if (existingIdx !== undefined) {
      if (parentIdx !== null && !nodes[parentIdx]!.children.includes(existingIdx)) {
        nodes[parentIdx]!.children.push(existingIdx);
      }
      return;
    }

    if (nodes.length >= maxExploreStates) {
      return;
    }

    const idx = nodes.length;
    const node: ExploreNode = {
      index: idx,
      state,
      ledger,
      beatStatuses,
      lockedByGroup,
      endingTriggered,
      expanded: false,
      canReachEndingDirectly: endingTriggered !== null,
      children: [],
    };
    nodes.push(node);
    visitedKeys.set(key, idx);
    queue.push(idx);
    if (parentIdx !== null) {
      nodes[parentIdx]!.children.push(idx);
    }
  };

  enqueueState(
    null,
    initialWorld,
    initialLedger,
    initialBeatStatuses,
    initialLockedByGroup,
    null
  );

  let budgetReached = false;
  let head = 0;

  while (head < queue.length) {
    const nodeIdx = queue[head]!;
    head += 1;
    const node = nodes[nodeIdx]!;

    const env = makeEnv(node.state, node.beatStatuses);

    // Check reachable leaf observational beats in this state
    for (const leaf of leafBeats) {
      if (reachableBeatSet.has(leaf.id)) {
        continue;
      }
      if (leaf.route !== undefined) {
        const reqRoute = routeById.get(leaf.route);
        if (!reqRoute || getSafeProperty(node.state.flags, reqRoute.lock) !== true) {
          continue;
        }
      }
      if (!areRequiresSatisfiedInMap(leaf, node.beatStatuses)) {
        continue;
      }
      const flexibility = leaf.flexibility ?? 'adaptable';
      const roleCheck = bindBeatRoles(leaf.roles, node.state, {
        allowFallback: flexibility !== 'strict',
      });
      if (!roleCheck.ok) {
        continue;
      }
      if (canSatisfyPredicate(leaf.when, env)) {
        reachableBeatSet.add(leaf.id);
      }
    }

    // If an ending already triggered on this path, check post-ending branches if any
    if (node.endingTriggered !== null) {
      node.canReachEndingDirectly = true;
      node.expanded = true;
      continue;
    }

    // Check which endings can trigger directly from this state
    for (const ending of endings) {
      if (ending.route !== undefined) {
        const reqRoute = routeById.get(ending.route);
        if (!reqRoute || getSafeProperty(node.state.flags, reqRoute.lock) !== true) {
          continue;
        }
      }
      if (canSatisfyPredicate(ending.when, env)) {
        reachableEndingSet.add(ending.id);
        node.canReachEndingDirectly = true;
      }
    }

    // 1. Check concrete deadlines & impossible_when on non-terminal significant beats
    let forcedAutoTransition = false;
    for (const beat of significantBeats) {
      const status = node.beatStatuses.get(beat.id) ?? 'dormant';
      if (isTerminalBeatStatus(status)) {
        continue;
      }
      const rec = getSafeProperty(node.ledger.records, beat.id);

      // Concrete impossible_when
      if (
        beat.impossible_when &&
        evaluatePredicate(beat.impossible_when, {
          state: node.state,
          beatStatuses: node.beatStatuses,
        })
      ) {
        const nextLedger = cloneBeatLedger(node.ledger);
        const nextStatuses = new Map(node.beatStatuses);
        const nextRec = getSafeProperty(nextLedger.records, beat.id);
        if (nextRec) {
          nextRec.status = 'short_circuited';
          if (nextLedger.liveGateId === beat.id) {
            nextLedger.liveGateId = null;
          }
        }
        nextStatuses.set(beat.id, 'short_circuited');
        const nextState = applyEffectsToWorldState(
          node.state,
          beat.id,
          'on_short_circuit',
          beat.on_short_circuit,
          nextRec?.boundRoles ?? {}
        );
        enqueueState(
          nodeIdx,
          nextState,
          nextLedger,
          nextStatuses,
          new Map(node.lockedByGroup),
          null
        );
        forcedAutoTransition = true;
        break;
      }

      // Concrete deadline firing
      if (
        beat.deadline &&
        !rec?.deadlineFired &&
        evaluatePredicate(beat.deadline, {
          state: node.state,
          beatStatuses: node.beatStatuses,
        })
      ) {
        const nextLedger = cloneBeatLedger(node.ledger);
        const nextStatuses = new Map(node.beatStatuses);
        const nextRec = getSafeProperty(nextLedger.records, beat.id);
        const policy = beat.deadlinePolicy ?? 'defer';
        const nextStatus: BeatStatus =
          policy === 'close' ? 'closed' : policy === 'defer' ? 'deferred' : status;
        if (nextRec) {
          nextRec.deadlineFired = true;
          nextRec.status = nextStatus;
          if (nextStatus !== 'live' && nextLedger.liveGateId === beat.id) {
            nextLedger.liveGateId = null;
          }
        }
        nextStatuses.set(beat.id, nextStatus);
        const nextState = applyEffectsToWorldState(
          node.state,
          beat.id,
          'on_deadline',
          beat.on_deadline,
          nextRec?.boundRoles ?? {}
        );
        enqueueState(
          nodeIdx,
          nextState,
          nextLedger,
          nextStatuses,
          new Map(node.lockedByGroup),
          null
        );
        forcedAutoTransition = true;
        break;
      }
    }

    if (forcedAutoTransition) {
      node.expanded = true;
      if (nodes.length >= maxExploreStates) {
        budgetReached = true;
        break;
      }
      continue;
    }

    // 2. Route locking transitions (first-lock-wins per group)
    for (const route of routes) {
      const group = route.group ?? DEFAULT_ROUTE_GROUP;
      if (node.lockedByGroup.has(group)) {
        continue;
      }
      if (!canSatisfyPredicate(route.when, env)) {
        continue;
      }
      const nextState = applyPatchBatch(node.state, {
        eventId: `sim:route:${route.id}:t${node.state.meta.turn}`,
        source: 'beat',
        operations: [{ op: 'route_lock', routeId: route.id, lockFlag: route.lock }],
      });
      if (nextState.ok) {
        const nextLocked = new Map(node.lockedByGroup);
        nextLocked.set(group, route.id);
        enqueueState(
          nodeIdx,
          nextState.value.nextState,
          cloneBeatLedger(node.ledger),
          new Map(node.beatStatuses),
          nextLocked,
          null
        );
      }
    }

    // 3. Beat entry and resolution transitions for significant beats
    const orderedSignificant = [...significantBeats].sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return compareStringsLexicographic(a.id, b.id);
    });

    const liveGateBeat = node.ledger.liveGateId
      ? orderedSignificant.find((b) => b.id === node.ledger.liveGateId)
      : undefined;

    for (const beat of orderedSignificant) {
      const status = node.beatStatuses.get(beat.id) ?? 'dormant';
      if (isTerminalBeatStatus(status)) {
        continue;
      }

      if (beat.route !== undefined) {
        const reqRoute = routeById.get(beat.route);
        if (!reqRoute || getSafeProperty(node.state.flags, reqRoute.lock) !== true) {
          continue;
        }
      }

      if (status === 'dormant' || status === 'deferred' || status === 'eligible') {
        if (!areRequiresSatisfiedInMap(beat, node.beatStatuses)) {
          continue;
        }

        // Check gate priority occupation if another gate is live
        if (
          beat.class === 'gate' &&
          liveGateBeat !== undefined &&
          liveGateBeat.id !== beat.id &&
          (beat.priority < liveGateBeat.priority ||
            (beat.priority === liveGateBeat.priority &&
              compareStringsLexicographic(beat.id, liveGateBeat.id) > 0))
        ) {
          continue;
        }

        const entryAst: PredicateAst = beat.impossible_when
          ? { all: [beat.when, { not: beat.impossible_when }] }
          : beat.when;

        if (!canSatisfyPredicate(entryAst, env)) {
          continue;
        }

        const flexibility = beat.flexibility ?? 'adaptable';
        const roleOutcome = bindBeatRoles(beat.roles, node.state, {
          allowFallback: flexibility !== 'strict',
        });

        if (!roleOutcome.ok) {
          if (flexibility === 'strict') {
            const nextLedger = cloneBeatLedger(node.ledger);
            const nextStatuses = new Map(node.beatStatuses);
            const nextRec = getSafeProperty(nextLedger.records, beat.id);
            if (nextRec) {
              nextRec.status = 'short_circuited';
            }
            nextStatuses.set(beat.id, 'short_circuited');
            const nextState = applyEffectsToWorldState(
              node.state,
              beat.id,
              'on_short_circuit',
              beat.on_short_circuit,
              {}
            );
            enqueueState(
              nodeIdx,
              nextState,
              nextLedger,
              nextStatuses,
              new Map(node.lockedByGroup),
              null
            );
          }
          continue;
        }

        // Enter 'live'
        reachableBeatSet.add(beat.id);
        const nextLedger = cloneBeatLedger(node.ledger);
        const nextStatuses = new Map(node.beatStatuses);
        const nextRec = getSafeProperty(nextLedger.records, beat.id);
        const adapted = Object.values(roleOutcome.bindings).some((b) => b.adapted);

        let nextState = node.state;
        if (nextRec) {
          nextRec.status = 'live';
          nextRec.boundRoles = roleOutcome.bindings;
          nextRec.adapted = adapted;
          if (!nextRec.entryEffectsFired) {
            nextRec.entryEffectsFired = true;
            nextState = applyEffectsToWorldState(
              nextState,
              beat.id,
              'on_entry',
              beat.on_entry,
              roleOutcome.bindings
            );
          }
        }
        if (beat.class === 'gate') {
          if (nextLedger.liveGateId !== null && nextLedger.liveGateId !== beat.id) {
            const prevRec = getSafeProperty(nextLedger.records, nextLedger.liveGateId);
            if (prevRec && prevRec.status === 'live') {
              prevRec.status = 'eligible';
              nextStatuses.set(nextLedger.liveGateId, 'eligible');
            }
          }
          nextLedger.liveGateId = beat.id;
        }
        nextStatuses.set(beat.id, 'live');
        enqueueState(
          nodeIdx,
          nextState,
          nextLedger,
          nextStatuses,
          new Map(node.lockedByGroup),
          null
        );
      } else if (status === 'live') {
        reachableBeatSet.add(beat.id);
        const canResolve =
          beat.until === undefined || canSatisfyPredicate(beat.until, env);
        if (!canResolve) {
          continue;
        }

        const nextLedger = cloneBeatLedger(node.ledger);
        const nextStatuses = new Map(node.beatStatuses);
        const nextRec = getSafeProperty(nextLedger.records, beat.id);
        const targetStatus: BeatStatus = nextRec?.adapted ? 'adapted' : 'resolved';
        if (nextRec) {
          nextRec.status = targetStatus;
        }
        if (nextLedger.liveGateId === beat.id) {
          nextLedger.liveGateId = null;
        }
        nextStatuses.set(beat.id, targetStatus);
        const nextState = applyEffectsToWorldState(
          node.state,
          beat.id,
          'on_resolve',
          beat.on_resolve,
          nextRec?.boundRoles ?? {}
        );
        enqueueState(
          nodeIdx,
          nextState,
          nextLedger,
          nextStatuses,
          new Map(node.lockedByGroup),
          null
        );
      }
    }

    // 4. Advance clocks to next milestones
    const nextDay = milestones.days.find((d) => d > node.state.clocks.day);
    if (nextDay !== undefined) {
      const nextState = {
        ...node.state,
        clocks: {
          ...node.state.clocks,
          day: nextDay,
        },
      };
      enqueueState(
        nodeIdx,
        nextState,
        cloneBeatLedger(node.ledger),
        new Map(node.beatStatuses),
        new Map(node.lockedByGroup),
        null
      );
    }

    const nextTurn = milestones.turns.find((t) => t > node.state.clocks.turn);
    if (nextTurn !== undefined) {
      const nextState = {
        ...node.state,
        meta: {
          ...node.state.meta,
          turn: nextTurn,
        },
        clocks: {
          ...node.state.clocks,
          turn: nextTurn,
        },
      };
      enqueueState(
        nodeIdx,
        nextState,
        cloneBeatLedger(node.ledger),
        new Map(node.beatStatuses),
        new Map(node.lockedByGroup),
        null
      );
    }

    const nextStoryTurn = milestones.storyTurns.find(
      (st) => st > node.state.clocks.storyTurn
    );
    if (nextStoryTurn !== undefined) {
      const nextState = {
        ...node.state,
        clocks: {
          ...node.state.clocks,
          storyTurn: nextStoryTurn,
        },
      };
      enqueueState(
        nodeIdx,
        nextState,
        cloneBeatLedger(node.ledger),
        new Map(node.beatStatuses),
        new Map(node.lockedByGroup),
        null
      );
    }

    node.expanded = true;
    if (nodes.length >= maxExploreStates) {
      budgetReached = true;
      break;
    }
  }

  if (budgetReached) {
    warnings.push(
      validationError(
        '',
        'EXPLORATION_BUDGET_REACHED',
        `Static graph analysis reached maxExploreStates limit (${maxExploreStates})`
      )
    );
  }

  // Classify reachable vs unreachable beats & endings
  const reachableBeatIds: string[] = [];
  const unreachableBeatIds: string[] = [];
  for (const beat of beats) {
    if (reachableBeatSet.has(beat.id)) {
      reachableBeatIds.push(beat.id);
    } else {
      unreachableBeatIds.push(beat.id);
      if (beat.class === 'gate') {
        errors.push(
          validationError(
            `beats.${beat.id}`,
            'UNREACHABLE_GATE',
            `Gate beat "${beat.id}" is unreachable from initial state`
          )
        );
      } else {
        warnings.push(
          validationError(
            `beats.${beat.id}`,
            'UNREACHABLE_BEAT',
            `Beat "${beat.id}" (${beat.class}) is unreachable from initial state`
          )
        );
      }
    }
  }

  const reachableEndingIds: string[] = [];
  const unreachableEndingIds: string[] = [];
  for (const ending of endings) {
    if (reachableEndingSet.has(ending.id)) {
      reachableEndingIds.push(ending.id);
    } else {
      unreachableEndingIds.push(ending.id);
      errors.push(
        validationError(
          `endings.${ending.id}`,
          'UNREACHABLE_ENDING',
          `Ending "${ending.id}" is unreachable from initial state`
        )
      );
    }
  }

  // Compute backward reachability of endings / terminal gate completion for deadlock detection
  let deadlockStatesDetected = false;
  const gateIds = beats.filter((b) => b.class === 'gate').map((b) => b.id);

  if (endings.length > 0) {
    const canReachEnding = new Array<boolean>(nodes.length).fill(false);
    for (let i = 0; i < nodes.length; i += 1) {
      const n = nodes[i]!;
      // Treat unexpanded frontier nodes when budget exhausted as conservatively non-deadlocked
      if (n.canReachEndingDirectly || !n.expanded) {
        canReachEnding[i] = true;
      }
    }

    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < nodes.length; i += 1) {
        if (canReachEnding[i]) continue;
        const n = nodes[i]!;
        for (const childIdx of n.children) {
          if (canReachEnding[childIdx]) {
            canReachEnding[i] = true;
            changed = true;
            break;
          }
        }
      }
    }

    for (let i = 0; i < nodes.length; i += 1) {
      if (!canReachEnding[i]) {
        deadlockStatesDetected = true;
        break;
      }
    }
  } else if (gateIds.length > 0) {
    // No endings defined: check whether all gates can resolve and no expanded sink leaves gates blocked
    const canCompleteAllGates = new Array<boolean>(nodes.length).fill(false);
    for (let i = 0; i < nodes.length; i += 1) {
      const n = nodes[i]!;
      if (!n.expanded) {
        canCompleteAllGates[i] = true;
        continue;
      }
      const allGatesResolved = gateIds.every((gid) => {
        const st = n.beatStatuses.get(gid);
        return st === 'resolved' || st === 'adapted';
      });
      if (allGatesResolved) {
        canCompleteAllGates[i] = true;
      }
    }

    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < nodes.length; i += 1) {
        if (canCompleteAllGates[i]) continue;
        const n = nodes[i]!;
        for (const childIdx of n.children) {
          if (canCompleteAllGates[childIdx]) {
            canCompleteAllGates[i] = true;
            changed = true;
            break;
          }
        }
      }
    }

    for (let i = 0; i < nodes.length; i += 1) {
      if (!canCompleteAllGates[i]) {
        deadlockStatesDetected = true;
        break;
      }
    }
  }

  if (deadlockStatesDetected) {
    errors.push(
      validationError(
        '',
        'DEADLOCK_DETECTED',
        'Deadlock state detected: reachable non-ending state where no gate or ending can become eligible'
      )
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    reachableBeatIds,
    unreachableBeatIds,
    reachableEndingIds,
    unreachableEndingIds,
    deadlockStatesDetected,
  };
}
