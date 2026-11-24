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
  bindPlayerToCanonCharacter,
  cloneWorldState,
  createWorldState,
  validateWorldState,
} from './state/world-state.js';
export {
  type CharacterCardLoreEntry,
  type CharacterCardSheet,
  type CharacterCardSourceSpec,
  cloneCharacterCardSheet,
  validateCharacterCardSheet,
} from './state/character-card-sheet.js';
export {
  type AssetKnowledgeTier,
  type ConnectionMeta,
  type ConnectionStateKind,
  type DiscoveryState,
  type EmergentLocationResolution,
  type HiddenAssetCanonStatus,
  type HiddenAssetKind,
  type HiddenSiteAsset,
  type LocationEntity,
  type LocationGeometry,
  type LocationMapAssets,
  type LocationStatus,
  type TravelTargetResolution,
  cloneLocationEntity,
  matchesLocationPredicate,
  projectPlayerVisibleLocations,
  registerOrResolveEmergentLocation,
  slugifyLocationName,
  validateTravelTarget,
} from './state/spatial-topology.js';
export {
  type EvaluateFormRulesOptions,
  type FormDefinition,
  type FormIndex,
  type FormTransitionRule,
  type FormTransitionSecretIdentity,
  applyFormProfileOverlay,
  buildFormIndex,
  buildFormRuleDependencyIndex,
  evaluateFormTransitionRules,
  isLegalTransform,
  selectExclusiveCast,
  validateFormTransitionRules,
} from './state/forms.js';
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
export {
  COMBAT_SCALE_VARIABLES,
  type CombatScaleVariable,
  type CombatVariableScaleSpec,
  type CombatVariableValues,
  computeCombatVariables,
  resolveScaledDiceExpression,
  validateCombatVariableScaleSpec,
} from './combat/combat-variables.js';
export {
  EFFECT_TEMPLATE_ROLES,
  EFFECT_TEMPLATE_STEP_KINDS,
  type EffectTemplate,
  type EffectTemplateRole,
  type EffectTemplateStep,
  type EffectTemplateStepKind,
  type ExpandedEffectTemplateStepTargets,
  type ExpandedEffectTemplateTargets,
  cloneEffectTemplate,
  expandEffectTemplateTargets,
  validateEffectTemplate,
} from './combat/effect-templates.js';
export {
  DEFAULT_TRADITIONAL_FORMATION_CONFIG,
  type BuildTraditionalAftermathOptions,
  type BuildTraditionalParticipantsOptions,
  type BuildTraditionalParticipantsResult,
  type EquipmentBonusSpec,
  type FormationRow,
  type ResolveTraditionalCombatTurnParams,
  type ResolveTraditionalCombatTurnResult,
  type ResolveTraditionalEnemyPhaseParams,
  type ResolveTraditionalEnemyPhaseResult,
  type ResolveTraditionalTargetIdsParams,
  type ResolveTraditionalTargetIdsResult,
  type StartTraditionalEncounterParams,
  type StartTraditionalEncounterResult,
  type TraditionalCombatState,
  type TraditionalEnemySpec,
  type TraditionalFormationConfig,
  type TraditionalOutcomeSummary,
  type TraditionalPhase,
  type TraditionalTurnStyle,
  buildTraditionalAftermathPatches,
  buildTraditionalEncounterParticipants,
  computeTraditionalEffectiveAc,
  isMeleeSkill,
  isRangedSkill,
  resolveTraditionalCombatTurn,
  resolveTraditionalEnemyPhase,
  resolveTraditionalTargetIds,
  startTraditionalEncounter,
} from './combat/traditional-theater.js';
export {
  type KnockbackCollisionResult,
  type KnockbackCollisionType,
  type TileHazardTriggerResult,
  type TraditionalZoneHazardResult,
  applyTerrainModification,
  applyTraditionalZoneHazard,
  damageDestructibleObstacle,
  evaluateTileHazardTrigger,
  resolveKnockbackWithCollision,
  resolveTerrainFootprint,
  tickRoundTerrainHazards,
} from './combat/terrain-effects.js';
export {
  type ApplyCombatTransformationResult,
  type ApplyTransformTempHpDamageResult,
  type CombatFormLoadout,
  type DespawnSummonsResult,
  type PreTransformSnapshot,
  type PurgeSummonsResult,
  type RevertAllTransformsResult,
  type RevertCombatTransformationResult,
  type SpawnCombatSummonResult,
  type SummonTemplate,
  type TickTransformationsResult,
  applyCombatTransformation,
  applyTransformTempHpDamage,
  despawnSummonsForFallenCaster,
  purgeSummonsOnEncounterEnd,
  revertAllTransformsOnEncounterEnd,
  revertCombatTransformation,
  spawnCombatSummon,
  tickAndCleanupSummons,
  tickCombatTransformations,
} from './combat/summons-and-transforms.js';
export {
  type CombatActionPreviewResult,
  type DamageRangePreview,
  type HazardWarning,
  type KnockbackPreview,
  type PreviewCombatActionOptions,
  type ReachableTilePreview,
  type ReachableTilesPreviewResult,
  type TargetActionPreview,
  computeReachableTilesPreview,
  previewCombatAction,
} from './combat/action-preview.js';

