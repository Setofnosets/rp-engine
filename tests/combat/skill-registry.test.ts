import { describe, expect, it } from 'vitest';
import {
  type PassiveDefinition,
  adjustWillpower,
  evaluatePassiveHooks,
} from '../../src/combat/passives-and-willpower.js';
import {
  type SkillDefinition,
  SkillRegistry,
  createDefaultSkillCatalog,
  validateSkillCatalog,
} from '../../src/combat/skill-registry.js';
import {
  type ActiveStatusEffect,
  applyStatusEffect,
  tickStatusEffects,
} from '../../src/combat/status-effects.js';
import { createQueuedRng, createSeededRng } from '../../src/core/prng.js';

describe('SkillRegistry and skill catalog validation', () => {
  it('builds a valid default skill catalog and returns defensive clones', () => {
    const registry = createDefaultSkillCatalog();
    const list = registry.list();
    expect(list.length).toBeGreaterThanOrEqual(6);

    const fireball = registry.get('fireball');
    expect(fireball).toBeDefined();
    expect(fireball?.category).toBe('spell');
    expect(fireball?.targeting.shape).toBe('aoe_radius');
    expect(fireball?.targeting.radius).toBe(2);

    // Mutate returned copy and verify registry remains intact.
    if (fireball) {
      fireball.resourceCosts['mana'] = 999;
      (fireball.effects as SkillDefinition['effects'][number][]).push({
        type: 'knockback',
        distance: 5,
      });
    }
    const freshFireball = registry.get('fireball');
    expect(freshFireball?.resourceCosts['mana']).toBe(5);
    expect(freshFireball?.effects).toHaveLength(2);

    // Default catalog itself passes validateSkillCatalog.
    const validation = validateSkillCatalog(list);
    expect(validation.ok).toBe(true);
  });

  it('registers valid custom skills and rejects duplicates', () => {
    const registry = new SkillRegistry();
    const customSkill: SkillDefinition = {
      id: 'shield_bash',
      name: 'Shield Bash',
      category: 'skill',
      actionCost: 'bonus',
      resourceCosts: { stamina: 1 },
      cooldownTurns: 2,
      targeting: {
        shape: 'single_enemy',
        minRange: 1,
        maxRange: 1,
        requiresLos: true,
      },
      hitResolution: {
        kind: 'attack_roll',
        stat: 'str',
      },
      effects: [
        { type: 'damage', dice: '1d4', scalingStat: 'str' },
        { type: 'apply_status', statusId: 'stunned', statusDuration: 1, statusIntensity: 1 },
      ],
      tags: ['melee', 'control'],
    };

    const first = registry.register(customSkill);
    expect(first.ok).toBe(true);
    expect(registry.get('shield_bash')?.name).toBe('Shield Bash');

    const dup = registry.register(customSkill);
    expect(dup.ok).toBe(false);
    if (!dup.ok) {
      expect(dup.error.some((e) => e.code === 'DUPLICATE_SKILL_ID')).toBe(true);
    }
  });

  it('rejects invalid skill catalogs including bad dice, bad range, missing save fields, duplicates, and prototype pollution keys', () => {
    const pollutedCosts = JSON.parse('{"__proto__": 1, "mana": 2}') as Record<string, number>;
    const badCatalog = [
      {
        id: 'bad_skill',
        name: 'Broken Spell',
        category: 'spell',
        actionCost: 'action',
        resourceCosts: pollutedCosts,
        targeting: {
          shape: 'aoe_radius',
          minRange: 5,
          maxRange: 2,
          requiresLos: true,
        },
        hitResolution: {
          kind: 'save',
        },
        effects: [
          { type: 'damage', dice: 'invalid_dice' },
          { type: 'apply_status' },
        ],
      },
      {
        id: 'dup_skill',
        name: 'One',
        category: 'attack',
        actionCost: 'action',
        resourceCosts: {},
        targeting: { shape: 'self', minRange: 0, maxRange: 0, requiresLos: false },
        hitResolution: { kind: 'auto' },
        effects: [],
      },
      {
        id: 'dup_skill',
        name: 'Two',
        category: 'attack',
        actionCost: 'action',
        resourceCosts: {},
        targeting: { shape: 'self', minRange: 0, maxRange: 0, requiresLos: false },
        hitResolution: { kind: 'auto' },
        effects: [],
      },
    ];

    const res = SkillRegistry.validateSkillCatalog(badCatalog);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const codes = res.error.map((e) => e.code);
      expect(codes).toContain('FORBIDDEN_KEY');
      expect(codes).toContain('INVALID_RANGE_ORDER');
      expect(codes).toContain('INVALID_NOTATION');
      expect(codes).toContain('DUPLICATE_SKILL_ID');
      expect(codes).toContain('REQUIRED');
    }

    const pollutedId = JSON.parse('{"id":"__proto__"}') as SkillDefinition;
    const reg = new SkillRegistry();
    expect(reg.register(pollutedId).ok).toBe(false);
    expect(reg.get('__proto__')).toBeUndefined();
    expect(reg.get('constructor')).toBeUndefined();
  });
});

