/**
 * Core types for tactical combat grids, terrain features, cover, and combatant placement.
 */

export interface GridCoord {
  readonly x: number;
  readonly y: number;
}

export type CoverLevel = 'none' | 'half' | 'full' | 'blocked';

export type TileHazard =
  | 'none'
  | 'difficult'
  | 'fire'
  | 'acid'
  | 'ice'
  | 'electrified'
  | 'sanctuary';

export type TerrainTheme = 'open' | 'ruins' | 'indoor_keep' | 'street' | 'forest';

export interface GridTile {
  x: number;
  y: number;
  passable: boolean;
  cover: 'none' | 'half' | 'full';
  elevation: number;
  hazard: TileHazard;
  blocksLos: boolean;
  baseHazard?: TileHazard;
  hazardDurationRounds?: number | null;
  hazardDamageDice?: string;
  destructible?: boolean;
  obstacleHp?: number;
  maxObstacleHp?: number;
}

export type TerrainModificationShape = 'single_tile' | 'aoe_radius' | 'line' | 'cone';

export interface TerrainModificationSpec {
  readonly shape: TerrainModificationShape;
  readonly radius?: number;
  readonly passable?: boolean;
  readonly blocksLos?: boolean;
  readonly cover?: 'none' | 'half' | 'full';
  readonly elevationDelta?: number;
  readonly setElevation?: number;
  readonly hazard?: TileHazard;
  readonly hazardDurationRounds?: number | null;
  readonly hazardDamageDice?: string;
  readonly destructible?: boolean;
  readonly obstacleHp?: number;
}

export interface TacticalGrid {
  width: number;
  height: number;
  theme: TerrainTheme;
  readonly tiles: readonly GridTile[];
}

export interface CombatantPlacement {
  id: string;
  team: 'ally' | 'enemy' | 'neutral';
  coord: GridCoord;
  speed: number;
  initiative: number;
  alive: boolean;
}