export { compileNarratorPrompt } from './context/prompt-compiler.js';
export { renderWorldStateBlock } from './context/state-renderer.js';
export {
  type ContextBudgetReport,
  type ContextBudgetSectionInput,
  type SectionBudgetReportEntry,
  type SectionTokenBudgets,
  inspectContextBudget,
} from './context/tokenizer-budget.js';
export {
  ModelGateway,
  type ModelGatewayOptions,
  OpenAICompatibleProvider,
} from './gateway/model-gateway.js';
export { AnthropicProvider } from './gateway/providers/anthropic-provider.js';
export { GeminiProvider } from './gateway/providers/gemini-provider.js';
export { OllamaProvider } from './gateway/providers/ollama-provider.js';
export {
  type ConnectionPreset,
  type ModelProvider,
  type ProviderFailure,
  type ProviderKind,
  type SamplerPreset,
} from './gateway/types.js';
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
  type DigestEvaluationResult,
  type DigestFlowConfig,
  type DowntimeActivity,
  type DowntimeExecutionResult,
  type DowntimeOptions,
  type EncounterPendingAction,
  type TravelArrivalSummary,
  type TravelExecutionResult,
  type TravelOptions,
  evaluateDigestFlow,
  executeDowntime,
  executeTravel,
} from './world/flow-hooks.js';
export {
  type AuditorFinding,
  type AuditorRuleCode,
  type AuditorSeverity,
  type DeterministicAuditResult,
  type RunAuditorPassParams,
  type RunAuditorPassResult,
  runAuditorPass,
  runDeterministicStateAudit,
} from './agents/auditor-agent.js';
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
  PNG_SIGNATURE,
  type EmbedCharaJsonOptions,
  type PngCardKeyword,
  type PngTextChunkType,
  computeCrc32,
  computePngChunkCrc,
  embedCharaJsonInPng,
  extractCharaJsonFromPngBuffer,
} from './cartridge/png-card-codec.js';
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
export {
  ALLOWED_ASSET_MIME_BY_EXT,
  DEFAULT_ASSET_CACHE_CONTROL,
  type AssetResolutionError,
  type ContainedAssetInfo,
  type ServeSafeBinaryAssetOptions,
  computeAssetETag,
  normalizeRelativeAssetPath,
  resolveAllowedAssetMime,
  resolveContainedAssetPath,
  serveBufferAsset,
} from './server/asset-handler.js';
export { TuiController } from './tui/app.js';
export { runSimCli, runSimPlaythroughCommand, runSimValidateCommand } from './cli/sim-cli.js';
export { runMainCli } from './cli/main.js';
