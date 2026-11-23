export * from './core/errors.js';
export * from './core/result.js';
export * from './core/prng.js';
export * from './core/dice.js';
export * from './core/world-clock.js';

export {
  STOCK_FREEFORM_PACK,
  STOCK_LIVING_WORLD_PACK,
  STOCK_SLICE_OF_LIFE_PACK,
  STOCK_SYSTEM_PACKS,
  STOCK_TACTICAL_RPG_PACK,
  getStockSystemPack,
} from './schema/stock-system-packs.js';
export {
  compileActiveTrackerSchema,
  isCadenceDue,
} from './schema/dynamic-schema-compiler.js';

export {
  WORLD_STATE_SCHEMA_VERSION,
  cloneWorldState,
  createWorldState,
  validateWorldState,
} from './state/world-state.js';
export { applyPatchBatch } from './state/reducer.js';
export {
  appendAuditRecords,
  appendEventRecord,
  branchSave,
  formatCheckpointFilename,
  initSaveDirectory,
  loadSessionSave,
  saveActivePersonaAtomic,
  saveCheckpointAtomic,
  saveControlRoomLayerAtomic,
  saveSwipeTreeAtomic,
} from './state/persistence.js';
export type {
  CheckpointSnapshot,
  InitSaveManifestInput,
  InitSaveOptions,
  LoadedSessionSave,
  SaveManifest,
} from './state/persistence.js';
export { replayFromEvents } from './state/replay.js';
export type { EventLogRecord, ReplayOptions, ReplayResult } from './state/replay.js';
export {
  activateSwipeVariant,
  appendMessageTurn,
  computeStateHash,
  createSwipeTree,
  getLinearTranscript,
  recordSwipeVariant,
  rollbackForSwipe,
} from './state/swipe-tree.js';
export {
  resolveEffectiveControlRoomConfig,
} from './config/control-room-config.js';
export {
  buildPlayerPatchFromPersona,
  cloneUserPersonaPreset,
  validateUserPersonaPreset,
} from './config/persona-preset.js';
export type { UserPersonaPreset } from './config/persona-preset.js';
export { applySelectivePayloadGroups } from './config/selective-loader.js';
export { computeControlRoomDiffReport, getSectionImpactBadge } from './config/prompt-diff.js';

export { evaluateBeatGraph, forceBeatTransition } from './beats/beat-engine.js';
export {
  chooseEndingBranch,
  evaluateEndings,
  evaluateRoutes,
  filterBeatsForActiveRoutes,
} from './beats/routes-and-endings.js';
export { executeSandboxedScript } from './sandbox/quickjs-host.js';

export {
  resolveCombatTurn,
  startCombatEncounter,
} from './combat/combat-resolver.js';
export { SkillRegistry } from './combat/skill-registry.js';

export { compileNarratorPrompt } from './context/prompt-compiler.js';
export { renderWorldStateBlock } from './context/state-renderer.js';
export { ModelGateway } from './gateway/model-gateway.js';
export { MockModelProvider, createMockModelGateway } from './gateway/mock-provider.js';
export {
  activateNamedProfile,
  applyConnectionsFileToGateway,
  deleteNamedProfile,
  loadConnectionsFile,
  parseConnectionsDocument,
  saveConnectionsFile,
  saveNamedProfile,
  snapshotGatewayToConnectionsDoc,
  validateConnectionsDocument,
} from './gateway/connection-store.js';
export type { ConnectionProfile, ConnectionsFileDocument } from './gateway/connection-store.js';
export { GameSystemWizard } from './wizard/game-system-wizard.js';

export { SessionEventBus } from './runtime/event-bus.js';
export { applyDirectorSteering } from './runtime/director-steering.js';
export { SessionRuntime } from './runtime/session-runtime.js';
export {
  inspectCharacterDossier,
  inspectSettingCharacters,
} from './world/character-inspector.js';
export type {
  CharacterDossier,
  CharacterPresenceBucket,
  DossierCustomFieldEntry,
  DossierSectionEntry,
  InspectCharacterOptions,
  InspectDossierOptions,
  PlayerAffinitySummary,
  SettingCharacterFilter,
  SettingCharacterSummary,
  SettingRosterInspection,
} from './world/character-inspector.js';

export { loadCartridgeFromDirectory } from './cartridge/loader.js';
export {
  analyzeCartridgeGraph,
  detectBeatCycles,
  validateCrossFileReferences,
} from './cartridge/static-analyzer.js';
export { importSillyTavernCard } from './cartridge/importers/st-card-importer.js';
export { importSillyTavernPreset } from './cartridge/importers/st-preset-importer.js';
export type {
  SillyTavernPresetFormat,
  SillyTavernPresetImportOptions,
  SillyTavernPresetImportResult,
} from './cartridge/importers/st-preset-importer.js';
export {
  exportToSillyTavernChatCompletionPreset,
  exportToSillyTavernTextCompletionPreset,
} from './cartridge/exporters/st-preset-exporter.js';
export type { SillyTavernPresetExportOptions } from './cartridge/exporters/st-preset-exporter.js';
export {
  exportSystemPackToControlRoomLayer,
  exportSystemPackToJson,
} from './cartridge/exporters/system-pack-exporter.js';
export { importMultihogCartridge } from './cartridge/importers/multihog-importer.js';
export { importNeoTerraSeasonFromDirectory } from './cartridge/importers/neoterra-importer.js';
export { RefereeDataStore, validateSafeStorageId } from './storage/data-store.js';
export type {
  SaveControlRoomPresetInput,
  SavedControlRoomPreset,
  StorageListResult,
} from './storage/data-store.js';

export { RefereeDaemon } from './server/daemon.js';
export { DaemonRegistry } from './server/routes.js';
export { TuiController } from './tui/app.js';
export { runSimCli, runSimPlaythroughCommand, runSimValidateCommand } from './cli/sim-cli.js';
export { runMainCli } from './cli/main.js';
