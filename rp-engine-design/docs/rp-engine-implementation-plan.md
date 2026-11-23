# Referee — Comprehensive PR-by-PR Implementation Plan

- **Companion Design Document:** [rp-engine-findings-and-design.md](./rp-engine-findings-and-design.md) (v0.3)
- **Status:** Actionable Engineering Blueprint (v1.1 — updated with Opt-In Subsystems, 3-Tier Spatial Topology, Dynamic Compositional Tracker, Composable System Packs, Control Room Customization, Game System Wizard, Episodic Chronicle, Swipe-Coupled Checkpoints, and Director Steering Bar)
- **Date:** November 22, 2026
- **Target Runtime:** Node.js 22+ / TypeScript 5.x (ESM, zero-DOM headless engine core, playable on Windows, Linux, macOS, and Android/Termux)

---

## 0. Global Execution & Parallelization Matrix

This implementation plan breaks the entire Referee system into **6 Milestones** and **25 PR-sized steps**. Each step is scoped to ~300–800 lines of implementation + tests so that it can be reviewed, verified, and merged independently.

```
M1: Foundation, Dynamic Schema Registry & Store-First Spine
  PR-1.1 (Monorepo & Tooling)
    ├──► PR-1.2 (Seeded PRNG & Dice Engine)
    ├──► PR-1.3 (Dual World Clock & Time Holds)
    ├──► PR-1.4 (Dynamic Compositional Schema Registry, Sheet Sections & 4 Stock System Packs)
    │      └──► PR-1.5 (WorldState v2, Opt-In Subsystems & 3-Tier Spatial Model)
    │             └──► PR-1.6 (Atomic Reducer, Dynamic Field Bounds & Audit Log) [depends on 1.2, 1.3, 1.5]
    │                    └──► PR-1.7 (Swipe-Coupled Checkpoints, JSONL Event Log Persistence & Replay)
    └──► PR-1.8 (3-Layer Control Room Config, Selective Payload Loader & Prompt-Diff Fingerprints) [depends on 1.4]

M2: Beat Graph, Episodic Chronicle, Living-World Agendas & Script Sandbox
  ├──► PR-2.1 (Declarative Predicate DSL, Tier 0–2 `at` Matcher & Dirty-Flag Compiler) [depends on 1.5]
  │      └──► PR-2.2 (Beat Lifecycle Engine: Pressure-Scaled Deadlines, Short-Circuit, Roles) [depends on 1.6, 2.1]
  │             └──► PR-2.3 (Routes, Endings & Post-Ending Branching) [depends on 2.2]
  ├──► PR-2.4 (Off-Screen Agenda Tick, Tier 0–2 Cast Presence & Episodic Chronicle Engine) [depends on 1.6]
  └──► PR-2.5 (QuickJS WASM Sandbox & Capability Manifest Runtime) [depends on 1.6]

M3: Deterministic Combat & Optional RPG Progression Engine
  ├──► PR-3.1 (Tactical Grid Topology, Seeded Terrain, Deployment & LOS/Cover) [depends on 1.2, 1.5]
  ├──► PR-3.2 (Declarative Skill Registry, Statuses, Willpower, Passives & Optional RPG Progression) [depends on 1.6]
  └──► PR-3.3 (Action Validator, Partial-Prefix Salvage, Fallback AI & Traditional Mode) [depends on 3.1, 3.2]

M4: Prompt Compiler, Model Gateway, Cadence-Throttled Agents & Game System Wizard
  ├──► PR-4.1 (Unlockable Section Prompt Compiler, Game System Rule Injector & Tier 0–2 State Renderer) [depends on 1.8, 2.2, 2.4, 3.3]
  ├──► PR-4.2 (Per-Role Model Gateway & Structured JSON Output Repair) [depends on 1.1]
  ├──► PR-4.3 (Cadence-Throttled Dynamic Tracker, Parser, Combat, Cast, Storyline & Chronicle Agents) [depends on 4.1, 4.2]
  ├──► PR-4.4 (In-Engine Game System Wizard: Natural Language -> Schema + Rule + Beat Generator) [depends on 1.4, 4.2]
  └──► PR-4.5 (Unified Session Turn Runtime, Swipe Rollback Controller & Director Steering Bar API) [depends on 1.7, 2.3, 2.5, 3.3, 4.3]

M5: System Pack & Story Cartridge Ecosystem, Converters & Route Simulator CLI
  ├──► PR-5.1 (`system-pack/0.1` & `cartridge/0.1` Loader, Static Analyzer & Deadlock Verifier) [depends on 1.8, 2.3, 3.2]
  ├──► PR-5.2 (Importers: ST V2/V3 PNG/JSON, Combat-Multihog Cartridge/System & NeoTerra Importer) [depends on 5.1]
  └──► PR-5.3 (Route Simulator CLI `referee sim` & Reference Cartridges: Slice-of-Life, Crimson Keep, NeoTerra S1) [depends on 4.5, 5.2]

M6: Local Daemon, SillyTavern Bridge & Native TUI Client
  └──► PR-6.1 (Localhost HTTP/WebSocket Service Daemon: Sessions, Control Room, Wizard & Director APIs) [depends on 4.4, 4.5, 5.1]
         ├──► PR-6.2 (SillyTavern Bridge Extension with Control Room, Wizard & Director Bar UI) [depends on 6.1]
         └──► PR-6.3 (Native CLI/TUI Client with HUD, Control Room, ASCII Grid & Freeform/Pack Modes) [depends on 6.1]
```

### Parallel Execution Wave Summary

| Wave | Concurrently Executable PRs | Blocking Prerequisites |
| --- | --- | --- |
| **Wave 1** | `PR-1.1` | None (root bootstrap) |
| **Wave 2** | `PR-1.2`, `PR-1.3`, `PR-1.4`, `PR-4.2` | `PR-1.1` |
| **Wave 3** | `PR-1.5`, `PR-1.8`, `PR-4.4` | `PR-1.4`, `PR-4.2` |
| **Wave 4** | `PR-1.6`, `PR-2.1`, `PR-3.1` | `PR-1.2`, `PR-1.3`, `PR-1.5` |
| **Wave 5** | `PR-1.7`, `PR-2.2`, `PR-2.4`, `PR-2.5`, `PR-3.2` | `PR-1.6`, `PR-2.1` |
| **Wave 6** | `PR-2.3`, `PR-3.3` | `PR-2.2`, `PR-3.1`, `PR-3.2` |
| **Wave 7** | `PR-4.1`, `PR-5.1` | `PR-1.8`, `PR-2.3`, `PR-2.4`, `PR-3.3` |
| **Wave 8** | `PR-4.3`, `PR-5.2` | `PR-4.1`, `PR-4.2`, `PR-5.1` |
| **Wave 9** | `PR-4.5` | `PR-1.7`, `PR-2.5`, `PR-4.3` |
| **Wave 10** | `PR-5.3`, `PR-6.1` | `PR-4.4`, `PR-4.5`, `PR-5.2` |
| **Wave 11** | `PR-6.2`, `PR-6.3` | `PR-6.1` |

---

## Milestone 1: Foundation, Dynamic Schema Registry & Store-First Spine

**Goal:** Establish the headless TypeScript repository, deterministic PRNG and dice math, the Dual World Clock (with time holds), the **Dynamic Compositional Schema Compiler & 4 Stock System Packs**, `WorldState` v2 with the **3-Tier Spatial Model**, the transactional reducer with dynamic field bounds & audit logging, **Swipe-Coupled Checkpoint Persistence**, and the **3-Layer Control Room Config & Prompt-Diff Engine**.

---

### PR-1.1: Monorepo Bootstrap, TypeScript Config & Deterministic Test Harness

- **Files to add/change:**
  - `package.json` (new)
  - `tsconfig.json` (new)
  - `vitest.config.ts` (new)
  - `.gitignore` (new)
  - `src/index.ts` (new)
  - `src/core/errors.ts` (new)
  - `src/core/result.ts` (new)
  - `tests/core/result.test.ts` (new)
- **Risk:** Low
- **Depends on:** None
- **Parallelizable:** No (foundational root commit; blocks all subsequent steps).
- **Description & Technical Details:**
  Initialize an ESM-first TypeScript project designed to run on Node.js 22+ across desktop OSes and Android/Termux without native C++ compilation dependencies.
  - Define a standard `Result<T, E>` and `ValidationError` (`{ path: string, code: string, message: string }`) pattern so all schema loaders, reducers, and action validators return structured diagnostics rather than untyped exceptions.
  - Configure `vitest` with strict coverage thresholds (`>= 90%` lines/branches on `src/core`, `src/state`, `src/beats`, `src/combat`).
- **Required Verification / Tests:**
  - `npm test` runs in `< 2s` with zero network access enabled.
  - Unit tests in `tests/core/result.test.ts` verifying error accumulation, path formatting, and type narrowing.