describe('Status Effects', () => {
  it('applies refresh, stack_intensity, and ignore stacking policies without mutating inputs', () => {
    const burn1: ActiveStatusEffect = {
      id: 'burning',
      name: 'Burning',
      remainingTurns: 1,
      intensity: 1,
      stackPolicy: 'refresh',
      tickTiming: 'turn_start',
      damageDice: '1d4',
    };
    const burnRefresh: ActiveStatusEffect = { ...burn1, remainingTurns: 3, intensity: 1 };

    const initial: ActiveStatusEffect[] = [];
    const after1 = applyStatusEffect(initial, burn1);
    expect(initial).toHaveLength(0);
    expect(after1).toHaveLength(1);

    const afterRefresh = applyStatusEffect(after1, burnRefresh);
    expect(afterRefresh).toHaveLength(1);
    expect(afterRefresh[0]?.remainingTurns).toBe(3);
    expect(afterRefresh[0]?.intensity).toBe(1);
    expect(after1[0]?.remainingTurns).toBe(1);

    const poison: ActiveStatusEffect = {
      id: 'poison',
      name: 'Poison',
      remainingTurns: 2,
      intensity: 1,
      stackPolicy: 'stack_intensity',
      tickTiming: 'turn_start',
      damageDice: '1d4',
    };
    const s1 = applyStatusEffect([], poison);
    const s2 = applyStatusEffect(s1, { ...poison, remainingTurns: 3, intensity: 2 });
    expect(s2).toHaveLength(1);
    expect(s2[0]?.intensity).toBe(3);
    expect(s2[0]?.remainingTurns).toBe(3);

    const ward: ActiveStatusEffect = {
      id: 'ward',
      name: 'Ward',
      remainingTurns: 2,
      intensity: 1,
      stackPolicy: 'ignore',
      tickTiming: 'turn_end',
    };
    const w1 = applyStatusEffect([], ward);
    const w2 = applyStatusEffect(w1, { ...ward, remainingTurns: 5, intensity: 4 });
    expect(w2).toHaveLength(1);
    expect(w2[0]?.remainingTurns).toBe(2);
    expect(w2[0]?.intensity).toBe(1);
  });

  it('computes deterministic tick damage/healing, decrements durations, expires 0-turn effects, and tracks stun/root', () => {
    const rng = createQueuedRng([0.5, 0.0]); // 1d6 -> 4, 1d4 -> 1
    const statuses: ActiveStatusEffect[] = [
      {
        id: 'burning',
        name: 'Burning',
        remainingTurns: 1,
        intensity: 2,
        stackPolicy: 'stack_intensity',
        tickTiming: 'turn_start',
        damageDice: '1d6',
      },
      {
        id: 'regeneration',
        name: 'Regeneration',
        remainingTurns: 2,
        intensity: 1,
        stackPolicy: 'refresh',
        tickTiming: 'turn_start',
        healDice: '1d4',
      },
      {
        id: 'stunned',
        name: 'Stunned',
        remainingTurns: 1,
        intensity: 1,
        stackPolicy: 'ignore',
        tickTiming: 'turn_end',
        stun: true,
      },
      {
        id: 'rooted',
        name: 'Rooted',
        remainingTurns: 2,
        intensity: 1,
        stackPolicy: 'refresh',
        tickTiming: 'turn_start',
        root: true,
      },
    ];

    const startTick = tickStatusEffects(statuses, 'turn_start', rng);
    expect(startTick.tickDamageTotal).toBe(8); // 4 * intensity 2
    expect(startTick.tickHealingTotal).toBe(1);
    expect(startTick.expiredIds).toEqual(['burning']);
    expect(startTick.isStunned).toBe(true); // stunned ticks on turn_end
    expect(startTick.isRooted).toBe(true); // rooted decremented from 2 -> 1
    expect(startTick.statuses.map((s) => s.id)).toEqual(['regeneration', 'stunned', 'rooted']);

    const endTick = tickStatusEffects(startTick.statuses, 'turn_end', startTick.nextRng);
    expect(endTick.tickDamageTotal).toBe(0);
    expect(endTick.tickHealingTotal).toBe(0);
    expect(endTick.expiredIds).toEqual(['stunned']);
    expect(endTick.isStunned).toBe(false);
    expect(endTick.isRooted).toBe(true);

    // Final turn_start tick expires remaining statuses
    const rng2 = createSeededRng('status-determinism');
    const secondStart = tickStatusEffects(endTick.statuses, 'turn_start', rng2);
    expect(secondStart.expiredIds).toEqual(['regeneration', 'rooted']);
    expect(secondStart.statuses).toHaveLength(0);
    expect(secondStart.isRooted).toBe(false);
  });
});

