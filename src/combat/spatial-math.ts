import type { CoverLevel, GridCoord, GridTile, TacticalGrid } from './grid-types.js';

/**
 * Result of evaluating line of sight and cover between two grid coordinates.
 */
export interface LineOfSightResult {
  readonly visible: boolean;
  readonly cover: CoverLevel;
  readonly path: GridCoord[];
}

/**
 * Options controlling 8-way A* pathfinding.
 */
export interface PathfindingOptions {
  readonly occupied?: readonly GridCoord[];
  readonly maxCost?: number;
}

/**
 * Result of 8-way A* pathfinding between two grid coordinates.
 */
export interface ShortestPathResult {
  readonly reachable: boolean;
  readonly path: GridCoord[];
  readonly cost: number;
}

interface AStarNode {
  readonly idx: number;
  readonly x: number;
  readonly y: number;
  readonly g: number;
  readonly h: number;
  readonly octile: number;
  readonly f: number;
}

interface DijkstraNode {
  readonly idx: number;
  readonly x: number;
  readonly y: number;
  readonly cost: number;
}

const DIRECTIONS: readonly GridCoord[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
  { x: 1, y: 1 },
  { x: 1, y: -1 },
  { x: -1, y: 1 },
  { x: -1, y: -1 },
];

function isValidGridDimensions(grid: TacticalGrid): boolean {
  return (
    Number.isSafeInteger(grid.width) &&
    Number.isSafeInteger(grid.height) &&
    grid.width > 0 &&
    grid.height > 0
  );
}

function isCoordInBounds(grid: TacticalGrid, coord: GridCoord): boolean {
  return (
    Number.isSafeInteger(coord.x) &&
    Number.isSafeInteger(coord.y) &&
    coord.x >= 0 &&
    coord.x < grid.width &&
    coord.y >= 0 &&
    coord.y < grid.height
  );
}

/**
 * Compute octile distance between two coordinates (`1` orthogonal, `sqrt(2)` diagonal).
 */
export function octileDistance(a: GridCoord, b: GridCoord): number {
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  const min = Math.min(dx, dy);
  const max = Math.max(dx, dy);
  return max + (Math.SQRT2 - 1) * min;
}

/**
 * Compute Chebyshev (8-way uniform grid) distance between two coordinates.
 */
export function chebyshevDistance(a: GridCoord, b: GridCoord): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/**
 * Look up a tile at `coord` on `grid`, returning `null` if out of bounds or invalid.
 */
export function getTileAt(grid: TacticalGrid, coord: GridCoord): GridTile | null {
  if (!isValidGridDimensions(grid) || !isCoordInBounds(grid, coord)) {
    return null;
  }

  const index = coord.y * grid.width + coord.x;
  const direct = grid.tiles[index];
  if (direct !== undefined && direct.x === coord.x && direct.y === coord.y) {
    return direct;
  }

  for (const tile of grid.tiles) {
    if (tile.x === coord.x && tile.y === coord.y) {
      return tile;
    }
  }
  return null;
}

function coverRank(cover: CoverLevel): number {
  switch (cover) {
    case 'none':
      return 0;
    case 'half':
      return 1;
    case 'full':
      return 2;
    case 'blocked':
      return 3;
  }
}

function maxCover(a: CoverLevel, b: CoverLevel): CoverLevel {
  return coverRank(a) >= coverRank(b) ? a : b;
}

function minCover(a: CoverLevel, b: CoverLevel): CoverLevel {
  return coverRank(a) <= coverRank(b) ? a : b;
}

function getTileCoverLevel(tile: GridTile | null): CoverLevel {
  if (tile === null || tile.blocksLos) {
    return 'blocked';
  }
  return tile.cover;
}

function resolveCornerCover(edgeA: GridTile | null, edgeB: GridTile | null): CoverLevel {
  return minCover(getTileCoverLevel(edgeA), getTileCoverLevel(edgeB));
}

/**
 * Evaluate symmetric line of sight and intervening cover between `from` and `to`.
 *
 * Uses exact integer grid raycasting (Amanatides & Woo) with symmetric corner-peeking
 * edge resolution when rays graze a grid vertex, ignoring blocking on `from` and `to` themselves.
 */
