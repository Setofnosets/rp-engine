import { describe, expect, it } from 'vitest';
import type { GridCoord, GridTile, TacticalGrid, TileHazard } from '../../src/combat/grid-types.js';
import {
  chebyshevDistance,
  evaluateLineOfSight,
  findShortestPath,
  getReachableCoords,
  getTileAt,
  octileDistance,
} from '../../src/combat/spatial-math.js';

function createOpenGrid(width: number, height: number): TacticalGrid {
  const tiles: GridTile[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      tiles.push({
        x,
        y,
        passable: true,
        cover: 'none',
        elevation: 0,
        hazard: 'none',
        blocksLos: false,
      });
    }
  }
  return { width, height, theme: 'open', tiles };
}

function withTilePatches(
  grid: TacticalGrid,
  patches: ReadonlyArray<{
    readonly x: number;
    readonly y: number;
    readonly passable?: boolean;
    readonly cover?: 'none' | 'half' | 'full';
    readonly elevation?: number;
    readonly hazard?: TileHazard;
    readonly blocksLos?: boolean;
  }>
): TacticalGrid {
  const nextTiles = grid.tiles.map((tile) => ({ ...tile }));
  for (const patch of patches) {
    const idx = patch.y * grid.width + patch.x;
    const target = nextTiles[idx];
    if (target !== undefined) {
      nextTiles[idx] = {
        ...target,
        ...(patch.passable !== undefined ? { passable: patch.passable } : {}),
        ...(patch.cover !== undefined ? { cover: patch.cover } : {}),
        ...(patch.elevation !== undefined ? { elevation: patch.elevation } : {}),
        ...(patch.hazard !== undefined ? { hazard: patch.hazard } : {}),
        ...(patch.blocksLos !== undefined ? { blocksLos: patch.blocksLos } : {}),
      };
    }
  }
  return { ...grid, tiles: nextTiles };
}

describe('distance metrics and getTileAt', () => {
  it('computes Chebyshev and octile distances accurately', () => {
    expect(chebyshevDistance({ x: 2, y: 3 }, { x: 2, y: 3 })).toBe(0);
    expect(octileDistance({ x: 2, y: 3 }, { x: 2, y: 3 })).toBe(0);

    expect(chebyshevDistance({ x: 0, y: 0 }, { x: 4, y: 2 })).toBe(4);
    expect(octileDistance({ x: 0, y: 0 }, { x: 1, y: 1 })).toBeCloseTo(Math.SQRT2, 12);
    expect(octileDistance({ x: 0, y: 0 }, { x: 4, y: 2 })).toBeCloseTo(2 * Math.SQRT2 + 2, 12);

    // Symmetry
    expect(octileDistance({ x: 1, y: 5 }, { x: 7, y: 2 })).toBeCloseTo(
      octileDistance({ x: 7, y: 2 }, { x: 1, y: 5 }),
      12
    );
  });

  it('returns null for out-of-bounds or non-integer coordinates in getTileAt', () => {
    const grid = createOpenGrid(5, 4);
    expect(getTileAt(grid, { x: 0, y: 0 })).toMatchObject({ x: 0, y: 0, passable: true });
    expect(getTileAt(grid, { x: 4, y: 3 })).toMatchObject({ x: 4, y: 3, passable: true });
    expect(getTileAt(grid, { x: -1, y: 0 })).toBeNull();
    expect(getTileAt(grid, { x: 5, y: 0 })).toBeNull();
    expect(getTileAt(grid, { x: 0, y: 4 })).toBeNull();
    expect(getTileAt(grid, { x: 1.5, y: 2 })).toBeNull();
    expect(getTileAt(grid, { x: Number.NaN, y: 0 })).toBeNull();
  });

  it('handles unordered tile arrays via fallback scan in getTileAt', () => {
    const base = createOpenGrid(3, 3);
    const reversedGrid: TacticalGrid = {
      ...base,
      tiles: [...base.tiles].reverse(),
    };
    const found = getTileAt(reversedGrid, { x: 0, y: 1 });
    expect(found).not.toBeNull();
    expect(found).toMatchObject({ x: 0, y: 1 });
  });
});

