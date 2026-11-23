/**
 * Core types for tactical combat grids, terrain features, cover, and combatant placement.
 */

export interface GridCoord {
  readonly x: number;
  readonly y: number;
}

export type CoverLevel = 'none' | 'half' | 'full' | 'blocked';

export type TileHazard = 'none' | 'difficult' | 'fire' | 'acid';

export type TerrainTheme = 'open' | 'ruins' | 'indoor_keep' | 'street' | 'forest';

export interface GridTile {
  x: number;
  y: number;
  passable: boolean;
  cover: 'none' | 'half' | 'full';
  elevation: number;
  hazard: TileHazard;
  blocksLos: boolean;
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