- **Acceptance Criteria:**
  - Clean `tsc --noEmit` and `vitest run` pass on Windows, Linux, and Termux.

---

### PR-1.2: Seeded PRNG & Deterministic Dice/Roll Engine

- **Files to add/change:**
  - `src/core/prng.ts` (new)
  - `src/core/dice.ts` (new)
  - `tests/core/prng.test.ts` (new)
  - `tests/core/dice.test.ts` (new)
- **Risk:** Low
- **Depends on:** `PR-1.1`
- **Parallelizable:** Yes. Can run in parallel with `PR-1.3`, `PR-1.4`, `PR-4.2`. Blocks `PR-1.6`, `PR-3.1`.
- **Description & Technical Details:**
  Implement a serializable, pure seeded PRNG (`xoshiro128**`) whose internal state tuple can be snapshotted into `WorldState.meta.rngState` and restored on save load or swipe rollback.
  - Implement a deterministic dice parser and evaluator (`dice.roll("2d6+3", rng)`, advantage/disadvantage `2d20kh1`, percentile `1d100`, and weighted table selection) that records every roll into an audit roll trace.
  - Support an explicit **Test Oracle Queue** mode (`createQueuedRng([0.15, 0.85], fallbackSeed)`) matching `Combat-Multihog`'s deterministic test RNG queues.
- **Required Verification / Tests:**
  - Property test: 10,000 draws from a fixed seed produce the exact same sequence across restarts and after mid-sequence state serialization/deserialization.
  - Dice notation tests covering standard (`1d20+5`), keep-highest (`2d20kh1`), keep-lowest (`2d20kl1`), and invalid notation rejection.
- **Acceptance Criteria:**
  - Zero calls to `Math.random()` anywhere in the codebase.

---

### PR-1.3: Dual World Clock & Time Hold Engine

- **Files to add/change:**
  - `src/core/world-clock.ts` (new)
  - `tests/core/world-clock.test.ts` (new)
- **Risk:** Low
- **Depends on:** `PR-1.1`
- **Parallelizable:** Yes. Can run in parallel with `PR-1.2`, `PR-1.4`, `PR-4.2`. Blocks `PR-1.6`.
- **Description & Technical Details:**
  Adapt and generalize `NeoTerra-Framework`'s `src/core/world-clock.js` (`MIT`) into Referee's Dual World Clock:
  - Track mechanical turns (`turn`, incremented every exchange) separately from narrative time (`storyTurn`, `day` integer `1..N`, optional `inGameDate` ISO `YYYY-MM-DD`, and `slot` from configurable `slotsPerDay`, defaulting to `['morning', 'afternoon', 'evening', 'night']`).
  - Support **Time Holds** (`held: boolean`, `holdReason: string | null`, e.g., `'combat'` or `'director-hold'`). While `held === true`, `advanceMechanicalTurn` increments `turn` while leaving `storyTurn`, `day`, `inGameDate`, and `slot` untouched.
  - Support user display formatting preferences (`use24hTime`, `useDdMmYyFormat` from `Combat-Multihog`) and named countdown/progress timers (`timers: Record<string, { current: number, max: number, tickOn: 'turn' | 'slot' | 'day' }>`).
- **Required Verification / Tests:**
  - Full port of `NeoTerra-Framework`'s `world-clock.test.js` edge cases (leap years, invalid ISO dates, slot wrap-around incrementing `day` and `inGameDate`, time hold freezing fiction time while mechanical turn advances, countdown timer expiration).
- **Acceptance Criteria:**
  - 100% branch coverage on `src/core/world-clock.ts`.

---

### PR-1.4: Dynamic Compositional Schema Registry, Modular Sheet Sections & 4 Stock System Packs

- **Files to add/change:**
  - `src/schema/tracker-module.ts` (new)
  - `src/schema/character-sections.ts` (new)
  - `src/schema/dynamic-schema-compiler.ts` (new)
  - `src/schema/stock-system-packs.ts` (new)
  - `tests/schema/dynamic-schema-compiler.test.ts` (new)
  - `tests/schema/stock-system-packs.test.ts` (new)
- **Risk:** Medium
- **Depends on:** `PR-1.1`
- **Parallelizable:** Yes. Can run in parallel with `PR-1.2`, `PR-1.3`, `PR-4.2`. Blocks `PR-1.5`, `PR-1.8`, `PR-4.4`.
- **Description & Technical Details:**
  Implement the **Dynamic Compositional State Tracker** and **System Pack** specifications (§5.5, §5.6, §8.1), translating `Combat-Multihog`'s `schema-sections.js`, `game-systems.js`, and `customFields` into a typed, store-first schema compiler:
  - **Modular PC & NPC Sheet Sections (`CharacterSectionDef`):**
    Define default and optional section descriptors (`Species`, `Body`, `Worn Equipment`, `Personality`, `Background`, `Habits`, `Strengths`, `Flaws`, plus optional `Combat Profile`, `Desires`, `Cyberware`, `Superpowers`) with `id`, `name`, `description`, `icon`, `color`, `fieldType` (`prose | bullet_list | stat_block`), `hiddenUntilSet`, `writableByTracker`, and `cadence`.
  - **Dynamic Game System Modules (`GameSystemModule`):**
    A user- or cartridge-defined module bundling:
    - `id`, `name`, `enabled`, `scope` (`global | session`), `target` (`global | player | npc | location`)
    - `effectOwner`: `'engine' | 'tracker' | 'hybrid'`
    - `cadence`: `'every_turn' | 'every_n_turns' | 'on_clock_advance' | 'on_combat_end' | 'manual_only'`
    - `fields`: `Record<string, DynamicFieldSpec>` (`meter` with `min`/`max`, `counter`, `enum` with `options[]`, `boolean`, `string`, `string_list`)
    - `trackerInstruction`: string injected into `state_tracker` when enabled and due
    - `narratorRule`: string injected into narrator's `game_system_rules` section when enabled
    - `ui`: `{ widget: 'bar' | 'badge' | 'tags' | 'card' | 'hidden', order: number }`
  - **Dynamic Schema Compiler (`compileActiveTrackerSchema`):**
    Given active `Capabilities`, `pcCoreSections`, `npcCoreSections`, and `gameSystems[]`, dynamically compiles:
    1. The JSON Schema object (`additionalProperties: false`) for `state_tracker` LLM calls (filtering out disabled modules and modules not due on `currentTurn` cadence).
    2. The Reducer Field Validator Map (providing fast lookup of type, `min`/`max` bounds, enum values, `writableByTracker`, and `confirmPolicy` for every dynamic path).
  - **Four Built-in Stock System Packs (`src/schema/stock-system-packs.ts`):**
    1. `stock-freeform`: Tier 0 `scene_only`, minimal scene mood/presence only.
    2. `stock-slice-of-life`: Tier 0 `scene_only`, PC/NPC core sections (`Worn Equipment`, `Personality`, `Habits`, etc.), `Relationship Affinity`, `Calendar Clock`, `Narrative Pacing`. (`combatMode: 'disabled'`, `progression: 'disabled'`, `factions: false`).
    3. `stock-tactical-rpg`: Tier 1 `emergent` (or Tier 2), `combatMode: 'tactical_grid'`, `progression: 'rpg_levels'` (XP, level, class, attributes, HP/Willpower/Stamina, inventory/gold), skill registry, seeded dice.
    4. `stock-living-world`: Tier 2 `authored_graph`, `clocks: 'full_sim'`, `factions: true`, threats, multi-form identities, off-screen agendas, canon beat ledger.
  ```typescript
  export function compileActiveTrackerSchema(
    pack: EffectiveSystemConfig,
    context: { turn: number; clockAdvancedThisTurn: boolean; combatEndedThisTurn: boolean }
  ): {
    trackerJsonSchema: Record<string, unknown> | null; // null if zero modules due this turn!
    activeTrackerInstructions: string[];
    activeNarratorRules: string[];
    fieldPolicyMap: Map<string, CompiledFieldPolicy>;
  };
  ```
- **Required Verification / Tests:**
  - Verify `stock-slice-of-life` compiles a tracker JSON Schema with zero references to `hp`, `xp`, `level`, `class`, `factions`, or `combat`.
  - Verify adding a custom user `GameSystemModule` (`"sanity"`, `meter 0..100`, `cadence: 'every_turn'`) dynamically adds `custom_fields.sanity` to both `trackerJsonSchema` and `fieldPolicyMap`.
  - Verify cadence filtering: a module with `cadence: { everyNTurns: 3 }` is included on turns 3, 6, 9 and excluded on turns 1, 2, 4, 5.
- **Acceptance Criteria:**
  - Tracker schema and narrator rules recompile in `< 0.5 ms` whenever the user toggles a module or adds a custom field.

---

