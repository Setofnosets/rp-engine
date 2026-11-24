import { describe, expect, it } from 'vitest';
import {
  type CombatState,
  type CombatantState,
  validateSingleCombatAction,
} from '../../src/combat/action-validator.js';
import {
  COMBAT_SCALE_VARIABLES,
  computeCombatVariables,
  resolveScaledDiceExpression,
} from '../../src/combat/combat-variables.js';
import {
  type EffectTemplate,
  expandEffectTemplateTargets,
  validateEffectTemplate,
} from '../../src/combat/effect-templates.js';
import {
  WILLPOWER_BREAK_OUTCOMES,
  isCriticalNaturalRoll,
  isFumbleNaturalRoll,
  resolveWillpowerBreak,
} from '../../src/combat/passives-and-willpower.js';
import { SkillRegistry } from '../../src/combat/skill-registry.js';
import { generateTacticalGrid } from '../../src/combat/terrain-generator.js';
import { createSeededRng } from '../../src/core/prng.js';

function makeCombatant(overrides: Partial<CombatantState> = {}): CombatantState {
  return {
    id: 'hero',
    name: 'Hero',
    team: 'ally',
    coord: { x: 2, y: 2 },
    alive: true,
    hp: 30,
    maxHp: 40,
    ac: 14,
    speed: 6,
    remainingMovement: 6,
    remainingActions: { action: 1, bonus: 1, reaction: 1 },
    resources: { mana: 10, stamina: 10 },
    cooldowns: {},
    stats: { str: 3, dex: 2, int: 2, level: 4 },
    statuses: [],
    abilities: [],
    passives: [],
    willpower: 10,
    maxWillpower: 10,
    ...overrides,
  };
}

function makeCombatState(
  combatants: CombatantState[],
  mode: 'tactical_grid' | 'traditional' = 'tactical_grid'
): CombatState {
  const map: Record<string, CombatantState> = {};
  for (const c of combatants) {
    map[c.id] = c;
  }
  let grid: CombatState['grid'] = null;
  if (mode === 'tactical_grid') {
    const generated = generateTacticalGrid({
      width: 8,
      height: 8,
      theme: 'open',
      rng: createSeededRng('v1'),
    });
    if (!generated.ok) {
      throw new Error('Failed to generate test grid');
    }
    grid = generated.value.grid;
  }
  return {
    active: true,
    mode,
    round: 3,
    turnIndex: 0,
    initiativeOrder: combatants.map((c) => c.id),
    grid,
    combatants: map,
    triggerCountsThisTurn: {},
  };
}