describe('Passives and Willpower', () => {
  it('enforces maxRecursionDepth and maxTriggersPerTurn to stop infinite reactive counter-attack loops', () => {
    const counterAttack: PassiveDefinition = {
      id: 'riposte',
      name: 'Riposte',
      hook: 'on_damaged',
      priority: 10,
      condition: { minWillpower: 20, maxHpPercent: 100 },
      effect: { type: 'damage', dice: '1d6' },
    };

    const lowPriorityThorns: PassiveDefinition = {
      id: 'thorns',
      name: 'Thorns',
      hook: 'on_damaged',
      priority: 5,
      maxTriggersPerTurn: 1,
      effect: { type: 'damage', flat: 2 },
    };

    let depth = 0;
    let counts: Record<string, number> = {};
    const triggeredByDepth: string[][] = [];

    // Simulate a reactive loop where each counter triggers another on_damaged hook.
    while (depth < 10) {
      const res = evaluatePassiveHooks({
        hook: 'on_damaged',
        passives: [lowPriorityThorns, counterAttack],
        triggerCountsThisTurn: counts,
        recursionDepth: depth,
        maxRecursionDepth: 2,
        actorStats: { hp: 50, maxHp: 100, willpower: 40 },
      });
      if (res.triggered.length === 0) {
        break;
      }
      triggeredByDepth.push(res.triggered.map((p) => p.id));
      counts = res.nextTriggerCounts;
      depth += 1;
    }

    // Depth 0: both riposte (priority 10) and thorns (priority 5) trigger.
    // Depth 1: thorns reached maxTriggersPerTurn=1 so only riposte triggers.
    // Depth 2: riposte triggers one last time (<= maxRecursionDepth 2).
    // Depth 3: blocked by recursionDepth > maxRecursionDepth!
    expect(triggeredByDepth).toEqual([
      ['riposte', 'thorns'],
      ['riposte'],
      ['riposte'],
    ]);
    expect(depth).toBe(3);
    expect(counts['riposte']).toBe(3);
    expect(counts['thorns']).toBe(1);
  });

  it('evaluates willpower and HP percentage conditions safely', () => {
    const berserk: PassiveDefinition = {
      id: 'last_stand',
      name: 'Last Stand',
      hook: 'on_turn_start',
      priority: 10,
      condition: { minWillpower: 30, maxHpPercent: 50 },
      effect: { type: 'apply_status', statusId: 'enraged', statusDuration: 1 },
    };

    const highHp = evaluatePassiveHooks({
      hook: 'on_turn_start',
      passives: [berserk],
      triggerCountsThisTurn: {},
      recursionDepth: 0,
      actorStats: { hp: 60, maxHp: 100, willpower: 50 },
    });
    expect(highHp.triggered).toHaveLength(0);

    const lowWill = evaluatePassiveHooks({
      hook: 'on_turn_start',
      passives: [berserk],
      triggerCountsThisTurn: {},
      recursionDepth: 0,
      actorStats: { hp: 40, maxHp: 100, willpower: 10 },
    });
    expect(lowWill.triggered).toHaveLength(0);

    const eligible = evaluatePassiveHooks({
      hook: 'on_turn_start',
      passives: [berserk],
      triggerCountsThisTurn: {},
      recursionDepth: 0,
      actorStats: { hp: 50, maxHp: 100, willpower: 30 },
    });
    expect(eligible.triggered.map((p) => p.id)).toEqual(['last_stand']);
  });

  it('adjusts willpower and detects shattered and surging threshold crossings', () => {
    expect(adjustWillpower(25, 100, -30)).toEqual({
      next: 0,
      thresholdCrossed: 'shattered',
    });
    expect(adjustWillpower(0, 100, -10)).toEqual({
      next: 0,
      thresholdCrossed: null,
    });
    expect(adjustWillpower(80, 100, 25)).toEqual({
      next: 100,
      thresholdCrossed: 'surging',
    });
    expect(adjustWillpower(100, 100, 10)).toEqual({
      next: 100,
      thresholdCrossed: null,
    });
    expect(adjustWillpower(40, 100, 15)).toEqual({
      next: 55,
      thresholdCrossed: null,
    });
  });
});
