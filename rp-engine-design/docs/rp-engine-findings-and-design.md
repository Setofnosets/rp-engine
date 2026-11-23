# Referee (working title) — LLM Roleplay Engine

**Findings, product definition, and design document**

- Status: architecture & design specification (v0.3 — updated with modular subsystems, 3-tier spatial topology, dynamic compositional tracker, System Packs vs. Story Cartridges, Control Room customization, and Chronicle/Swipe/Wizard systems)
- Date: November 22, 2026
- Origin: design discussions and reference codebase audits preceding implementation; supersedes v0.1 and v0.2 drafts
- Companion artifacts:
  1. [Combat-Multihog](https://github.com/Setofnosets/Combat-Multihog) — fork of the RPG Companion extension; serves as the **behavioral reference and test oracle** for tactical grid combat, declarative action validation, partial-action salvage, fallback tactics, dynamic tracker sections (`schema-sections.js`), modular Game Systems & Wizard (`game-systems.js`), selective cartridge payload loading (`game-cartridges.js`), and prompt-diff fingerprinting (`factory-and-diff.js`).
  2. **NeoTerra-Framework** — MIT-licensed SillyTavern extension implementing a multi-season superhero/living-world simulation; serves as the **architectural reference and reusable pure-module source** for typed `WorldState` reducers, dual world clocks with time holds, active character/form/goal/location tracking, faction influence & off-screen agenda ticks, canon beat ledgers with soft deadlines, and token-budgeted context rendering.
  3. [rp-engine-implementation-plan.md](./rp-engine-implementation-plan.md) — companion PR-by-PR engineering execution plan.

---

## 1. Executive summary

The decision recorded here is to build a new engine rather than extend SillyTavern (ST) further, and to build it **from scratch as a clean Node/TypeScript runtime**, using `Combat-Multihog` as a behavioral oracle and adapting pure, MIT-licensed architectural patterns from `NeoTerra-Framework`.

Five findings drive this:

1. **The combat referee loop already exists and is proven.** `Combat-Multihog` contains a deterministic, validated, thoroughly tested rules engine (`199` test files, `1,909` tests) currently *embedded* inside a SillyTavern browser extension. The hard math (grid movement, LOS, cover, action validation, deterministic fallback tactics) is solved; the host packaging is the bottleneck.
2. **Living-world simulation inside ST independently forced a store-first rewrite.** `NeoTerra-Framework` stretches SillyTavern to its absolute limit by tracking dozens of active characters (their abilities, multi-form identities, goals, and locations), seasonal timelines, faction influence/goals, and a Canon Beat Ledger. To survive inside ST, NeoTerra already had to invent a versioned `WorldState` document, a pure typed event reducer (`reducer.js`), a dual world clock (`world-clock.js`), schema-constrained micro-agents (`storyline.js`, `cast-director.js`, `state-tracker.js`), a custom `localStorage` Write-Ahead Log (WAL) to work around ST's debounced metadata saves, and an in-flight prompt copy splicer (`interceptor.js`).
3. **Every core requirement demands a state store as the authoritative spine.** Story beats, route locks, endings, off-screen faction agendas, engine-side scripting, swipe-safe rollback, and cheap tracker agents require a **transactional state store as the single source of truth** — architecturally opposite to ST's prompt-and-chat-variable paradigm. Extension work cannot fix a data-flow inversion.
4. **Modularity and user customization are non-negotiable for daily play.** `Combat-Multihog` proved that roleplayers do not play a single genre: an RPG campaign wants XP, levels, classes, tactical combat, and loot, whereas a realistic slice-of-life or drama card wants clothing, mood, relationship affinity, and narrative pacing with zero RPG numbers or pre-authored maps. Therefore, **every engine subsystem must be opt-in**, the **state tracker must be dynamically composable** by both cartridges and users, and **System Packs (rulesets)** must be separable from **Story/Character Cards**.
5. **Full extraction of ST extensions preserves mostly host glue.** Roughly 50–60% of both reference extensions consists of defensive SillyTavern glue (jQuery UI modals, `eventSource` listeners, `chatMetadata` debounce workarounds, `localStorage` WAL recovery, chat-switch race cancellation, and swipe interception). Rewriting the runtime spine from scratch while lifting pure data schemas, prompts, MIT pure helpers, and regression test cases captures the value without inheriting a permanent ST emulation layer.

The application, informally: **a local-first, store-first, modular roleplay engine with a thin CLI/TUI client (and an interim ST bridge), where an LLM narrates but never arbitrates.** Code owns game state, dynamic tracker schemas, clocks, entities, and outcomes; models write prose and propose schema-validated boundary patches. It scales smoothly from a zero-map, zero-stat slice-of-life character card up to a 25-character, multi-faction tactical RPG campaign.

---

## 2. Background and prior art survey

### 2.1 SillyTavern

The dominant LLM roleplay frontend: Node.js server + web UI, 300+ contributors, character cards (V2/V3 spec), world info / lorebooks, personas, prompt presets with injection ordering, STscript macros, group chats, and a mature extension API. Architecture: prompts in, text out; state lives in chat variables, metadata blobs, and re-extracted panels. The model is the default arbiter of outcomes. Docs: <https://docs.sillytavern.app>.

### 2.2 RPG Companion (upstream of Combat-Multihog)

AGPL-3.0 ST extension by SpicyMarinara et al.: sidebar trackers for stats, scene info, character thoughts; "Together" mode (tracker data inside main response) and "Separate" mode (tracker generated in a second API call). State is re-extracted from prose every turn. Notably: the author deprecated the extension and graduated to building **Marinara Engine**, a standalone frontend — the canonical instance of the extension ceiling this project hits.
Repo: <https://github.com/SpicyMarinara/rpg-companion-sillytavern>.

### 2.3 Marinara Engine

Closest existing standalone product to this proposal: self-hosted TypeScript app (AGPL-3.0), three chat modes including a Game mode with AI GM, party, quests, combat; agent pipeline around generation; imports ST cards. Combat remains **model-mediated**, not deterministic in the sense defined here; designed around SOTA models; someone else's design language. Repo: <https://github.com/Pasta-Devs/Marinara-Engine>.

### 2.4 Combat-Multihog (tactical combat, dynamic tracker & modular Game Systems oracle)

The author's fork of RPG Companion, ~2,179 commits, GPL v3 (with visible relicense friction), actively maintained as of November 2026.

**Codebase architecture & capabilities:**
- **Pure Combat Core (`src/features/combat/`):** Separated from ST DOM via `src/app/runtime-bridge.js`. Implements tactical grid combat (seeded terrain, deployment, 8-way movement, LOS, cover, status effects, willpower counters, passives, initiative) and traditional/lewd combat modes.
- **Declarative Action Validation & Partial Salvage:** The combat agent submits a declarative action list against `skill-registry.js`. The engine validates preconditions, resource costs, and targets step-by-step. When an LLM returns a partially invalid sequence, the engine **salvages valid prefix actions** (e.g., legal movement) and substitutes deterministic fallback tactics (basic attack/passives) for the illegal action so the game loop never hangs.
- **Dynamic Compositional Tracker & Core Sections (`src/state/schema-sections.js`, `src/state/default-modules.js`):**
  - NPC and PC character sheets are defined as modular arrays of section descriptors (`DEFAULT_NPC_SECTIONS`, `DEFAULT_PC_SECTIONS`: `Species`, `Body`, `Worn Equipment`, `Personality`, `Background`, `Habits`, `Strengths`, `Flaws`, plus optional `Combat Profile` and `Desires`).
  - Users can add custom fields (`customFields`), reorder tracker blocks (`blockOrder`), and toggle Lorebook Router modules (`NPC`, `LOC`, `FAC`, `QUEST`, `EVENT`, `WORLD`).
- **Game Systems & Wizard (`game-systems.js`, `game-cartridges.js`, `src/state/factory-and-diff.js`):**
  - A **Game System** pairs a GM/Narrator rule block with a structured tracker module and an effect-owner policy. The **Game System Wizard** generates both halves from a plain-English user prompt in a single Architect LLM call.
  - **Game Cartridges (`game-cartridges.js`):** Bundles the entire rule/tracker configuration surface (`CARTRIDGE_PAYLOAD_KEYS`) into shareable packs, with a read-only virtual `"Stock"` cartridge, **Selective Group Loading** (`applyCartridgePayloadKeys`), and **Prompt Diff / Customized Badges** (`getPromptCategoryImpactBadge`).
  - **Runtime Kill Switches (`src/state/section-enabled.js`):** Cleanly powers off entire subsystems (Persistent Maps, CYOA mode, Relationship Bars, Lorebook Agent) when not wanted for a session.
- **Resilience & Test Suite:** `state-manager.js` with WAL backup guards; `199` Vitest suites (`1,909` tests) runnable on Android/Termux with `sessionStorage` isolation.

**Strain points:** A frontend living inside a frontend; lifecycle management hand-rolled around ST's `chat` array and `eventSource`; `llm-client.js` tightly coupled to ST generation hooks; no sandboxed scripting surface; custom Game Systems remain "prompt law" rather than typed, schema-validated store mutations.

### 2.5 NeoTerra-Framework (living-world simulation & store-first prototype)

An advanced, self-contained SillyTavern extension (`MIT` license, zero external runtime dependencies) built for the Neo Terra multi-season superhero setting. Inspection of its codebase reveals that it already implements a working prototype of a **store-first, deterministic world engine** bolted onto SillyTavern:

- **Authoritative `WorldState` & Pure Typed Reducer (`src/state/world-state.js`, `src/state/reducer.js`):** Seeded deterministically from season definitions (`s1`, `s1dark` villain POV, `s2`–`s4`, `sandbox` in `src/data/seasons.js`). State transitions occur exclusively through pure typed events (`applyWorldEvent`) with schema validation and version migrations (`src/state/migrations.js`).
- **Active Character, Form, Ability, Goal, and Location Tracking:**
  - `WorldState.characters[charId]` tracks bounded `status` (`active`, `offscreen`, `captured`, `corrupted`, `dead`, `retired`, `missing`, `lost`, `imprisoned`), `locationId`, numeric `resources` (`{ current, max }`), `corruption` (`{ stage, source, progress }`), `abilities` (extracted from card facets in `src/data/card-facets.js`), and `goals` (`src/data/goals.js`).
  - **Multi-Form Identities (`src/data/forms.js`, `src/state/form-profiles.js`):** Characters can transform between civilian, hero, or corrupted/knight personas while sharing core resources, status, and relationship history. `selectExclusiveCast` guarantees two forms of the same entity never co-exist in a scene.
  - **Player POV Override (`src/data/player-card.js`):** Allows playing as a custom persona or taking over any canon roster character (relocating the scene to their location, removing them from NPC presence lists, and deriving initial goals).
- **Dual World Clock & Time Holds (`src/core/world-clock.js`):**
  - Separates the monotonic mechanical turn counter (`meta.turn`) from narrative fiction time (`meta.storyTurn`, `meta.inGameDate` in `YYYY-MM-DD`, and `meta.timeOfDay` cycling through `morning → afternoon → evening → night`).
  - Supports **Time Holds** (`clock.held`): freezes fiction time during extended multi-message conversations or combat so deadlines do not expire mid-scene.
- **Factions, Threats, and Off-Screen Agenda Ticks (`src/data/factions.js`, `src/data/agendas.js`):**
  - Tracks every faction's `status` (`active`, `dormant`, `disbanded`, `underground`, `dominant`), `influence` (`0..100`), `headquartersLocationId`, and `goals[]`, alongside ranked `threats` (`main` vs `secondary`, `stage`, `progress`).
  - When in-game days advance, an off-screen agenda tick applies deterministic per-day progress (`factionInfluencePerDay`, `mainThreatProgressPerDay`, `maxNpcMovesPerTick`) and generates location-bound rumors.
- **Canon Beat Ledger (`src/data/beats.js`, `src/agents/storyline.js`):**
  - Organizes seasonal story beats by act (`opening`, `escalation`, `climax`, `resolution`), completion predicates (`event-tag`, `character-status`, `location-control`, `threat-stage`, `relationship-affinity`, `form-active`, `beat-resolved`, `flag`), and **flexibility** (`strict`, `adaptable`, `optional`).
  - Beats carry monotonic lifecycle statuses (`open`, `deferred`, `resolved`, `adapted`, `short-circuited`, `closed`) and **soft deadlines** with configurable **beat pressure** (`off | generous | standard | harsh`). Passing the season's terminal deadline triggers a **Villain Victory** epilogue and branches into post-victory routes (`resistance` vs `join-villain`).
- **Schema-Constrained Micro-Agents & Budgeted Context Renderer (`src/agents/`, `src/context/`):**
  - Pure planners (`cast-director.js`, `storyline.js`, `state-tracker.js`) run deterministic lifecycle rules *first*, then optionally invoke a schema-validated LLM pass whose proposals are normalized against the reducer.
  - `src/context/renderer.js` and `budget.js` compile `WorldState` into token-budgeted sections, using location-scoped filtering so only characters and threats present at `player.locationId` consume full prompt detail.

**Where NeoTerra hits SillyTavern's ceiling:**
1. **Persistence fragility:** Because ST's `chatMetadata` save is debounced and non-transactional, `src/state/store.js` had to implement a custom `localStorage` WAL (`neoterra:wal:*`) and per-chat singleton locks.
2. **Prompt splicing gymnastics:** `src/context/interceptor.js` (`neoTerraGenerateInterceptor`) must intercept a mutable copy of the `chat` array, strip previous markers, and splice a synthetic narrator message at `chat.length - depth`.
3. **Browser-bound multi-agent contention:** Running `state-tracker`, `storyline`, `cast-director`, and `auditor` inside browser extension hooks causes UI latency, swipe cancellation races, and shared connection profile contention.

---

## 3. Findings (numbered)

**F-1 — Referee loop already exists and works.** Both `Combat-Multihog` (for grid combat) and `NeoTerra-Framework` (for world/cast/beat updates) prove the target loop: engine runs deterministic rules first → validates structured agent proposals against a strict schema → commits atomic state transitions → renders an authoritative state block for the narrator.

**F-2 — Extension ceiling is structural, not skill-based.** RPG Companion's author left ST to build Marinara Engine; NeoTerra had to build an entire shadow state store, WAL, prompt splicer, and agent scheduler inside a browser extension just to keep a superhero season coherent. The extension API has no transactional execution surface.

**F-3 — Determinism demands store-first.** Hard plot conditions (route locks, ending prerequisites, beat resolution, faction territory control, combat HP/positioning) must be set by code — engine events, reducers, validated scripts, or explicit user actions — never by free-text prose drift.

**F-4 — Tracker separation generalizes into role-specialized micro-agents with configurable cadence.** Separating the narrator from cheap, schema-constrained boundary agents (`parser`, `combat`, `tracker`, `cast-director`, `storyline-adapter`, `chronicle-router`) bounds inputs and isolates model drift. Every agent output is an untrusted **patch/event proposal** normalized against cartridge permissions, and each module runs on a configurable cadence (`every_turn`, `every_n_turns`, `on_clock_advance`, `manual_only`) to avoid unnecessary latency on casual dialogue turns.

**F-5 — The portable fraction of both extensions is crystal clear.**
- From `Combat-Multihog`: pure tactical combat rules, action validation with partial-prefix salvage, deterministic fallback tactics, skill registries, modular NPC/PC section schemas, Game System Wizard patterns, selective payload loading, and `1,909` test specifications serve as the behavioral oracle.
- From `NeoTerra-Framework` (`MIT`): pure reducer architecture, dual world clock with time holds, entity/form exclusivity logic, off-screen agenda math, canon beat lifecycle transitions, and token-budgeted context rendering can be adapted directly.

**F-6 — Scripts make cards third-party code.** Engine-side scripting turns extended character cards ("cartridges") into untrusted imports. The system requires an embedded sandbox (QuickJS) with a strict capability manifest *designed in from the first commit* (§7).

**F-7 — Existing ecosystems still matter.** ST card V2/V3 import keeps the existing card library usable immediately without requiring map or RPG data; an ST Bridge mode allows using SillyTavern as a thin UI host against the local Referee service during migration (§9).

**F-8 — Scratch vs extraction: scratch wins, with dual reference discipline.** Full extraction inherits ST's prompt-mediated chat assumptions and host shims (`eventSource`, `chatMetadata`, DOM popups). Building a clean headless core while using `Combat-Multihog` and `NeoTerra-Framework` as reference specifications captures all domain value at a fraction of the maintenance cost (§10).

**F-9 — License hygiene distinguishes the two references.** Upstream RPG Companion is AGPL-3.0 and `Combat-Multihog` is GPL v3; any code derived from them inherits copyleft. Conversely, `NeoTerra-Framework` is MIT-licensed. Therefore, all core and combat engine code is authored fresh (using `Combat-Multihog` strictly as a black-box behavioral oracle), while MIT patterns from `NeoTerra-Framework` may be cleanly adapted (§12).

**F-10 — Novelty budget goes to the composable System Pack + Story Cartridge format.** Runtime plumbing (turn scheduler, event bus, SQLite/JSONL store, prompt compiler, QuickJS sandbox) uses standard software patterns. The separation of **System Packs** (reusable rulesets & dynamic tracker schemas) from **Story Cartridges** (characters, lore, beats, maps) is the primary user-facing design surface (§5.6, §8).

**F-11 — Deterministic-first rule.** Anything computable (HP arithmetic, XP/level thresholds, inventory, movement legality, clock advancement, off-screen agenda rates, beat predicate satisfaction) never touches an LLM. Models get: narration, boundary intent parsing, and soft-field/adaptation proposals under schema and confirmation gates.

**F-12 — Living worlds require typed entity tables and location-scoped rendering.** When tracking 20+ active characters, multi-form personas, locations, factions, and threats, the state store must natively support typed entity collections (`entities.<collection>.<id>`) and location-scoped context compilation so off-screen entities do not bloat the narrator's prompt (§5.1, §5.3).

**F-13 — Dual clocks and deterministic off-screen agenda ticks are essential.** Separating mechanical `turn` from narrative `story_turn` / `day` / `slot` (with a `clock.held` lock during active scenes/combat) and running a deterministic **Off-Screen World Tick** only when narrative time advances prevents deadlines from expiring mid-conversation (§5.4).

**F-14 — Open-ended RP requires soft deadlines, beat adaptation, and short-circuiting.** Beats must support **soft deadlines** (with user-tunable pressure: `off | generous | standard | harsh`), **`SHORT_CIRCUITED` transitions** (when an `impossible_when` predicate fires, unlocking fallback beats), and **adaptable role binding** (§6.4, §6.5).

**F-15 — Subsystems and spatial topology must be opt-in (3-Tier Spatial Model).** Because 99% of standard character cards lack map data and realistic/slice-of-life RP rejects RPG stats (XP, levels, classes, combat grids), every engine subsystem (`topology`, `combat`, `progression`, `factions`, `clocks`, `beats`, `chronicle`) must be optional. Specifically, spatial tracking must degrade gracefully across three tiers: **Tier 0 (Scene-Only string location, default for ST cards)**, **Tier 1 (Emergent/auto-discovered locations as play progresses)**, and **Tier 2 (Strict authored location graph)** (§5.5).

**F-16 — The State Tracker must be dynamically composable by users and cartridges.** Users and cartridge authors need `Combat-Multihog`'s ability to add, remove, reorder, and customize tracker fields, NPC/PC sheet sections, and paired "Game Systems" (Narrator rule + Tracker schema field) at any time, including via an AI **Game System Wizard**. In a store-first engine, this is achieved by compiling active **Tracker Modules** dynamically into the runtime reducer validator, tracker JSON Schema, and `[STATE]` prompt template (§5.6).

**F-17 — Swipe/Edit/Regenerate must be atomically coupled to State Checkpoints.** In chat frontends, swiping or editing a message frequently desynchronizes or double-applies tracker mutations. Binding every turn's post-turn state snapshot to the message tree (`messageId → stateCheckpoint`) guarantees that swiping, switching swipes, or editing a message automatically rolls back or swaps state atomically (§5.8).

---

## 4. General description of the proposed application

### 4.1 Concept

A lightweight, local-first application and headless service for LLM roleplay that adds a modular, customizable game engine layer: personas, character cards, lorebooks, prompt presets, and model connections (the ST parity set), backed by an authoritative engine that owns **state, dynamic tracker modules, entities, clocks, factions, rules, tactical combat, story structure, episodic chronicles, and swipe-coupled save files**. The LLM is the narrator and a schema-constrained boundary parser/proposer; it is never the referee.

### 4.2 The core loop

```
player input (chat message, slash command, Director Bar nudge/hold, or declared combat action)
   │  (if swipe/regenerate/edit: automatically restore pre-turn state checkpoint for target message node)
   ▼
1. parse intent / command    (deterministic command router or structured boundary parser; skipped if plain chat)
   │
   ▼
2. engine resolves action    (if combat/progression/travel module enabled:
   │                          combat grid, skills, dice, XP/level-up, Tier 1/2 travel, QuickJS scripts;
   │                          partial-prefix salvage + fallback tactics if combat action invalid)
   ▼
3. store commits action patch (typed, atomic reducer transaction against active Compositional Schema
   │                          + audit log + turn_events buffer)
   ▼
4. world clock & agenda tick (if clock module enabled, narrative time advanced, and !clock.held:
   │                          advance day/slot → if factions/agendas enabled, run off-screen agenda tick
   │                          → evaluate cast presence via Tier 0 scene presence or Tier 1/2 locationId)
   ▼
5. beat graph evaluates      (if beats module enabled: dirty-flag indexed predicates over new state)
   │  ├─ impossible beats → SHORT_CIRCUITED (triggers fallback graph)
   │  ├─ soft deadlines passed (scaled by beatPressure dial) → apply on_deadline consequence patches
   │  ├─ beat entered (LIVE) → apply on_entry effects + bind adaptable roles + queue nudge
   │  ├─ route locked → explicit state write recorded in audit log
   │  └─ ending satisfied → session enters ENDED, epilogue fires, post-ending branch offered
   │
   ▼
6. prompt compiler renders   (token-budgeted sections from active System Pack + User Control Room overrides:
   │                          system, persona, card, active Game System rules,
   │                          location/presence-scoped [STATE], [COMBAT_OUTCOME], [PLOT] + Director Nudge,
   │                          predicate-triggered [WORLD] lore + episodic chronicle memories, transcript window)
   ▼
7. narrator generates prose ──────────────────────────────────────────────► chat stream
   │
   ▼
8. post-turn tracker / router agents propose patches (filtered by module enabled flag & turn cadence)
   │  ├─ state_tracker validates dynamic module fields against writable schema & confirmation gates
   │  ├─ cast / storyline agents normalize arrivals, offscreen moves, or adaptable beat bindings
   │  └─ chronicle router records milestone EVENT / LOC / QUEST entries into episodic memory
   ▼
9. save turn & bind swipe    (bind state checkpoint to messageId + append JSONL event log + PRNG seed state)
```

### 4.3 Actors

| Actor | Model role | Trust level | Examples of authority |
| --- | --- | --- | --- |
| Narrator | Main chat model | Prose only | Describes outcomes, active Game System rules, and nudges; never decides state |
| Intent parser | Same or lighter model | Boundary (when active) | Maps free-text player declarations to structured engine actions |
| Combat agent | Fast/reasoning model | Zero (when combat active) | Proposes declarative action list; engine validates, salvages prefix, or runs fallback |
| Dynamic State Tracker | Cheap local/fast model | Enabled writable module fields | Extracts PC/NPC sheet sections, custom fields, mood, clothing, or soft counters on module cadence |
| Cast / Storyline / Chronicle | Cheap local/fast model | Bounded moves & chronicle logs | Proposes NPC arrivals, adaptable role bindings, or concise `EVENT`/`LOC` chronicle summaries |
| Game System Wizard | Main or Architect model | Authoring time only | Generates a validated JSON System Module (schema + tracker instruction + narrator rule + beat) for user review |
| Scripts | None (QuickJS sandbox) | Capability manifest | Custom game rules, skill math, beat effects, custom agenda ticks |
| Engine / store | None (host code) | Absolute | Dynamic schema compiler, reducer, PRNG dice, HP/XP, grid legality, clock, agendas, beat/route/ending resolution |
| User | Human (Control Room & Director Bar) | Absolute via UI/CLI | Toggles modules/System Packs, edits tracker schemas, confirms patches, steers turns, swipes with state rollback |

### 4.4 Platform strategy

- **v1 clients: CLI/TUI + SillyTavern Bridge.** The CLI/TUI matches daily Termux/Android and desktop usage and keeps the engine honest and headless. The ST Bridge extension lets users play inside SillyTavern's web UI while delegating all state, dynamic tracker compilation, combat, and prompt compilation to the local Referee daemon.
- **The engine is a pure TypeScript/Node library + localhost HTTP/WebSocket service.** Same core drives the TUI, the ST Bridge, the Route Simulator CLI, and any future standalone web GUI.
- **Local-first.** Zero telemetry; network calls go exclusively to user-configured LLM endpoints.

---

## 5. System architecture & Modular Subsystems

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Clients:  CLI / TUI (v1)   ·   ST Bridge Extension (v1)   ·   Web GUI (v2)  │
│           (Includes Control Room Editor, Game System Wizard & Director Bar) │
├─────────────────────────────────────────────────────────────────────────────┤
│ Local Daemon API (HTTP REST + WebSocket / SSE stream) & CLI Runner          │
├─────────────────────────────────────────────────────────────────────────────┤
│ Session Runtime: turn scheduler · cadence filter · swipe-checkpoint binder  │
├─────────────────────────────────────────────────────────────────────────────┤
│ 3-Layer Config & Dynamic Schema Registry:                                   │
│   Stock Defaults ──► System Pack / Cartridge ──► User Session Overrides     │
│   (Compiles enabled Tracker Modules, NPC/PC Sections & Custom Game Systems) │
├──────────────────────┬──────────────────────────┬───────────────────────────┤
│ Beat & Route Engine  │ Compositional State Store│ Audit & Episodic Log      │
│ (optional; gates,    │ (scalars, dynamic module │ (append-only JSONL,       │
│  nudges, ambient,    │  fields, typed entity    │  swipe-bound checkpoints, │
│  pressure-scaled     │  tables, form groups)    │  chronicle memory table)  │
│  deadlines, roles)   │                          │                           │
├──────────────────────┴──────────────────────────┴───────────────────────────┤
│ Opt-In Domain Engines (toggled per System Pack / Cartridge / User):         │
│  • Spatial Topology: Tier 0 (Scene string) · Tier 1 (Emergent) · Tier 2 (Map)│
│  • RPG Progression: XP/Level curves, classes, inventory/currency, loot      │
│  • Combat Engine: Tactical Grid · Traditional (theater-of-mind) · Disabled  │
│  • Dual World Clock (turn vs story_turn/day/slot + time holds)              │
│  • Off-Screen Agenda & Cast Presence Engine (factions, threats, forms)      │
├─────────────────────────────────────────────────────────────────────────────┤
│ Script Sandbox (QuickJS WASM; per-script capability manifest; seeded PRNG)  │
├─────────────────────────────────────────────────────────────────────────────┤
│ Prompt Compiler (section order/unlocks, location-scoped [STATE], budgets)   │
│        │                                                                    │
│        ▼                                                                    │
│ Model Gateway (per-role connections: narrator · tracker · combat · wizard)  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 5.1 Compositional State Store & Typed Entity Tables

The state store supports both fixed core primitives and **dynamically registered schema modules** (from the active System Pack, Cartridge, or User Control Room):

- **Core Scalar & Collection Primitives:**
  - `flags`: `Record<string, boolean>`
  - `counters`: `Record<string, number>`
  - `scene`: `{ location: string, locationId: string | null, presentCharacterIds: string[], mood: string, pacing: string, directorNudge: string | null }`
  - `clocks` (when clock module enabled): Dual clock (`turn`, `story_turn`, `day`, `date`, `slot`, `held`, `hold_reason`) + custom countdown/progress timers.
  - `relations` (when relationship module enabled): `Record<string, Record<string, { affinity: number, maxAffinity: number, label: string, tags: string[] }>>`.
  - `custom_fields`: `Record<string, unknown>` — user- or System-Pack-defined global or player fields validated against their dynamic `TrackerModuleDefinition` schema (`meter`, `number`, `enum`, `boolean`, `string`, `string_list`, `object`).
- **Typed Entity Tables (`entities`):**
  - `entities.characters.<id>`:
    - Core identity: `id`, `name`, `status` (`active | offscreen | captured | corrupted | dead | retired | missing | lost | imprisoned`), `presentInScene` (Tier 0), `locationId` (Tier 1/2), `formId`, `formGroup`.
    - **Dynamic Character Sheet Sections (`sections: Record<string, string | string[]>`):** Driven by the active `pcCoreSections` and `npcCoreSections` schema (defaulting to `Combat-Multihog`'s modular sections: `Species`, `Body`, `Worn Equipment`, `Personality`, `Background`, `Habits`, `Strengths`, `Flaws`, plus optional `Combat Profile`, `Desires`, or user-added sections).
    - **Optional RPG Progression & Resources (`progression`, `resources`):** Present only when the active System Pack enables `progression` or `resources` modules (e.g., `level`, `xp`, `class`, `subclass`, `attributes: { str, dex, con, int, wis, cha }`, `resources: { hp, stamina, mana, willpower }`, `abilities[]`). Completely omitted in Realistic / Slice-of-Life mode!
    - **Optional Goals & Corruption (`goals[]`, `agenda`, `allegiance`, `corruption`):** Enabled by Living-World / Faction packs.
  - `entities.factions.<id>` (optional module): `status`, `side`, `influence` (`0..100`), `headquartersLocationId`, `goals[]`.
  - `entities.threats.<id>` (optional module): `rank`, `status`, `stage`, `progress` (`0..100`), `locationId`, `sourceFactionId`, `agenda`.
  - `entities.locations.<id>` (Tier 1/2 topology): `kind`, `status`, `controllingFactionId`, `connectedLocations[]`, `discovered: boolean`, `notes`.
  - `chronicle.events[]` (optional Episodic Chronicle module): Append-only array of `{ id, turn, day, date, title, category: 'event' | 'quest' | 'world', summary, locationId, involvedEntityIds[], keywords[] }`.

### 5.2 Model gateway

- **Per-role connection profiles:** Separate endpoint, model ID, temperature, and JSON-schema strategy per actor role (`narrator`, `intent_parser`, `combat_agent`, `state_tracker`, `storyline_planner`, `game_system_wizard`).
- **Structured output enforcement & JSON repair:** Boundary agents use native JSON Schema response formats with deterministic `<think>` tag stripping and fence extraction (`json-repair`) for local models.

### 5.3 Prompt compiler & Unlockable Section Pipeline

Combines `NeoTerra-Framework`'s token-budgeted renderer (`budget.js`, `renderer.js`) with `Combat-Multihog`'s reorderable, unlockable prompt section manager (`syspromptSectionOrder`, `customSyspromptLibrary`, `factory-and-diff.js`):

- **Ordered, toggleable, and user-unlockable sections:**
  1. `system` & active `preset` instructions (unlockable/overridable per session or System Pack).
  2. `narrative_pacing` & `game_system_rules` — compiled dynamically from all currently enabled **Game Systems** (each active Game System injects its `narratorRule` snippet here; disabling a Game System immediately removes its rule from the narrator prompt).
  3. `persona` & `player_pov` (custom persona + enabled `pcCoreSections` sheet, or "Play As" canon character POV override).
  4. `card` / scenario premise.
  5. `[STATE]` — **rendered deterministically from the store**, formatted according to the active `blockOrder` and enabled tracker modules:
     - **Tier 0 (Scene-Only):** Renders `scene.location`, active player fields, and character sheets (`npcCoreSections`) for NPCs with `presentInScene == true`.
     - **Tier 1/2 (Location Graph):** Renders full profiles only for NPCs and threats at `player.locationId`, plus a 3-line summary of off-screen faction/threat rumors.
     - Disabled modules (e.g., `xp`, `levels`, `hp`, `factions` in a slice-of-life session) produce **zero tokens** in `[STATE]`.
  6. `[COMBAT_OUTCOME]` — present only when the combat module is active and a round resolved this turn.
  7. `[PLOT]` — active `LIVE` gate nudge + `LIVE` nudges + soft-deadline warnings + any one-turn **Director Bar OOC Nudge** entered by the user.
  8. `[WORLD]` — active `ambient` beats (lorebook entries + relevant `chronicle.events` memories matching current entities/location/keywords), clipped to the `[WORLD]` token budget.
  9. `transcript_window` & `latest_input`.

### 5.4 Dual World Clock, Off-Screen Agendas, and Cast Presence

- **Dual World Clock (`clock-engine`, optional module):** Separates mechanical `turn` from narrative `story_turn`, `day`, `date`, and `slot` (`morning | afternoon | evening | night`), with `clock.held` scene locks and user-configurable date/time formatting (`use24hTime`, `useDdMmYyFormat` from Multihog).
- **Off-Screen Agenda Engine (`agenda-engine`, optional module):** Runs deterministically when `day` or `slot` advances and `factions`/`threats` are enabled.
- **Cast Presence (`cast-engine`):** Operates seamlessly in both Tier 0 (`presentInScene` boolean + `formGroup` exclusivity) and Tier 1/2 (`locationId === player.locationId` + `formGroup` exclusivity + manual user scene pins).

### 5.5 Opt-In Subsystem Architecture & The 3-Tier Spatial Model (New)

Every domain subsystem in Referee is controlled by a capability manifest in the active **System Pack / Session Config** (`capabilities: { spatialMode, combatMode, progression, clocks, factions, beats, relationships, chronicle }`):

| Spatial Tier | Config (`spatialMode`) | When to Use | How Locations & `at` Predicates Work |
| --- | --- | --- | --- |
| **Tier 0: Scene-Only (Default)** | `'scene_only'` | Standard SillyTavern V2/V3 cards, slice-of-life, romance, freeform RP with no map | No `entities.locations` graph needed. `scene.location` is a soft string updated by the tracker (e.g., `"Royal Library"`). NPC presence uses `character.presentInScene: boolean`. Beat `{ "at": "library" }` predicates perform case-insensitive substring/tag matching against `scene.location`. |
| **Tier 1: Emergent Topology** | `'emergent'` | Open-ended sandbox RPGs where the author didn't pre-build a map | Starts with an empty `entities.locations` table. When the tracker's `LOC` router module detects a move to a new named site, the engine auto-registers a discovered `LocationEntity` node and links it to the previous location, building the world graph organically during play. |
| **Tier 2: Authored Topology** | `'authored_graph'` | Authored campaigns (*Crimson Keep*, *NeoTerra S1*) | Pre-authored `entities.locations` adjacency graph with `/travel <locationId>` validation, faction territory control, and deterministic travel arrival encounters. |

Similarly, other major subsystems toggle cleanly:
- **`combatMode`**: `'tactical_grid'` (full 2D grid, LOS, cover, fallback AI) | `'traditional'` (theater-of-the-mind skill/turn resolution) | `'disabled'` (pure narrative conflict).
- **`progression`**: `'rpg_levels'` (XP, level tables, classes, stat allocation, skill unlocks) | `'point_buy'` | `'disabled'` (no XP, levels, or classes tracked).
- **`clocks` & `factions`**: `'full_sim'` (dual clock + off-screen faction/threat agendas) | `'calendar_only'` (time of day + date tracking without factions) | `'disabled'`.

### 5.6 Dynamic Compositional State Tracker, Custom Sheet Sections & Game System Wizard (New)

To preserve and elevate `Combat-Multihog`'s moddability (`game-systems.js`, `schema-sections.js`, `customFields`, `blockOrder`) inside Referee's store-first architecture:

1. **Modular PC & NPC Sheet Sections (`pcCoreSections`, `npcCoreSections`):**
   - Character sheets are composed of ordered section definitions (`{ id, name, description, icon, color, fieldType: 'prose' | 'bullet_list' | 'stat_block', hiddenUntilSet?: boolean, writableByTracker: boolean, cadence: CadencePolicy }`).
   - Users and System Packs can switch between presets (e.g., *"D&D Adventurer Sheet"*, *"Realistic Modern Persona"*, *"Superhero Dossier"*, *"Lewd/Intimate Profile"*) or add/edit/delete individual sections at any time.
2. **Dynamic Tracker Modules & Linked "Game Systems" (`GameSystemModule`):**
   - A **Game System** in Referee is a self-contained, toggleable JSON object that bundles:
     - **`id`, `name`, `enabled`, `scope` (`global | session`), `target` (`global | player | npc | location`)**
     - **`fields`**: Typed field schemas (`meter` with `min`/`max`, `counter`, `enum`, `boolean`, `string_list`, `table`) that are dynamically mounted into `WorldState.custom_fields` or `entities.characters.<id>.custom_fields`.
     - **`effectOwner`**: `'engine'` (deterministic formulas/scripts only) | `'tracker'` (LLM tracker proposes patches) | `'hybrid'` (engine computes math; tracker proposes triggers).
     - **`cadence`**: `'every_turn' | 'every_n_turns' | 'on_clock_advance' | 'manual_only'`.
     - **`trackerInstruction`**: Exact extraction rules injected into `state_tracker`'s system prompt *only when this module is enabled and due on the current turn's cadence*.
     - **`narratorRule`**: Behavioral guidance injected into the narrator's `game_system_rules` prompt section *only when this module is enabled*.
     - **`ui`**: How the TUI and ST Bridge HUD render the fields (`bar`, `badge`, `pill_list`, `card`, `hidden`).
3. **Runtime Dynamic Schema Compilation:**
   - Before every turn, the **Dynamic Schema Compiler** inspects all enabled `GameSystemModule`s and `CoreSections` to compile:
     - The strict JSON Schema passed to `state_tracker`'s structured output call.
     - The Reducer's validation & clamping rules (`applyPatchBatch` automatically validates and clamps any dynamic `meter` or `enum` field!).
4. **In-Engine Game System Wizard (`game-system-wizard`):**
   - Upgraded from `Combat-Multihog`'s `game-systems.js`: the user describes a desired mechanic in plain text (e.g., *"Track Hunger and Rest (0-100); lower Hunger by 10 each time slot, and when Hunger < 20, apply a Weakened status and warn the narrator"*).
   - The `game_system_wizard` agent generates a complete, schema-validated `GameSystemModule` JSON (plus optional `ambient`/`nudge` beat definitions and deterministic clock-tick modifiers). The user can preview a sample rendered card, edit the fields or prompts, and toggle it live in the current session or save it to their global Game System Library.

### 5.7 Three-Layer User Customization, Control Room & Pre-Turn Director Bar (New)

1. **Three-Layer Configuration Hierarchy:**
   $$\text{Stock Engine Defaults} \longrightarrow \text{Active System Pack / Cartridge} \longrightarrow \text{User Session / Global Overrides}$$
   - **Selective Group Loader (Multihog `applyCartridgePayloadKeys` parity):** When applying a System Pack or importing a Cartridge, the user can selectively check which payload groups to apply: `[x] Subsystem Toggles`, `[x] Game Systems & Custom Fields`, `[ ] NPC/PC Sheet Sections`, `[ ] Prompt Section Overrides`, `[x] Combat & Dice Rules`, `[x] Story Beats & Lore`.
   - **Prompt Diff Fingerprinting & `"Customized"` Badges (Multihog `factory-and-diff.js` parity):** The Control Room computes format-neutral fingerprints of stock and cartridge prompts/schemas, displaying a `"Matches Stock"`, `"From Cartridge"`, or `"User Customized"` badge on every prompt section and tracker module, with one-click diff inspection and reset.
2. **User-Tunable Gameplay Dials:**
   - **Beat & Deadline Pressure (`beatPressure`):** `off` (soft deadlines disabled) | `generous` ($1.5\times$ deadline window) | `standard` ($1.0\times$) | `harsh` ($0.75\times$ window, $1.5\times$ penalty).
   - **Narrative Pacing Module (`narrativePacing`):** User-tunable scene pacing speed (`slow_burn | balanced | fast_forward`) and optional **CYOA Choice Generation toggle** (`cyoaEnabled`, generating 3–4 suggested action choices at the end of narrator replies).
   - **Per-Field Confirmation & Lock Policy:** Any tracker field can be flipped by the user between `Auto-Apply`, `Queue for Confirmation Toast`, or `Locked (Pin current value)`.
3. **Pre-Turn "Director Steering Bar":**
   - Available directly above the chat input in both TUI and ST Bridge:
     - **Clock Control:** `[ ⏸ Hold Time ]` / `[ ⏩ +1 Slot ]` / `[ 🌙 Rest to Morning ]`
     - **One-Turn OOC Plot Nudge:** Injects a temporary `[DIRECTOR NUDGE: ...]` directive into `[PLOT]` for the upcoming generation only.
     - **Scene Cast Pin / Dismiss:** Manually pin an NPC into the current scene or send them off-screen.
     - **Beat Override:** Manually mark an active Gate beat as `Resolved`, `Deferred`, or `Short-Circuited` if the player wants to steer the story in a custom direction.

### 5.8 Episodic Chronicle Compaction, Swipe-State Coupling & Cadence Throttling (New)

1. **Episodic Chronicle & Memory Router (`chronicle-engine`, from Multihog `EVENT`/`QUEST`/`WORLD` modules):**
   - While `WorldState` scalars/entities hold *present-tense* truth, long campaigns (100–500+ turns) need *past-tense* narrative memory once old messages slide out of the prompt's `transcript_window`.
   - When a beat resolves, combat ends, or the Chronicle Router triggers on its cadence, the engine appends a structured `ChronicleEntry` (`{ id, day, title, category: 'event' | 'quest' | 'world', summary, keywords, entityIds }`) to `WorldState.chronicle`.
   - Each `ChronicleEntry` is automatically indexed as a synthetic `ambient` beat: whenever its `entityIds`, `locationId`, or `keywords` (`mentions`) are active in a later turn, the `[WORLD]` compiler injects the chronicle memory within budget.
2. **Swipe / Edit / Regenerate State Coupling (Branching Message-State Tree):**
   - Every message node in `transcript.jsonl` stores `stateCheckpointId` (pointing to the exact `WorldState` + `BeatLedgerState` + `RngState` after that message's turn completed) and `parentMessageId`.
   - **On Swipe / Regenerate:** Before generating a new swipe for assistant message $M_k$, the Session Runtime automatically restores the `stateCheckpointId` of the preceding user message $M_{k-1}$. The old swipe's tracker mutations, RNG draws, and beat transitions are cleanly unrolled—**never double-applied**.
   - **On Swipe Switch (Left/Right arrow in ST or TUI):** Switching back to an earlier swipe variant $M_k^{(a)}$ immediately activates $M_k^{(a)}$'s bound `stateCheckpointId` so the HUD and store always match the displayed text.
3. **Per-Module Tracker Cadence & Dirty-Turn Throttling:**
   - Not every tracker module needs to run every turn. The Session Runtime groups enabled tracker modules by their `cadence` (`every_turn`, `every_3_turns`, `on_clock_advance`, `on_combat_end`, `manual_only`) and builds the `state_tracker` JSON Schema dynamically for *only the modules due on the current turn*. If zero modules are due on a turn, the post-turn tracker LLM call is skipped entirely.

---

## 6. Beat graph design

### 6.1 Motivation

Story beats, seasonal arcs, routes, and endings are unsupported by traditional chat frontends because they are *temporal and structural predicates over game state*. With a compositional store in place, the beat graph becomes a pure, statically verifiable state machine evaluated each turn (when the `beats` capability is enabled).

### 6.2 State schema (compositional & cartridge/pack-declared)

```json
{
  "schemaVersion": 1,
  "capabilities": {
    "spatialMode": "authored_graph",
    "combatMode": "tactical_grid",
    "progression": "rpg_levels",
    "clocks": "full_sim",
    "factions": true,
    "beats": true,
    "relationships": true,
    "chronicle": true
  },
  "flags": { "met_castellan": false, "secret_known": false },
  "counters": { "trust": 0, "suspicion": 0 },
  "custom_fields": {
    "sanity": 100
  },
  "scene": {
    "location": "The Great Hall",
    "locationId": "keep.great_hall",
    "presentCharacterIds": ["castellan"],
    "mood": "tense",
    "pacing": "balanced"
  },
  "clocks": {
    "day": 1,
    "date": "2026-11-01",
    "slot": "evening",
    "held": false,
    "timers": {
      "ritual_countdown": { "current": 0, "max": 6, "tickOn": "slot" }
    }
  },
  "relations": {
    "player": {
      "castellan": { "affinity": 0, "maxAffinity": 100, "label": "stranger", "tags": [] }
    }
  },
  "inventory": { "party": [], "items": {}, "currency": { "gold": 50 } },
  "entities": {
    "characters": {
      "castellan": {
        "status": "active",
        "presentInScene": true,
        "locationId": "keep.great_hall",
        "formId": "human",
        "formGroup": "castellan_identity",
        "sections": {
          "sec_species": "Human (Northlander, Male)",
          "sec_equipment": "Blackened steel halberd, crimson tabard over chainmail",
          "sec_personality": "Stern, duty-bound, fiercely protective of the archive"
        },
        "progression": { "level": 5, "xp": 0, "class": "Warden" },
        "resources": { "hp": { "current": 80, "max": 80 }, "willpower": { "current": 10, "max": 10 } },
        "custom_fields": {},
        "goals": ["guard_archive"],
        "abilities": ["halberd_sweep", "command_guards"]
      }
    },
    "factions": {
      "crimson_order": {
        "status": "active",
        "side": "villain",
        "influence": 40,
        "headquartersLocationId": "keep.sanctum",
        "goals": ["complete_ritual"]
      }
    },
    "threats": {
      "blood_eclipse": {
        "rank": "main",
        "status": "active",
        "stage": 1,
        "progress": 15,
        "locationId": "keep.sanctum"
      }
    },
    "locations": {
      "keep.great_hall": {
        "kind": "interior",
        "status": "normal",
        "controllingFactionId": "crimson_order",
        "connectedLocations": ["keep.courtyard", "keep.upper_stairs"]
      }
    }
  },
  "chronicle": {
    "events": []
  }
}
```

*(Note: In a **Realistic / Slice-of-Life System Pack**, `capabilities.spatialMode` is `"scene_only"`, `combatMode` and `progression` are `"disabled"`, `factions` is `false`, and `entities.characters.<id>` contains only `status`, `presentInScene`, `sections` (`Species`, `Body`, `Worn Equipment`, `Personality`, etc.), and `custom_fields`.)*

### 6.3 Predicate DSL — declarative data, never code

Predicates are pure JSON ASTs so cartridges remain editable, diffable, statically analyzable for dependency indexing (BR-1, BR-4), and safe to evaluate in bulk. **No JavaScript in triggers.**

```
predicate      := flag | counter | custom_field | clock | at | relation | entity
                | any_entity | count_entities | beat_status | form_active | mentions
                | all | any | not

flag           := { "flag": "<name>", "value"?: true }
counter        := { "counter": "<name>", "op": "=="|"!="|"<"|"<="|">"|">=", "value": <number> }
custom_field   := { "custom_field": "<path>", "op": "=="|"!="|"<"|"<="|">"|">="|"in"|"contains", "value": <val> }
clock          := { "clock": "day"|"story_turn"|"<timer_id>", "op": ">=", "value": <number> }
                | { "slot": "morning"|"afternoon"|"evening"|"night" }
at             := { "at": "<location-id-or-scene-tag>" } // matches locationId in Tier 1/2, or normalized scene.location in Tier 0
relation       := { "relation": ["<from-id>", "<to-id>"], "field": "affinity"|"label"|"tag", "op": ">=", "value": <val> }
entity         := { "entity": ["<collection>", "<id>", "<path>"], "op": "=="|"!="|"<"|"<="|">"|">="|"in"|"contains", "value": <val> }
any_entity     := { "any_entity": "<collection>", "where": { "<path>": <predicate_condition> } }
count_entities := { "count_entities": "<collection>", "where": { ... }, "op": ">=", "value": <number> }
beat_status    := { "beat": "<beat-id>", "status": "resolved"|"adapted"|"short_circuited"|"live" }
form_active    := { "character": "<char-id>", "form": "<form-id>" }
mentions       := { "mentions": ["<keyword>", ...], "window"?: 2 } // case-insensitive token/phrase match in last N turns
all            := { "all": [ predicate, ... ] }
any            := { "any": [ predicate, ... ] }
not            := { "not": predicate }
```

### 6.4 Beat anatomy

Combining Referee's beat structure with `NeoTerra-Framework`'s Canon Beat Ledger features:

```json
{
  "id": "castellan-intro",
  "act": "opening",
  "class": "gate",
  "flexibility": "adaptable",
  "priority": 100,
  "requires": [],
  "roles": {
    "warden": {
      "default": "castellan",
      "fallback_query": { "collection": "characters", "where": { "status": "active", "allegiance": "crimson_order" } }
    }
  },
  "when": { "all": [ { "at": "keep.great_hall" }, { "not": { "flag": "met_castellan" } } ] },
  "until": { "flag": "met_castellan" },
  "impossible_when": {
    "all": [
      { "entity": ["characters", "castellan", "status"], "op": "in", "value": ["dead", "captured"] },
      { "count_entities": "characters", "where": { "status": "active", "allegiance": "crimson_order" }, "op": "==", "value": 0 }
    ]
  },
  "deadline": { "clock": "day", "op": ">=", "value": 4 },
  "on_entry": [
    { "set": { "flags.met_castellan": true } },
    { "inject": "lore/castellan.md" },
    { "script": "castellan-greeting" }
  ],
  "on_resolve": [
    { "increment": { "counters.trust": 1 } },
    { "chronicle": { "category": "event", "title": "Confrontation in the Great Hall", "summary": "Met {{roles.warden.name}} at the stairs of the Crimson Keep." } }
  ],
  "on_deadline": [
    { "increment": { "entities.threats.blood_eclipse.progress": 15 } },
    { "set": { "counters.suspicion": 2 } }
  ],
  "nudge": "{{roles.warden.name}} intercepts the party in the Great Hall before they reach the upper stairs.",
  "once": true
}
```

### 6.5 Beat lifecycle

```
                 ┌────────────── impossible_when true ──────────────► SHORT_CIRCUITED (terminal)
                 │
DORMANT ──when──► ELIGIBLE ──selection──► LIVE ──until true─────────► RESOLVED / ADAPTED (terminal)
   ▲                 │                      │
   │                 ├── deadline passed ───┴── (scaled by beatPressure, fires on_deadline) ► DEFERRED or CLOSED
   └─ when false ────┘
```

- Terminal statuses (`RESOLVED`, `ADAPTED`, `SHORT_CIRCUITED`, `CLOSED`) are **monotonic**: once reached, a beat never re-opens (BR-9).
- Soft `deadline` thresholds scale dynamically with the user's **`beatPressure`** setting (`off` disables deadline firing; `generous` multiplies day/turn thresholds by `1.5`; `harsh` multiplies by `0.75`).

### 6.6 Beat classes

| Class | Cardinality live | Purpose | Resolution |
| --- | --- | --- | --- |
| `gate` | 0–1 (the "current objective") | Primary scene/act progression driver | `until`, `impossible_when`, `deadline` (`close`), or Director Bar override |
| `nudge` | 0–N (budgeted) | Soft plot pushes, foreshadowing, faction/deadline/Game-System pressure | `until`, or `once: true` auto-resolve after entry turn |
| `ambient` | 0–N (budgeted) | Conditional lorebook entries & auto-indexed Episodic Chronicle memories | Non-terminal; active whenever `when` holds |

### 6.7 Evaluation semantics and performance

- **Dirty-flag evaluation (BR-4):** On cartridge load (and whenever a dynamic `GameSystemModule` is toggled), each beat's predicates are compiled into a **dependency path set**. When the store commits a patch, only beats whose dependency paths intersect the mutated paths re-evaluate.
- **Performance target:** Graphs up to ~500 beats and ~100 entities evaluate in `< 1 ms` per turn (N-5).

### 6.8 Ambient beats = structured lorebook + episodic chronicle

An `ambient` beat generalizes SillyTavern World Info: entries are triggered by a declarative **predicate** (combining `mentions` keyword checks with state conditions). Furthermore, entries recorded in `chronicle.events[]` are automatically exposed as synthetic `ambient` beats triggered when their linked characters, locations, or keywords appear in recent turns.

### 6.9 Routes & 6.10 Endings / Post-Ending Branches

- **Routes (§6.9):** Explicit state locks (`flags.route_<id> = true`) recorded in the audit log; route locks can activate route-specific beat subgraphs.
- **Endings & Post-Victory Play (§6.10):** When an ending's `when` predicate holds, the narrator generates a grounded epilogue once from the ending's prompt template + rendered `WorldState`, and offers any declared post-ending branches (e.g., *Resistance* or *Collaborator* arcs, or cross-season save continuation).

### 6.11 Beat-engine requirements (BR)

| ID | Requirement |
| --- | --- |
| BR-1 | Predicates are declarative JSON data only; no scripts in triggers |
| BR-2 | Effect lists apply atomically per event; failure rolls back the entire batch |
| BR-3 | Selection is deterministic: priority descending, then lexicographic `id` |
| BR-4 | Dirty-flag re-evaluation via compiled dependency path sets; O(touched) per turn |
| BR-5 | `requires` cycles, unknown entity/beat IDs, and malformed predicates fail at load time |
| BR-6 | Every beat status transition appends to the audit log |
| BR-7 | Reachability, deadlock, and soft-deadline verification exist as CLI test commands over cartridges |
| BR-8 | Missing state keys default safely (`false`/`0`/`null`) and emit structured validation warnings |
| BR-9 | Terminal beat statuses (`RESOLVED`, `ADAPTED`, `SHORT_CIRCUITED`, `CLOSED`) are monotonic and never reopen |

---

## 7. Scripting sandbox

- **Host engine:** **QuickJS** (`quickjs-emscripten` / WASM), decided over Lua (resolving Q-2).
- **Capability manifest per script:** Declared in `card.json` or `system.json` (`dice`, `state:read`, `state:write:<path-glob>`, `entities:write:<collection>`, `combat:act`, `prompt:inject`, `clock:advance`). Default-deny; undeclared API calls throw a capability violation and abort the script's atomic patch (F-6, N-7).
- **Resource & time limits:** Per-invocation CPU timeout (`50 ms`) and heap cap (`16 MB`).
- **Determinism:** `Math.random` and `Date.now` inside the QuickJS isolate are replaced by the engine's seeded PRNG and virtual `WorldClock`.

---

## 8. Composable "System Packs" (`system-pack/0.1`) & "Story Cartridges" (`cartridge/0.1`)

### 8.1 Separation of Rulesets from Character/Story Cards (F-10, F-15, F-16)

A critical insight from `Combat-Multihog` (`game-cartridges.js`) is that **a game system configuration** (which tracker sections, custom fields, combat rules, and prompt sections are enabled) should be separable from **a character or campaign card**.

Referee therefore defines two composable artifact types:

1. **System Pack (`system-pack/0.1`):**
   - Defines `capabilities` (spatial tier, combat mode, progression mode, clocks, factions, chronicle), `pcCoreSections`, `npcCoreSections`, `gameSystems[]` (dynamic tracker modules + paired narrator rules), `combat` skill/rule catalogues, and base prompt templates.
   - **Four Built-in Stock System Packs ship out of the box:**
     1. **`stock-freeform` (Minimal Chat):** Only basic scene context (`scene.location`, `presentInScene`, `mood`). Zero RPG numbers, zero maps.
     2. **`stock-slice-of-life` (Realistic / Drama / Romance):** Tier 0 Scene-Only spatial mode; tracks `Species`, `Body`, `Worn Equipment/Clothing`, `Personality`, `Habits`, `Relationship Affinity Bars`, `Calendar/Time of Day`, and `Narrative Pacing`. (`XP`, `Levels`, `Classes`, `HP`, `Combat`, and `Dice` are completely disabled).
     3. **`stock-tactical-rpg` (Multihog D&D Parity):** Enables `Classes`, `Levels`, `XP`, `HP/Willpower/Stamina`, `Inventory/Currency`, `Skill Registry`, `Tactical Grid Combat`, `Seeded Dice`, and `Tier 1 Emergent` (or `Tier 2 Authored`) locations.
     4. **`stock-living-world` (NeoTerra Faction Sim Parity):** Enables `Tier 2 Authored Topology`, `Dual World Clock` with time holds, `Faction Influence & Goals`, `Threat Stages`, `Multi-Form Identities`, `Off-Screen Agendas`, and `Canon Beat Ledger`.
   - Users can modify any System Pack in the Control Room, add new mechanics via the **Game System Wizard**, and export their own custom `.syspack.json` bundles (e.g., *"Cyberpunk Edgerunners Pack"*, *"Call of Cthulhu Sanity Pack"*, *"Cozy Life Sim Pack"*).

2. **Story / Character Cartridge (`cartridge/0.1`):**
   - Contains the character(s), scenario premise, lore, and optional authored entities, locations, beats, routes, and endings.
   - A Story Cartridge can declare `"recommendedSystemPack": "stock-tactical-rpg"` (and optionally bundle cartridge-specific `gameSystems` or `combat.json` overrides), **or** leave `systemPack` unbound so the user can pair any standard SillyTavern character card with whichever System Pack they want to play with.

### 8.2 Story Cartridge layout (`cartridge/0.1`)

```
my-campaign.cartridge/
├── card.json               # spec ("cartridge/0.1"), id, version, recommendedSystemPack, persona, prompts
├── system-overrides.json   # (optional) cartridge-specific capabilities, custom Game Systems, or sheet sections
├── state.json              # (optional) initial flags, counters, clocks, relations, inventory, custom_fields
├── entities.json           # (optional) initial characters, forms, factions, threats, locations (omit for Tier 0 cards)
├── agendas.json            # (optional) off-screen per-day faction/threat rates & rumor templates
├── combat.json             # (optional) cartridge-specific skills, passives, enemy stat blocks, terrain themes
├── beats.json              # (optional) beat graph (gates, nudges, ambient, roles, soft deadlines)
├── routes.json             # (optional) routes + endings + post-ending branches
├── lore/*.md               # (optional) ambient markdown injectables
├── scripts/*.js            # (optional) QuickJS sandboxed scripts with capability manifests
└── assets/
    ├── avatars/*           # character/form portraits
    └── endings/*.md        # epilogue generation prompts
```

*(Notice that almost every file beyond `card.json` is optional: a simple ST card import only needs `card.json` + `lore/*.md` and immediately gains full dynamic tracking from whichever System Pack the user selects!)*

### 8.3 Import / export ecosystems

- **Import SillyTavern V2/V3 (JSON & PNG):** Maps character description/personality/scenario/first_mes into `card.json` (defaulting to Tier 0 `scene_only` spatial mode so no map is required); converts World Info / Lorebook entries into `ambient` beats using `mentions` keyword predicates. The user can then attach any System Pack (*Slice-of-Life*, *Tactical RPG*, etc.).
- **Import Combat-Multihog Cartridges & Game Systems:** CLI/UI converter imports `multihog-game-cartridge` JSON payloads directly into Referee **System Packs** (`system-pack/0.1`), preserving `gameSystems`, `customFields`, `npcCoreSections`, `pcCoreSections`, `blockOrder`, and combat catalogues.
- **Import NeoTerra-Framework Seasons:** CLI converter maps NeoTerra's `data/seasons/s*.json`, `registry.json`, `factions.json`, `locations.json`, `agendas.json`, and `beats.json` into `cartridge/0.1` bundles paired with the `stock-living-world` System Pack.
- **Export to ST (lossy):** Exports prose prompts and converts beats into keyword-triggered World Info.

---

## 9. Implementation plan overview

The detailed, PR-sized engineering blueprint (with per-step file lists, pseudocode, dependencies, parallelization matrices, risk levels, and verification suites) lives in **[rp-engine-implementation-plan.md](./rp-engine-implementation-plan.md)**.

### 9.1 Milestones summary

| Milestone | Scope & Deliverables | Key Acceptance Criteria |
| --- | --- | --- |
| **M1: Foundation & Compositional Store Spine** | Workspace bootstrap, seeded PRNG, Dual World Clock (`world-clock`), Dynamic Compositional Schema Compiler (NPC/PC sections, custom fields, Game Systems, 4 Stock System Packs), `WorldState` v2 & 3-Tier Spatial Model, Atomic Reducer, Audit Log, Swipe-Bound Snapshot + JSONL Persistence | 100% deterministic replay; dynamic schema hot-reload; swipe rollback unrolls state without double-application; works in both Slice-of-Life (zero RPG stats/maps) and full RPG/Entity modes |
| **M2: Beat Graph, Chronicle, Agendas & Sandbox** | Declarative Predicate DSL (with Tier 0–2 `at` matching & `custom_field` predicates) + dirty-flag compiler, Beat Lifecycle Engine (soft deadlines scaled by `beatPressure`, `SHORT_CIRCUITED`, adaptable roles), Routes & Endings, Off-Screen Agenda & Tier 0–2 Cast Presence + Episodic Chronicle Engine, QuickJS Sandbox | 500-beat benchmark evaluates in `< 1 ms`; `beatPressure` dial scales deadlines; Episodic Chronicle auto-indexes `EVENT` memories as `ambient` beats |
| **M3: Deterministic Combat & RPG Progression** | Clean-room tactical grid engine (terrain, 8-way move, LOS, cover, initiative), Declarative Skill/Ability Registry & Optional RPG Progression (XP/levels/classes/loot), Action Validator with partial-prefix salvage, Fallback Tactics AI & Traditional Combat mode | Passes behavioral oracle test suite derived from `Combat-Multihog`; entire combat/progression subsystem can be toggled off via System Pack (`combatMode: 'disabled'`, `progression: 'disabled'`) |
| **M4: Prompt Compiler, Gateway, Micro-Agents & Wizard** | 3-Layer Config & Prompt Compiler (unlockable sections, diff fingerprints, location/tier-scoped `[STATE]`, budgets), Per-Role Model Gateway, Cadence-Throttled Boundary Agents (`parser`, `combat`, `dynamic-tracker`, `cast`, `storyline`, `chronicle`) + Game System Wizard, Session Turn Runtime + Director Bar API | Dynamic tracker compiles JSON schema only for enabled modules due on current cadence; Game System Wizard generates valid `GameSystemModule` JSON; Director Bar nudges/holds steer turn execution |
| **M5: Cartridge & System Pack Ecosystem** | `system-pack/0.1` & `cartridge/0.1` Loader, Selective Group Loader (`applyPayloadKeys`), Static Analyzer, Importers (ST V2/V3 PNG/JSON, Multihog Cartridge/System Importer, NeoTerra Season Importer), Route Simulator CLI (`referee sim`), Reference Cartridges (*Slice-of-Life Sample*, *The Crimson Keep*, *NeoTerra S1*) | Standard ST card runs in Tier 0 Slice-of-Life mode with zero map; *Crimson Keep* and *NeoTerra S1* pass static reachability and automated campaign replay tests |
| **M6: Local Daemon, ST Bridge & Native TUI** | Localhost HTTP/WS Service Daemon, SillyTavern Bridge Extension (with Control Room, Game System Wizard & Director Bar UI), Native CLI/TUI Client (Desktop & Termux, HUD, ASCII grid, Control Room & Director Bar) | Playable end-to-end in both SillyTavern (via Bridge) and standalone Termux/Desktop TUI across all 4 Stock System Packs |

---

## 10. Decision record: scratch vs full extraction

| Dimension | Full extraction of extensions | Scratch + dual reference discipline (chosen) |
| --- | --- | --- |
| Host coupling | Inherited; permanent shim layer for ST `eventSource`, `chatMetadata`, `chat` array splicing | None; native Node/TS runtime; browser WAL and `sessionStorage` hacks evaporate |
| State model | Divided between ST chat variables (`Combat-Multihog`) and metadata blobs (`NeoTerra`) | Unified, transactional store-first spine (`scalars + dynamic modules + typed entities + audit log`) |
| Genre flexibility | Multihog assumes D&D/RPG sections by default; NeoTerra hardcodes superhero seasons | Composable **System Packs** (`Freeform`, `Slice-of-Life`, `Tactical RPG`, `Living-World`) + **3-Tier Spatial Model** |
| Dynamic Tracker & Wizard | Custom Game Systems in Multihog are prompt text with no store-side type validation | Game Systems compile dynamically into typed Reducer rules + structured Tracker JSON Schemas |
| Swipe safety | Swiping in ST risks desynchronizing or double-applying tracker state | Message-bound state checkpoints roll back and swap swipe states atomically |
| License | GPLv3 (`Combat-Multihog`) / AGPLv3 (`RPG Companion`) infects extracted code | Fresh core + MIT (`NeoTerra`) patterns allows a permissive (MIT/Apache-2.0) engine core |

---

## 11. Requirements summary

### 11.1 Functional

| ID | Requirement | Priority |
| --- | --- | --- |
| F-1 | Personas (custom persona with modular `pcCoreSections` + "Play As" canon character POV override) | Must |
| F-2 | Composable **System Packs (`system-pack/0.1`)** & **Story Cartridges (`cartridge/0.1`)**, plus ST V2/V3, Multihog, and NeoTerra importers | Must |
| F-3 | Opt-in subsystems & **3-Tier Spatial Model** (Tier 0 Scene-Only string, Tier 1 Emergent discovered locations, Tier 2 Authored graph) | Must |
| F-4 | **Dynamic Compositional State Tracker**: modular NPC/PC sheet sections, user custom fields, toggleable Game Systems (schema + tracker instruction + narrator rule), and **In-Engine Game System Wizard** | Must |
| F-5 | **3-Layer User Control Room**: selective payload group loading, prompt diff fingerprinting & `"Customized"` badges, unlockable prompt sections, `beatPressure` dial, and per-field confirmation policies | Must |
| F-6 | **Pre-Turn Director Steering Bar**: one-turn OOC plot nudges, clock hold/advance controls, manual cast pins, and manual beat status overrides | Should |
| F-7 | Prompt compiler: ordered unlockable sections, active Game System rule injection, Tier 0–2 presence-scoped `[STATE]` rendering, strict token budgets | Must |
| F-8 | Model Gateway: OpenAI-compatible/local endpoints; per-role configs (`narrator`, `tracker`, `combat`, `parser`, `storyline`, `wizard`) | Must |
| F-9 | Typed, versioned, audited state store with scalar maps, dynamic module fields, typed entity tables, and **Episodic Chronicle (`EVENT`/`QUEST`/`WORLD`) memory table** | Must |
| F-10 | **Swipe-coupled saves**: message-node state checkpoints (`messageId → stateCheckpoint`) for atomic swipe rollback/switching + append-only JSONL event log | Must |
| F-11 | Beat graph (when enabled): `gate`/`nudge`/`ambient`, pressure-scaled soft deadlines, `SHORT_CIRCUITED` handling, adaptable role bindings, routes, endings & post-ending branches | Must |
| F-12 | Dual World Clock (`turn` vs `story_turn`/`day`/`slot` + time holds) & deterministic Off-Screen Agenda ticks (when enabled) | Must |
| F-13 | Deterministic tactical grid & traditional combat engine + optional RPG progression (XP, levels, classes, loot) | Must |
| F-14 | QuickJS WASM script sandbox with per-script capability manifest and seeded PRNG | Should |
| F-15 | **Cadence-throttled boundary agents** (`every_turn`, `every_n_turns`, `on_clock_advance`, `manual_only`) with schema validation & confirmation gates | Must |
| F-16 | Route simulator, reachability checker, and deadlock verifier CLI (`referee sim`) | Must |
| F-17 | Localhost daemon + SillyTavern Bridge extension + Native CLI/TUI client | Must (v1) |

### 11.2 Non-functional

| ID | Requirement |
| --- | --- |
| N-1 | Local-first; zero telemetry; network traffic only to configured model endpoints |
| N-2 | Replay determinism: initial seed + event log ⇒ byte-identical state, agenda ticks, beat positions, and dice rolls |
| N-3 | Engine test coverage ≥ 90%; zero unit tests depend on a live LLM call |
| N-4 | Every state mutation and beat transition is audit-logged with source, turn, path, old, and new values |
| N-5 | Beat & dependency evaluation `< 1 ms/turn` at ≤ 500 beats and ≤ 100 entities (dirty-flag indexed) |
| N-6 | Runs on Windows, Linux, macOS, and Android via Termux |
| N-7 | QuickJS sandbox is default-deny with CPU timeout (`50 ms`), memory limit (`16 MB`), and zero network/FS access |
| N-8 | `system-pack/0.1` and `cartridge/0.1` specs strictly versioned with automated schema migration support |
| N-9 | Clean-room authorship for combat/core (GPLv3 reference as behavioral oracle only; MIT reuse permitted from NeoTerra) |
| N-10 | Zero-friction casual RP: any standard ST character card works immediately in Tier 0 without maps or RPG stats |

---

## 12. License note

1. **RPG Companion (AGPL-3.0) & Combat-Multihog (GPL v3):** Any code copied or directly derived from `Combat-Multihog` or upstream `RPG Companion` carries copyleft obligations. To keep the Referee engine core permissively licensed (MIT), all core runtime, dynamic tracker compiler, and combat engine modules must be authored fresh in TypeScript, using `Combat-Multihog` strictly as a behavioral specification and test oracle.
2. **NeoTerra-Framework (MIT):** Explicitly licensed under the MIT License (`README.md`). Its pure architectural designs, schemas, clock arithmetic, reducer conventions, and context budgeting logic are license-compatible with a permissive MIT Referee core.

---

## 13. Risks and resolved design decisions

### 13.1 Risks

| Risk | Mitigation |
| --- | --- |
| Friction on casual ST cards that have no map or RPG stats | **3-Tier Spatial Model** defaults to Tier 0 (`scene_only`) and separates **System Packs** from **Story Cartridges** so any ST card runs out-of-the-box |
| Dynamic user-created tracker modules breaking store determinism | **Dynamic Compositional Schema Compiler**: user/Wizard modules declare typed fields (`meter`, `enum`, `counter`, `string_list`) that compile into deterministic Reducer bounds checks and strict JSON Schemas |
| Swipe / regenerate desynchronizing tracker state from chat history | **Swipe-Coupled Checkpoints**: every message node binds to its post-turn state snapshot; swiping restores the parent message's snapshot before running |
| Micro-agent latency/token cost on every chat turn | **Per-Module Cadence Throttling** (`every_turn`, `every_n_turns`, `on_clock_advance`, `manual_only`); turns with no due modules skip the background LLM call |
| Long campaigns forgetting narrative history after 50+ turns | **Episodic Chronicle (`chronicle.events`)** compacts milestone events into auto-indexed `ambient` memory beats |
| Second-system effect (over-engineering visual maps or GUI chrome) | Location graph only (no visual canvas/Leaflet map in v1); reuse ST UI via Bridge while keeping native UI to a clean TUI |

### 13.2 Resolved questions

- **Q-1 (Do visual maps enter v1?):** **No visual canvas map, and location graphs themselves are optional via the 3-Tier Spatial Model** (`Tier 0 Scene-Only`, `Tier 1 Emergent`, `Tier 2 Authored Graph`).
- **Q-2 (QuickJS vs Lua/Luau as sandbox host?):** **QuickJS (WASM).**
- **Q-3 (Should `mentions` keyword predicates exist in v0.1?):** **Yes**, powering both declarative ST Lorebook imports and Episodic Chronicle memory retrieval.
- **Q-4 (Save format?):** **Swipe-Coupled Checkpoint Snapshots + Append-Only JSONL Event Log.**
- **Q-5 (Tracker customization & confirmation UI?):** **Dynamic Compositional Tracker** with per-module enablement, cadence, effect ownership, and confirmation policies (`auto | batch_confirm | always_confirm | locked`), plus selective group loading and prompt-diff badges in the Control Room.

---

## 14. Glossary

- **3-Tier Spatial Model** — spatial topology modes: Tier 0 (`scene_only` freeform string, no map required), Tier 1 (`emergent` auto-discovered location nodes), and Tier 2 (`authored_graph` strict node connections).
- **Agenda Tick** — deterministic off-screen progression of faction influence, threat stages, NPC relocations, and rumors triggered when narrative time (`day`/`slot`) advances.
- **Beat** — a declarative node in the story graph with eligibility (`when`), completion (`until`), impossibility (`impossible_when`), pressure-scaled soft `deadline`, atomic effects, and a narrator `nudge`.
- **Director Steering Bar** — pre-turn UI/CLI controls allowing the player to hold/advance the clock, inject a one-turn OOC plot nudge, pin NPCs to the scene, or manually resolve/defer a beat.
- **Dynamic Game System Module** — a toggleable bundle pairing typed state fields, a tracker extraction instruction, a narrator behavioral rule, a cadence policy, and a UI renderer (creatable manually or via the **Game System Wizard**).
- **Episodic Chronicle** — append-only log of milestone narrative events (`EVENT`/`QUEST`/`WORLD`) automatically indexed as `ambient` memory beats so long campaigns retain history outside the sliding transcript window.
- **Swipe-Coupled Checkpoint** — binding of a state store snapshot to a specific chat message/swipe ID so regenerating or switching swipes atomically restores the matching game state.
- **System Pack (`system-pack/0.1`)** — a reusable ruleset and tracker configuration bundle (e.g., *Freeform*, *Realistic Slice-of-Life*, *Tactical RPG*, *Living-World Faction Sim*) that can be paired with any character card or Story Cartridge.