export function evaluateLineOfSight(
  grid: TacticalGrid,
  from: GridCoord,
  to: GridCoord
): LineOfSightResult {
  if (getTileAt(grid, from) === null || getTileAt(grid, to) === null) {
    return { visible: false, cover: 'blocked', path: [] };
  }

  const dx = to.x - from.x;
  const dy = to.y - from.y;

  if (dx === 0 && dy === 0) {
    const nx = from.x === 0 ? 0 : from.x;
    const ny = from.y === 0 ? 0 : from.y;
    return {
      visible: true,
      cover: 'none',
      path: [{ x: nx, y: ny }],
    };
  }

  let x = from.x === 0 ? 0 : from.x;
  let y = from.y === 0 ? 0 : from.y;
  const targetX = to.x === 0 ? 0 : to.x;
  const targetY = to.y === 0 ? 0 : to.y;
  const path: GridCoord[] = [{ x, y }];
  let worstCover: CoverLevel = 'none';

  if (dx === 0 || dy === 0) {
    const sx = dx === 0 ? 0 : dx > 0 ? 1 : -1;
    const sy = dy === 0 ? 0 : dy > 0 ? 1 : -1;

    while (x !== targetX || y !== targetY) {
      x += sx;
      y += sy;
      path.push({ x, y });
      if (x !== targetX || y !== targetY) {
        worstCover = maxCover(worstCover, getTileCoverLevel(getTileAt(grid, { x, y })));
      }
    }

    return {
      visible: worstCover !== 'blocked',
      cover: worstCover,
      path,
    };
  }

  const sx = dx > 0 ? 1 : -1;
  const sy = dy > 0 ? 1 : -1;
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);
  const stepX = 2 * absDy;
  const stepY = 2 * absDx;
  let tMaxX = absDy;
  let tMaxY = absDx;

  while (x !== targetX || y !== targetY) {
    if (tMaxX === tMaxY) {
      // Exact vertex crossing: permit peeking unless both flanking corner tiles obstruct.
      const edgeA = getTileAt(grid, { x: x + sx, y });
      const edgeB = getTileAt(grid, { x, y: y + sy });
      worstCover = maxCover(worstCover, resolveCornerCover(edgeA, edgeB));

      x += sx;
      y += sy;
      tMaxX += stepX;
      tMaxY += stepY;
      path.push({ x, y });
    } else if (tMaxX < tMaxY) {
      x += sx;
      tMaxX += stepX;
      path.push({ x, y });
    } else {
      y += sy;
      tMaxY += stepY;
      path.push({ x, y });
    }

    if (x !== targetX || y !== targetY) {
      worstCover = maxCover(worstCover, getTileCoverLevel(getTileAt(grid, { x, y })));
    }
  }

  return {
    visible: worstCover !== 'blocked',
    cover: worstCover,
    path,
  };
}

class MinHeap<T> {
  private readonly items: T[] = [];
  private readonly compare: (a: T, b: T) => number;

  constructor(compare: (a: T, b: T) => number) {
    this.compare = compare;
  }

  get size(): number {
    return this.items.length;
  }

  push(item: T): void {
    this.items.push(item);
    this.bubbleUp(this.items.length - 1);
  }

  pop(): T | undefined {
    if (this.items.length === 0) {
      return undefined;
    }
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0 && last !== undefined) {
      this.items[0] = last;
      this.sinkDown(0);
    }
    return top;
  }

  private bubbleUp(index: number): void {
    let idx = index;
    while (idx > 0) {
      const parentIdx = (idx - 1) >> 1;
      const current = this.items[idx];
      const parent = this.items[parentIdx];
      if (current === undefined || parent === undefined || this.compare(current, parent) >= 0) {
        break;
      }
      this.items[idx] = parent;
      this.items[parentIdx] = current;
      idx = parentIdx;
    }
  }

  private sinkDown(index: number): void {
    let idx = index;
    const len = this.items.length;
    while (true) {
      const leftIdx = idx * 2 + 1;
      const rightIdx = leftIdx + 1;
      let smallestIdx = idx;

      if (leftIdx < len) {
        const left = this.items[leftIdx];
        const smallest = this.items[smallestIdx];
        if (left !== undefined && smallest !== undefined && this.compare(left, smallest) < 0) {
          smallestIdx = leftIdx;
        }
      }
      if (rightIdx < len) {
        const right = this.items[rightIdx];
        const smallest = this.items[smallestIdx];
        if (right !== undefined && smallest !== undefined && this.compare(right, smallest) < 0) {
          smallestIdx = rightIdx;
        }
      }

      if (smallestIdx === idx) {
        break;
      }

      const current = this.items[idx];
      const smallest = this.items[smallestIdx];
      if (current === undefined || smallest === undefined) {
        break;
      }
      this.items[idx] = smallest;
      this.items[smallestIdx] = current;
      idx = smallestIdx;
    }
  }
}

function buildOccupiedIndexSet(
  grid: TacticalGrid,
  start: GridCoord,
  occupied?: readonly GridCoord[]
): Set<number> {
  const occupiedSet = new Set<number>();
  if (occupied === undefined) {
    return occupiedSet;
  }
  for (const coord of occupied) {
    if (!isCoordInBounds(grid, coord)) {
      continue;
    }
    if (coord.x === start.x && coord.y === start.y) {
      continue;
    }
    occupiedSet.add(coord.y * grid.width + coord.x);
  }
  return occupiedSet;
}

