export interface DirectorBeatOverrideInput {
  beatId: string;
  status: 'resolved' | 'deferred' | 'short_circuited';
  reason?: string;
}

export interface DirectorBarInitialState {
  holdClock?: boolean;
  clockActionMode?: 'auto' | 'hold' | 'release' | 'rest_to_morning';
  advanceSlots?: number;
  oocNudge?: string;
  pinCharacterIds?: string[];
  dismissCharacterIds?: string[];
  beatOverrides?: DirectorBeatOverrideInput[];
}

export class DirectorBarState {
  holdClock: boolean;
  clockActionMode: 'auto' | 'hold' | 'release' | 'rest_to_morning';
  advanceSlots: number;
  oocNudge: string;
  pinCharacterIds: string[];
  dismissCharacterIds: string[];
  beatOverrides: DirectorBeatOverrideInput[];

  constructor(initial?: DirectorBarInitialState);
  setHoldClock(held: boolean): void;
  setClockActionMode(mode: 'auto' | 'hold' | 'release' | 'rest_to_morning'): void;
  setAdvanceSlots(slots: number): void;
  setOocNudge(text: string): void;
  pinCharacter(characterId: string): void;
  unpinCharacter(characterId: string): void;
  setPinnedCharacters(ids: string[]): void;
  dismissCharacter(characterId: string): void;
  addBeatOverride(
    beatId: string,
    status: 'resolved' | 'deferred' | 'short_circuited',
    reason?: string
  ): void;
  removeBeatOverride(beatId: string): void;
  clearBeatOverrides(): void;
  resetTurnOverrides(): void;
  buildDirectorSteeringPayload(): Record<string, unknown>;
}

export function renderDirectorBarHtml(
  stateOrController: DirectorBarState | DirectorBarInitialState,
  options?: { availableCharacters?: Array<{ id: string; name?: string }> }
): string;

export function bindDirectorBarDom(
  container: Record<string, unknown>,
  controller: DirectorBarState,
  options?: {
    availableCharacters?: Array<{ id: string; name?: string }>;
    onChange?: (payload: Record<string, unknown>) => void;
  }
): () => void;
