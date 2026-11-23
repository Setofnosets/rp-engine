import { type ValidationError } from '../core/errors.js';
import { type RngState, nextFloat, nextInt } from '../core/prng.js';
import { ErrorAccumulator, type Result, err, ok } from '../core/result.js';
import type { GridCoord, GridTile, TacticalGrid, TerrainTheme, TileHazard } from './grid-types.js';
import { getTileAt } from './spatial-math.js';

/**
 * Options for generating a deterministic tactical grid.
 */
export interface GenerateTacticalGridOptions {
  readonly width: number;
  readonly height: number;
  readonly theme: TerrainTheme;
  readonly rng: RngState;
}

/**
 * Generated tactical grid paired with the advanced PRNG state.
 */
export interface GeneratedTacticalGrid {
  readonly grid: TacticalGrid;
  readonly nextRng: RngState;
}

/**
 * Initiative descriptor for a combatant participating in initiative resolution.
 */
export interface InitiativeParticipant {
  readonly id: string;
  readonly initiativeBonus: number;
}

/**
 * Resolved initiative entry for a combatant.
 */
export interface InitiativeEntry {
  readonly id: string;
  readonly roll: number;
  readonly total: number;
}

/**
 * Deterministic initiative resolution output.
 */
export interface InitiativeOrderResult {
  readonly order: InitiativeEntry[];
  readonly nextRng: RngState;
}

interface ThemeProfile {
  readonly obstacleProb: number;
  readonly halfCoverProb: number;
  readonly difficultProb: number;
  readonly specialHazard: TileHazard;
  readonly specialHazardProb: number;
  readonly elevationProb: number;
}

const MIN_GRID_WIDTH = 4;
const MIN_GRID_HEIGHT = 4;
const MAX_GRID_DIMENSION = 256;

const VALID_THEMES: ReadonlySet<string> = new Set<TerrainTheme>([
  'open',
  'ruins',
  'indoor_keep',
  'street',
  'forest',
]);

const THEME_PROFILES: ReadonlyMap<TerrainTheme, ThemeProfile> = new Map<TerrainTheme, ThemeProfile>([
  [
    'open',
    {
      obstacleProb: 0.02,
      halfCoverProb: 0.06,
      difficultProb: 0.08,
      specialHazard: 'none',
      specialHazardProb: 0,
      elevationProb: 0.05,
    },
  ],
  [
    'ruins',
    {
      obstacleProb: 0.14,
      halfCoverProb: 0.14,
      difficultProb: 0.18,
      specialHazard: 'acid',
      specialHazardProb: 0.03,
      elevationProb: 0.1,
    },
  ],
  [
    'indoor_keep',
    {
      obstacleProb: 0.16,
      halfCoverProb: 0.12,
      difficultProb: 0.06,
      specialHazard: 'fire',
      specialHazardProb: 0.05,
      elevationProb: 0.08,
    },
  ],
  [
    'street',
    {
      obstacleProb: 0.16,
      halfCoverProb: 0.14,
      difficultProb: 0.08,
      specialHazard: 'fire',
      specialHazardProb: 0.03,
      elevationProb: 0.04,
    },
  ],
  [
    'forest',
    {
      obstacleProb: 0.15,
      halfCoverProb: 0.14,
      difficultProb: 0.24,
      specialHazard: 'acid',
      specialHazardProb: 0.03,
      elevationProb: 0.1,
    },
  ],
]);

