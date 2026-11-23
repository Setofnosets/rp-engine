import { describe, expect, it } from 'vitest';
import type { GridCoord, GridTile, TacticalGrid, TerrainTheme } from '../../src/combat/grid-types.js';
import { findShortestPath, getTileAt } from '../../src/combat/spatial-math.js';
import {
  generateDeploymentCoords,
  generateTacticalGrid,
  rollInitiativeOrder,
} from '../../src/combat/terrain-generator.js';
import { createQueuedRng, createSeededRng } from '../../src/core/prng.js';
import { isErr, isOk } from '../../src/core/result.js';

const ALL_THEMES: readonly TerrainTheme[] = [
  'open',
  'ruins',
  'indoor_keep',
  'street',
  'forest',
];

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      const prop = (value as Record<string, unknown>)[key];
      deepFreeze(prop);
    }
  }
  return value;
}

describe('generateTacticalGrid', () => {
  it('produces byte-identical grids and nextRng for the same seed and theme', () => {
    for (const theme of ALL_THEMES) {
      const rngA = deepFreeze(createSeededRng(`seed-${theme}-42`));
      const rngB = deepFreeze(createSeededRng(`seed-${theme}-42`));

      const resultA = generateTacticalGrid({ width: 12, height: 10, theme, rng: rngA });
      const resultB = generateTacticalGrid({ width: 12, height: 10, theme, rng: rngB });

      expect(isOk(resultA)).toBe(true);
      expect(isOk(resultB)).toBe(true);
      if (!resultA.ok || !resultB.ok) {
        continue;
      }

      expect(JSON.stringify(resultA.value)).toBe(JSON.stringify(resultB.value));
      expect(resultA.value.grid.tiles).toHaveLength(12 * 10);
      expect(resultA.value.nextRng.drawCount).toBeGreaterThan(0);
    }
  });

  it('produces distinct grids for distinct seeds on spacious maps', () => {
    const first = generateTacticalGrid({
      width: 12,
      height: 10,
      theme: 'ruins',
      rng: createSeededRng('alpha-seed'),
    });
    const second = generateTacticalGrid({
      width: 12,
      height: 10,
      theme: 'ruins',
      rng: createSeededRng('beta-seed'),
    });

    expect(isOk(first) && isOk(second)).toBe(true);
    if (first.ok && second.ok) {
      expect(first.value.grid.tiles).not.toEqual(second.value.grid.tiles);
    }
  });

  it('keeps deployment edges passable and connects opposite deployment sides across all themes', () => {
    const seeds = ['deploy-1', 'deploy-2', 'deploy-3', 999, 2026];
    const dimensions: ReadonlyArray<{ width: number; height: number }> = [
      { width: 4, height: 4 },
      { width: 8, height: 6 },
      { width: 14, height: 10 },
    ];

    for (const theme of ALL_THEMES) {
      for (const seed of seeds) {
        for (const { width, height } of dimensions) {
          const result = generateTacticalGrid({
            width,
            height,
            theme,
            rng: createSeededRng(`${theme}-${String(seed)}`),
          });

          expect(isOk(result)).toBe(true);
          if (!result.ok) {
            continue;
          }

          const { grid } = result.value;
          for (let y = 0; y < height; y++) {
            for (const x of [0, 1, width - 2, width - 1]) {
              const tile = getTileAt(grid, { x, y });
              expect(tile).not.toBeNull();
              expect(tile?.passable).toBe(true);
              expect(tile?.blocksLos).toBe(false);
              expect(tile?.cover).toBe('none');
              expect(tile?.hazard).toBe('none');
            }
          }

          const pathResult = findShortestPath(
            grid,
            { x: 0, y: 0 },
            { x: width - 1, y: height - 1 }
          );
          expect(pathResult.reachable).toBe(true);
        }
      }
    }
  });

  it('carves a breach corridor if interior terrain completely blocks traversal', () => {
    // Queue 0.01 floats across interior tiles to force maximum obstacle density.
    const queuedValues = Array.from({ length: 40 }, () => 0.01);
    const rng = createQueuedRng(queuedValues, 'breach-fallback');

    const result = generateTacticalGrid({
      width: 6,
      height: 5,
      theme: 'ruins',
      rng,
    });

    expect(isOk(result)).toBe(true);
    if (!result.ok) {
      return;
    }

    const { grid } = result.value;
    const traversal = findShortestPath(grid, { x: 0, y: 0 }, { x: 5, y: 4 });
    expect(traversal.reachable).toBe(true);
  });

  it('rejects invalid dimensions, themes, and corrupted RNG states with ValidationError[]', () => {
    const validRng = createSeededRng(123);

    const badWidth = generateTacticalGrid({ width: 3, height: 6, theme: 'open', rng: validRng });
    expect(isErr(badWidth)).toBe(true);
    if (badWidth.ok) {
      return;
    }
    expect(badWidth.error.some((e) => e.path === 'width' && e.code === 'INVALID_WIDTH')).toBe(true);

    const badHeight = generateTacticalGrid({ width: 6, height: 2, theme: 'open', rng: validRng });
    expect(isErr(badHeight)).toBe(true);

    const badTheme = generateTacticalGrid({
      width: 6,
      height: 6,
      theme: '__proto__' as TerrainTheme,
      rng: validRng,
    });
    expect(isErr(badTheme)).toBe(true);
    if (!badTheme.ok) {
      expect(badTheme.error.some((e) => e.path === 'theme' && e.code === 'INVALID_THEME')).toBe(true);
    }

    const zeroRng = {
      type: 'xoshiro128**' as const,
      s0: 0,
      s1: 0,
      s2: 0,
      s3: 0,
      drawCount: 0,
    };
    const badRng = generateTacticalGrid({ width: 6, height: 6, theme: 'forest', rng: zeroRng });
    expect(isErr(badRng)).toBe(true);
    if (!badRng.ok) {
      expect(badRng.error.some((e) => e.code === 'INVALID_RNG_STATE')).toBe(true);
    }

    const badQueuedRng = {
      type: 'queued' as const,
      queue: [1.2],
      cursor: 0,
      fallback: validRng,
      drawCount: 0,
    };
    const badQueueRes = generateTacticalGrid({
      width: 6,
      height: 6,
      theme: 'forest',
      rng: badQueuedRng,
    });
    expect(isErr(badQueueRes)).toBe(true);
  });

  it('generates expected theme characteristics across large samples', () => {
    const openRes = generateTacticalGrid({
      width: 24,
      height: 20,
      theme: 'open',
      rng: createSeededRng('stats-check'),
    });
    const forestRes = generateTacticalGrid({
      width: 24,
      height: 20,
      theme: 'forest',
      rng: createSeededRng('stats-check'),
    });
    const keepRes = generateTacticalGrid({
      width: 24,
      height: 20,
      theme: 'indoor_keep',
      rng: createSeededRng('stats-check'),
    });

    expect(openRes.ok && forestRes.ok && keepRes.ok).toBe(true);
    if (!openRes.ok || !forestRes.ok || !keepRes.ok) {
      return;
    }

    const openObstacles = openRes.value.grid.tiles.filter((t) => !t.passable).length;
    const forestDifficult = forestRes.value.grid.tiles.filter((t) => t.hazard === 'difficult').length;
    const openDifficult = openRes.value.grid.tiles.filter((t) => t.hazard === 'difficult').length;
    const keepObstacles = keepRes.value.grid.tiles.filter((t) => !t.passable).length;
    const keepFire = keepRes.value.grid.tiles.filter((t) => t.hazard === 'fire').length;

    expect(keepObstacles).toBeGreaterThan(openObstacles);
    expect(forestDifficult).toBeGreaterThan(openDifficult);
    expect(keepFire).toBeGreaterThan(0);
  });
});

