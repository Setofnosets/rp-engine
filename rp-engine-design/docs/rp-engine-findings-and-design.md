# Referee (working title) — LLM Roleplay Engine

**Findings, product definition, and design document**

- Status: planning draft
- Date: November 22, 2026
- Origin: design discussions preceding implementation; supersedes nothing
- Companion artifact: the [Combat-Multihog](https://github.com/Setofnosets/Combat-Multihog) fork of the RPG Companion extension, which serves as behavioral reference and test oracle

---

## 1. Executive summary

The decision recorded here is to build a new engine rather than extend SillyTavern (ST) further, and to build it **from scratch with the existing fork as reference**, rather than extracting the fork wholesale.

Three findings drive this:

1. The fork already contains the genuinely novel asset — a deterministic, validated, fully tested rules engine — and it is currently *embedded* in a browser extension inside a chat frontend. The hard part is done; the packaging is the problem.
2. Every additional requirement (story beats, routes, endings, engine-side scripting, a cheap tracker agent) requires a **state store as the source of truth**, which is architecturally opposite to ST's prompt-and-chat-variable model of state. Extension work cannot buy this; it is a data-flow inversion, and inversions are rewrites.
3. Extraction of the whole fork is dominated by host glue (jQuery, `eventSource`, chat arrays, `sessionStorage`, per-chat persistence, chat-switch cancellation) that would have to be emulated forever. The pure modules lift cheaply regardless, so full extraction preserves mostly the parts we intend to discard.

The application, informally: **a local-first, store-first roleplay engine with a thin CLI/TUI client, where an LLM narrates but never arbitrates.** Code owns game state and outcomes; models write prose. It must degrade gracefully to a plain chat frontend (no cartridge loaded → freeform RP) so it can be dogfooded daily, not just used for engine showcase scenarios.

---

## 2. Background and prior art survey

### 2.1 SillyTavern

The dominant LLM roleplay frontend: Node.js server + web UI, 300+ contributors, character cards (V2/V3 spec), world info / lorebooks, personas, prompt presets with injection ordering, STscript macros, group chats, and a mature extension API. Architecture: prompts in, text out; state lives in chat variables and re-extracted panels. The model is the arbiter of outcomes. Docs: <https://docs.sillytavern.app>.

### 2.2 RPG Companion (upstream of the fork)

AGPL-3.0 ST extension by SpicyMarinara et al.: sidebar trackers for stats, scene info, character thoughts; "Together" mode (tracker data inside main response) and "Separate" mode (tracker generated in a second API call). State is re-extracted from prose every turn. Notably: the author deprecated the extension and graduated to building **Marinara Engine**, a standalone frontend — the canonical instance of the extension ceiling this project hits.
Repo: <https://github.com/SpicyMarinara/rpg-companion-sillytavern>.

### 2.3 Marinara Engine

Closest existing product to this proposal: self-hosted TypeScript app (AGPL-3.0), three chat modes including a Game mode with AI GM, party, quests, combat; agent pipeline around generation; imports ST cards. Combat remains **model-mediated**, not deterministic in the sense defined here; designed around SOTA models; someone else's design language. Repo: <https://github.com/Pasta-Devs/Marinara-Engine>.

### 2.4 Combat-Multihog (the fork)

The author's fork of RPG Companion, ~2,179 commits, GPL v3 (with visible relicense friction), actively maintained as of November 2026. Capabilities:

- Grid-based tactical combat: pure rules engine (seeded terrain, deployment, 8-way movement, LOS, cover, statuses, initiative), agent submits a **declarative action list**, engine **validates and interprets every action**, deterministic local tactics run when the model returns nothing usable.
- Skill/ability registry resolved deterministically; D&D-like tracking; game modules / cartridges (`game-cartridges.js`, `game-systems.js`).
- Own LLM client (`llm-client.js`), own sysprompt files, narrator-card creator, per-chat persistence (`tacticalCombatByChat`) with chat-switch cancellation and one-shot interceptors.
- Test suite: 154 files / 1,301 tests (grew to 197 files / 1,870 tests), runnable on Android/Termux with sessionStorage isolation.
- Map architect / map evolution / dungeon reality subsystem: large, prompt-module-paradigm code.

**Strain points** (why the fork motivates the new system): a frontend living inside a frontend; lifecycle management hand-rolled inside an extension; test hacks for a host that was never meant to run an engine; scripting absent — game systems are prompt modules the models are *asked* to follow, i.e., prompt law instead of code.

---

## 3. Findings (numbered)

**F-1 — Referee loop already exists and works.** The fork's combat pipeline *is* the target architecture at miniature scale: engine parses declared intent → resolves deterministically → hands outcome + state block to the model → model narrates. This validates the core design; the project is generalization, not invention.

**F-2 — Extension ceiling is structural, not skill-based.** RPG Companion's own author, having hit the same ceiling, left to build a standalone frontend. The extension API is prompt-in/text-out with UI hooks; there is no engine-side execution surface with state access. Every system-level feature strains the same seam.

**F-3 — Determinism demands store-first.** For combat that cannot be cheated by the model, hard plot conditions (route locks, ending prerequisites) must be set by code — engine events, validated scripts, or explicit user actions — never by free-text inference. ST's architecture has nowhere to put such a store; the new system's spine is the store.

**F-4 — Tracker separation is correct and generalizes.** The tracker-as-cheap-agent idea (Separate mode) works because it bounds inputs. Generalized: tracker proposes **patches** against a typed schema; engine validates and applies. Correctness of plot logic must never depend on tracker inference (see F-3, F-11).

**F-5 — The portable fraction of the fork is small and precious.** Pure rules engine, schemas, prompt texts, and tests: all liftable. Host glue: all rewritable. The git history: a paid-for bug catalog to harvest into regression tests (see §9.3).

**F-6 — Scripts make cards third-party code.** Engine-side scripting turns extended character cards into untrusted imports. The system therefore needs a sandbox with a capability model *designed in from the first commit*, not bolted on (see §7).

**F-7 — Existing ecosystems still matter.** ST card V2/V3 import keeps the existing card library usable; ST stays usable as a host during migration (see §9); Marinara Engine proves the category but does not remove the architectural gap (deterministic referee + editable beat graphs).

**F-8 — Scratch vs extraction: scratch wins, with reference discipline.** Full extraction inherits the prompt-mediated state model — the exact constraint being outgrown — plus a permanent emulation layer for ST host APIs. Lifting the pure modules + copying assets + rewriting glue + harvesting history captures ~all value at lower risk. Recorded in full in §10.

**F-9 — License hygiene requires fresh code.** Upstream is AGPL-3.0; the fork is GPL v3 with relicense friction in history. A permissive new core requires new authorship, with the fork used as reference (behavioral oracle), not as copied source. See §12.

**F-10 — Novelty budget goes to the cartridge format.** Runtime pieces (turn scheduler, event bus, versioned store, prompt compiler, sandbox) are boring, solved patterns. The beat graph / extended-card spec is the genuinely new artifact and the main design surface (see §6, §8).

**F-11 — Deterministic-first rule.** Anything computable (HP arithmetic, inventory, gold, movement legality, beat predicates) never touches an LLM. Models get: narration, intent parsing at the boundary, and soft-field inference under confirmation gates.

---

## 4. General description of the proposed application

### 4.1 Concept

A lightweight, local-first application for LLM roleplay that adds a real game layer: personas, character cards, lorebooks, prompt presets, and connections (the ST parity set), plus an engine that owns **state, rules, story structure, and save files**. The LLM is the narrator and a parser of intent at the boundaries; it is never the referee.

### 4.2 The core loop

```
player input (chat, command, or declared action)
   │
   ▼
1. parse intent            (model call, structured output)   ← boundary
   │
   ▼
2. engine resolves         (deterministic: rules, dice, scripts)
   │
   ▼
3. store commits patch     (typed, atomic, audited)
   │
   ▼
4. beat graph evaluates    (predicates over the new state)
   │
   ▼
   ├─ beat entered → effects + nudge into plot context
   ├─ route locked → recorded, silent or announced
   └─ ending satisfied → session ends, epilogue fires
   │
   ▼
5. prompt compiler renders (state block + live nudges + lore + transcript window)
   │
   ▼
   ▼ narrator generates prose ─────────────────────────► chat
   │
   ▼
6. tracker agent proposes patch (optional, cheap model)
   │    engine validates against schema → commit or reject
   ▼
7. save turn (state snapshot + seed + event log + transcript ref)
```

### 4.3 Actors

| Actor | Model role | Trust level | Examples of authority |
| --- | --- | --- | --- |
| Narrator | Main chat model | Prose only | Describes, never decides outcomes |
| Intent parser | Same or lighter model | Boundary | Maps free text to declared actions |
| Combat agent | Any model | Zero | Proposes action list; engine validates and may discard |
| Tracker | Cheap local model | Soft fields only | Infers mood, presence, location; proposes patches |
| Scripts | None (code) | Explicit capabilities | Rules, custom systems, beat effects |
| Engine / store | None (code) | Absolute | Dice, HP, legality, beat resolution, routes, endings |
| User | Human | Absolute via UI | Confirms tracker patches, edits state, fixes routes |

### 4.4 Platform strategy

- **v1 client: CLI/TUI.** Matches actual usage (fork already runs on Termux/Android), keeps scope honest, forces the engine to be headless and scriptable from day one.
- **The engine is a library + local service.** Same core drives the TUI, a future web UI, and the ST bridge (§9, M2). UIs are replaceable; the store is not.
- **Local-first.** No telemetry; network only toward configured model endpoints.

### 4.5 What it is not

- Not a model backend; connects to OpenAI-compatible (and other) endpoints like ST does.
- Not a SillyTavern UI clone; UI ambition is deliberately minimal in v1.
- Not multiplayer; single-player + GM-shaped sessions only.

---

## 5. System architecture

```
┌────────────────────────────────────────────────────────┐
│ Clients:  CLI · TUI (v1)      web UI / GUI (later)      │
├────────────────────────────────────────────────────────┤
│ Session runtime: event bus · turn scheduler · replay    │
├────────────────────────┬───────────────┬───────────────┤
│ Beat graph engine      │ State store   │ Audit log     │
│ (§6)                   │ (typed,       │ (append-only, │
│                        │  versioned,   │  replayable)  │
│                        │  atomic)      │               │
├────────────────────────┴───────────────┴───────────────┤
│ Rules engines: combat (grid) · skills · dice · clock    │
├────────────────────────────────────────────────────────┤
│ Script sandbox (QuickJS or Lua; capability manifest)   │
├────────────────────────────────────────────────────────┤
│ Prompt compiler ──► Model gateway (per-role connections) │
│      narrator · tracker · combat agent · parser         │
└────────────────────────────────────────────────────────┘
```

### 5.1 State store

- Typed fields: `flags` (bool), `counters` (number), `relations` (character → label), `inventory` (sets/maps), `clocks` (day/time), `party`/`personas`, `locations`.
- Schema declared per cartridge (§8); strict mode: unknown keys rejected on load, missing keys default (false / 0 / empty) and are reported.
- **Atomic patches.** Effects, script writes, and validated tracker proposals all compile to a patch; application is all-or-nothing per event; failures roll back.
- **Audit log.** Every mutation appends `turn, source, op, path, old, new`. The log is what makes routes debuggable (F-3): "why is this ending locked" becomes a `log grep`, not prompt archaeology.

### 5.2 Model gateway

- Per-role connection config (narrator / tracker / combat / parser), i.e., the generalization of the fork's separate combat-agent connection.
- OpenAI-compatible first; other backends behind one interface.
- No business logic above this line — nothing above the gateway may interpret model output as authoritative state (F-3, F-11).

### 5.3 Prompt compiler

- Ordered, named sections (system, persona, card, `[STATE]`, `[PLOT]`, `[WORLD]`, transcript window, latest reply) with per-section token budgets.
- The `[STATE]` block is **rendered from the store**, never pasted tracker prose (tracker output drifts; rendered state does not).
- `[PLOT]` is filled from live-beat nudges by priority; `[WORLD]` from predicate-triggered lore (structured lorebook, §6.8).

---

## 6. Beat graph design

### 6.1 Motivation

"Story beats", routes, and endings are unsupported by chat frontends because they are *temporal predicates over game state*, and chat frontends have no game state. Once a typed store exists, a beat graph falls out almost for free: **beats are data nodes evaluated against the store each turn.**

### 6.2 State schema (cartridge-declared)

```json
{
  "flags":    { "met_castellan": false, "secret_known": false },
  "counters": { "trust": 0, "suspicion": 0 },
  "clocks":   { "day": 1 },
  "relations": [],
  "inventory": { "party": [] }
}
```

### 6.3 Predicate DSL — data, not code

Predicates must be declarative JSON so cards stay editable, diffable, statically analyzable (dependency extraction, F-4/BR-1), and safe to evaluate in bulk. **No JS in triggers.**

```
predicate := flag | counter | at | relation | clock | all | any | not
flag      := { "flag": "<name>" }                    // value defaults to true
counter   := { "counter": "<name>", "op": ">=" , "value": 3 }
            // ops: == != < <= > >=
at        := { "at": "<site-id>" }
relation  := { "relation": ["<char>", "<rel-id>"] }
clock     := { "clock": "<name>", "op": ">=", "value": 3 }
all       := { "all": [ predicate, ... ] }
any       := { "any": [ predicate, ... ] }
not       := { "not": predicate }
```

Missing names: `flag` → false, `counter`/`clock` → 0. Evaluation is pure and total (no partial-failure states).

### 6.4 Beat anatomy

```json
{
  "id": "castellan-intro",
  "class": "gate",
  "priority": 100,
  "requires": [],
  "when":  { "not": { "flag": "met_castellan" } },
  "until": { "flag": "met_castellan" },
  "on_entry": [
    { "set":     { "met_castellan": true } },
    { "inject":  "lore/castellan.md" },
    { "script": "castellan-greeting" }
  ],
  "nudge": "The castellan intercepts the party before they reach the stairs.",
  "once": true
}
```

- `id` — stable, referenced by `requires`, saves, and tests.
- `class` — `gate` | `nudge` | `ambient` (§6.6).
- `priority` — selection order within a class (higher wins; tie-break: lexicographic `id`, so selection is deterministic, BR-3).
- `requires` — beat IDs that must be resolved first (DAG, not a tree; cycles are a load-time validation error, BR-5).
- `when` — eligibility predicate.
- `until` — resolution predicate; when true on a live beat, it resolves (fires no narration by itself).
- `on_entry` — ordered effect list: `set`, `increment`, `give`, `inject` (lore into `[WORLD]`), `script` (capability-gated hook).
- `nudge` — prose fragment injected into `[PLOT]` while the beat is live; this is the *only* way a beat talks to the narrator.
- `once` — resolved beats never re-enter (default true for gates).

### 6.5 Beat lifecycle

```
DORMANT ──when true──► ELIGIBLE ──selection──► LIVE ──until true──► RESOLVED
   ▲                                                        │
   └──────────────── when becomes false (eligibility loss) ─┘
```

- A beat's nudge is injected only while `LIVE`.
- Resolution is idempotent; re-resolution is a no-op.
- Eligibility loss (state changed such that `when` no longer holds) returns the beat to `DORMANT` **without** rolling back effects — rollback is explicit, via `on_abort` effects if a card wants it.

### 6.6 Beat classes

| Class | Cardinality live | Purpose | Resolution |
| --- | --- | --- | --- |
| gate | 0–1 (the "current objective") | Route-blocking progression; scene starters | `until` or explicit engine event |
| nudge | 0–N | Soft plot pushes, foreshadowing, recurring pressure | `until`, or `once` auto-resolve on entry fire |
| ambient | 0–N | Conditional lore/context (predicate-triggered world info) | never resolves; active while `when` holds |

The selection policy per turn: evaluate dirty beats (§6.7) → the highest-priority eligible **gate** becomes the live gate (at most one) → all eligible **nudges** within their class token budget become live → all **ambient** beats with true predicates activate (subject to `[WORLD]` budget).

This one-gate-many-nudges policy keeps `[PLOT]` coherent: the narrator sees exactly one "what should happen now" directive plus supporting pressures, which is how authored campaigns read.

### 6.7 Evaluation semantics and performance

- **Dirty-flag evaluation (BR-4).** On load, each beat's `when`/`until` AST is compiled to a **dependency key set** (e.g., `{flags.met_castellan}`, `{counters.trust}`). On a store patch, only beats whose dependencies intersect the changed keys re-evaluate. Cost per turn is O(changed keys → beats touched), not O(beats).
- **When:** start of turn (after applying user events/script effects) and after tracker patch application.
- **Resolution check:** after each patch as well, so a beat whose `until` becomes true via a tracker-proposed patch resolves in the same turn.
- Budget: graphs up to ~500 beats evaluate in < 1 ms per turn (N-5); the dependency index makes this comfortable.

### 6.8 Ambient beats = structured lorebook

An `ambient` beat generalizes ST world info: entries triggered by a **predicate** (possibly including "keyword appeared in last exchange" via a `mentions` predicate) instead of keywords alone. Injection is budgeted and priority-ordered. This is the "lorebook, but only when it matters, and verifiable" upgrade: activation is testable (BR-7).

### 6.9 Routes

A route is a named slice through the beat space with an explicit lock:

```json
"routes": [
  { "id": "loyal",    "lock": "route_loyal",
    "when": { "counter": "trust", "op": ">=", "value": 3 }, "priority": 2 },
  { "id": "betrayal", "lock": "route_betrayal",
    "when": { "flag": "secret_known" }, "priority": 1 },
  { "id": "exile",    "lock": "route_exile",
    "when": { "counter": "suspicion", "op": ">=", "value": 5 } }
]
```

Semantics:

- Route lock is an **explicit state write** (flag set) recorded in the audit log — auditable, not emergent.
- First lock wins (highest priority among currently-true routes evaluated left-to-right on ties); locks are sticky unless a script clears them.
- `beats` may declare `"route": "loyal"` to only exist on that route — route locking can *activate* beat subgraphs. The beat graph, not the narrator, decides what exists in the world on each route.
- Optional `announce` field on a route lets the engine surface "(The story has turned: Exile)" to the player, or stay silent.

### 6.10 Endings

```json
"endings": [
  { "id": "true-ending", "route": "loyal",
    "when": { "all": [ { "flag": "secret_known" },
                       { "counter": "trust", "op": ">=", "value": 5 } ] },
    "epilogue": { "prompt": "assets/endings/true.md" },
    "mark": "ended.true-ending" }
]
```

- An ending is an endpoint predicate evaluated like a gate with infinite priority; when true, the session enters `ENDED`: the narrator generates the epilogue from the ending's prompt + a rendered final state block, the save is marked `ended.<ending-id>`, and branching ("new game plus" from this save) is offered.
- **Ending eligibility is checked only against current state + route locks**, never against transcript content (F-3).

### 6.11 Interaction contract with the other systems

- **Narrator:** receives live-beat nudges via `[PLOT]`; nothing else about the graph. The narrator cannot see dormant beats and cannot resolve them.
- **Tracker:** may only propose patches; the engine validates them against the schema and its own policy (`trust` mutable by tracker, `secret_known` not — the cartridge declares which fields are tracker-writable). A beat may **require confirmation** for hard fields: `"confirm": true` surfaces a UI prompt to the player (F-4).
- **Combat:** `END_COMBAT` is a normal engine event; cartridge scripts hook `on_combat_end` to write outcomes into state (`guard_defeated = true`), which then drive beats. The fork's "authoritative outcome block queued for the next narrator generation" becomes a store event.
- **Saves:** a save snapshots state + beat positions (`dormant/eligible/live/resolved` set) + RNG seed + transcript ref. Because beat position is derived from state (except `resolved` sets), saves stay small: state + resolved-beat IDs + seed.

### 6.12 Determinism and audit rules (normative)

1. Hard conditions are set only by: engine events, validated scripts, or explicit user action — never tracker inference (F-3, F-11).
2. Tracker proposals apply only to fields the cartridge marks tracker-writable; everything else rejects with a logged reason.
3. Beat selection is a pure function of (state, resolved-set, cartridge) — no RNG, no timestamps, no model calls.
4. Replay determinism: same seed + same event log ⇒ identical state, beat positions, and dice outcomes (N-2).

### 6.13 Beat-engine requirements (BR)

| ID | Requirement |
| --- | --- |
| BR-1 | Predicates are declarative data only; no scripts in triggers |
| BR-2 | Effect lists apply atomically per event; failure rolls back the whole list |
| BR-3 | Selection is deterministic: priority, then lexicographic id |
| BR-4 | Dirty-flag re-evaluation via compiled dependency sets; O(touched) per turn |
| BR-5 | `requires` cycles, unknown ids, and malformed predicates are load-time errors |
| BR-6 | Every beat transition appends to the audit log |
| BR-7 | Reachability/deadlock checking exists as a test-harness command over cartridges |
| BR-8 | Missing state keys default (false/0/empty) and are reported, not silent |

### 6.14 Testing the graph

- **Route simulator (CLI):** `sim run --cartridge c --events events.jsonl --assert expectations.json` — replay recorded event streams and assert beat/route/ending outcomes. This is the beat-graph analogue of the fork's engine tests.
- **Reachability check:** every gate and every ending is reachable from the initial state under *some* event sequence (bounded exploration); unreachable artifacts are reported as authoring errors.
- **No-deadlock property test:** from the initial state, some event sequence always leaves at least one gate eligible (a campaign can't paint itself into a corner without ending).
- **Campaign regression tests:** a scripted playthrough per route asserting its ending fires — the thing prompt-module game systems can never have (F-3).

### 6.15 Worked mini-example

A three-beat, two-route cartridge "The Crimson Keep":

```
day 1, party enters keep.great_hall
  ambient "torchlight-lore" (at keep) → [WORLD]: keep description
  gate   "castellan-intro" becomes ELIGIBLE → LIVE
    nudge → narrator: castellan intercepts party
    tracker proposes presence:castellan → engine accepts (writable)
  party talks with castellan → counter trust rises (script on dialogue)

day 2, party finds the archive (gate "archive-discovery" requires castellan-intro)
    on_entry: set secret_known → route "betrayal" LOCKS (priority 1 beats "loyal")
    live beats on route betrayal now include "castellan-confrontation"

ending "true-ending" (route loyal + secret_known + trust>=5):
  unreachable on this playthrough — because lock order was fixed at priority,
  the audit log shows exactly when betrayal locked and why.
```

The last line is the point: **route locks are legible**. In a prompt-module system, debugging "why did the story go here" is re-reading transcripts and guessing; here it is `audit grep route_betrayal`.

---

## 7. Scripting sandbox

- **Host:** embed a real interpreter — QuickJS or Lua/Luau — never `eval`. Decide by benchmark on Termux (open question Q-2).
- **Capability manifest per script** (`dice`, `state:read`, `state:write:<field>`, `combat:act`, `prompt:inject`, `clock`): default-deny; engine denies undeclared calls (F-6, N-7). No network. No filesystem beyond the sandbox root.
- **Injected APIs:** `state.get/patch`, `dice.roll(spec)` (seeded), `combat` facade, `prompt.inject(section, text)`, `events.on(...)`, `clock.advance(...)`.
- **Determinism:** RNG is a seeded PRNG provided by the engine (never `Math.random`), so script behavior is replayable and unit-testable like the rest of the engine (F-5 discipline).
- **Lifecycle:** scripts register event handlers (`on_turn`, `on_combat_start/end`, `on_beat:<id>`); handlers run inside the turn's atomic patch scope — a throwing handler aborts its own patch, logged, and never corrupts state (BR-2).

---

## 8. Extended character card ("cartridge") format

### 8.1 Principles

1. **Data-first; scripts are the exception** (F-10). The vast majority of a card is JSON + prose assets, editable by hand; embedded scripts are versioned, capability-declared, and reviewed on import.
2. **Card = class, save = instance.** Saves live outside the card, reference card id + spec version, and store state against the card's schema.
3. **Strict and versioned.** `spec` field (`cartridge/0.1`), `requires` engine capabilities with semver ranges; load-time validation of all ids and predicates (BR-5).

### 8.2 Layout (abbreviated)

```
card.json               # spec, id, requires, persona, prompts
state.json              # initial state schema (§6.2)
beats.json               # beat graph (§6.4)
routes.json              # routes + endings (§6.9, §6.10)
lore/*.md                # ambient injectables
scripts/*.js|*.lua      # capability-manifested scripts
assets/endings/*.md      # epilogue prompts
```

### 8.3 Import / export

- **Import ST V2/V3** (including PNG-embedded cards) → map description/personality/scenario into prompts; world info entries → ambient beats with keyword predicates; creator notes preserved.
- **Import from the fork:** existing `game-cartridges.js` / `game-systems.js` content migrates through an exporter script; combat action catalogues copy nearly verbatim (they were data already).
- **Export to ST** (lossy): state → chat variables, beats → world info with keyword triggers. Lossy on purpose — the point of export is sharing prose, not the graph.

---

## 9. Implementation plan

### 9.1 Milestones

| ID | Deliverable | Acceptance |
| --- | --- | --- |
| M1 | Core library: store, beat graph, combat engine lifted from fork, prompt compiler; fork imports it via build | Fork behavior unchanged; lifted tests green in new repo |
| M2 | Core as localhost service + ST bridge; tracker agent split out with own model config; ST remains UI | A full session playable through ST against the service; tracker on cheap local model |
| M3 | Cartridge spec v0.1 + importers (ST V2/V3, fork exporter) + route simulator CLI | "The Crimson Keep" sample cartridge passes reachability + campaign tests |
| M4 | Native TUI client on the same service | Daily-drivable on desktop + Termux; freeform mode (no cartridge) works |

### 9.2 Kill criteria

- After M2, if the extracted engine under ST-as-host covers ~90% of actual play and the residual doesn't itch → stop before M4; nothing is lost (cleaner engine, kept frontend).
- The rewrite time-boxes: v1 may only reimplement what the fork does today for real play **plus the cartridge spec**. Map evolution, lewd-combat profiles, party modes: deferred until a real session demands them (F-8 guardrail against second-system effect).

### 9.3 Reference discipline (how the fork is used)

- **Lift near-as-is:** combat engine, action validation, registry resolution, deterministic fallback — plus their tests (they are the regression contract).
- **Copy verbatim:** sysprompts, tracker prompts, action catalogues, terrain themes (data/text, re-bind to the new compiler; they become the parity baseline).
- **Rewrite, do not port:** `llm-client.js`, `narrative-hooks.js`, per-chat persistence, chat-switch cancellation, swipe handling, guided-generation detection — each lesson becomes a test case in the new lifecycle.
- **Harvest before writing:** read the fork's 2,179-commit history; every legacy-repair commit ("clear stale target hints", "mirror engine fallbacks") becomes one regression test in the new core. Budget: one focused pass.
- **Oracle passes:** when new-core behavior surprises, run the same scenario in the fork, diff, write one test, move on. No archaeology sessions.
- **Do not copy:** the map-architect/evolution cluster (largest prompt-module-paradigm code; redesign as store-owned state + scripts if maps enter v1 — open question Q-1).

---

## 10. Decision record: scratch vs full extraction

| Dimension | Full extraction | Scratch + reference (chosen) |
| --- | --- | --- |
| Host coupling | Inherited; permanent shim layer (fake eventSource, fake settings, fake chat) | None; native Node runtime; fork's test hacks (sessionStorage isolation, thread pools) evaporate |
| State model | Stays prompt-mediated — chat variables remain source of truth | Store-first by construction |
| Scripting | Nowhere to host a sandbox | Capability model designed in from first commit |
| Multi-agent | `llm-client.js` shims enshrined | Per-role model configs first-class |
| License | GPLv3 travels with all extracted code | Fresh code; permissive core possible (F-9) |
| Velocity | Archaeology through coupled code | Writing against a known spec; fork = executable requirements doc |
| Risk | Hidden: ships the old architecture's flaws into the new system | Overt: second-system effect — mitigated by §9.2 time-box |

Rationale in one line: extraction optimizes for code continuity, but the code worth keeping lifts in days and the code that wouldn't lift is the glue being discarded — so what extraction actually preserves is the prompt-mediated state model, which is precisely the constraint being escaped.

---

## 11. Requirements summary

### 11.1 Functional

| ID | Requirement | Priority |
| --- | --- | --- |
| F-1 | Personas (name, description, avatar) | Must |
| F-2 | Character card import: ST V2/V3 (incl. PNG-embedded) and native cartridge | Must |
| F-3 | Lorebook/world info as ambient beats (predicate + keyword triggers) | Must |
| F-4 | Prompt presets + compiler: ordered sections, injection positions, token budgets | Must |
| F-5 | Connections: OpenAI-compatible; per-role model config (narrator/tracker/combat/parser) | Must |
| F-6 | Typed, versioned, audited state store; atomic patches | Must |
| F-7 | Saves: file-based, schema-versioned, seed-replayable, branchable | Must |
| F-8 | Beat graph: gate/nudge/ambient, routes with explicit locks, endings with epilogues | Must |
| F-9 | Deterministic combat engine (grid, validated actions, fallback tactics) | Must |
| F-10 | Script sandbox with capability manifest | Should |
| F-11 | Tracker agent: cheap model, patch protocol, confirmation gates | Should |
| F-12 | CLI/TUI client; freeform mode (no cartridge) | Must (v1) |
| F-13 | Route simulator + reachability checker as first-class commands | Should |
| F-14 | ST bridge (M2) and export (lossy) | Should |

### 11.2 Non-functional

| ID | Requirement |
| --- | --- |
| N-1 | Local-first; no telemetry; network only to configured endpoints |
| N-2 | Replay determinism: seed + event log ⇒ identical run |
| N-3 | Engine test coverage ≥ 90%; no unit test depends on a model call |
| N-4 | Every state mutation audit-logged and replayable |
| N-5 | Beat evaluation < 1 ms/turn at ≤ 500 beats (dirty-flag indexed) |
| N-6 | Runs on Windows, Linux, macOS; Android via Termux |
| N-7 | Sandbox default-deny; scripts get declared capabilities only, no network |
| N-8 | Cartridge spec strictly versioned; breaking changes require migration notes |
| N-9 | New core authored fresh (reference-only reuse of fork) for license clarity |
| N-10 | Degrades gracefully: engine absent ⇒ usable plain chat frontend |

---

## 12. License note

Upstream RPG Companion is AGPL-3.0; the fork is GPL v3 with relicense friction already visible in its history. If any new-core code is copied or derived from fork/upstream code, copyleft travels with it. To keep the new core permissive (desirable if others should embed it), write it fresh with the fork as behavioral reference only — compare behavior, consult history, but do not copy source. This is a planning note, not legal advice.

---

## 13. Risks and open questions

### 13.1 Risks

| Risk | Mitigation |
| --- | --- |
| Second-system effect: rebuilding terrain gen "properly" instead of playing | §9.2 time-box; v1 scope = fork's current feature set + cartridge spec, nothing more |
| Card scripts = third-party code vector | Capability manifest, default-deny, review-on-import (§7) |
| Solo maintenance: model drift, API changes, prompt debugging | Boring runtime patterns; per-role model configs isolate drift; oracle passes cap debugging time |
| Route/ending authoring is game-design labor, not code | Beat data format prioritizes hand-editability; simulator feedback loop shortens iteration |
| Dogfooding gap: engine used only for showcases | Freeform mode (N-10) + TUI on Termux where play actually happens |

### 13.2 Open questions

- Q-1: Do maps enter v1? Default no (largest redesign surface); revisit if a real session demands it.
- Q-2: QuickJS vs Lua/Luau as sandbox host — benchmark on Termux, decide at M3.
- Q-3: Should `mentions` (keyword-in-last-reply) predicates exist in v0.1, or is predicate-only cleaner and keywords simulated via scripts?
- Q-4: Save format — one JSON per turn (git-friendly diffs) vs snapshot + event log (replay-native). Lean snapshot + log; confirm with a replay feature at M3.
- Q-5: Does the tracker need a confirmation UI for every soft patch, or only batch review? Match the fork's per-field trust settings.

---

## 14. Glossary

- **Beat** — a node in the story graph: eligibility predicate, effects, a nudge, and a resolution condition.
- **Cartridge** — the extended character card: card data + state schema + beat graph + routes + endings + scripts + assets.
- **Gate / nudge / ambient** — beat classes: the single current objective / soft plot pressure / conditional lore.
- **Route** — a named, explicitly-locked partition of beat space leading toward endings.
- **Referee loop** — parse intent → resolve deterministically → commit state → narrate from rendered state.
- **Store-first** — the typed state store is the only source of truth; prompts and panels are rendered views.
- **Tracker patch protocol** — cheap model proposes schema-validated patches; engine applies, rejects, or gates them on confirmation.