function getTileMoveCost(tile: GridTile): number {
  switch (tile.hazard) {
    case 'difficult':
    case 'ice':
      return 2;
    case 'none':
    case 'fire':
    case 'acid':
    case 'electrified':
    case 'sanctuary':
      return 1;
  }
}

/**
 * Compute the high-ground attack bonus (`+1` when the attacker stands at a strictly
 * higher elevation than the defender, `0` otherwise or if either coordinate is invalid).
 */
export function computeHighGroundAttackBonus(
  grid: TacticalGrid,
  attackerCoord: GridCoord,
  defenderCoord: GridCoord
): number {
  const attackerTile = getTileAt(grid, attackerCoord);
  const defenderTile = getTileAt(grid, defenderCoord);
  if (attackerTile === null || defenderTile === null) {
    return 0;
  }
  return attackerTile.elevation > defenderTile.elevation ? 1 : 0;
}

function canStepDiagonal(
  grid: TacticalGrid,
  fromX: number,
  fromY: number,
  dx: number,
  dy: number
): boolean {
  if (dx === 0 || dy === 0) {
    return true;
  }
  const adj1 = getTileAt(grid, { x: fromX + dx, y: fromY });
  const adj2 = getTileAt(grid, { x: fromX, y: fromY + dy });
  // Allow cutting past a single corner, but forbid squeezing between two impassable pillars.
  return (adj1 !== null && adj1.passable) || (adj2 !== null && adj2.passable);
}

function compareAStarNodes(a: AStarNode, b: AStarNode): number {
  if (a.f !== b.f) {
    return a.f - b.f;
  }
  if (a.h !== b.h) {
    return a.h - b.h;
  }
  if (a.octile !== b.octile) {
    return a.octile - b.octile;
  }
  if (a.y !== b.y) {
    return a.y - b.y;
  }
  return a.x - b.x;
}

function compareDijkstraNodes(a: DijkstraNode, b: DijkstraNode): number {
  if (a.cost !== b.cost) {
    return a.cost - b.cost;
  }
  if (a.y !== b.y) {
    return a.y - b.y;
  }
  return a.x - b.x;
}

/**
 * Find a minimum-cost 8-way path between `start` and `goal` using A*.
 *
 * Standard tiles cost `1` movement point; `difficult` hazard tiles cost `2`.
 * Diagonal moves are allowed except when squeezing between two orthogonally adjacent impassable pillars.
 */
export function findShortestPath(
  grid: TacticalGrid,
  start: GridCoord,
  goal: GridCoord,
  options?: PathfindingOptions
): ShortestPathResult {
  const startTile = getTileAt(grid, start);
  const goalTile = getTileAt(grid, goal);

  if (startTile === null || goalTile === null || !startTile.passable || !goalTile.passable) {
    return { reachable: false, path: [], cost: Number.POSITIVE_INFINITY };
  }

  const maxCost = options?.maxCost ?? Number.POSITIVE_INFINITY;
  if (Number.isNaN(maxCost) || maxCost < 0) {
    return { reachable: false, path: [], cost: Number.POSITIVE_INFINITY };
  }

  const width = grid.width;
  const startX = start.x === 0 ? 0 : start.x;
  const startY = start.y === 0 ? 0 : start.y;
  const occupiedSet = buildOccupiedIndexSet(grid, start, options?.occupied);
  const startIdx = startY * width + startX;
  const goalIdx = goal.y * width + goal.x;

  if (startIdx === goalIdx) {
    return {
      reachable: true,
      path: [{ x: startX, y: startY }],
      cost: 0,
    };
  }

  if (occupiedSet.has(goalIdx)) {
    return { reachable: false, path: [], cost: Number.POSITIVE_INFINITY };
  }

  const totalCells = width * grid.height;
  const gScores = new Float64Array(totalCells);
  gScores.fill(Number.POSITIVE_INFINITY);
  const cameFrom = new Int32Array(totalCells);
  cameFrom.fill(-1);
  const closed = new Uint8Array(totalCells);

  const startH = chebyshevDistance(start, goal);
  const startOctile = octileDistance(start, goal);
  gScores[startIdx] = 0;

  const openHeap = new MinHeap<AStarNode>(compareAStarNodes);
  openHeap.push({
    idx: startIdx,
    x: start.x,
    y: start.y,
    g: 0,
    h: startH,
    octile: startOctile,
    f: startH,
  });

  while (openHeap.size > 0) {
    const current: AStarNode | undefined = openHeap.pop();
    if (current === undefined) {
      break;
    }

    if (closed[current.idx] === 1) {
      continue;
    }
    closed[current.idx] = 1;

    if (current.idx === goalIdx) {
      const reversedPath: GridCoord[] = [];
      let cursor = goalIdx;
      while (cursor !== -1) {
        const cy = Math.floor(cursor / width);
        const cx = cursor - cy * width;
        reversedPath.push({ x: cx, y: cy });
        if (cursor === startIdx) {
          break;
        }
        cursor = cameFrom[cursor] ?? -1;
      }
      reversedPath.reverse();
      return {
        reachable: true,
        path: reversedPath,
        cost: current.g,
      };
    }

    for (const dir of DIRECTIONS) {
      const nx: number = current.x + dir.x;
      const ny: number = current.y + dir.y;
      if (nx < 0 || nx >= width || ny < 0 || ny >= grid.height) {
        continue;
      }

      const nIdx = ny * width + nx;
      if (closed[nIdx] === 1 || occupiedSet.has(nIdx)) {
        continue;
      }

      const neighborTile = getTileAt(grid, { x: nx, y: ny });
      if (neighborTile === null || !neighborTile.passable) {
        continue;
      }

      if (!canStepDiagonal(grid, current.x, current.y, dir.x, dir.y)) {
        continue;
      }

      const tentativeG = current.g + getTileMoveCost(neighborTile);
      if (tentativeG > maxCost) {
        continue;
      }

      const knownG = gScores[nIdx] ?? Number.POSITIVE_INFINITY;
      if (tentativeG < knownG) {
        gScores[nIdx] = tentativeG;
        cameFrom[nIdx] = current.idx;
        const h = chebyshevDistance({ x: nx, y: ny }, goal);
        openHeap.push({
          idx: nIdx,
          x: nx,
          y: ny,
          g: tentativeG,
          h,
          octile: octileDistance({ x: nx, y: ny }, goal),
          f: tentativeG + h,
        });
      }
    }
  }

  return { reachable: false, path: [], cost: Number.POSITIVE_INFINITY };
}