describe('generateDeploymentCoords', () => {
  it('deploys allies on left edge (x=0..1) and enemies on right edge (x=width-2..width-1) across all themes', () => {
    for (const theme of ALL_THEMES) {
      const generated = generateTacticalGrid({
        width: 10,
        height: 8,
        theme,
        rng: createSeededRng(`deploy-coords-${theme}`),
      });
      expect(generated.ok).toBe(true);
      if (!generated.ok) {
        continue;
      }

      const { grid } = generated.value;
      const allies = generateDeploymentCoords(grid, 5, 'ally');
      const enemies = generateDeploymentCoords(grid, 5, 'enemy');

      expect(allies).toHaveLength(5);
      expect(enemies).toHaveLength(5);

      for (const coord of allies) {
        expect(coord.x).toBeGreaterThanOrEqual(0);
        expect(coord.x).toBeLessThanOrEqual(1);
        expect(getTileAt(grid, coord)?.passable).toBe(true);
      }

      for (const coord of enemies) {
        expect(coord.x).toBeGreaterThanOrEqual(grid.width - 2);
        expect(coord.x).toBeLessThanOrEqual(grid.width - 1);
        expect(getTileAt(grid, coord)?.passable).toBe(true);
      }
    }
  });

  it('skips occupied coordinates and impassable tiles without mutating inputs', () => {
    const tiles: GridTile[] = [];
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 6; x++) {
        const isWall = x === 0 && y === 1;
        tiles.push({
          x,
          y,
          passable: !isWall,
          cover: isWall ? 'full' : 'none',
          elevation: 0,
          hazard: 'none',
          blocksLos: isWall,
        });
      }
    }
    const grid: TacticalGrid = { width: 6, height: 4, theme: 'open', tiles };
    const occupied: readonly GridCoord[] = deepFreeze([
      { x: 0, y: 0 },
      { x: 0, y: 2 },
      { x: 0, y: 3 },
    ]);

    const coords = generateDeploymentCoords(grid, 3, 'ally', occupied);
    expect(coords).toHaveLength(3);
    for (const c of coords) {
      expect(getTileAt(grid, c)?.passable).toBe(true);
      expect(occupied.some((o) => o.x === c.x && o.y === c.y)).toBe(false);
    }
    // Column 0 is completely blocked/occupied, so all 3 fall cleanly into column 1.
    expect(coords.every((c) => c.x === 1)).toBe(true);
    expect(generateDeploymentCoords(grid, 0, 'ally')).toEqual([]);
    expect(generateDeploymentCoords(grid, -2, 'enemy')).toEqual([]);
  });
});