### PR-1.5: `WorldState` v2, Opt-In Subsystems & The 3-Tier Spatial Model

- **Files to add/change:**
  - `src/state/world-state.ts` (new)
  - `src/state/spatial-topology.ts` (new)
  - `src/state/forms.ts` (new)
  - `tests/state/world-state.test.ts` (new)
  - `tests/state/spatial-topology.test.ts` (new)
  - `tests/state/forms.test.ts` (new)
- **Risk:** Medium
- **Depends on:** `PR-1.4`
- **Parallelizable:** Yes. Can run in parallel with `PR-1.8`, `PR-4.4`. Blocks `PR-1.6`, `PR-2.1`, `PR-3.1`.
- **Description & Technical Details:**
  Define the authoritative `WorldState` document and the **3-Tier Spatial Model** (§5.1, §5.5, F-15):
  - **3-Tier Spatial Topology (`src/state/spatial-topology.ts`):**
    - **Tier 0 (`spatialMode: 'scene_only'`):** `state.scene.location` holds the current freeform location string (e.g., `"Central Café"`). `entities.locations` is empty (`{}`) and not required. NPC presence is tracked via `character.presentInScene: boolean`.
    - **Tier 1 (`spatialMode: 'emergent'`):** Starts with `entities.locations = {}`. Provides `registerOrResolveEmergentLocation(state, locationName, previousLocationId)` which slugifies newly visited site names into discovered `LocationEntity` nodes and records bidirectional edges as the player explores.
    - **Tier 2 (`spatialMode: 'authored_graph'`):** Strictly validates `player.locationId` and `character.locationId` against pre-authored `entities.locations` nodes and enforces `connectedLocations` adjacency on `/travel`.
  - **Compositional Character & World Entities:**
    - `entities.characters.<id>` supports dynamic `sections` (validated against `pcCoreSections`/`npcCoreSections`), dynamic `custom_fields`, optional `progression` (`level`, `xp`, `class`, `attributes`) and `resources` (when enabled by System Pack), and multi-form `formId`/`formGroup` (`src/state/forms.ts`, adapted from `NeoTerra-Framework`).
    - Optional `entities.factions`, `entities.threats`, `entities.locations`, and `chronicle.events`.
- **Required Verification / Tests:**
  - Tier 0 validation test: a character card with zero map/location nodes seeds a valid `WorldState`, tracks `scene.location = "Coffee Shop"`, and resolves NPC presence via `presentInScene`.
  - Tier 1 emergent discovery test: moving from `"Town Square"` to `"Old Mill"` dynamically creates both nodes in `entities.locations` and links them.
  - Tier 2 strict graph test: unresolved `locationId` or disconnected `/travel` target is rejected with a clear validation error.
- **Acceptance Criteria:**
  - Seamless operation across all three spatial tiers and all four Stock System Packs.

---

### PR-1.6: Atomic Reducer, Dynamic Field Bounds & Append-Only Audit Log

- **Files to add/change:**
  - `src/state/patch.ts` (new)
  - `src/state/reducer.ts` (new)
  - `src/state/audit-log.ts` (new)
  - `tests/state/reducer.test.ts` (new)
  - `tests/state/audit-log.test.ts` (new)
- **Risk:** Medium
- **Depends on:** `PR-1.2`, `PR-1.3`, `PR-1.5`
- **Parallelizable:** Yes, with `PR-2.1` and `PR-3.1`. Blocks `PR-1.7`, `PR-2.2`, `PR-2.4`, `PR-2.5`, `PR-3.2`.
- **Description & Technical Details:**
  Implement the pure transactional reducer (`applyPatchBatch(state, batch, compiledSchema)`):
  - Supported atomic operations: `set`, `increment`, `clamp`, `push`, `remove`, `section_patch` (updates PC/NPC sheet sections), `custom_field_patch` (validates and clamps against `compiledSchema.fieldPolicyMap`), `entity_patch`, `form_transform`, `emergent_location_visit`, `chronicle_append`, `clock_advance`, `clock_hold`, `route_lock`.
  - **Dynamic Bounds & Permission Enforcement:**
    - Uses `compiledSchema.fieldPolicyMap` (`PR-1.4`) to enforce `min`/`max` clamping on any user-created `meter`, enum membership on `enum` fields, `writableByTracker` guards when `batch.source === 'tracker'`, and `confirmPolicy` (`auto | batch_confirm | always_confirm | locked`).
    - Operations targeting a `locked` field or an unauthorized path are rejected; operations requiring confirmation are diverted into `pendingConfirmations[]` without mutating state until confirmed by the user.
  - **All-or-Nothing Atomicity (BR-2) & Dirty Path Set:** Rolls back the entire event batch on any structural or invariant error; returns `changedPaths: Set<string>` and appends structured `AuditEntry` records.
- **Required Verification / Tests:**
  - Dynamic field validation test: tracker proposing `custom_fields.sanity = 150` on a `0..100` meter clamps to `100` (or rejects out-of-type string `"very sane"`), and proposing a write to a user-`locked` field is blocked and logged.
  - Atomicity rollback test: 4 valid operations + 1 invalid operation leaves `WorldState` untouched.
- **Acceptance Criteria:**
  - Reducer enforces full type and permission safety across both built-in fields and user-created dynamic tracker modules.

---

### PR-1.7: Swipe-Coupled Message Tree Checkpoints, JSONL Persistence & Replay Engine

- **Files to add/change:**
  - `src/state/swipe-tree.ts` (new)
  - `src/state/persistence.ts` (new)
  - `src/state/replay.ts` (new)
  - `src/state/migrations.ts` (new)
  - `tests/state/swipe-tree.test.ts` (new)
  - `tests/state/persistence.test.ts` (new)
- **Risk:** Medium
- **Depends on:** `PR-1.6`
- **Parallelizable:** Yes. Can run in parallel with M2 (`PR-2.2`–`PR-2.5`) and M3 (`PR-3.2`–`PR-3.3`). Blocks `PR-4.5`.
- **Description & Technical Details:**
  Implement file-backed persistence with **Swipe / Edit / Regenerate State Coupling** (§5.8, F-10, F-17):
  - **Message-State Checkpoint Binding (`src/state/swipe-tree.ts`):**
    - Chat history is stored as a tree of message nodes (`{ messageId, parentMessageId, role, swipeIndex, content, stateCheckpointId }`).
    - Every completed turn writes a lightweight checkpoint (`stateCheckpointId`) capturing `(WorldState, BeatLedgerState, RngState)`.
    - **`rollbackForSwipe(session, targetAssistantMessageId)`:** Restores the active store state to the `stateCheckpointId` of `targetAssistantMessage.parentMessageId` (the user prompt before that assistant response) before generating the new swipe.
    - **`activateSwipeVariant(session, messageId, swipeIndex)`:** Atomically switches the active store state to the checkpoint bound to that swipe variant so switching between Swipe #1 and Swipe #2 in SillyTavern or the TUI updates all stats, locations, clocks, and beat statuses to match!
  - **Periodic Full Snapshots + Append-Only `events.jsonl` & `audit.jsonl`:** Supports deterministic replay (`replayToTurn`) and save branching (`branchSave`).
- **Required Verification / Tests:**
  - Swipe rollback & variant switch test:
    - Turn 1 Swipe A: tracker increments `trust` from `0 -> 2` and moves scene to `"Garden"`.
    - User swipes (regenerates Turn 1 Swipe B): engine automatically rolls state back to `trust: 0, location: "Hall"` before running Swipe B (where `trust` becomes `1` and location stays `"Hall"`).
    - User clicks "Previous Swipe (Swipe A)": store immediately reflects `trust: 2, location: "Garden"`.
- **Acceptance Criteria:**
  - Swiping, editing, or switching swipes never double-applies tracker deltas or desynchronizes state from prose (F-17).

---

### PR-1.8: 3-Layer Control Room Config, Selective Payload Loader & Prompt-Diff Fingerprinting

- **Files to add/change:**
  - `src/config/control-room-config.ts` (new)
  - `src/config/selective-loader.ts` (new)
  - `src/config/prompt-diff.ts` (new)
  - `tests/config/control-room-config.test.ts` (new)
  - `tests/config/prompt-diff.test.ts` (new)
