export const STOCK_PACK_IDS: readonly string[];
export const SELECTIVE_PAYLOAD_GROUPS: ReadonlyArray<{ readonly id: string; readonly label: string }>;
export const DIFF_BADGES: readonly string[];

export interface ControlRoomViewModelInput {
  systemPacks?: readonly object[];
  sessionState?: Record<string, unknown>;
  selectedGroups?: readonly string[];
  wizardRequest?: { description?: string; effectOwner?: string; target?: string };
  wizardDraft?: Record<string, unknown> | null;
}

export interface ControlRoomViewModel {
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
}

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
export function renderControlRoomModalHtml(viewModel?: ControlRoomViewModel): string;
export function bindControlRoomModalDom(
  container: Record<string, unknown>,
  viewModel: ControlRoomViewModel,
  handlers?: {
    onApplyPack?: (payload: Record<string, unknown>) => void;
    onToggleModule?: (payload: Record<string, unknown>) => void;
    onWizardGenerate?: (req: Record<string, unknown>) => void;
    onWizardApply?: (payload: Record<string, unknown>) => void;
  }
): () => void;