describe('rollInitiativeOrder', () => {
  it('produces identical initiative order for the same seed and unit list without mutating inputs', () => {
    const units = deepFreeze([
      { id: 'fighter', initiativeBonus: 2 },
      { id: 'wizard', initiativeBonus: 3 },
      { id: 'rogue', initiativeBonus: 5 },
      { id: 'goblin-1', initiativeBonus: 2 },
    ]);
    const rng = deepFreeze(createSeededRng('init-seed-99'));

    const resA = rollInitiativeOrder(units, rng);
    const resB = rollInitiativeOrder(units, rng);

    expect(resA).toEqual(resB);
    expect(resA.order).toHaveLength(4);
    for (const entry of resA.order) {
      expect(entry.roll).toBeGreaterThanOrEqual(1);
      expect(entry.roll).toBeLessThanOrEqual(20);
      const unit = units.find((u) => u.id === entry.id);
      expect(unit).toBeDefined();
      if (unit !== undefined) {
        expect(entry.total).toBe(entry.roll + unit.initiativeBonus);
      }
    }
    expect(resA.nextRng.drawCount).toBe(4);
  });

  it('breaks ties deterministically by higher initiativeBonus, then lexicographic id', () => {
    // Queue rolls on d20: floor(q * 20) + 1
    // q = 0.5 -> floor(10) + 1 = 11
    // q = 0.4 -> floor(8) + 1 = 9
    // q = 0.3 -> floor(6) + 1 = 7
    const rng = createQueuedRng([0.5, 0.4, 0.4, 0.3], 'init-tie-fallback');
    const units = [
      { id: 'unit-c', initiativeBonus: 1 }, // roll 11, total 12
      { id: 'unit-b', initiativeBonus: 3 }, // roll 9, total 12 (wins tie over unit-c via bonus 3 > 1)
      { id: 'unit-a', initiativeBonus: 3 }, // roll 9, total 12 (same bonus as unit-b, wins tie via id 'unit-a' < 'unit-b')
      { id: 'unit-d', initiativeBonus: 5 }, // roll 7, total 12 (wins all via bonus 5)
    ];

    const result = rollInitiativeOrder(units, rng);
    expect(result.order.map((e) => e.id)).toEqual(['unit-d', 'unit-a', 'unit-b', 'unit-c']);
    expect(result.order.every((e) => e.total === 12)).toBe(true);
  });

  it('handles empty participant arrays cleanly', () => {
    const rng = createSeededRng('empty-init');
    const result = rollInitiativeOrder([], rng);
    expect(result.order).toEqual([]);
    expect(result.nextRng).toEqual(rng);
  });
});