- **Risk:** Low
- **Depends on:** `PR-1.4`
- **Parallelizable:** Yes. Can run in parallel with `PR-1.5`–`PR-1.7`, `PR-2.1`–`PR-2.5`, `PR-3.1`–`PR-3.3`. Blocks `PR-4.1`, `PR-5.1`.
- **Description & Technical Details:**
  Implement the user customization and tuning engine (§5.7, F-5) modeled on `Combat-Multihog`'s `game-cartridges.js` (`applyCartridgePayloadKeys`) and `src/state/factory-and-diff.js` (`getPromptCategoryImpactBadge`):
  - **3-Layer Precedence Resolver (`resolveEffectiveConfig`):**
    Merges `StockDefaults` → `ActiveSystemPack / CartridgeOverrides` → `UserSessionOverrides` (and `UserGlobalOverrides`).
  - **Selective Payload Group Loader (`applySelectivePayloadGroups`):**
    Allows users loading a System Pack or Cartridge to toggle which payload groups to apply:
    - `capabilities` (spatial tier, combat mode, progression, clocks, factions)
    - `characterSections` (`pcCoreSections`, `npcCoreSections`)
    - `gameSystems` (dynamic tracker modules & custom fields)
    - `promptSections` (base prompt overrides, section ordering, narrative pacing, CYOA toggle)
    - `combatRules` (skill registry, dice settings)
    - `tuningDials` (`beatPressure: 'off' | 'generous' | 'standard' | 'harsh'`, date/time formats)
  - **Prompt & Schema Diff Fingerprinting (`src/config/prompt-diff.ts`):**
    Computes format-neutral hashes (`djb2` / SHA-256 normalized snapshot) for every prompt section and tracker module against both Stock and Cartridge baselines, returning `'matches_stock' | 'from_cartridge' | 'user_customized'` badges and one-click reset helpers.
- **Required Verification / Tests:**
  - Selective apply test: loading a Tactical RPG Cartridge with `characterSections: false` applies the cartridge's combat and beat rules while preserving the user's custom PC/NPC sheet sections untouched.
  - Fingerprint badge test: modifying a prompt section flips its badge to `'user_customized'`, and calling `resetSectionToBaseline` restores `'matches_stock'` (or `'from_cartridge'`).
- **Acceptance Criteria:**
  - Users have complete visibility and selective control over every rule, prompt, and tracker section loaded by a cartridge or System Pack.

---

## Milestone 2: Beat Graph, Episodic Chronicle, Living-World Agendas & Script Sandbox

**Goal:** Build the declarative Predicate DSL (supporting Tier 0–2 `at` matching and dynamic `custom_field` predicates), the Beat Lifecycle Engine (with `beatPressure`-scaled soft deadlines, `SHORT_CIRCUITED` handling, and adaptable role bindings), Routes and Endings, the Off-Screen Agenda + Tier 0–2 Cast Presence + **Episodic Chronicle Engine**, and the QuickJS WASM sandbox.

---

### PR-2.1: Declarative Predicate DSL, Tier 0–2 `at` Matcher & Dirty-Flag Dependency Compiler

- **Files to add/change:**
  - `src/beats/predicate-ast.ts` (new)
  - `src/beats/dependency-compiler.ts` (new)
  - `src/beats/predicate-evaluator.ts` (new)
  - `tests/beats/predicate-evaluator.test.ts` (new)
  - `tests/beats/dependency-compiler.test.ts` (new)
- **Risk:** Medium
- **Depends on:** `PR-1.5`
- **Parallelizable:** Yes. Can run in parallel with `PR-1.6`, `PR-1.8`, `PR-3.1`. Blocks `PR-2.2`.
- **Description & Technical Details:**
  Implement the pure JSON Predicate DSL (§6.3):
  - Predicate kinds: `flag`, `counter`, `custom_field` (queries user/Game-System dynamic fields!), `clock`, `slot`, `at`, `relation`, `entity`, `any_entity`, `count_entities`, `beat_status`, `form_active`, `mentions`, and `all`, `any`, `not`.
  - **Tier-Aware `{ "at": "<target>" }` Evaluation:**
    - In Tier 1/2 (`emergent` / `authored_graph`), checks `state.scene.locationId === target` (or location tag membership).
    - In Tier 0 (`scene_only`), performs normalized case-insensitive word/tag matching against `state.scene.location` so beats work even on mapless character cards!
  - **Dirty-Flag Dependency Path Compiler (BR-4):** Indexes all predicate ASTs into `DependencyIndex: Map<PathPattern, Set<BeatId>>` (including `custom_fields.<id>` and `scene.location`).
- **Required Verification / Tests:**
  - Unit tests for all predicate types, Tier 0 vs Tier 2 `at` matching, and dynamic `custom_field` predicates (e.g., `{ "custom_field": "sanity", "op": "<", "value": 30 }`).
  - Benchmark test: 500-beat dirty-flag lookup and evaluation completes in `< 0.2 ms` (N-5).
- **Acceptance Criteria:**
  - 100% declarative evaluation (BR-1) across all three spatial tiers and custom tracker fields.

---

### PR-2.2: Beat Lifecycle Engine (Gates, Nudges, Ambient, Pressure-Scaled Soft Deadlines, Short-Circuiting & Role Binding)

- **Files to add/change:**
  - `src/beats/beat-ledger.ts` (new)
  - `src/beats/role-binder.ts` (new)
  - `src/beats/beat-engine.ts` (new)
  - `tests/beats/beat-engine.test.ts` (new)
  - `tests/beats/role-binder.test.ts` (new)
- **Risk:** High (core narrative state machine)
- **Depends on:** `PR-1.6`, `PR-2.1`
- **Parallelizable:** Yes. Can run in parallel with `PR-1.7`, `PR-2.4`, `PR-2.5`, `PR-3.2`. Blocks `PR-2.3`, `PR-4.1`.
- **Description & Technical Details:**
  Implement the Beat Lifecycle Engine (§6.4–§6.7) with `beatPressure` scaling and Director overrides:
  - **No-Op When Disabled:** If `capabilities.beats === false` and no custom Game System registers ambient/nudge triggers, beat evaluation returns immediately in `0 ms`.
  - **User `beatPressure` Scaling on Soft Deadlines:**
    - When `beatPressure === 'off'`, soft `deadline` predicates never fire `on_deadline`.
    - When `beatPressure === 'generous'`, numeric clock deadline thresholds scale by $\lceil 1.5 \times \text{value} \rceil$; when `'harsh'`, by $\lfloor 0.75 \times \text{value} \rfloor$.
  - **Lifecycle Passes:** Impossibility (`impossible_when` → `SHORT_CIRCUITED`) → Resolution (`until` → `RESOLVED`/`ADAPTED`, supporting `chronicle` effect emission) → Soft Deadline (`deadline` → `on_deadline` effects + `DEFERRED`/`CLOSED`/`escalate`) → Eligibility & Adaptable Role Binding (`bindBeatRoles`) → Priority Selection (`0..1` `gate`, budgeted `nudge`s, budgeted `ambient`s).
  - **Director Bar Manual Beat Override:** Supports `forceBeatTransition(beatId, 'resolved' | 'deferred' | 'short_circuited')` logged with `source: 'user_director'`.
- **Required Verification / Tests:**
  - `beatPressure` scaling test: a beat with a Day 4 deadline fires on Day 4 under `standard`, Day 6 under `generous`, Day 3 under `harsh`, and never under `off`.
  - Adaptable role binding, monotonicity (`BR-9`), and Director manual beat override tests.
- **Acceptance Criteria:**
  - All beat requirements `BR-1` through `BR-9` verified by automated unit tests.

---

### PR-2.3: Routes, Endings & Post-Ending Branches

- **Files to add/change:**
  - `src/beats/routes-and-endings.ts` (new)
  - `tests/beats/routes-and-endings.test.ts` (new)
- **Risk:** Medium
- **Depends on:** `PR-2.2`
- **Parallelizable:** Yes. Can run in parallel with `PR-2.4`, `PR-2.5`, `PR-3.3`. Blocks `PR-4.5`, `PR-5.1`.
- **Description & Technical Details:**
  Implement route locking (§6.9) and ending/epilogue evaluation with post-victory branching (§6.10).
- **Required Verification / Tests:**
  - Worked example test from §6.15 (*The Crimson Keep*) and Villain Victory post-ending branch test (*NeoTerra S1* Resistance arc transition).
- **Acceptance Criteria:**
  - Route locks and endings are auditable state writes depending strictly on `WorldState` + `BeatLedgerState`.

---

### PR-2.4: Off-Screen Agenda Tick, Tier 0–2 Cast Presence & Episodic Chronicle Engine

- **Files to add/change:**
  - `src/world/agendas.ts` (new)
  - `src/world/cast-presence.ts` (new)
  - `src/world/chronicle.ts` (new)
  - `tests/world/agendas.test.ts` (new)
  - `tests/world/cast-presence.test.ts` (new)
  - `tests/world/chronicle.test.ts` (new)