function isUint32(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

function validateRngState(rng: unknown, acc: ErrorAccumulator): rng is RngState {
  if (typeof rng !== 'object' || rng === null || Array.isArray(rng)) {
    acc.add('rng', 'INVALID_RNG_STATE', 'rng must be a valid RngState object');
    return false;
  }

  const candidate = rng as Partial<RngState>;
  if (candidate.type === 'xoshiro128**') {
    if (
      !isUint32(candidate.s0) ||
      !isUint32(candidate.s1) ||
      !isUint32(candidate.s2) ||
      !isUint32(candidate.s3)
    ) {
      acc.add('rng', 'INVALID_RNG_STATE', 'xoshiro128** state words must be unsigned 32-bit integers');
      return false;
    }
    if ((candidate.s0 | candidate.s1 | candidate.s2 | candidate.s3) === 0) {
      acc.add('rng', 'INVALID_RNG_STATE', 'xoshiro128** state words cannot all be zero');
      return false;
    }
    if (typeof candidate.drawCount !== 'number' || !Number.isSafeInteger(candidate.drawCount) || candidate.drawCount < 0) {
      acc.add('rng.drawCount', 'INVALID_RNG_STATE', 'rng.drawCount must be a non-negative safe integer');
      return false;
    }
    return true;
  }

  if (candidate.type === 'queued') {
    if (!Array.isArray(candidate.queue)) {
      acc.add('rng.queue', 'INVALID_RNG_STATE', 'queued rng must contain a queue array');
      return false;
    }
    for (let i = 0; i < candidate.queue.length; i++) {
      const val = candidate.queue[i];
      if (typeof val !== 'number' || !Number.isFinite(val) || val < 0 || val >= 1) {
        acc.add(
          `rng.queue[${i}]`,
          'INVALID_RNG_STATE',
          `queued rng value at index ${i} must be a finite number in [0, 1)`
        );
        return false;
      }
    }
    if (typeof candidate.cursor !== 'number' || !Number.isSafeInteger(candidate.cursor) || candidate.cursor < 0) {
      acc.add('rng.cursor', 'INVALID_RNG_STATE', 'queued rng cursor must be a non-negative safe integer');
      return false;
    }
    if (typeof candidate.drawCount !== 'number' || !Number.isSafeInteger(candidate.drawCount) || candidate.drawCount < 0) {
      acc.add('rng.drawCount', 'INVALID_RNG_STATE', 'rng.drawCount must be a non-negative safe integer');
      return false;
    }
    return validateRngState(candidate.fallback, acc.scope('fallback'));
  }

  acc.add('rng.type', 'INVALID_RNG_STATE', 'rng.type must be "xoshiro128**" or "queued"');
  return false;
}

function isDeploymentColumn(x: number, width: number): boolean {
  return x <= 1 || x >= width - 2;
}

function hasDeploymentConnectivity(tiles: readonly GridTile[], width: number, height: number): boolean {
  const total = width * height;
  const visited = new Uint8Array(total);
  const queue: number[] = [0];
  visited[0] = 1;

  const targetX = width - 1;
  let head = 0;

  while (head < queue.length) {
    const idx = queue[head] as number;
    head += 1;

    const cy = Math.floor(idx / width);
    const cx = idx - cy * width;
    if (cx === targetX) {
      return true;
    }

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) {
          continue;
        }
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
          continue;
        }
        const nIdx = ny * width + nx;
        if (visited[nIdx] === 1) {
          continue;
        }
        const neighbor = tiles[nIdx];
        if (neighbor === undefined || !neighbor.passable) {
          continue;
        }
        if (dx !== 0 && dy !== 0) {
          const adj1 = tiles[cy * width + (cx + dx)];
          const adj2 = tiles[(cy + dy) * width + cx];
          if ((adj1 === undefined || !adj1.passable) && (adj2 === undefined || !adj2.passable)) {
            continue;
          }
        }
        visited[nIdx] = 1;
        queue.push(nIdx);
      }
    }
  }

  return false;
}

/**
 * Generate a deterministic tactical combat grid for a given dimension and {@link TerrainTheme}.
 *
 * Guarantees that deployment edge columns (`x = 0..1` and `x = width-2..width-1`) remain
 * passable and unobstructed, and guarantees at least one passable path connects opposite deployment edges.
 */
