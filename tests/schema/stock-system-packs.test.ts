import { describe, expect, it } from 'vitest';
import { isErr, isOk } from '../../src/core/result.js';
import {
  compileActiveTrackerSchema,
  validateSystemPack,
} from '../../src/schema/dynamic-schema-compiler.js';
import {
  STOCK_FREEFORM_PACK,
  STOCK_LIVING_WORLD_PACK,
  STOCK_SLICE_OF_LIFE_PACK,
  STOCK_SYSTEM_PACKS,
  STOCK_TACTICAL_RPG_PACK,
  getStockSystemPack,
} from '../../src/schema/stock-system-packs.js';

describe('Stock System Packs', () => {
  it('exposes all 4 stock system packs with valid specifications', () => {
    expect(Object.keys(STOCK_SYSTEM_PACKS)).toEqual([
      'stock-freeform',
      'stock-slice-of-life',
      'stock-tactical-rpg',
      'stock-living-world',
    ]);

    const packs = [
      STOCK_FREEFORM_PACK,
      STOCK_SLICE_OF_LIFE_PACK,
      STOCK_TACTICAL_RPG_PACK,
      STOCK_LIVING_WORLD_PACK,
    ];

    for (const pack of packs) {
      expect(pack.spec).toBe('system-pack/0.1');
      const validation = validateSystemPack(pack);
      expect(isOk(validation), `Pack ${pack.id} failed validation`).toBe(true);
    }
  });

  it('configures distinct capabilities across the 4 stock packs', () => {
    expect(STOCK_FREEFORM_PACK.capabilities).toEqual({
      spatialMode: 'scene_only',
      combatMode: 'disabled',
      progression: 'disabled',
      clocks: 'disabled',
      factions: false,
      beats: false,
      relationships: false,
      chronicle: false,
    });

    expect(STOCK_SLICE_OF_LIFE_PACK.capabilities).toEqual({
      spatialMode: 'scene_only',
      combatMode: 'disabled',
      progression: 'disabled',
      clocks: 'calendar_only',
      factions: false,
      beats: false,
      relationships: true,
      chronicle: true,
    });

    expect(STOCK_TACTICAL_RPG_PACK.capabilities).toEqual({
      spatialMode: 'emergent',
      combatMode: 'tactical_grid',
      progression: 'rpg_levels',
      clocks: 'calendar_only',
      factions: false,
      beats: true,
      relationships: true,
      chronicle: true,
    });

    expect(STOCK_LIVING_WORLD_PACK.capabilities).toEqual({
      spatialMode: 'authored_graph',
      combatMode: 'traditional',
      progression: 'disabled',
      clocks: 'full_sim',
      factions: true,
      beats: true,
      relationships: true,
      chronicle: true,
    });
  });

  it('returns isolated deep clones from getStockSystemPack and rejects prototype keys', () => {
    expect(getStockSystemPack('non-existent')).toBeUndefined();
    expect(getStockSystemPack('toString')).toBeUndefined();
    expect(getStockSystemPack('constructor')).toBeUndefined();
    expect(getStockSystemPack('__proto__')).toBeUndefined();

    const copy = getStockSystemPack('stock-slice-of-life');
    expect(copy).toBeDefined();
    expect(copy?.id).toBe('stock-slice-of-life');

    // Mutate the clone and verify stock pack remains clean
    copy!.capabilities.factions = true;
    copy!.pcCoreSections.pop();
    copy!.gameSystems.push({
      id: 'mutated_custom',
      name: 'Mutated',
      enabled: true,
      scope: 'session',
      target: 'global',
      effectOwner: 'tracker',
      cadence: 'every_turn',
      fields: {},
      trackerInstruction: '',
      narratorRule: '',
      ui: { widget: 'hidden', order: 99 },
    });

    const fresh = getStockSystemPack('stock-slice-of-life');
    expect(fresh?.capabilities.factions).toBe(false);
    expect(fresh?.pcCoreSections.length).toBe(STOCK_SLICE_OF_LIFE_PACK.pcCoreSections.length);
    expect(fresh?.gameSystems.some((g) => g.id === 'mutated_custom')).toBe(false);
  });

  it('rejects invalid SystemPack payloads in validateSystemPack', () => {
    const badPack = getStockSystemPack('stock-freeform')!;
    const invalidSpecPack = { ...badPack, spec: 'system-pack/999' as unknown as 'system-pack/0.1' };
    const res = validateSystemPack(invalidSpecPack);
    expect(isErr(res)).toBe(true);
    if (isErr(res)) {
      expect(res.error.some((e) => e.path === 'spec' && e.code === 'INVALID_SPEC')).toBe(true);
    }
  });

  it('compiles all 4 stock packs quickly and cleanly across representative turn contexts', () => {
    const start = performance.now();
    for (const pack of Object.values(STOCK_SYSTEM_PACKS)) {
      const compiled = compileActiveTrackerSchema(pack, {
        turn: 5,
        clockAdvancedThisTurn: true,
        combatEndedThisTurn: true,
        manualTrigger: pack.id === 'stock-freeform',
      });
      expect(compiled.trackerJsonSchema).not.toBeNull();
    }
    const elapsedMs = performance.now() - start;
    // Sanity check that compilation is instantaneous (< 25ms for all 4 combined)
    expect(elapsedMs).toBeLessThan(25);
  });
});