describe('evaluateLineOfSight', () => {
  it('returns clear LOS on open grids along orthogonal, diagonal, and sloped rays', () => {
    const grid = createOpenGrid(8, 8);

    const same = evaluateLineOfSight(grid, { x: 2, y: 2 }, { x: 2, y: 2 });
    expect(same).toEqual({ visible: true, cover: 'none', path: [{ x: 2, y: 2 }] });

    const ortho = evaluateLineOfSight(grid, { x: 1, y: 2 }, { x: 5, y: 2 });
    expect(ortho.visible).toBe(true);
    expect(ortho.cover).toBe('none');
    expect(ortho.path).toEqual([
      { x: 1, y: 2 },
      { x: 2, y: 2 },
      { x: 3, y: 2 },
      { x: 4, y: 2 },
      { x: 5, y: 2 },
    ]);

    const diag = evaluateLineOfSight(grid, { x: 0, y: 0 }, { x: 3, y: 3 });
    expect(diag.visible).toBe(true);
    expect(diag.cover).toBe('none');
    expect(diag.path).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
    ]);
  });

  it('aggregates half cover, full cover, and blocking obstacles along the ray', () => {
    const base = createOpenGrid(7, 5);
    const grid = withTilePatches(base, [
      { x: 2, y: 2, cover: 'half', blocksLos: false },
      { x: 4, y: 2, cover: 'full', blocksLos: false },
      { x: 3, y: 4, passable: false, cover: 'full', blocksLos: true },
    ]);

    const half = evaluateLineOfSight(grid, { x: 0, y: 2 }, { x: 3, y: 2 });
    expect(half.visible).toBe(true);
    expect(half.cover).toBe('half');

    const full = evaluateLineOfSight(grid, { x: 0, y: 2 }, { x: 5, y: 2 });
    expect(full.visible).toBe(true);
    expect(full.cover).toBe('full');

    const blocked = evaluateLineOfSight(grid, { x: 1, y: 4 }, { x: 5, y: 4 });
    expect(blocked.visible).toBe(false);
    expect(blocked.cover).toBe('blocked');
  });

  it('ignores blocking and cover on the start and end tiles themselves', () => {
    const base = createOpenGrid(5, 3);
    const grid = withTilePatches(base, [
      { x: 0, y: 1, passable: false, cover: 'full', blocksLos: true },
      { x: 4, y: 1, passable: false, cover: 'full', blocksLos: true },
    ]);

    const res = evaluateLineOfSight(grid, { x: 0, y: 1 }, { x: 4, y: 1 });
    expect(res.visible).toBe(true);
    expect(res.cover).toBe('none');
  });

  it('prevents diagonal corner squeezing between two blocking pillars while allowing single-corner peeking', () => {
    const base = createOpenGrid(5, 5);

    // Single pillar at (1,0), open at (0,1): corner peek should succeed
    const singlePillar = withTilePatches(base, [
      { x: 1, y: 0, passable: false, cover: 'full', blocksLos: true },
    ]);
    const peekAdjacent = evaluateLineOfSight(singlePillar, { x: 0, y: 0 }, { x: 1, y: 1 });
    expect(peekAdjacent.visible).toBe(true);
    expect(peekAdjacent.cover).toBe('none');

    const peekFar = evaluateLineOfSight(singlePillar, { x: 0, y: 0 }, { x: 2, y: 2 });
    expect(peekFar.visible).toBe(true);

    // Two corner pillars at (1,0) and (0,1): diagonal squeeze must be blocked
    const twoPillars = withTilePatches(base, [
      { x: 1, y: 0, passable: false, cover: 'full', blocksLos: true },
      { x: 0, y: 1, passable: false, cover: 'full', blocksLos: true },
    ]);
    const squeezedAdjacent = evaluateLineOfSight(twoPillars, { x: 0, y: 0 }, { x: 1, y: 1 });
    expect(squeezedAdjacent.visible).toBe(false);
    expect(squeezedAdjacent.cover).toBe('blocked');

    const squeezedFar = evaluateLineOfSight(twoPillars, { x: 0, y: 0 }, { x: 3, y: 3 });
    expect(squeezedFar.visible).toBe(false);
    expect(squeezedFar.cover).toBe('blocked');

    // Two half-cover corners grant half cover across the diagonal vertex
    const halfCorners = withTilePatches(base, [
      { x: 1, y: 0, cover: 'half', blocksLos: false },
      { x: 0, y: 1, cover: 'half', blocksLos: false },
    ]);
    const halfCornerDiag = evaluateLineOfSight(halfCorners, { x: 0, y: 0 }, { x: 1, y: 1 });
    expect(halfCornerDiag.visible).toBe(true);
    expect(halfCornerDiag.cover).toBe('half');
  });

  it('maintains strict raycast symmetry (from -> to matches reversed to -> from)', () => {
    const base = createOpenGrid(7, 7);
    const grid = withTilePatches(base, [
      { x: 2, y: 1, cover: 'half', blocksLos: false },
      { x: 3, y: 2, passable: false, cover: 'full', blocksLos: true },
      { x: 4, y: 3, cover: 'half', blocksLos: false },
    ]);

    const pairs: ReadonlyArray<[GridCoord, GridCoord]> = [
      [{ x: 0, y: 0 }, { x: 6, y: 2 }],
      [{ x: 0, y: 0 }, { x: 5, y: 3 }],
      [{ x: 1, y: 0 }, { x: 4, y: 4 }],
      [{ x: 0, y: 2 }, { x: 6, y: 5 }],
      [{ x: 0, y: 0 }, { x: 6, y: 4 }],
    ];

    for (const [a, b] of pairs) {
      const forward = evaluateLineOfSight(grid, a, b);
      const backward = evaluateLineOfSight(grid, b, a);
      expect(forward.visible).toBe(backward.visible);
      expect(forward.cover).toBe(backward.cover);
      expect(forward.path).toEqual([...backward.path].reverse());
    }
  });

  it('returns blocked with empty path when either endpoint is out of bounds', () => {
    const grid = createOpenGrid(4, 4);
    expect(evaluateLineOfSight(grid, { x: -1, y: 0 }, { x: 2, y: 2 })).toEqual({
      visible: false,
      cover: 'blocked',
      path: [],
    });
    expect(evaluateLineOfSight(grid, { x: 1, y: 1 }, { x: 4, y: 2 })).toEqual({
      visible: false,
      cover: 'blocked',
      path: [],
    });
  });
});