export function generateTacticalGrid(
  options: GenerateTacticalGridOptions
): Result<GeneratedTacticalGrid, ValidationError[]> {
  const acc = new ErrorAccumulator();

  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    acc.add('', 'INVALID_OPTIONS', 'options must be an object');
    return err([...acc.errors]);
  }

  if (
    typeof options.width !== 'number' ||
    !Number.isSafeInteger(options.width) ||
    options.width < MIN_GRID_WIDTH ||
    options.width > MAX_GRID_DIMENSION
  ) {
    acc.add(
      'width',
      'INVALID_WIDTH',
      `width must be an integer between ${MIN_GRID_WIDTH} and ${MAX_GRID_DIMENSION}; received ${String(options.width)}`
    );
  }

  if (
    typeof options.height !== 'number' ||
    !Number.isSafeInteger(options.height) ||
    options.height < MIN_GRID_HEIGHT ||
    options.height > MAX_GRID_DIMENSION
  ) {
    acc.add(
      'height',
      'INVALID_HEIGHT',
      `height must be an integer between ${MIN_GRID_HEIGHT} and ${MAX_GRID_DIMENSION}; received ${String(options.height)}`
    );
  }

  if (typeof options.theme !== 'string' || !VALID_THEMES.has(options.theme)) {
    acc.add(
      'theme',
      'INVALID_THEME',
      `theme must be one of "open", "ruins", "indoor_keep", "street", or "forest"; received ${String(options.theme)}`
    );
  }

  validateRngState(options.rng, acc);

  if (acc.hasErrors()) {
    return err([...acc.errors]);
  }

  const { width, height, theme } = options;
  const profile = THEME_PROFILES.get(theme);
  if (profile === undefined) {
    acc.add('theme', 'INVALID_THEME', `Unsupported theme "${String(theme)}"`);
    return err([...acc.errors]);
  }

  let currentRng = options.rng;
  const tiles: GridTile[] = [];
  const centerRow = Math.floor(height / 2);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (isDeploymentColumn(x, width)) {
        tiles.push({
          x,
          y,
          passable: true,
          cover: 'none',
          elevation: 0,
          hazard: 'none',
          blocksLos: false,
        });
        continue;
      }

      const featureStep = nextFloat(currentRng);
      currentRng = featureStep.nextState;
      const roll = featureStep.value;

      // Street theme keeps a mostly open central lane for urban thoroughfare geometry.
      const isStreetCenterLane =
        theme === 'street' && Math.abs(y - centerRow) <= (height >= 7 ? 1 : 0);
      const obstacleProb = isStreetCenterLane ? 0 : profile.obstacleProb;

      // Keep pillar-like cadence slightly elevated on keep intersections when spacious.
      const isKeepPillarAnchor =
        theme === 'indoor_keep' &&
        width >= 8 &&
        height >= 6 &&
        x % 3 === 0 &&
        y % 2 === 1 &&
        y < height - 1;

      let passable = true;
      let cover: 'none' | 'half' | 'full' = 'none';
      let hazard: TileHazard = 'none';
      let blocksLos = false;
      let elevation = 0;

      if (isKeepPillarAnchor) {
        const pillarStep = nextFloat(currentRng);
        currentRng = pillarStep.nextState;
        if (pillarStep.value < 0.75) {
          passable = false;
          cover = 'full';
          blocksLos = true;
        }
      } else if (roll < obstacleProb) {
        passable = false;
        cover = 'full';
        blocksLos = true;
      } else if (roll < obstacleProb + profile.halfCoverProb) {
        cover = 'half';
        if (theme === 'forest') {
          const brushStep = nextFloat(currentRng);
          currentRng = brushStep.nextState;
          if (brushStep.value < 0.5) {
            hazard = 'difficult';
          }
        }
      } else if (roll < obstacleProb + profile.halfCoverProb + profile.difficultProb) {
        hazard = 'difficult';
      } else if (
        profile.specialHazard !== 'none' &&
        roll < obstacleProb + profile.halfCoverProb + profile.difficultProb + profile.specialHazardProb
      ) {
        hazard = profile.specialHazard;
      }

      if (passable) {
        const elevChanceStep = nextFloat(currentRng);
        currentRng = elevChanceStep.nextState;
        if (elevChanceStep.value < profile.elevationProb) {
          const elevLevelStep = nextInt(currentRng, 1, 2);
          currentRng = elevLevelStep.nextState;
          elevation = elevLevelStep.value;
        }
      }

      tiles.push({
        x,
        y,
        passable,
        cover,
        elevation,
        hazard,
        blocksLos,
      });
    }
  }

  // Guarantee a passable corridor between left and right deployment zones.
  if (!hasDeploymentConnectivity(tiles, width, height)) {
    const rowStep = nextInt(currentRng, 0, height - 1);
    currentRng = rowStep.nextState;
    const breachRow = rowStep.value;
    for (let x = 2; x <= width - 3; x++) {
      const idx = breachRow * width + x;
      const existing = tiles[idx];
      if (existing !== undefined && !existing.passable) {
        tiles[idx] = {
          x,
          y: breachRow,
          passable: true,
          cover: 'none',
          elevation: existing.elevation,
          hazard: 'none',
          blocksLos: false,
        };
      }
    }
  }

  return ok({
    grid: {
      width,
      height,
      theme,
      tiles,
    },
    nextRng: currentRng,
  });
}