/**
 * Return all grid coordinates reachable from `start` within `movementBudget` movement points,
 * ordered deterministically in row-major order.
 */
export function getReachableCoords(
  grid: TacticalGrid,
  start: GridCoord,
  movementBudget: number,
  occupied?: readonly GridCoord[]
): GridCoord[] {
  const startTile = getTileAt(grid, start);
  if (startTile === null || !startTile.passable) {
    return [];
  }
  if (Number.isNaN(movementBudget) || movementBudget < 0) {
    return [];
  }

  const width = grid.width;
  const startX = start.x === 0 ? 0 : start.x;
  const startY = start.y === 0 ? 0 : start.y;
  const totalCells = width * grid.height;
  const occupiedSet = buildOccupiedIndexSet(grid, start, occupied);
  const startIdx = startY * width + startX;

  const bestCost = new Float64Array(totalCells);
  bestCost.fill(Number.POSITIVE_INFINITY);
  const visited = new Uint8Array(totalCells);

  bestCost[startIdx] = 0;
  const heap = new MinHeap<DijkstraNode>(compareDijkstraNodes);
  heap.push({
    idx: startIdx,
    x: startX,
    y: startY,
    cost: 0,
  });

  while (heap.size > 0) {
    const current: DijkstraNode | undefined = heap.pop();
    if (current === undefined) {
      break;
    }

    if (visited[current.idx] === 1) {
      continue;
    }
    visited[current.idx] = 1;

    for (const dir of DIRECTIONS) {
      const nx: number = current.x + dir.x;
      const ny: number = current.y + dir.y;
      if (nx < 0 || nx >= width || ny < 0 || ny >= grid.height) {
        continue;
      }

      const nIdx = ny * width + nx;
      if (visited[nIdx] === 1 || occupiedSet.has(nIdx)) {
        continue;
      }

      const neighborTile = getTileAt(grid, { x: nx, y: ny });
      if (neighborTile === null || !neighborTile.passable) {
        continue;
      }

      if (!canStepDiagonal(grid, current.x, current.y, dir.x, dir.y)) {
        continue;
      }

      const nextCost = current.cost + getTileMoveCost(neighborTile);
      if (nextCost > movementBudget) {
        continue;
      }

      const knownCost = bestCost[nIdx] ?? Number.POSITIVE_INFINITY;
      if (nextCost < knownCost) {
        bestCost[nIdx] = nextCost;
        heap.push({
          idx: nIdx,
          x: nx,
          y: ny,
          cost: nextCost,
        });
      }
    }
  }

  const reachable: GridCoord[] = [];
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < width; x++) {
      if (visited[y * width + x] === 1) {
        reachable.push({ x, y });
      }
    }
  }
  return reachable;
}