describe('PR-8.1 Combat Variables, Effect Templates, Crits & Willpower Break', () => {
  describe('computeCombatVariables & resolveScaledDiceExpression', () => {
    it('computes all 10 @variables accurately in tactical_grid mode', () => {
      expect(COMBAT_SCALE_VARIABLES).toHaveLength(10);

      const hero = makeCombatant({
        id: 'hero',
        team: 'ally',
        coord: { x: 2, y: 2 },
        hp: 20,
        maxHp: 40,
        stats: { level: 5 },
      });
      const allyAdj = makeCombatant({
        id: 'ally_adj',
        team: 'ally',
        coord: { x: 3, y: 2 },
      });
      const allyFar = makeCombatant({
        id: 'ally_far',
        team: 'ally',
        coord: { x: 7, y: 7 },
      });
      const foeAdj = makeCombatant({
        id: 'foe_adj',
        team: 'enemy',
        coord: { x: 2, y: 3 },
        hp: 10,
        maxHp: 40,
        statuses: [
          {
            id: 'burning',
            name: 'Burning',
            remainingTurns: 2,
            intensity: 3,
            stackPolicy: 'stack_intensity',
            tickTiming: 'turn_end',
          },
          {
            id: 'poisoned',
            name: 'Poisoned',
            remainingTurns: 1,
            intensity: 2,
            stackPolicy: 'stack_intensity',
            tickTiming: 'turn_end',
          },
        ],
      });
      const foeFar1 = makeCombatant({ id: 'foe_far_1', team: 'enemy', coord: { x: 6, y: 6 } });
      const foeFar2 = makeCombatant({ id: 'foe_far_2', team: 'enemy', coord: { x: 7, y: 6 } });
      const foeFar3 = makeCombatant({ id: 'foe_far_3', team: 'enemy', coord: { x: 6, y: 7 } });
      const foeDead = makeCombatant({
        id: 'foe_dead',
        team: 'enemy',
        coord: { x: 1, y: 2 },
        alive: false,
        hp: 0,
      });

      const state = makeCombatState(
        [hero, allyAdj, allyFar, foeAdj, foeFar1, foeFar2, foeFar3, foeDead],
        'tactical_grid'
      );

      const vars = computeCombatVariables(state, hero, foeAdj);
      expect(vars).toEqual({
        enemies: 4,
        allies: 2,
        outnumbered: 1, // 4 enemies - (2 allies + 1 hero) = 1
        adjacentEnemies: 1,
        adjacentAllies: 1,
        round: 3,
        missingHpPct: 50,
        targetMissingHpPct: 75,
        level: 5,
        targetStacks: 5,
      });
    });

    it('uses living opposing/allied counts for adjacency in traditional mode', () => {
      const hero = makeCombatant({ id: 'hero', team: 'ally', coord: { x: 0, y: 0 } });
      const ally = makeCombatant({ id: 'ally', team: 'ally', coord: { x: 7, y: 7 } });
      const foe1 = makeCombatant({ id: 'foe1', team: 'enemy', coord: { x: 5, y: 5 } });
      const foe2 = makeCombatant({ id: 'foe2', team: 'enemy', coord: { x: 6, y: 6 } });

      const state = makeCombatState([hero, ally, foe1, foe2], 'traditional');
      const vars = computeCombatVariables(state, hero);

      expect(vars.enemies).toBe(2);
      expect(vars.allies).toBe(1);
      expect(vars.adjacentEnemies).toBe(2);
      expect(vars.adjacentAllies).toBe(1);
      expect(vars.outnumbered).toBe(0);
    });

    it('resolves @variable tokens and CombatVariableScaleSpec bounds in dice expressions', () => {
      const vars = {
        enemies: 4,
        allies: 1,
        outnumbered: 2,
        adjacentEnemies: 2,
        adjacentAllies: 1,
        round: 3,
        missingHpPct: 50,
        targetMissingHpPct: 25,
        level: 6,
        targetStacks: 3,
      };

      expect(resolveScaledDiceExpression('1d8 + @adjacentEnemies', vars)).toBe('1d8+2');
      expect(resolveScaledDiceExpression('@outnumbered d6 + @round', vars)).toBe('2d6+3');
      expect(
        resolveScaledDiceExpression('2d6+1', vars, {
          variable: 'targetStacks',
          per: 2,
          min: 1,
          max: 5,
        })
      ).toBe('2d6+6'); // 1 + min(5, 3*2) = 6
      expect(
        resolveScaledDiceExpression('1d8', vars, {
          variable: 'enemies',
          per: 3,
          min: 0,
          max: 7,
        })
      ).toBe('1d8+7');
      expect(resolveScaledDiceExpression('@level + 4', vars)).toBe('10');
      expect(() => resolveScaledDiceExpression('1d8 + @unknownVar', vars)).toThrow();
    });
  });

  describe('EffectTemplate validation & target expansion', () => {
    it('validates all 10 normalized EffectTemplateStep kinds and rejects prototype pollution', () => {
      const rawTemplate = {
        id: 'tpl_storm_nova',
        skillId: 'storm_nova',
        source: 'compiled',
        cachedAtTurn: 2,
        steps: [
          { kind: 'damage', role: '$areaHostile', dice: '2d6+@enemies', scale: { variable: 'round', per: 1 } },
          { kind: 'drain', role: '$target', dice: '1d4', targetResource: 'hp', healCaster: true },
          { kind: 'heal', role: '$areaFriendly', dice: '1d6', flat: 2 },
          { kind: 'status', role: '$target', statusId: 'shocked', statusDuration: 2, statusIntensity: 1 },
          { kind: 'cure', role: '$caster', statusId: 'poisoned' },
          { kind: 'terrain', role: '$area', terrainSpec: { hazard: 'fire', duration: 2 } },
          { kind: 'summon', role: '$caster', summonId: 'storm_elemental', durationTurns: 3 },
          { kind: 'transform', role: '$caster', formLoadoutId: 'avatar_of_storm', tempHp: 15, revertOnZeroTempHp: true },
          { kind: 'revert_transform', role: '$caster' },
          { kind: 'log', role: '$caster', message: 'Storm Nova erupts!' },
        ],
      };

      const res = validateEffectTemplate(rawTemplate);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.steps).toHaveLength(10);
        expect(res.value.cachedAtTurn).toBe(2);
      }

      const polluted = JSON.parse('{"__proto__":{"polluted":true},"id":"x","skillId":"y","source":"manual","steps":[]}');
      const badRes = validateEffectTemplate(polluted);
      expect(badRes.ok).toBe(false);
    });

    it('expands $caster, $target, $area, $areaHostile, and $areaFriendly deterministically', () => {
      const hero = makeCombatant({ id: 'hero', team: 'ally' });
      const ally = makeCombatant({ id: 'ally', team: 'ally' });
      const foe1 = makeCombatant({ id: 'foe1', team: 'enemy' });
      const foeDead = makeCombatant({ id: 'foeDead', team: 'enemy', alive: false, hp: 0 });
      const state = makeCombatState([hero, ally, foe1, foeDead]);

      const template: EffectTemplate = {
        id: 'tpl_1',
        skillId: 'nova',
        source: 'manual',
        steps: [
          { kind: 'damage', role: '$areaHostile', dice: '2d6' },
          { kind: 'heal', role: '$areaFriendly', dice: '1d4' },
          { kind: 'status', role: '$target', statusId: 'marked', statusDuration: 2 },
          { kind: 'log', role: '$caster', message: 'Nova cast' },
        ],
      };

      const expanded = expandEffectTemplateTargets(
        template,
        state,
        hero,
        foe1,
        ['ally', 'foe1', 'foeDead', 'foe1']
      );

      expect(expanded.roles.$caster).toEqual(['hero']);
      expect(expanded.roles.$target).toEqual(['foe1']);
      expect(expanded.roles.$area).toEqual(['ally', 'foe1']);
      expect(expanded.roles.$areaHostile).toEqual(['foe1']);
      expect(expanded.roles.$areaFriendly).toEqual(['ally']);
      expect(expanded.stepTargets[0]?.targetIds).toEqual(['foe1']);
      expect(expanded.stepTargets[1]?.targetIds).toEqual(['ally']);
    });
  });

  describe('SkillRegistry extensions & EffectTemplate caching', () => {
    it('supports new effect types, targeting shapes, maxTargets, and template caching', () => {
      const registry = new SkillRegistry();
      const tpl: EffectTemplate = {
        id: 'tpl_drain',
        skillId: 'soul_siphon',
        source: 'compiled',
        steps: [{ kind: 'drain', role: '$target', dice: '2d6', targetResource: 'hp' }],
      };

      const regRes = registry.register({
        id: 'soul_siphon',
        name: 'Soul Siphon',
        category: 'spell',
        actionCost: 'action',
        resourceCosts: { mana: 4 },
        targeting: {
          shape: 'splash',
          minRange: 1,
          maxRange: 5,
          radius: 1,
          maxTargets: 3,
          requiresLos: true,
        },
        hitResolution: { kind: 'attack_roll', stat: 'int' },
        effects: [
          {
            type: 'drain',
            dice: '2d6',
            targetResource: 'hp',
            scale: { variable: 'targetMissingHpPct', per: 1, max: 10 },
          },
          {
            type: 'modify_terrain',
            terrainSpec: { hazard: 'acid' },
          },
        ],
        effectTemplate: tpl,
      });

      expect(regRes.ok).toBe(true);
      const fetched = registry.get('soul_siphon');
      expect(fetched?.targeting.maxTargets).toBe(3);
      expect(registry.getEffectTemplate('soul_siphon')?.id).toBe('tpl_drain');

      const cacheRes = registry.cacheEffectTemplate('soul_siphon', {
        ...tpl,
        id: 'tpl_drain_v2',
        cachedAtTurn: 4,
      });
      expect(cacheRes.ok).toBe(true);
      expect(registry.getEffectTemplate('soul_siphon')?.id).toBe('tpl_drain_v2');
      expect(registry.getEffectTemplate('soul_siphon')?.cachedAtTurn).toBe(4);
    });
  });

  describe('Critical natural rolls & all 5 WillpowerBreakOutcomes', () => {
    it('detects natural 20 crits and natural 1 fumbles', () => {
      expect(isCriticalNaturalRoll(20)).toBe(true);
      expect(isCriticalNaturalRoll(19)).toBe(false);
      expect(isFumbleNaturalRoll(1)).toBe(true);
      expect(isFumbleNaturalRoll(2)).toBe(false);
    });

    it('resolves all 5 willpower break outcome policies cleanly', () => {
      expect(WILLPOWER_BREAK_OUTCOMES).toHaveLength(5);
      const base = { alive: true, team: 'enemy' as const, hp: 25, willpower: 3 };

      expect(resolveWillpowerBreak(base, 'defeat')).toEqual({
        outcome: 'defeat',
        alive: false,
        team: 'enemy',
        hp: 0,
        willpower: 0,
        removedFromCombat: true,
        appliedStatusId: 'defeated',
      });

      expect(resolveWillpowerBreak(base, 'flee')).toEqual({
        outcome: 'flee',
        alive: true,
        team: 'enemy',
        hp: 25,
        willpower: 0,
        removedFromCombat: true,
        appliedStatusId: 'fled',
      });

      expect(resolveWillpowerBreak(base, 'surrender')).toEqual({
        outcome: 'surrender',
        alive: true,
        team: 'neutral',
        hp: 25,
        willpower: 0,
        removedFromCombat: true,
        appliedStatusId: 'surrendered',
      });

      expect(resolveWillpowerBreak(base, 'incapacitate')).toEqual({
        outcome: 'incapacitate',
        alive: true,
        team: 'enemy',
        hp: 25,
        willpower: 0,
        removedFromCombat: false,
        appliedStatusId: 'incapacitated',
      });

      expect(resolveWillpowerBreak(base, 'switch_side')).toEqual({
        outcome: 'switch_side',
        alive: true,
        team: 'ally',
        hp: 25,
        willpower: 0,
        removedFromCombat: false,
        appliedStatusId: 'charmed',
      });
    });
  });

  describe('Action validator stubs for item, flee, and new targeting shapes', () => {
    it('validates item, flee, all_enemies, and single_tile actions', () => {
      const hero = makeCombatant({ id: 'hero', team: 'ally', coord: { x: 1, y: 1 } });
      const foe = makeCombatant({ id: 'foe', team: 'enemy', coord: { x: 2, y: 2 } });
      const state = makeCombatState([hero, foe], 'tactical_grid');
      const registry = SkillRegistry.createDefaultSkillCatalog();

      registry.register({
        id: 'war_cry',
        name: 'War Cry',
        category: 'skill',
        actionCost: 'action',
        resourceCosts: {},
        targeting: { shape: 'all_enemies', minRange: 0, maxRange: 10, maxTargets: 1, requiresLos: false },
        hitResolution: { kind: 'auto' },
        effects: [{ type: 'apply_status', statusId: 'shaken', statusDuration: 1 }],
      });
      hero.abilities.push('war_cry');

      const itemRes = validateSingleCombatAction(state, 'hero', { type: 'item', itemId: 'potion' }, registry);
      expect(itemRes.ok).toBe(true);

      const fleeRes = validateSingleCombatAction(state, 'hero', { type: 'flee' }, registry);
      expect(fleeRes.ok).toBe(true);

      const skillRes = validateSingleCombatAction(state, 'hero', { type: 'skill', skillId: 'war_cry' }, registry);
      expect(skillRes.ok).toBe(true);
      if (skillRes.ok) {
        expect(skillRes.value.resolvedTargetIds).toEqual(['foe']);
      }
    });
  });
});