function getCenteredRowOrder(height: number): number[] {
  const order: number[] = [];
  const mid = Math.floor((height - 1) / 2);
  order.push(mid);
  for (let offset = 1; order.length < height; offset++) {
    if (mid + offset < height) {
      order.push(mid + offset);
    }
    if (mid - offset >= 0) {
      order.push(mid - offset);
    }
  }
  return order;
}

/**
 * Compute deterministic deployment coordinates on the requested side (`ally` = left edges `x=0..1`,
 * `enemy` = right edges `x=width-2..width-1`), skipping impassable or already-occupied coordinates.
 */
export function generateDeploymentCoords(
  grid: TacticalGrid,
  count: number,
  side: 'ally' | 'enemy',
  occupied?: readonly GridCoord[]
): GridCoord[] {
  if (
    !Number.isSafeInteger(count) ||
    count <= 0 ||
    !Number.isSafeInteger(grid.width) ||
    !Number.isSafeInteger(grid.height) ||
    grid.width <= 0 ||
    grid.height <= 0
  ) {
    return [];
  }

  const taken = new Set<number>();
  if (occupied !== undefined) {
    for (const coord of occupied) {
      if (
        Number.isSafeInteger(coord.x) &&
        Number.isSafeInteger(coord.y) &&
        coord.x >= 0 &&
        coord.x < grid.width &&
        coord.y >= 0 &&
        coord.y < grid.height
      ) {
        taken.add(coord.y * grid.width + coord.x);
      }
    }
  }

  const columnOrder: number[] = [];
  if (side === 'ally') {
    for (let x = 0; x < grid.width; x++) {
      columnOrder.push(x);
    }
  } else {
    for (let x = grid.width - 1; x >= 0; x--) {
      columnOrder.push(x);
    }
  }

  const rowOrder = getCenteredRowOrder(grid.height);
  const placements: GridCoord[] = [];

  for (const x of columnOrder) {
    for (const y of rowOrder) {
      const idx = y * grid.width + x;
      if (taken.has(idx)) {
        continue;
      }
      const tile = getTileAt(grid, { x, y });
      if (tile === null || !tile.passable) {
        continue;
      }
      taken.add(idx);
      placements.push({ x, y });
      if (placements.length === count) {
        return placements;
      }
    }
  }

  return placements;
}

/**
 * Roll deterministic d20 initiative for all participants and sort descending by total.
 *
 * Ties break deterministically by higher `initiativeBonus`, then lexicographically ascending `id`.
 */
export function rollInitiativeOrder(
  units: ReadonlyArray<InitiativeParticipant>,
  rng: RngState
): InitiativeOrderResult {
  let currentRng = rng;
  const rolled: Array<InitiativeEntry & { readonly initiativeBonus: number }> = [];

  for (const unit of units) {
    const step = nextInt(currentRng, 1, 20);
    currentRng = step.nextState;
    const roll = step.value;
    const total = roll + unit.initiativeBonus;
    rolled.push({
      id: unit.id,
      roll,
      total,
      initiativeBonus: unit.initiativeBonus,
    });
  }

  rolled.sort((a, b) => {
    if (b.total !== a.total) {
      return b.total - a.total;
    }
    if (b.initiativeBonus !== a.initiativeBonus) {
      return b.initiativeBonus - a.initiativeBonus;
    }
    if (a.id < b.id) {
      return -1;
    }
    if (a.id > b.id) {
      return 1;
    }
    return 0;
  });

  const order: InitiativeEntry[] = rolled.map(({ id, roll, total }) => ({
    id,
    roll,
    total,
  }));

  return {
    order,
    nextRng: currentRng,
  };
}
