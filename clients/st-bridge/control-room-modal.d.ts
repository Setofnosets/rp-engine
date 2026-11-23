export const STOCK_PACK_IDS: readonly string[];
export const SHEET_PRESET_IDS: readonly string[];
export const SHEET_PRESETS: ReadonlyArray<{ readonly id: string; readonly label: string }>;
export const CONNECTION_PROVIDERS: readonly string[];
export const SELECTIVE_PAYLOAD_GROUPS: ReadonlyArray<{ readonly id: string; readonly label: string }>;
export const DIFF_BADGES: readonly string[];

export interface ControlRoomViewModelInput {
  sessionId?: string | null;
  systemPacks?: readonly object[];
  sessionState?: Record<string, unknown>;
  selectedGroups?: readonly string[];
  sheetPresetId?: string;
  activePersona?: { id?: string; name: string; description?: string } | null;
  connections?: Record<string, unknown> | null;
  wizardRequest?: { description?: string; effectOwner?: string; target?: string };
  wizardDraft?: Record<string, unknown> | null;
}

export interface ControlRoomViewModel {
  sessionId: string | null;
  activePackId: string;
  overallBadge: string;
  overallBadgeLabel: string;
  systemPacks: Array<{
    id: string;
    name: string;
    description: string;
    isActive: boolean;
    isStock: boolean;
  }>;
  selectiveGroups: Array<{
    id: string;
    label: string;
    selected: boolean;
    badge: string;
    badgeLabel: string;
  }>;
  modules: Array<{
    id: string;
    name: string;
    description: string;
    enabled: boolean;
    effectOwner: string;
    cadence: unknown;
    widget: string;
    badge: string;
    badgeLabel: string;
  }>;
  pcSections: Array<Record<string, unknown>>;
  npcSections: Array<Record<string, unknown>>;
  promptSections: Array<{
    sectionId: string;
    badge: string;
    badgeLabel: string;
    unlocked: boolean;
    text: string;
  }>;
  tuningDials: Record<string, unknown>;
  wizard: {
    description: string;
    effectOwner: string;
    target: string;
    draft: Record<string, unknown> | null;
  };
  sheetPresetId: string;
  sheetPresets: Array<{ id: string; label: string; selected: boolean }>;
  generation: {
    presetName: string;
    sourceFormat: string;
    temperature: number | null;
    maxTokens: number | null;
    maxContextTokens: number | null;
  };
  activePersona: { id: string; name: string; description: string } | null;
  connections: {
    activeProfile: string | null;
    profiles: string[];
    defaultConnection: {
      provider: string;
      baseUrl: string;
      model: string;
      temperature: number | null;
      maxTokens: number | null;
    };
  };
}

export function extractActiveSillyTavernPreset(ctx: unknown): Record<string, unknown> | null;
export function extractActiveSillyTavernPersona(ctx: unknown): {
  id: string;
  name: string;
  description: string;
};

export function buildControlRoomViewModel(input?: ControlRoomViewModelInput): ControlRoomViewModel;
export function buildSwitchPackPayload(
  systemPackId: string,
  selectedGroups?: readonly string[]
): Record<string, unknown>;
export function buildModuleTogglePayload(moduleId: string, enabled: boolean): Record<string, unknown>;
export function buildSheetSectionsPayload(
  target: 'pc' | 'npc',
  sections: ReadonlyArray<Record<string, unknown>>
): Record<string, unknown>;
export function buildPromptSectionPayload(
  sectionId: string,
  text: string,
  unlocked?: boolean
): Record<string, unknown>;
export function buildTuningDialsPayload(tuningDials: Record<string, unknown>): Record<string, unknown>;
export function buildWizardGenerateRequest(params: {
  description: string;
  effectOwner?: 'engine' | 'tracker' | 'hybrid';
  target?: 'global' | 'player' | 'npc' | 'location';
  loreContext?: string;
  previousDraft?: Record<string, unknown>;
  refinementFeedback?: string;
}): Record<string, unknown>;
export function buildApplyWizardModulePayload(
  wizardResult: Record<string, unknown>
): Record<string, unknown>;
export function buildApplySheetPresetPayload(
  sheetPresetId: string,
  target?: 'pc' | 'npc' | 'both'
): Record<string, unknown>;
export function buildConnectionsUpdatePayload(input: {
  provider?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  temperature?: number | string | null;
  maxTokens?: number | string | null;
}): Record<string, unknown>;
export function renderControlRoomModalHtml(viewModel?: ControlRoomViewModel): string;
export interface ControlRoomModalHandlers {
  client?: import('./bridge-client.js').RefereeBridgeClient;
  sessionId?: string | null;
  stContext?: unknown;
  getStContext?: () => unknown;
  onResult?: (res: unknown, action: string) => void;
  onError?: (err: unknown, action: string) => void;
  onApplyPack?: (payload: Record<string, unknown>) => unknown;
  onToggleModule?: (payload: Record<string, unknown>) => unknown;
  onWizardGenerate?: (req: Record<string, unknown>) => unknown;
  onWizardApply?: (payload: Record<string, unknown>) => unknown;
  onSyncStPreset?: (info: {
    preset: Record<string, unknown> | null;
    sessionId: string | null;
    ctx: unknown;
  }) => unknown;
  onSyncStPersona?: (info: {
    persona: { id: string; name: string; description: string };
    sessionId: string | null;
    ctx: unknown;
  }) => unknown;
  onApplySheetPreset?: (payload: Record<string, unknown>) => unknown;
  onUpdateConnections?: (payload: Record<string, unknown>) => unknown;
  onSaveConnectionProfile?: (name: string, payload: Record<string, unknown>) => unknown;
  onActivateConnectionProfile?: (name: string) => unknown;
}
export function bindControlRoomModalDom(
  container: Record<string, unknown>,
  viewModel: ControlRoomViewModel,
  handlers?: ControlRoomModalHandlers
): () => void;