describe('findShortestPath and getReachableCoords', () => {
  it('finds minimum-cost 8-way paths around solid obstacles', () => {
    const base = createOpenGrid(6, 5);
    // Vertical wall at x=2, y=0..3 leaving y=4 open
    const grid = withTilePatches(base, [
      { x: 2, y: 0, passable: false, cover: 'full', blocksLos: true },
      { x: 2, y: 1, passable: false, cover: 'full', blocksLos: true },
      { x: 2, y: 2, passable: false, cover: 'full', blocksLos: true },
      { x: 2, y: 3, passable: false, cover: 'full', blocksLos: true },
    ]);

    const res = findShortestPath(grid, { x: 0, y: 1 }, { x: 4, y: 1 });
    expect(res.reachable).toBe(true);
    expect(res.path[0]).toEqual({ x: 0, y: 1 });
    expect(res.path[res.path.length - 1]).toEqual({ x: 4, y: 1 });
    // Optimal 8-way detour goes down to y=4 around (2,3):
    // (0,1)->(1,2)->(1,3)->(2,4)->(3,3)->(4,2)->(4,1) = 6 steps
    expect(res.cost).toBe(6);
    for (const step of res.path) {
      expect(getTileAt(grid, step)?.passable).toBe(true);
    }
  });

  it('applies cost 2 for difficult terrain and routes around when cheaper', () => {
    const base = createOpenGrid(5, 3);
    // Put difficult terrain along direct middle path (1,1), (2,1), (3,1)
    const grid = withTilePatches(base, [
      { x: 1, y: 1, hazard: 'difficult' },
      { x: 2, y: 1, hazard: 'difficult' },
      { x: 3, y: 1, hazard: 'difficult' },
    ]);

    // Direct through difficult would cost 2 + 2 + 2 + 1 = 7
    // Routing via y=0: (0,1)->(1,0)->(2,0)->(3,0)->(4,1) costs 1 + 1 + 1 + 1 = 4!
    const detour = findShortestPath(grid, { x: 0, y: 1 }, { x: 4, y: 1 });
    expect(detour.reachable).toBe(true);
    expect(detour.cost).toBe(4);
    expect(detour.path.some((c) => c.y !== 1)).toBe(true);

    // When entering a single difficult tile is strictly shorter than detouring:
    const singleMud = withTilePatches(base, [
      { x: 1, y: 0, passable: false, blocksLos: true, cover: 'full' },
      { x: 1, y: 1, hazard: 'difficult' },
      { x: 1, y: 2, passable: false, blocksLos: true, cover: 'full' },
    ]);
    const forcedMud = findShortestPath(singleMud, { x: 0, y: 1 }, { x: 2, y: 1 });
    expect(forcedMud.reachable).toBe(true);
    expect(forcedMud.cost).toBe(3); // (0,1) -> (1,1) [2] -> (2,1) [1]
    expect(forcedMud.path).toEqual([
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ]);
  });

  it('prevents diagonal squeezing through two adjacent impassable corner pillars', () => {
    const base = createOpenGrid(4, 4);
    // Seal (0,0) off from (1,1) diagonally using two pillars at (1,0) and (0,1)
    const sealed = withTilePatches(base, [
      { x: 1, y: 0, passable: false, blocksLos: true, cover: 'full' },
      { x: 0, y: 1, passable: false, blocksLos: true, cover: 'full' },
    ]);

    const blocked = findShortestPath(sealed, { x: 0, y: 0 }, { x: 1, y: 1 });
    expect(blocked.reachable).toBe(false);
    expect(blocked.path).toEqual([]);
    expect(blocked.cost).toBe(Number.POSITIVE_INFINITY);

    // With only ONE pillar at (1,0), diagonal step (0,0)->(1,1) is legal
    const singleCorner = withTilePatches(base, [
      { x: 1, y: 0, passable: false, blocksLos: true, cover: 'full' },
    ]);
    const allowed = findShortestPath(singleCorner, { x: 0, y: 0 }, { x: 1, y: 1 });
    expect(allowed.reachable).toBe(true);
    expect(allowed.cost).toBe(1);
    expect(allowed.path).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ]);
  });

  it('rejects impassable or occupied destinations and respects maxCost', () => {
    const base = createOpenGrid(5, 5);
    const grid = withTilePatches(base, [
      { x: 3, y: 3, passable: false, blocksLos: true, cover: 'full' },
    ]);

    const wallGoal = findShortestPath(grid, { x: 0, y: 0 }, { x: 3, y: 3 });
    expect(wallGoal.reachable).toBe(false);
    expect(wallGoal.path).toEqual([]);

    const occupiedGoal = findShortestPath(
      grid,
      { x: 0, y: 0 },
      { x: 2, y: 2 },
      { occupied: [{ x: 2, y: 2 }] }
    );
    expect(occupiedGoal.reachable).toBe(false);
    expect(occupiedGoal.path).toEqual([]);

    // Standing on start even if listed in occupied still resolves start -> start with cost 0
    const selfPath = findShortestPath(
      grid,
      { x: 1, y: 1 },
      { x: 1, y: 1 },
      { occupied: [{ x: 1, y: 1 }] }
    );
    expect(selfPath).toEqual({
      reachable: true,
      path: [{ x: 1, y: 1 }],
      cost: 0,
    });

    // Respects maxCost: wall at (3,3) forces a 5-step detour from (0,0) to (4,4)
    const overBudget = findShortestPath(grid, { x: 0, y: 0 }, { x: 4, y: 4 }, { maxCost: 4 });
    expect(overBudget.reachable).toBe(false);
    expect(overBudget.cost).toBe(Number.POSITIVE_INFINITY);

    const exactBudget = findShortestPath(grid, { x: 0, y: 0 }, { x: 4, y: 4 }, { maxCost: 5 });
    expect(exactBudget.reachable).toBe(true);
    expect(exactBudget.cost).toBe(5);
  });

  it('computes getReachableCoords consistent with findShortestPath maxCost reachability', () => {
    const base = createOpenGrid(6, 6);
    const grid = withTilePatches(base, [
      { x: 2, y: 1, passable: false, blocksLos: true, cover: 'full' },
      { x: 1, y: 2, passable: false, blocksLos: true, cover: 'full' },
      { x: 2, y: 2, hazard: 'difficult' },
      { x: 3, y: 2, hazard: 'fire' },
    ]);
    const start: GridCoord = { x: 1, y: 1 };
    const occupied: readonly GridCoord[] = [{ x: 2, y: 0 }];
    const budget = 3;

    const reachable = getReachableCoords(grid, start, budget, occupied);
    const reachableKeys = new Set(reachable.map((c) => `${c.x},${c.y}`));

    expect(reachableKeys.has('1,1')).toBe(true);
    expect(reachableKeys.has('2,0')).toBe(false); // occupied
    expect(reachableKeys.has('2,2')).toBe(false); // corner-blocked by (2,1) & (1,2) unless reached around in >3

    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        const pathRes = findShortestPath(grid, start, { x, y }, { occupied, maxCost: budget });
        expect(reachableKeys.has(`${x},${y}`)).toBe(pathRes.reachable);
      }
    }

    expect(getReachableCoords(grid, start, 0)).toEqual([start]);
    expect(getReachableCoords(grid, start, -1)).toEqual([]);
    expect(getReachableCoords(grid, { x: -1, y: 0 }, 4)).toEqual([]);
  });
});