- **Risk:** Medium
- **Depends on:** `PR-1.6`
- **Parallelizable:** Yes. Can run in parallel with `PR-1.7`, `PR-2.2`, `PR-2.3`, `PR-2.5`, `PR-3.2`. Blocks `PR-4.1`.
- **Description & Technical Details:**
  Implement the living-world simulation and long-term episodic memory engines (§5.4, §5.8):
  1. **Off-Screen Agenda Tick (`src/world/agendas.ts`):** When `capabilities.factions === true` and `daysElapsed > 0`, deterministically advances faction `influence`, threat `progress`/`stage`, off-screen NPC moves, and rumor generation using the seeded PRNG.
  2. **Tier 0–2 Cast Presence Engine (`src/world/cast-presence.ts`):**
     - **Tier 0 (`scene_only`):** Selects active characters with `presentInScene === true` (or manually pinned via Director Bar), excluding `player.characterId`, and enforces `formGroup` exclusivity (`selectExclusiveCast`).
     - **Tier 1/2 (`emergent` / `authored_graph`):** Selects active characters and faction threats at `state.scene.locationId` + manual pins, enforcing `formGroup` exclusivity.
  3. **Episodic Chronicle Engine (`src/world/chronicle.ts`, from Multihog `EVENT`/`QUEST`/`WORLD` modules):**
     - Stores milestone narrative events in `state.chronicle.events[]` (deduplicating or appending to existing chronicles with the same stable `title`, matching Multihog's `DEFAULT_MODULES.event` accumulation rule: *"Reuse the exact same Name when adding new information — entries are chronicles that accumulate automatically"*).
     - Exposes `getRelevantChronicleBeats(state, presentCharacterIds, recentTranscriptTokens)`: converts matching chronicle entries into priority-scored `ambient` memory blocks so events from 200 turns ago resurface automatically when the involved NPC, location, or keyword returns to the scene.
- **Required Verification / Tests:**
  - Chronicle accumulation & retrieval test: an event `"Siege of Ashford"` recorded on Day 2 is updated on Day 5 under the same title, scrolls out of the chat window, and is automatically retrieved into `[WORLD]` on Turn 120 when `"Ashford"` or a participating NPC enters the scene.
  - Tier 0 vs Tier 2 cast presence and `formGroup` exclusivity tests.
- **Acceptance Criteria:**
  - Long campaigns retain structured episodic memory without prompt bloat, and cast presence works identically with or without a map.

---

### PR-2.5: QuickJS WASM Sandbox & Capability Manifest Runtime

- **Files to add/change:**
  - `src/sandbox/capabilities.ts` (new)
  - `src/sandbox/quickjs-host.ts` (new)
  - `tests/sandbox/quickjs-host.test.ts` (new)
- **Risk:** High (security boundary & third-party code isolation)
- **Depends on:** `PR-1.6`
- **Parallelizable:** Yes. Can run in parallel with `PR-1.7`, `PR-2.2`–`PR-2.4`, `PR-3.1`–`PR-3.3`. Blocks `PR-4.5`.
- **Description & Technical Details:**
  Implement the embedded QuickJS script sandbox (§7, F-6, N-7) using `quickjs-emscripten` with per-script capability manifests (`dice`, `state:read`, `state:write:<glob>`, `entities:write:<collection>`, `clock:advance`, `prompt:inject`), seeded `Math.random`, virtual `Date.now`, `50 ms` CPU timeout, and `16 MB` heap cap.
- **Required Verification / Tests:**
  - Capability denial rollback test, `while(true){}` timeout test (`< 60 ms`), and seeded PRNG determinism test.
- **Acceptance Criteria:**
  - Default-deny isolation verified (`N-7`).

---

## Milestone 3: Deterministic Combat & Optional RPG Progression Engine

**Goal:** Build the clean-room TypeScript tactical grid combat engine, traditional theater-of-the-mind combat mode, and the optional RPG Progression subsystem (XP, level curves, classes, inventory/loot) using `Combat-Multihog` as the behavioral test oracle. When `combatMode: 'disabled'` and `progression: 'disabled'` (e.g., in *Slice-of-Life* mode), these modules are completely bypassed.

---

### PR-3.1: Tactical Grid Topology, Seeded Terrain, Deployment & LOS/Cover Math

- **Files to add/change:**
  - `src/combat/grid-types.ts` (new)
  - `src/combat/terrain-generator.ts` (new)
  - `src/combat/spatial-math.ts` (new)
  - `tests/combat/terrain-generator.test.ts` (new)
  - `tests/combat/spatial-math.test.ts` (new)
- **Risk:** Medium
- **Depends on:** `PR-1.2`, `PR-1.5`
- **Parallelizable:** Yes. Can run in parallel with `PR-1.6`, `PR-2.1`–`PR-2.5`, `PR-3.2`. Blocks `PR-3.3`.
- **Description & Technical Details:**
  Implement 2D tactical grid topology, seeded terrain generation, deployment zones, initiative rolls, 8-way A* movement, and Bresenham/supercover Line-of-Sight (LOS) & half/full cover raycasting.
- **Required Verification / Tests:**
  - Symmetry & edge-case tests for LOS raycasting, cover attribution, and 8-way movement around obstacles.
- **Acceptance Criteria:**
  - 100% pure TypeScript functions with deterministic output for any given seed.

---

### PR-3.2: Declarative Skill/Ability Registry, Status Effects, Passives & Optional RPG Progression

- **Files to add/change:**
  - `src/combat/skill-registry.ts` (new)
  - `src/combat/status-effects.ts` (new)
  - `src/combat/passives-and-willpower.ts` (new)
  - `src/combat/rpg-progression.ts` (new)
  - `tests/combat/skill-registry.test.ts` (new)
  - `tests/combat/rpg-progression.test.ts` (new)
- **Risk:** Medium
- **Depends on:** `PR-1.6`
- **Parallelizable:** Yes. Can run in parallel with `PR-2.2`–`PR-2.5`, `PR-3.1`. Blocks `PR-3.3`, `PR-5.1`.
- **Description & Technical Details:**
  Implement the declarative ability, status, willpower, and optional RPG progression layer:
  - **Skill Registry, Statuses & Passives:** Action costs, resource costs, targeting shapes, hit/save math, status stacking/duration ticks, willpower thresholds, and recursion-guarded passive hooks.
  - **Optional RPG Progression (`src/combat/rpg-progression.ts`):**
    - Active only when `capabilities.progression === 'rpg_levels'` (or `'point_buy'`).
    - Manages deterministic XP awards, configurable level-up thresholds, class/subclass feature unlocks (automatically adding unlocked skill IDs to `character.abilities[]` and scaling `resources.hp.max`), and inventory/currency/equipment stat modifiers.
- **Required Verification / Tests:**
  - Skill cost, cooldown, status stacking, and passive recursion guard tests.
  - RPG Progression test: awarding XP across a level threshold deterministically increments `level`, increases `hp.max`, and unlocks the class's level-gated skills; when `progression === 'disabled'`, XP/level patches are ignored/omitted.
- **Acceptance Criteria:**
  - Cleanly supports both class/level RPG campaigns and progression-disabled realistic settings.

---

### PR-3.3: Action Validator, Partial-Prefix Salvage, Fallback Tactics AI & Traditional Mode

- **Files to add/change:**
  - `src/combat/action-validator.ts` (new)
  - `src/combat/fallback-tactics.ts` (new)
  - `src/combat/combat-resolver.ts` (new)
  - `tests/combat/combat-resolver.test.ts` (new)
  - `tests/combat/oracle-regressions.test.ts` (new)
- **Risk:** High (core combat referee contract)
- **Depends on:** `PR-3.1`, `PR-3.2`
- **Parallelizable:** Yes. Can run in parallel with `PR-2.3`, `PR-2.5`. Blocks `PR-4.1`, `PR-4.5`.
- **Description & Technical Details:**
  Implement `resolveCombatTurn` with step-by-step declarative action validation, **partial-prefix salvage** (committing valid prefix moves before falling back on an illegal skill), **Deterministic Fallback Tactics AI**, **Traditional (gridless) combat mode**, automatic clock hold (`clocks.held = true`), and authoritative `CombatOutcomeSummary` generation.
- **Required Verification / Tests:**
  - Partial-salvage test, traditional gridless mode test, and harvested `Combat-Multihog` oracle regression tests (`tests/combat/oracle-regressions.test.ts`).
- **Acceptance Criteria:**
  - Combat never hangs or throws on malformed LLM action lists; completely inactive when `combatMode === 'disabled'`.

---

## Milestone 4: Prompt Compiler, Model Gateway, Cadence-Throttled Agents & Game System Wizard

**Goal:** Connect the composable store and domain engines to the LLM layer via the Unlockable Section Prompt Compiler, the Per-Role Model Gateway, Cadence-Throttled Boundary Agents, the **In-Engine Game System Wizard**, and the unified Session Turn Runtime (with Swipe Rollback and the **Pre-Turn Director Steering Bar**).

---

### PR-4.1: Unlockable Section Prompt Compiler, Game System Rule Injector & Tier 0–2 State Renderer

- **Files to add/change:**
  - `src/context/tokenizer-budget.ts` (new)
  - `src/context/state-renderer.ts` (new)
  - `src/context/prompt-compiler.ts` (new)
  - `tests/context/prompt-compiler.test.ts` (new)
- **Risk:** Medium
- **Depends on:** `PR-1.8`, `PR-2.2`, `PR-2.4`, `PR-3.3`
- **Parallelizable:** Yes. Can run in parallel with `PR-4.2`, `PR-4.4`, `PR-5.1`. Blocks `PR-4.3`.
- **Description & Technical Details:**
  Implement Referee's Prompt Compiler (§5.3) combining `NeoTerra-Framework`'s token-budgeted renderer with `Combat-Multihog`'s unlockable, reorderable prompt sections and dynamic Game System injectors:
  - **Unlockable & Reorderable Section Pipeline:** Respects `EffectiveConfig.syspromptSectionOrder` and any user-unlocked section overrides (`PR-1.8`).
  - **Dynamic Game System Rule Injection:** Automatically injects `narratorRule` blocks for all currently enabled `GameSystemModule`s (`PR-1.4`), plus Narrative Pacing and optional CYOA choice instructions (`cyoaEnabled`) when toggled on.
  - **Tier- & Module-Aware `[STATE]` Renderer (`src/context/state-renderer.ts`):**
    - Follows `EffectiveConfig.blockOrder`.
    - Only renders enabled modules: in `stock-slice-of-life`, `[STATE]` renders `scene.location`, calendar time, player/present-NPC `CoreSections` (`Worn Equipment`, `Personality`, etc.), relationship bars, and active custom fields—**zero RPG stats, zero faction tables, zero grid coordinates**.
    - In `stock-tactical-rpg` or `stock-living-world`, renders present NPCs' progression/resources/forms/goals and compressed off-screen faction/threat rumors within token budget.
  - **`[PLOT]` + Director Bar Nudge & `[WORLD]` + Episodic Chronicle:**
    - `[PLOT]` renders the `LIVE` gate, budgeted `LIVE` nudges, and any one-turn `scene.directorNudge`.
    - `[WORLD]` renders active `ambient` lore beats and relevant `ChronicleEntry` memories (`PR-2.4`) within the `[WORLD]` token budget.
- **Required Verification / Tests:**
  - Slice-of-Life vs Tactical RPG rendering test: switching a session's System Pack from `stock-tactical-rpg` to `stock-slice-of-life` immediately removes all HP/XP/Level/Class/Combat blocks from the compiled prompt.
  - Token budget enforcement test (`<= budget` guaranteed) and user unlocked-section override test.
- **Acceptance Criteria:**
  - `[STATE]` is 100% store-rendered, modular, and respects user section order, unlocks, and token budgets.

---

### PR-4.2: Per-Role Model Gateway & Structured JSON Output Validator/Repair

- **Files to add/change:**
  - `src/gateway/types.ts` (new)
  - `src/gateway/json-repair.ts` (new)
  - `src/gateway/model-gateway.ts` (new)
  - `src/gateway/mock-provider.ts` (new)
  - `tests/gateway/model-gateway.test.ts` (new)
  - `tests/gateway/json-repair.test.ts` (new)
- **Risk:** Low
- **Depends on:** `PR-1.1`
- **Parallelizable:** Yes. Can run in parallel with M1, M2, and M3. Blocks `PR-4.3`, `PR-4.4`.
- **Description & Technical Details:**
  Implement the multi-role LLM gateway (`narrator`, `intent_parser`, `combat_agent`, `state_tracker`, `storyline_planner`, `game_system_wizard`) with OpenAI-compatible/Ollama/local endpoint support, native JSON Schema enforcement, `<think>` tag stripping, markdown fence JSON extraction (`json-repair.ts`), `AbortSignal` cancellation, and `MockModelGateway`.
- **Required Verification / Tests:**
  - JSON repair tests covering reasoning tags, code fences, trailing commas, and schema validation errors.
- **Acceptance Criteria:**
  - All tests run offline via `MockModelGateway` (N-3).

---

### PR-4.3: Cadence-Throttled Dynamic Tracker & Boundary Micro-Agents

- **Files to add/change:**
  - `src/agents/dynamic-state-tracker.ts` (new)
  - `src/agents/intent-parser.ts` (new)
  - `src/agents/combat-agent.ts` (new)
  - `src/agents/cast-director-agent.ts` (new)
  - `src/agents/storyline-agent.ts` (new)
  - `src/agents/chronicle-router-agent.ts` (new)
  - `tests/agents/dynamic-state-tracker.test.ts` (new)
  - `tests/agents/boundary-agents.test.ts` (new)
- **Risk:** Medium
- **Depends on:** `PR-4.1`, `PR-4.2`
- **Parallelizable:** Yes, with `PR-4.4`, `PR-5.1`, `PR-5.2`. Blocks `PR-4.5`.
- **Description & Technical Details:**
  Implement the boundary micro-agents with **Dynamic Schema Compilation** and **Per-Module Cadence Throttling** (§5.6, §5.8, F-4, F-15):
  1. **Cadence-Throttled Dynamic State Tracker (`dynamic-state-tracker.ts`):**
     - Calls `compileActiveTrackerSchema(effectiveConfig, turnContext)` (`PR-1.4`).
     - If `trackerJsonSchema === null` (no tracker modules enabled or due on this turn's cadence), **skips the LLM call completely (0 tokens, 0 ms latency)**.
     - Otherwise, sends the compiled `trackerJsonSchema` and `activeTrackerInstructions` to the cheap `state_tracker` model, normalizes the returned JSON into a `PatchBatch` (`section_patch`, `custom_field_patch`, `entity_patch`, `emergent_location_visit`), and passes it to `applyPatchBatch` (`PR-1.6`).
  2. **Chronicle Router Agent (`chronicle-router-agent.ts`, from Multihog `EVENT`/`LOC`/`QUEST` router):**
     - Runs on configurable cadence (e.g., `every_5_turns` or `on_beat_resolve` / `on_combat_end`) when `capabilities.chronicle === true`. Extracts concise milestone `ChronicleEntry` records and Tier 1 emergent `LOC` discoveries.
  3. **Intent Parser, Combat Agent, Cast Director & Storyline Planner:**
     - Only invoked when their corresponding capability (`combatMode !== 'disabled'`, `factions`, `beats`) is active.
- **Required Verification / Tests:**
  - Cadence skip test: on a turn where only `every_3_turns` modules are enabled and `turn === 2`, zero LLM requests are made by `dynamic-state-tracker`.
  - Dynamic custom field extraction test: user enables a custom `"cyberpsychosis"` meter (`0..100`) and `"cyberware_installed"` string list; tracker extracts both via the dynamically compiled JSON Schema and commits them through the reducer.
- **Acceptance Criteria:**
  - Tracker adapts automatically to any user/cartridge schema changes and respects turn cadence throttling.

---

### PR-4.4: In-Engine Game System Wizard (Natural Language → Schema + Rule + Beat Generator)

- **Files to add/change:**
  - `src/wizard/game-system-wizard.ts` (new)
  - `src/wizard/wizard-prompts.ts` (new)
  - `tests/wizard/game-system-wizard.test.ts` (new)
- **Risk:** Low
- **Depends on:** `PR-1.4`, `PR-4.2`
- **Parallelizable:** Yes. Can run in parallel with M2, M3, `PR-4.1`, `PR-4.3`, `PR-4.5`, `PR-5.1`. Blocks `PR-6.1`.
- **Description & Technical Details:**
  Port and upgrade `Combat-Multihog`'s **Game System Wizard** (`game-systems.js`, `src/features/game-system-wizard-*.js`) into a store-first Architect tool (§5.6, F-4):
  - **Input:** User natural-language description (e.g., *"Create a Survival Sustenance system tracking Hunger and Thirst from 0 to 100. Reduce both by 10 whenever the time slot advances. If either drops below 25, nudge the narrator that the player is exhausted"*), desired `effectOwner` (`'engine' | 'tracker' | 'hybrid'`), and optional context samples (current lore/story summary).
  - **Execution:** Calls the `game_system_wizard` role on `ModelGateway` enforcing the `GameSystemWizardOutputSchema`:
    - `module`: A valid `GameSystemModule` definition (`id`, `name`, typed `fields`, `trackerInstruction`, `narratorRule`, `cadence`, `ui`).
    - `clockTriggers`: Optional deterministic rules executed on `clock_advance` (e.g., `{ "on": "slot", "patch": { "op": "increment", "path": "custom_fields.hunger", "value": -10 } }`).
    - `suggestedBeats`: Optional `nudge` or `ambient` beats using `{ "custom_field": "hunger", "op": "<", "value": 25 }` predicates.
    - `previewCard`: Sample rendered HUD card values so the user can preview how the system looks before saving.
  - **Validation & Iteration:** Validates the generated module and beats via `PR-1.4` and `PR-2.1` validators; supports `"Iterate / Refine"` prompts and custom Wizard system prompt inspection/copying (matching Multihog's `buildWizardPromptEditorHtml`).
- **Required Verification / Tests:**
  - Wizard generation & validation test: given a mocked Architect response for a "Sustenance" system, verifies that the generated `GameSystemModule`, `clockTriggers`, and `suggestedBeats` pass schema compilation and immediately work in a test turn.
- **Acceptance Criteria:**
  - Users can design new deterministic + tracked RPG mechanics in plain English without writing JSON by hand.

---

### PR-4.5: Unified Session Turn Runtime, Swipe Rollback Controller & Director Steering Bar API

- **Files to add/change:**
  - `src/runtime/session-runtime.ts` (new)
  - `src/runtime/director-steering.ts` (new)
  - `src/runtime/event-bus.ts` (new)
  - `tests/runtime/session-runtime.test.ts` (new)
- **Risk:** High (integrates all subsystems into the §4.2 core loop)
- **Depends on:** `PR-1.7`, `PR-2.3`, `PR-2.5`, `PR-3.3`, `PR-4.3`
- **Parallelizable:** No (convergence point for M1–M4). Blocks `PR-5.3`, `PR-6.1`.
- **Description & Technical Details:**
  Implement `SessionRuntime` orchestrating the 9-step Referee Turn Pipeline (§4.2), **Swipe Rollback/Switch**, and the **Pre-Turn Director Steering Bar** (§5.7, F-6):
  - **Pre-Turn Director Steering API (`applyDirectorSteering`):**
    - Accepts per-turn user overrides before step 1:
      - `clockAction?: 'hold' | 'release' | { advanceSlots: number } | 'rest_to_morning'`
      - `oocNudge?: string` (sets transient `scene.directorNudge` for the current turn's `[PLOT]` section)
      - `pinCharacterIds?: string[]` / `dismissCharacterIds?: string[]`
      - `beatOverrides?: Array<{ beatId: string, status: 'resolved' | 'deferred' | 'short_circuited' }>`
  - **Swipe / Edit / Regenerate Lifecycle Methods:**
    - `regenerateTurn(assistantMessageId, steering?)`: Calls `rollbackForSwipe` (`PR-1.7`), restoring the pre-turn state checkpoint, and re-runs steps 6–9.
    - `switchSwipe(assistantMessageId, swipeIndex)`: Calls `activateSwipeVariant` (`PR-1.7`) to atomically swap the store state to match the selected swipe.
  - **Opt-In Subsystem Gating:** Steps 2 (Combat/Progression), 4 (Clock/Agendas), 5 (Beats), and 8 (Cadence-filtered Tracker/Chronicle) execute only the subsystems enabled in the session's `EffectiveConfig`.
- **Required Verification / Tests:**
  - End-to-end tests across all 4 Stock System Packs:
    1. `stock-freeform`: pure chat turn with zero tracker calls.
    2. `stock-slice-of-life`: Tier 0 scene location + clothing/mood/relationship tracking + swipe rollback verification.
    3. `stock-tactical-rpg`: grid combat encounter + partial salvage + XP level-up.
    4. `stock-living-world`: dual clock advance + off-screen faction agenda tick + beat soft deadline + Director Bar OOC nudge.
- **Acceptance Criteria:**
  - Full §4.2 loop executes deterministically, respects all module toggles, and handles swipes atomically.

---

## Milestone 5: System Pack & Story Cartridge Ecosystem, Converters & Route Simulator CLI

**Goal:** Implement the `system-pack/0.1` and `cartridge/0.1` loaders and static verifiers, build importers for SillyTavern V2/V3 cards, `Combat-Multihog` cartridges/systems, and `NeoTerra-Framework` seasons, and deliver the `referee sim` CLI with three benchmark cartridges (*Slice-of-Life Cafe*, *The Crimson Keep*, and *NeoTerra Season 1*).

---

### PR-5.1: `system-pack/0.1` & `cartridge/0.1` Loader, Static Analyzer & Deadlock Verifier

- **Files to add/change:**
  - `src/cartridge/system-pack-schema.ts` (new)
  - `src/cartridge/cartridge-schema.ts` (new)
  - `src/cartridge/loader.ts` (new)
  - `src/cartridge/static-analyzer.ts` (new)
  - `tests/cartridge/static-analyzer.test.ts` (new)
- **Risk:** Medium
- **Depends on:** `PR-1.8`, `PR-2.3`, `PR-3.2`
- **Parallelizable:** Yes. Can run in parallel with `PR-4.1`, `PR-4.3`. Blocks `PR-5.2`, `PR-6.1`.
- **Description & Technical Details:**
  Implement the loader and static analyzer for composable **System Packs** (`system-pack/0.1`) and **Story Cartridges** (`cartridge/0.1`, §8.1–§8.2):
  - Supports minimal Tier 0 cartridges (only `card.json` + optional `lore/*.md`, requiring zero `entities.json`, `combat.json`, or `beats.json`) paired with any `SystemPack`.
  - When a cartridge includes `beats.json`, `routes.json`, or `entities.json`, runs cross-file ID validation, `requires` DAG cycle detection (`BR-5`), and bounded BFS reachability/deadlock verification (`BR-7`).
- **Required Verification / Tests:**
  - Minimal Tier 0 cartridge load test (loads with `stock-slice-of-life` pack with zero map/entity files).
  - Full Tier 2 cartridge cycle detection and unreachable ending tests.
- **Acceptance Criteria:**
  - Validates both minimal character cards and full multi-file campaign cartridges with exact path diagnostics.

---

### PR-5.2: Ecosystem Importers (SillyTavern V2/V3 PNG/JSON, Combat-Multihog Cartridges/Systems & NeoTerra Seasons)

- **Files to add/change:**
  - `src/cartridge/importers/st-card-importer.ts` (new)
  - `src/cartridge/importers/multihog-importer.ts` (new)
  - `src/cartridge/importers/neoterra-importer.ts` (new)
  - `src/cartridge/exporters/st-lossy-exporter.ts` (new)
  - `src/cartridge/exporters/system-pack-exporter.ts` (new)
  - `tests/cartridge/importers.test.ts` (new)
- **Risk:** Medium
- **Depends on:** `PR-5.1`
- **Parallelizable:** Yes. Can run in parallel with `PR-4.3`, `PR-4.5`. Blocks `PR-5.3`.
- **Description & Technical Details:**
  Build the converters connecting existing content ecosystems (§8.3):
  1. **SillyTavern V2/V3 JSON & PNG Importer (`st-card-importer.ts`):**
     - Extracts `chara` / `ccv3` chunks from PNG or JSON cards; defaults to Tier 0 `scene_only` so **no map is needed**; converts embedded World Info / Lorebooks into `ambient` beats with `mentions` keyword predicates; allows the user to pair the imported card with any System Pack (*Freeform*, *Slice-of-Life*, *Tactical RPG*, or *Custom*).
  2. **Combat-Multihog Cartridge & Game System Importer (`multihog-importer.ts`):**
     - Imports `multihog-game-cartridge` bundles (`CARTRIDGE_PAYLOAD_KEYS` from `game-cartridges.js`) directly into Referee `system-pack/0.1` files, translating `gameSystems`, `customFields`, `npcCoreSections`, `pcCoreSections`, `blockOrder`, `narrativePacing`, `cyoaConfig`, and skill registries into typed Referee schema modules.
  3. **NeoTerra-Framework Season Importer (`neoterra-importer.ts`):**
     - Converts NeoTerra's `data/seasons/s*.json`, `registry.json`, `forms.json`, `factions.json`, `locations.json`, `agendas.json`, and `beats.json` into `cartridge/0.1` bundles paired with `stock-living-world`.
- **Required Verification / Tests:**
  - ST V2/V3 PNG import test (verifying immediate playability in Tier 0 Slice-of-Life mode without map data).
  - Multihog cartridge import test (verifying custom Game Systems, NPC/PC sections, and selective payload loading).
  - NeoTerra S1 import test (verifying 100% validation pass on `validateCartridge` and `analyzeCartridgeGraph`).
- **Acceptance Criteria:**
  - ST cards, Multihog system cartridges, and NeoTerra seasons import cleanly without manual file editing.

---

### PR-5.3: Route Simulator CLI (`referee sim`) & Reference Cartridges (*Slice-of-Life*, *Crimson Keep*, *NeoTerra S1*)

- **Files to add/change:**
  - `src/cli/sim-cli.ts` (new)
  - `cartridges/slice-of-life-cafe/card.json` (new — Tier 0 mapless character card showcase)
  - `cartridges/crimson-keep/` (new — Tactical RPG + Beat Graph micro-campaign showcase)
  - `cartridges/neoterra-s1/` (new — Living-World multi-faction season showcase)
  - `tests/campaigns/slice-of-life.campaign.test.ts` (new)
  - `tests/campaigns/crimson-keep.campaign.test.ts` (new)
  - `tests/campaigns/neoterra-s1.campaign.test.ts` (new)
- **Risk:** Low
- **Depends on:** `PR-4.5`, `PR-5.2`
- **Parallelizable:** Yes. Can run in parallel with `PR-6.1`.
- **Description & Technical Details:**
  Implement the headless Route Simulator CLI (`referee sim validate`, `referee sim run`) and ship three reference cartridges demonstrating the spectrum of the engine:
  1. **`cartridges/slice-of-life-cafe` + `stock-slice-of-life`:** Zero map, zero combat, zero RPG levels; showcases dynamic clothing/mood/habit sheet sections, relationship affinity bars, calendar clock, and swipe rollback.
  2. **`cartridges/crimson-keep` + `stock-tactical-rpg`:** Tactical grid combat, XP/leveling, 5 beats, 2 routes, 2 endings.
  3. **`cartridges/neoterra-s1` + `stock-living-world`:** 20+ active characters with multi-form identities, faction influence clocks, off-screen agenda ticks, pressure-scaled soft deadlines, and Villain Victory → Resistance branching.
- **Required Verification / Tests:**
  - Automated campaign playthrough tests in `tests/campaigns/` for all three reference cartridges.
- **Acceptance Criteria:**
  - All three reference campaigns pass static verification and deterministic replay assertions in `< 1.5s`.

---

## Milestone 6: Local Daemon, SillyTavern Bridge & Native TUI Client

**Goal:** Expose the engine via a localhost HTTP/WebSocket daemon and ship the two v1 user-facing clients: the **SillyTavern Bridge Extension** and the **Native CLI/TUI Client**, both equipped with the **Control Room Editor**, **Game System Wizard**, **Swipe-State Sync**, and **Pre-Turn Director Steering Bar**.

---

### PR-6.1: Localhost HTTP & WebSocket/SSE Service Daemon

- **Files to add/change:**
  - `src/server/daemon.ts` (new)
  - `src/server/routes.ts` (new)
  - `src/server/ws-stream.ts` (new)
  - `tests/server/daemon.test.ts` (new)
- **Risk:** Medium
- **Depends on:** `PR-4.4`, `PR-4.5`, `PR-5.1`
- **Parallelizable:** Yes. Can run in parallel with `PR-5.3`. Blocks `PR-6.2`, `PR-6.3`.
- **Description & Technical Details:**
  Expose `SessionRuntime`, the Control Room Config Manager, the Game System Wizard, and the Cartridge/System Pack Loader over a localhost service (`127.0.0.1:4120`):
  - **REST Endpoints:**
    - `GET /api/system-packs` & `POST /api/system-packs` (list stock/custom System Packs, export/import `.syspack.json`).
    - `GET /api/cartridges` & `POST /api/cartridges/import` (import ST card / Multihog / NeoTerra).
    - `POST /api/sessions` (start session with any combination of `cartridgeId` + `systemPackId` + selective payload group flags).
    - `GET /api/sessions/:id/state` (returns `WorldState`, compiled dynamic tracker schema, active HUD blocks, prompt-diff badges, and pending confirmations).
    - `PATCH /api/sessions/:id/control-room` (live-toggle subsystems, add/edit/reorder custom tracker fields or PC/NPC sheet sections, unlock/edit prompt sections, adjust `beatPressure` or module `cadence`).
    - `POST /api/wizard/generate` (invokes the In-Engine Game System Wizard and returns a previewable `GameSystemModule`).
    - `POST /api/sessions/:id/turn` (executes a turn with optional `directorSteering` payload).
    - `POST /api/sessions/:id/swipe` (handles `regenerate` rollback or `switch_variant` checkpoint swap).
    - `POST /api/sessions/:id/compile-prompt` & `POST /api/sessions/:id/post-narrate` (for SillyTavern Bridge integration).
    - `GET /api/sessions/:id/audit` & `GET /api/sessions/:id/chronicle`.
- **Required Verification / Tests:**
  - Integration tests covering live Control Room module toggling, Wizard generation, turn execution with Director Steering, and swipe checkpoint switching over HTTP/WebSocket.
- **Acceptance Criteria:**
  - Binds strictly to `127.0.0.1` by default, zero telemetry (`N-1`), thread-safe per-session turn locks.

---

### PR-6.2: SillyTavern Bridge Extension (`referee-st-bridge`) with Control Room, Wizard & Director Bar

- **Files to add/change:**
  - `clients/st-bridge/manifest.json` (new)
  - `clients/st-bridge/index.js` (new)
  - `clients/st-bridge/bridge-client.js` (new)
  - `clients/st-bridge/hud-panel.js` (new)
  - `clients/st-bridge/control-room-modal.js` (new)
  - `clients/st-bridge/director-bar.js` (new)
  - `clients/st-bridge/style.css` (new)
  - `tests/clients/st-bridge.test.ts` (new)
- **Risk:** Medium
- **Depends on:** `PR-6.1`
- **Parallelizable:** Yes. Can run in parallel with `PR-6.3`.
- **Description & Technical Details:**
  Build the thin SillyTavern extension projecting the Referee Daemon inside SillyTavern's web UI:
  - **System Pack & Selective Group Picker:** Lets the user attach `stock-freeform`, `stock-slice-of-life`, `stock-tactical-rpg`, `stock-living-world`, or any custom System Pack to *any* SillyTavern chat or character card with one click.
  - **Swipe-State Synchronization:** Hooks ST's `MESSAGE_SWIPED`, `MESSAGE_EDITED`, and `MESSAGE_DELETED` events to call `POST /api/sessions/:id/swipe`, keeping Referee's store 100% synchronized with ST's swipe arrows.
  - **Dynamic HUD Panel:** Automatically renders whatever widgets (`bar`, `badge`, `tags`, `card`) are declared by the currently enabled Tracker Modules and PC/NPC Core Sections—hiding RPG/combat widgets completely when disabled.
  - **Control Room & Game System Wizard Drawer:** UI for toggling modules, editing NPC/PC sheet sections, viewing `"User Customized"` prompt-diff badges, and generating new Game Systems via natural language.
  - **Pre-Turn Director Steering Bar:** Compact bar above ST's chat input for `[⏸ Hold Time]`, `[+1 Slot]`, `[OOC Plot Nudge]`, and scene cast pinning.
- **Required Verification / Tests:**
  - Node unit tests with mocked `globalThis.SillyTavern.getContext()` verifying prompt interception, swipe event state synchronization, selective System Pack switching, and HUD widget rendering.
- **Acceptance Criteria:**
  - Any existing ST card can be played immediately in Slice-of-Life or RPG mode, and full cartridges (*Crimson Keep*, *NeoTerra S1*) run with zero browser-side state drift.

---

### PR-6.3: Native CLI/TUI Client (Desktop & Termux, Dynamic HUD, Control Room & Director Bar)

- **Files to add/change:**
  - `src/tui/app.ts` (new)
  - `src/tui/panes/chat-pane.ts` (new)
  - `src/tui/panes/dynamic-hud-pane.ts` (new)
  - `src/tui/panes/control-room-pane.ts` (new)
  - `src/tui/panes/combat-grid-pane.ts` (new)
  - `src/tui/panes/audit-and-chronicle-pane.ts` (new)
  - `src/cli/main.ts` (new)
  - `tests/tui/tui-controller.test.ts` (new)
- **Risk:** Medium
- **Depends on:** `PR-6.1`
- **Parallelizable:** Yes. Can run in parallel with `PR-6.2`.
- **Description & Technical Details:**
  Implement the native terminal client (`referee play`) for desktop and Android/Termux (§4.4, N-6, N-10):
  - **Adaptive Dynamic HUD (`dynamic-hud-pane.ts`):** Renders only the active System Pack's fields and character sections; collapses cleanly on 80x24 Termux screens.
  - **Interactive Director Bar & Slash Commands:** `/pack <id>` (switch System Pack live), `/wizard <prompt>` (run Game System Wizard in terminal), `/toggle <module>` (enable/disable any subsystem or tracker module), `/nudge <text>`, `/hold-clock`, `/swipe-left`, `/swipe-right`, `/regenerate`, `/chronicle`, `/audit`.
  - **ASCII/Unicode Tactical Grid Drawer:** Active only when a tactical combat encounter is running.
- **Required Verification / Tests:**
  - Headless TUI controller tests verifying live System Pack switching, Wizard invocation, swipe navigation, narrow-viewport (80x24 Termux) rendering, and zero-cartridge freeform play.
- **Acceptance Criteria:**
  - Daily-drivable on desktop and Termux (`N-6`), supporting seamless customization and any genre from realistic slice-of-life to tactical RPG campaigns.
