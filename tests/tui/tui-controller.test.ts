import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BeatLedgerState } from '../../src/beats/beat-ledger.js';
import { importSillyTavernCard } from '../../src/cartridge/importers/st-card-importer.js';
import {
  buildCliModelGateway,
  loadCliPersonaFile,
  loadCliPresetFile,
  loadPlaySessionInputs,
  parseMainCliArgs,
  runMainCli,
  saveCliModelGatewayConnections,
} from '../../src/cli/main.js';
import type { CombatState, CombatantState } from '../../src/combat/action-validator.js';
import type { GridTile, TacticalGrid } from '../../src/combat/grid-types.js';
import { resolveEffectiveControlRoomConfig } from '../../src/config/control-room-config.js';
import { computeControlRoomDiffReport } from '../../src/config/prompt-diff.js';
import { isOk } from '../../src/core/result.js';
import { saveConnectionsFile } from '../../src/gateway/connection-store.js';
import { createMockModelGateway } from '../../src/gateway/mock-provider.js';
import { SessionRuntime } from '../../src/runtime/session-runtime.js';
import {
  STOCK_FREEFORM_PACK,
  STOCK_SLICE_OF_LIFE_PACK,
  STOCK_TACTICAL_RPG_PACK,
} from '../../src/schema/stock-system-packs.js';
import { RefereeDaemon } from '../../src/server/daemon.js';
import type { AuditEntry } from '../../src/state/audit-log.js';
import { createWorldState } from '../../src/state/world-state.js';
import { RefereeDataStore } from '../../src/storage/data-store.js';
import { GAMEPLAY_SLASH_COMMANDS, TuiController } from '../../src/tui/app.js';
import { renderAuditAndChroniclePane } from '../../src/tui/panes/audit-and-chronicle-pane.js';
import { renderChatPane } from '../../src/tui/panes/chat-pane.js';
import { renderCombatGridPane } from '../../src/tui/panes/combat-grid-pane.js';
import { renderControlRoomPane } from '../../src/tui/panes/control-room-pane.js';
import { renderDynamicHudPane } from '../../src/tui/panes/dynamic-hud-pane.js';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

function makeCombatant(overrides: Partial<CombatantState> & { id: string }): CombatantState {
  return {
    name: overrides.id,
    team: 'ally',
    coord: { x: 1, y: 1 },
    alive: true,
    hp: 30,
    maxHp: 30,
    ac: 12,
    speed: 6,
    remainingMovement: 6,
    remainingActions: { action: 1, bonus: 1, reaction: 1 },
    resources: {},
    cooldowns: {},
    stats: { str: 3, dex: 2, initiative: 12 },
    statuses: [],
    abilities: ['basic_strike'],
    passives: [],
    willpower: 8,
    maxWillpower: 10,
    ...overrides,
  };
}

function makeStCardBundle() {
  const res = importSillyTavernCard(
    JSON.stringify({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'Claire',
        description: 'A neighborhood barista who remembers everyone’s coffee order.',
        scenario: 'Rainy Tuesday morning at The Brass Kettle cafe.',
        first_mes: 'She slides a steaming mug across the counter.',
      },
    }),
    { recommendedSystemPack: 'stock-slice-of-life' }
  );
  if (!res.ok) {
    throw new Error('Failed to import test ST card');
  }
  return res.value;
}

describe('PR-6.3: Native CLI/TUI Client & Panes', () => {
  it('1. Freeform / Tier 0 ST card mode (stock-slice-of-life): zero map and zero RPG stats', async () => {
    const cartridge = makeStCardBundle();
    const gateway = createMockModelGateway({
      narrator: [{ kind: 'text', text: 'Claire smiles and wipes down the espresso bar.' }],
      state_tracker: [
        {
          kind: 'json',
          value: {
            scene: {
              location: 'The Brass Kettle',
              mood: 'cozy',
            },
          },
        },
      ],
    });

    const runtime = new SessionRuntime({
      sessionId: 'tui-tier0-1',
      cartridge,
      systemPack: STOCK_SLICE_OF_LIFE_PACK,
      gateway,
      seed: 'tier0-seed',
    });

    const controller = new TuiController({
      runtime,
      gateway,
      cartridge,
      basePack: STOCK_SLICE_OF_LIFE_PACK,
    });

    const turnOut = await controller.handleInput('I order a cortado and sit near the window.');
    expect(turnOut.shouldExit).toBe(false);
    expect(turnOut.outputLines.join(' ')).toContain('Claire smiles');

    const frame = controller.renderScreen({ width: 80, height: 24 });
    const lines = frame.split('\n');
    expect(lines.length).toBeLessThanOrEqual(24);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(80);
    }

    // Zero tactical map and zero RPG stats in slice-of-life mode
    expect(frame).toContain('stock-slice-of-life');
    expect(frame).toContain('The Brass Kettle');
    expect(frame).not.toContain('Lv ');
    expect(frame).not.toContain('XP ');
    expect(frame).not.toContain('Faction:');
    expect(frame).not.toContain('Threat:');
    expect(frame).not.toContain('Legend: @=Ally');

    controller.dispose();
  });

  it('2. Live System Pack switching (/pack stock-tactical-rpg) and module toggling (/toggle)', async () => {
    const gateway = createMockModelGateway({
      narrator: [{ kind: 'text', text: 'Steel rings out across the ruined courtyard.' }],
      state_tracker: [{ kind: 'json', value: { scene: { mood: 'tense' } } }],
    });

    const runtime = new SessionRuntime({
      sessionId: 'tui-pack-switch',
      systemPack: STOCK_SLICE_OF_LIFE_PACK,
      gateway,
      seed: 'pack-seed',
    });

    const controller = new TuiController({
      runtime,
      gateway,
      basePack: STOCK_SLICE_OF_LIFE_PACK,
    });

    const packRes = await controller.handleInput('/pack stock-tactical-rpg');
    expect(packRes.shouldExit).toBe(false);
    expect(packRes.outputLines[0]).toContain('stock-tactical-rpg');
    expect(runtime.getConfig().packId).toBe('stock-tactical-rpg');
    expect(runtime.getState().capabilities.combatMode).toBe('tactical_grid');

    // Toggle a GameSystemModule off, then switch to control-room view and inspect
    const modToToggle = runtime.getConfig().gameSystems.find((m) => m.id === 'rpg_progression');
    expect(modToToggle?.enabled).toBe(true);

    const toggleModRes = await controller.handleInput('/toggle rpg_progression');
    expect(toggleModRes.outputLines[0]).toContain('OFF');
    expect(
      runtime.getConfig().gameSystems.find((m) => m.id === 'rpg_progression')?.enabled
    ).toBe(false);

    // Toggle a boolean capability (factions)
    const beforeFactions = runtime.getConfig().capabilities.factions;
    const toggleCapRes = await controller.handleInput('/toggle factions');
    expect(toggleCapRes.outputLines[0]).toContain(beforeFactions ? 'OFF' : 'ON');
    expect(runtime.getConfig().capabilities.factions).toBe(!beforeFactions);

    await controller.handleInput('/control-room');
    expect(controller.getViewMode()).toBe('control_room');
    const crFrame = controller.renderScreen({ width: 80, height: 24 });
    expect(crFrame).toContain('CONTROL ROOM');
    expect(crFrame).toContain('[User Customized]');
    expect(crFrame).toContain('[OFF] rpg_progression');

    controller.dispose();
  });

  it('3. In-terminal Wizard (/wizard Track stamina 0-100) generates and enables module', async () => {
    const gateway = createMockModelGateway({
      game_system_wizard: [
        {
          kind: 'json',
          value: {
            module: {
              id: 'stamina_tracker',
              name: 'Stamina Tracker',
              description: 'Tracks physical stamina from 0 to 100.',
              enabled: true,
              scope: 'session',
              target: 'player',
              effectOwner: 'hybrid',
              cadence: 'every_turn',
              fields: {
                stamina: {
                  type: 'meter',
                  min: 0,
                  max: 100,
                  default: 100,
                  writableByTracker: true,
                  confirmPolicy: 'auto',
                  description: 'Current physical stamina',
                },
              },
              trackerInstruction: 'Lower stamina during heavy exertion and restore on rest.',
              narratorRule: 'Describe heavy breathing when stamina drops below 25.',
              ui: { widget: 'bar', order: 20 },
            },
            clockTriggers: [
              { on: 'slot', op: 'increment', field: 'stamina', value: 10 },
            ],
            suggestedBeats: [],
            previewCard: { title: 'Stamina Tracker', stamina: 100 },
          },
        },
      ],
    });

    const runtime = new SessionRuntime({
      sessionId: 'tui-wizard-1',
      systemPack: STOCK_SLICE_OF_LIFE_PACK,
      gateway,
    });

    const controller = new TuiController({ runtime, gateway });
    const wizRes = await controller.handleInput('/wizard Track stamina 0-100');
    expect(wizRes.shouldExit).toBe(false);
    expect(wizRes.outputLines.join('\n')).toContain('Stamina Tracker (stamina_tracker)');
    expect(wizRes.outputLines.join('\n')).toContain('enabled module "stamina_tracker"');

    const enabledMod = runtime.getConfig().gameSystems.find((m) => m.id === 'stamina_tracker');
    expect(enabledMod).toBeDefined();
    expect(enabledMod?.enabled).toBe(true);

    // Dynamic HUD now renders the wizard-generated bar widget
    const frame = controller.renderScreen({ width: 80, height: 24 });
    expect(frame).toContain('Stamina Tracker:stamina');
    expect(frame).toContain('100/100');

    controller.dispose();
  });

  it('4. Director commands (/nudge, /hold-clock) + swipe commands (/regenerate, /swipe-left)', async () => {
    const gateway = createMockModelGateway({
      narrator: [
        { kind: 'text', text: 'First narration: The lantern flickers.' },
        { kind: 'text', text: 'Second narration: Rain beats on the stone arch.' },
      ],
      state_tracker: [
        { kind: 'json', value: { scene: { mood: 'mysterious' } } },
        { kind: 'json', value: { scene: { mood: 'ominous' } } },
      ],
    });

    const runtime = new SessionRuntime({
      sessionId: 'tui-director-swipe',
      systemPack: STOCK_SLICE_OF_LIFE_PACK,
      gateway,
      seed: 'swipe-seed',
    });

    const controller = new TuiController({ runtime, gateway });

    // Stage Director nudge and hold-clock
    await controller.handleInput('/nudge Make the innkeeper suspicious');
    await controller.handleInput('/hold-clock');

    const staged = controller.getDirectorSteering();
    expect(staged.oocNudge).toBe('Make the innkeeper suspicious');
    expect(staged.clockAction).toBe('hold');

    // Execute turn: steering is applied and oocNudge is cleared after send
    const turnRes = await controller.handleInput('I ask for a room for the night.');
    expect(turnRes.outputLines.join(' ')).toContain('First narration');
    expect(runtime.getState().clocks.held).toBe(true);
    expect(controller.getDirectorSteering().oocNudge).toBeUndefined();

    // Prompt sent to narrator included the director nudge
    const narratorCalls = gateway.mockProvider.recordedCalls.filter((c) => c.role === 'narrator');
    expect(narratorCalls[0]?.messages.some((m) => m.content.includes('Make the innkeeper suspicious'))).toBe(
      true
    );

    // Regenerate produces swipe [2/2]
    const regenRes = await controller.handleInput('/regenerate');
    expect(regenRes.outputLines[0]).toContain('[2/2]');
    expect(regenRes.outputLines.join(' ')).toContain('Second narration');

    const frameSwipe2 = controller.renderScreen({ width: 80, height: 24 });
    expect(frameSwipe2).toContain('[2/2]');

    // Swipe left returns to swipe [1/2]
    const swipeLeftRes = await controller.handleInput('/swipe-left');
    expect(swipeLeftRes.outputLines[0]).toContain('[1/2]');
    expect(swipeLeftRes.outputLines.join(' ')).toContain('First narration');

    const frameSwipe1 = controller.renderScreen({ width: 80, height: 24 });
    expect(frameSwipe1).toContain('[1/2]');

    // Swipe right returns to swipe [2/2]
    const swipeRightRes = await controller.handleInput('/swipe-right');
    expect(swipeRightRes.outputLines[0]).toContain('[2/2]');
    expect(swipeRightRes.outputLines.join(' ')).toContain('Second narration');

    // Release clock, advance slot, confirm/reject, help, and unsafe key guards
    await controller.handleInput('/release-clock');
    expect(controller.getDirectorSteering().clockAction).toBe('release');
    await controller.handleInput('/advance-slot 2');
    expect(controller.getDirectorSteering().clockAction).toEqual({ advanceSlots: 2 });

    const confirmRes = await controller.handleInput('/confirm');
    expect(confirmRes.outputLines[0]).toContain('Confirmed 0 pending patch');
    const rejectRes = await controller.handleInput('/reject');
    expect(rejectRes.outputLines[0]).toContain('Rejected all pending patches');

    const helpRes = await controller.handleInput('/help');
    expect(helpRes.outputLines.join('\n')).toContain('/wizard');

    const unsafePack = await controller.handleInput('/pack __proto__');
    expect(unsafePack.outputLines[0]).toContain('Usage');
    const unsafeToggle = await controller.handleInput('/toggle constructor');
    expect(unsafeToggle.outputLines[0]).toContain('Invalid toggle target');

    // Wide desktop viewport (side-by-side chat + HUD)
    const wideFrame = controller.renderScreen({ width: 120, height: 30 });
    const wideLines = wideFrame.split('\n');
    expect(wideLines.length).toBeLessThanOrEqual(30);
    for (const line of wideLines) {
      expect(line.length).toBeLessThanOrEqual(120);
    }

    // Quit command sets shouldExit = true
    const quitRes = await controller.handleInput('/quit');
    expect(quitRes.shouldExit).toBe(true);

    controller.dispose();
  });

  it('5. Tactical combat grid ASCII rendering and narrow 80x24 Termux viewport bounding', async () => {
    const tiles: GridTile[] = [];
    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 6; x += 1) {
        let passable = true;
        let blocksLos = false;
        let cover: GridTile['cover'] = 'none';
        let hazard: GridTile['hazard'] = 'none';

        if (x === 2 && y === 2) {
          passable = false;
          blocksLos = true;
        } else if (x === 3 && y === 1) {
          cover = 'half';
        } else if (x === 4 && y === 3) {
          hazard = 'fire';
        }

        tiles.push({ x, y, passable, cover, elevation: 0, hazard, blocksLos });
      }
    }

    const grid: TacticalGrid = {
      width: 6,
      height: 5,
      theme: 'ruins',
      tiles,
    };

    const hero = makeCombatant({
      id: 'hero',
      name: 'Valen',
      team: 'ally',
      coord: { x: 1, y: 2 },
      hp: 24,
      maxHp: 30,
    });
    const goblin = makeCombatant({
      id: 'goblin',
      name: 'Goblin Scout',
      team: 'enemy',
      coord: { x: 4, y: 2 },
      hp: 8,
      maxHp: 12,
    });

    const combatState: CombatState = {
      active: true,
      mode: 'tactical_grid',
      round: 2,
      turnIndex: 0,
      initiativeOrder: ['hero', 'goblin'],
      grid,
      combatants: { hero, goblin },
      triggerCountsThisTurn: {},
    };

    const gridLines = renderCombatGridPane(combatState, 80);
    const joined = gridLines.join('\n');
    expect(joined).toContain('COMBAT [ACTIVE] | Round 2');
    expect(joined).toContain('@');
    expect(joined).toContain('E');
    expect(joined).toContain('#');
    expect(joined).toContain('+');
    expect(joined).toContain('~');
    expect(joined).toContain('Valen');
    expect(joined).toContain('Goblin Scout');
    for (const line of gridLines) {
      expect(line.length).toBeLessThanOrEqual(80);
    }

    // Traditional theater-of-the-mind mode renders without grid map
    const tradLines = renderCombatGridPane(
      { ...combatState, mode: 'traditional', grid: null },
      80
    );
    expect(tradLines.join('\n')).toContain('Theater of the Mind');
    expect(tradLines.join('\n')).not.toContain('Legend: @=Ally');

    // Narrow 80x24 Termux viewport rendering with long unbroken tokens and multiple views
    const gateway = createMockModelGateway({
      narrator: [
        {
          kind: 'text',
          text: `LongToken_${'X'.repeat(120)} followed by normal prose across multiple lines for narrow Termux viewports.`,
        },
      ],
      state_tracker: [{ kind: 'json', value: { scene: { mood: 'tense' } } }],
    });
    const runtime = new SessionRuntime({
      sessionId: 'tui-termux-80x24',
      systemPack: STOCK_TACTICAL_RPG_PACK,
      gateway,
      seed: 'termux-seed',
    });

    const startRes = runtime.startCombat([hero, goblin], { mode: 'tactical_grid' });
    expect(isOk(startRes)).toBe(true);

    const controller = new TuiController({ runtime, gateway });
    await controller.handleInput('I raise my shield and advance carefully.');

    for (const cmd of ['/hud', '/control-room', '/combat', '/audit', '/chronicle']) {
      await controller.handleInput(cmd);
      const screen = controller.renderScreen({ width: 80, height: 24 });
      const screenLines = screen.split('\n');
      expect(screenLines.length).toBeLessThanOrEqual(24);
      for (const line of screenLines) {
        expect(line.length).toBeLessThanOrEqual(80);
      }
    }

    controller.dispose();
  });

  it('Pane renderers: chat, dynamic HUD (factions + beats), control room, and audit/chronicle filtering', () => {
    const chatLines = renderChatPane({
      messages: [
        { role: 'user', content: 'Hello world' },
        { role: 'assistant', content: 'Greetings traveler', swipeIndex: 0, swipeCount: 2 },
      ],
      streamingBuffer: 'More text...',
      width: 40,
      maxLines: 12,
    });
    expect(chatLines.join('\n')).toContain('[1/2]');
    expect(chatLines.join('\n')).toContain('(streaming)');
    for (const line of chatLines) {
      expect(line.length).toBeLessThanOrEqual(40);
    }

    const config = resolveEffectiveControlRoomConfig(STOCK_TACTICAL_RPG_PACK, undefined, {
      capabilities: { factions: true, beats: true },
      tuningDials: { beatPressure: 'harsh' },
    });
    const diff = computeControlRoomDiffReport(config, STOCK_TACTICAL_RPG_PACK);

    const state = createWorldState({
      capabilities: config.capabilities,
      factions: [
        {
          id: 'guild',
          name: 'Iron Guild',
          side: 'hero',
          status: 'active',
          influence: 65,
          headquartersLocationId: null,
          goals: [],
        },
      ],
      threats: [
        {
          id: 'blight',
          name: 'Ash Blight',
          rank: 'main',
          status: 'active',
          stage: 2,
          progress: 40,
          locationId: null,
          sourceFactionId: null,
          agenda: 'Spread',
        },
      ],
    });
    const beatLedger: BeatLedgerState = {
      records: {},
      liveGateId: 'gate_open_vault',
      liveNudgeIds: [],
      activeAmbientIds: [],
    };

    const hudLines = renderDynamicHudPane({
      state,
      config,
      beatLedger,
      pendingConfirmationsCount: 2,
      width: 60,
    });
    const hudStr = hudLines.join('\n');
    expect(hudStr).toContain('Clock:');
    expect(hudStr).toContain('LIVE Gate: gate_open_vault');
    expect(hudStr).toContain('Faction:Iron Guild');
    expect(hudStr).toContain('Threat:Ash Blight');
    expect(hudStr).toContain('Pending Confirmations: 2');

    const crLines = renderControlRoomPane({ config, diffReport: diff, width: 80 });
    expect(crLines.join('\n')).toContain('beatPressure=harsh');
    expect(crLines.join('\n')).toContain('[User Customized]');

    const auditEntries: AuditEntry[] = [
      {
        turn: 1,
        storyTurn: 1,
        timestampSeq: 1,
        source: 'tracker',
        eventId: 'e1',
        op: 'set',
        path: 'scene.location',
        oldValue: 'Road',
        newValue: 'Tavern',
        status: 'committed',
      },
      {
        turn: 2,
        storyTurn: 2,
        timestampSeq: 2,
        source: 'user_director',
        eventId: 'e2',
        op: 'set',
        path: 'player.resources.hp.current',
        oldValue: 30,
        newValue: 25,
        status: 'committed',
      },
    ];
    const auditFiltered = renderAuditAndChroniclePane({
      auditEntries,
      chronicleEvents: [],
      filter: 'Tavern'.toLowerCase().replace('tavern', 'scene.location'),
      mode: 'audit',
      width: 70,
    });
    expect(auditFiltered.join('\n')).toContain('scene.location');
    expect(auditFiltered.join('\n')).not.toContain('player.resources.hp.current');

    const chronicleLines = renderAuditAndChroniclePane({
      auditEntries: [],
      chronicleEvents: [
        {
          id: 'ch1',
          turn: 3,
          day: 1,
          date: '2026-01-01',
          title: 'Vault Opened',
          category: 'world',
          summary: 'The ancient seal broke.',
          locationId: null,
          involvedEntityIds: [],
          keywords: ['vault'],
        },
      ],
      mode: 'chronicle',
      width: 70,
    });
    expect(chronicleLines.join('\n')).toContain('Vault Opened');
  });

  it('TuiController works over live RefereeDaemon HTTP URL and CLI main parses arguments cleanly', async () => {
    const gateway = createMockModelGateway({
      narrator: [{ kind: 'text', text: 'Daemon response: the gate creaks open.' }],
      state_tracker: [{ kind: 'json', value: { scene: { mood: 'tense' } } }],
    });
    const daemon = new RefereeDaemon({ host: '127.0.0.1', port: 0, gateway });
    const info = await daemon.start();

    try {
      const controller = new TuiController({ daemonUrl: info.url });
      await controller.connectDaemonSession({ systemPackId: 'stock-slice-of-life' });

      const turnOut = await controller.handleInput('Push open the gate.');
      expect(turnOut.outputLines.join(' ')).toContain('Daemon response');

      const packOut = await controller.handleInput('/pack stock-tactical-rpg');
      expect(packOut.outputLines[0]).toContain('stock-tactical-rpg');

      const screen = controller.renderScreen({ width: 80, height: 24 });
      expect(screen).toContain('stock-tactical-rpg');
      expect(screen.split('\n').length).toBeLessThanOrEqual(24);
      controller.dispose();
    } finally {
      await daemon.stop();
    }

    // CLI argument parsing and card loading helpers
    const playParsed = parseMainCliArgs([
      'play',
      '--freeform',
      '--pack',
      'stock-slice-of-life',
      '--daemon',
      '--port',
      '4210',
    ]);
    expect(playParsed.ok).toBe(true);
    if (playParsed.ok && playParsed.value.command === 'play') {
      expect(playParsed.value.freeform).toBe(true);
      expect(playParsed.value.packId).toBe('stock-slice-of-life');
      expect(playParsed.value.daemon).toBe(true);
      expect(playParsed.value.port).toBe(4210);
    }

    const simParsed = parseMainCliArgs(['sim', 'validate', './cartridge']);
    expect(simParsed.ok).toBe(true);
    if (simParsed.ok && simParsed.value.command === 'sim') {
      expect(simParsed.value.simArgs).toEqual(['validate', './cartridge']);
    }

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'referee-cli-test-'));
    tempDirs.push(tmpDir);
    const cardPath = path.join(tmpDir, 'card.json');
    await fs.writeFile(
      cardPath,
      JSON.stringify({
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: { name: 'Lyra', description: 'Archivist' },
      }),
      'utf8'
    );

    const loaded = await loadPlaySessionInputs({
      freeform: false,
      cardPath,
      packId: 'stock-slice-of-life',
    });
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.cartridge?.card.title).toBe('Lyra');
      expect(loaded.value.systemPack?.id).toBe('stock-slice-of-life');
    }

    const stdout: string[] = [];
    const stderr: string[] = [];
    const helpCode = await runMainCli(['--help'], {
      stdout: (s) => stdout.push(s),
      stderr: (s) => stderr.push(s),
    });
    expect(helpCode).toBe(0);
    expect(stdout.join('\n')).toContain('Referee Engine CLI');
    expect(stderr).toHaveLength(0);
  });
});

describe('PR-7.13: Native CLI & TUI Completion', () => {
  it('1. Unblocks all GAMEPLAY_SLASH_COMMANDS and executes turns instead of rejecting as unknown', async () => {
    expect([...GAMEPLAY_SLASH_COMMANDS]).toEqual([
      '/travel',
      '/rest',
      '/play-as',
      '/move',
      '/attack',
      '/skill',
      '/defend',
      '/end-turn',
    ]);

    const gateway = createMockModelGateway({
      narrator: Array.from({ length: 10 }, (_, idx) => ({
        kind: 'text' as const,
        text: `Gameplay turn ${idx + 1} resolved.`,
      })),
      state_tracker: Array.from({ length: 10 }, () => ({
        kind: 'json' as const,
        value: {},
      })),
    });

    const runtime = new SessionRuntime({
      sessionId: 'tui-gameplay-cmds',
      systemPack: STOCK_TACTICAL_RPG_PACK,
      gateway,
      seed: 'gameplay-seed',
    });

    const heroRes = runtime.upsertCharacter('hero_1', {
      name: 'Kael',
      status: 'active',
      presentInScene: true,
      locationId: null,
      mood: 'focused',
      allegiance: 'allies',
    });
    expect(isOk(heroRes)).toBe(true);

    const goblinRes = runtime.upsertCharacter('goblin_1', {
      name: 'Goblin Raider',
      status: 'active',
      presentInScene: true,
      locationId: null,
      mood: 'hostile',
      allegiance: 'raiders',
    });
    expect(isOk(goblinRes)).toBe(true);

    const controller = new TuiController({ runtime, gateway });

    // Non-combat gameplay slash commands
    const travelOut = await controller.handleInput('/travel Old Watchtower');
    expect(travelOut.outputLines.join(' ')).toContain('Gameplay turn');
    expect(travelOut.outputLines.join(' ')).not.toContain('Unknown command');
    expect(runtime.getState().scene.location).toBe('Old Watchtower');

    const restOut = await controller.handleInput('/rest');
    expect(restOut.outputLines.join(' ')).toContain('Gameplay turn');

    const playAsOut = await controller.handleInput('/play-as hero_1');
    expect(playAsOut.outputLines.join(' ')).toContain('Gameplay turn');
    expect(runtime.getState().player.characterId).toBe('hero_1');

    // Start combat with /start-combat and exercise all combat slash commands
    const combatStartOut = await controller.handleInput('/start-combat goblin_1');
    expect(combatStartOut.outputLines[0]).toContain('Started combat');
    expect(runtime.getCombatState()?.active).toBe(true);

    const moveOut = await controller.handleInput('/move 2,1');
    expect(moveOut.outputLines.join(' ')).toContain('Gameplay turn');

    const attackOut = await controller.handleInput('/attack goblin_1');
    expect(attackOut.outputLines.join(' ')).toContain('Gameplay turn');

    const skillOut = await controller.handleInput('/skill basic_strike goblin_1');
    expect(skillOut.outputLines.join(' ')).toContain('Gameplay turn');

    const defendOut = await controller.handleInput('/defend');
    expect(defendOut.outputLines.join(' ')).toContain('Gameplay turn');

    const endTurnOut = await controller.handleInput('/end-turn');
    expect(endTurnOut.outputLines.join(' ')).toContain('Gameplay turn');

    controller.dispose();
  });

  it('2. Supports /characters, /inspect, /pin, /unpin, /dismiss, and HUD Cast: line within 80x24', async () => {
    const gateway = createMockModelGateway({
      narrator: [{ kind: 'text', text: 'Elena steps into the lantern light.' }],
      state_tracker: [{ kind: 'json', value: {} }],
    });

    const runtime = new SessionRuntime({
      sessionId: 'tui-cast-inspect',
      systemPack: STOCK_SLICE_OF_LIFE_PACK,
      gateway,
      seed: 'cast-seed',
    });

    runtime.upsertCharacter('elena', {
      name: 'Elena',
      status: 'active',
      presentInScene: true,
      locationId: null,
      mood: 'warm',
      allegiance: 'cafe_staff',
      agenda: 'Keep the morning rush smooth',
      traits: ['observant'],
      sections: { sec_personality: 'Warm and quick-witted.' },
    });
    runtime.upsertCharacter('marcus', {
      name: 'Marcus',
      status: 'active',
      presentInScene: false,
      locationId: 'north_gate',
      mood: 'guarded',
      allegiance: 'city_watch',
    });

    const controller = new TuiController({ runtime, gateway });

    // /characters (and aliases /roster, /cast)
    const charsOut = await controller.handleInput('/characters');
    const charsText = charsOut.outputLines.join('\n');
    expect(charsText).toContain('[HERE]');
    expect(charsText).toContain('Elena (elena)');
    expect(charsText).toContain('[OFFSCREEN @ north_gate]');
    expect(charsText).toContain('Marcus (marcus)');

    const rosterOut = await controller.handleInput('/roster');
    expect(rosterOut.outputLines.join('\n')).toContain('Elena');
    const castOut = await controller.handleInput('/cast marcus');
    expect(castOut.outputLines.join('\n')).toContain('Marcus');
    expect(castOut.outputLines.join('\n')).not.toContain('Elena');

    // /inspect
    const inspectNpc = await controller.handleInput('/inspect elena');
    const inspectText = inspectNpc.outputLines.join('\n');
    expect(inspectText).toContain('Dossier: Elena (elena)');
    expect(inspectText).toContain('Warm and quick-witted.');
    expect(inspectText).toContain('observant');

    const inspectPlayer = await controller.handleInput('/inspect player');
    expect(inspectPlayer.outputLines.join('\n')).toContain('[PC]');

    // /pin, /unpin (pre-turn), /pin + turn + /unpin + /dismiss
    await controller.handleInput('/pin marcus');
    expect(controller.getDirectorSteering().pinCharacterIds).toEqual(['marcus']);

    await controller.handleInput('/unpin marcus');
    expect(controller.getDirectorSteering().pinCharacterIds).toBeUndefined();

    await controller.handleInput('/pin marcus');
    const turnOut = await controller.handleInput('I look toward the doorway.');
    expect(turnOut.outputLines.join(' ')).toContain('Elena steps');
    expect(runtime.getState().scene.pinnedCharacterIds).toContain('marcus');
    expect(controller.getDirectorSteering().pinCharacterIds).toBeUndefined();

    const pinnedList = await controller.handleInput('/characters');
    expect(pinnedList.outputLines.join('\n')).toContain('[PINNED]');

    await controller.handleInput('/unpin marcus');
    expect(controller.getDirectorSteering().dismissCharacterIds).toContain('marcus');

    await controller.handleInput('/dismiss elena');
    expect(controller.getDirectorSteering().dismissCharacterIds).toContain('elena');

    // Narrow 80x24 HUD Cast: line and strict viewport bounds
    const screen80 = controller.renderScreen({ width: 80, height: 24 });
    expect(screen80).toContain('Cast:');
    expect(screen80).toContain('Elena');
    const lines = screen80.split('\n');
    expect(lines.length).toBeLessThanOrEqual(24);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(80);
    }

    controller.dispose();
  });

  it('3. Supports /save-connections, /load-connections, /disconnect-role, /preset-import/export/save/load/list, /sheet-preset, /sampling, and /persona', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'referee-tui-713-'));
    tempDirs.push(tmpDir);
    const dataStore = new RefereeDataStore(path.join(tmpDir, 'data'));
    await dataStore.init();
    const connectionsPath = path.join(tmpDir, 'connections.json');

    const gateway = createMockModelGateway({
      narrator: [{ kind: 'text', text: 'OK' }],
    });
    gateway.setDefaultConnection({
      provider: 'openai_compatible',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'llama3.1:8b',
      temperature: 0.7,
    });
    gateway.setRoleConnection('state_tracker', {
      provider: 'openai_compatible',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen2.5:7b',
    });

    const runtime = new SessionRuntime({
      sessionId: 'tui-presets-persona',
      systemPack: STOCK_SLICE_OF_LIFE_PACK,
      gateway,
      seed: 'preset-seed',
    });

    const controller = new TuiController({
      runtime,
      gateway,
      dataStore,
      connectionsPath,
    });

    // Connections: save named profile, disconnect role, modify default, then load profile back
    const saveConnOut = await controller.handleInput('/save-connections local-dev');
    expect(saveConnOut.outputLines[0]).toContain('local-dev');

    const discOut = await controller.handleInput('/disconnect-role state_tracker');
    expect(discOut.outputLines[0]).toContain('Removed connection override for role "state_tracker"');
    expect(gateway.getConnectionsSnapshot().connections.state_tracker).toBeUndefined();

    await controller.handleInput('/connect http://127.0.0.1:9999/v1 other-model');
    expect(gateway.getConnectionsSnapshot().defaultConnection?.model).toBe('other-model');

    const loadConnOut = await controller.handleInput('/load-connections local-dev');
    expect(loadConnOut.outputLines[0]).toContain('Loaded connection profile "local-dev"');
    expect(gateway.getConnectionsSnapshot().defaultConnection?.model).toBe('llama3.1:8b');
    expect(gateway.getConnectionsSnapshot().connections.state_tracker?.model).toBe('qwen2.5:7b');

    // Preset import (ST Chat Completion preset) & Control Room pane rendering
    const stPresetPath = path.join(tmpDir, 'st-chat-preset.json');
    await fs.writeFile(
      stPresetPath,
      JSON.stringify({
        name: 'Cozy Tavern Chat',
        temperature: 0.85,
        openai_max_tokens: 420,
        openai_max_context: 8192,
        top_p: 0.92,
        repetition_penalty: 1.12,
        prompts: [
          {
            identifier: 'main',
            name: 'Main Prompt',
            role: 'system',
            content: 'Narrate vividly.',
            enabled: true,
          },
          {
            identifier: 'custom_style',
            name: 'Style Block',
            role: 'system',
            content: 'Keep prose grounded.',
            injection_position: 0,
            enabled: true,
          },
        ],
        prompt_order: [
          {
            character_id: 100001,
            order: [
              { identifier: 'main', enabled: true },
              { identifier: 'custom_style', enabled: true },
              { identifier: 'chatHistory', enabled: true },
            ],
          },
        ],
      }),
      'utf8'
    );

    const importOut = await controller.handleInput(`/preset-import ${stPresetPath}`);
    expect(importOut.outputLines[0]).toContain('st_chat_completion');
    expect(runtime.getConfig().generation?.temperature).toBe(0.85);
    expect(runtime.getConfig().generation?.maxTokens).toBe(420);
    expect(Object.keys(runtime.getConfig().customPromptBlocks ?? {}).length).toBeGreaterThanOrEqual(1);

    // Control Room pane shows Generation: and ST Blocks: within 80x24
    await controller.handleInput('/control-room');
    const crScreen = controller.renderScreen({ width: 80, height: 24 });
    expect(crScreen).toContain('Generation:');
    expect(crScreen).toContain('temp=0.85');
    expect(crScreen).toContain('ST Blocks:');
    for (const line of crScreen.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(80);
    }

    // /sampling view and live update
    const samplingView = await controller.handleInput('/sampling');
    expect(samplingView.outputLines[0]).toContain('temperature=0.85');

    const samplingSet = await controller.handleInput(
      '/sampling temp=0.65 max_tokens=500 top_p=0.9 rep_pen=1.08 max_context=12000'
    );
    expect(samplingSet.outputLines[0]).toContain('temperature=0.65');
    expect(runtime.getConfig().generation?.temperature).toBe(0.65);
    expect(runtime.getConfig().generation?.maxTokens).toBe(500);
    expect(runtime.getConfig().generation?.topP).toBe(0.9);
    expect(runtime.getConfig().generation?.repetitionPenalty).toBe(1.08);
    expect(runtime.getConfig().generation?.maxContextTokens).toBe(12000);

    // /preset save, /preset list, /preset load
    const presetSaveOut = await controller.handleInput('/preset save tavern-v1');
    expect(presetSaveOut.outputLines[0]).toContain('Saved Control Room preset "tavern-v1"');

    const presetListOut = await controller.handleInput('/preset list');
    expect(presetListOut.outputLines.join('\n')).toContain('tavern-v1');

    await controller.handleInput('/sampling temp=0.2');
    expect(runtime.getConfig().generation?.temperature).toBe(0.2);

    const presetLoadOut = await controller.handleInput('/preset load tavern-v1');
    expect(presetLoadOut.outputLines[0]).toContain('Loaded Control Room preset "tavern-v1"');
    expect(runtime.getConfig().generation?.temperature).toBe(0.65);

    // /preset-export (st_chat, st_text, referee)
    const exportChatPath = path.join(tmpDir, 'out-chat.json');
    const exportTextPath = path.join(tmpDir, 'out-text.json');
    const exportRefPath = path.join(tmpDir, 'out-ref.json');
    await controller.handleInput(`/preset-export ${exportChatPath} st_chat`);
    await controller.handleInput(`/preset-export ${exportTextPath} st_text`);
    await controller.handleInput(`/preset-export ${exportRefPath} referee`);

    const exportedChat = JSON.parse(await fs.readFile(exportChatPath, 'utf8')) as Record<string, unknown>;
    expect(exportedChat['temperature']).toBe(0.65);
    expect(Array.isArray(exportedChat['prompts'])).toBe(true);

    const exportedText = JSON.parse(await fs.readFile(exportTextPath, 'utf8')) as Record<string, unknown>;
    expect(exportedText['temp']).toBe(0.65);
    expect(exportedText['amount_gen']).toBe(500);

    const exportedRef = JSON.parse(await fs.readFile(exportRefPath, 'utf8')) as Record<string, unknown>;
    expect((exportedRef['generation'] as Record<string, unknown>)['temperature']).toBe(0.65);

    // /sheet-preset
    const sheetOut = await controller.handleInput('/sheet-preset dnd-adventurer');
    expect(sheetOut.outputLines[0]).toContain('dnd-adventurer');
    expect(runtime.getConfig().pcCoreSections.some((s) => s.id === 'sec_combat_profile')).toBe(true);

    // /persona set, /persona section, /persona save, /persona list, /persona load
    const pSetOut = await controller.handleInput('/persona set Aria | Wandering clockmaker');
    expect(pSetOut.outputLines[0]).toContain('Aria');
    expect(runtime.getState().player.name).toBe('Aria');
    expect(runtime.getActivePersona()?.description).toBe('Wandering clockmaker');

    const pSecOut = await controller.handleInput('/persona section sec_body Tall with brass goggles.');
    expect(pSecOut.outputLines[0]).toContain('sec_body');
    expect(runtime.getState().player.sections['sec_body']).toBe('Tall with brass goggles.');

    const pSaveOut = await controller.handleInput('/persona save aria-main');
    expect(pSaveOut.outputLines[0]).toContain('Saved persona "aria-main"');

    const pListOut = await controller.handleInput('/persona list');
    expect(pListOut.outputLines.join('\n')).toContain('aria-main: Aria');

    await controller.handleInput('/persona set TempUser | Temporary');
    expect(runtime.getState().player.name).toBe('TempUser');

    const pLoadOut = await controller.handleInput('/persona load aria-main');
    expect(pLoadOut.outputLines[0]).toContain('Loaded persona "aria-main"');
    expect(runtime.getState().player.name).toBe('Aria');
    expect(runtime.getState().player.sections['sec_body']).toBe('Tall with brass goggles.');

    controller.dispose();
  });

  it('4. Works over live RefereeDaemon HTTP mode for new commands', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'referee-tui-daemon-713-'));
    tempDirs.push(tmpDir);

    const gateway = createMockModelGateway({
      narrator: [{ kind: 'text', text: 'Daemon turn complete.' }],
      state_tracker: [{ kind: 'json', value: {} }],
    });
    gateway.setDefaultConnection({
      provider: 'mock',
      baseUrl: 'mock://127.0.0.1/v1',
      model: 'daemon-default',
    });
    gateway.setRoleConnection('narrator', {
      provider: 'mock',
      baseUrl: 'mock://127.0.0.1/v1',
      model: 'daemon-narrator',
    });

    const daemon = new RefereeDaemon({
      host: '127.0.0.1',
      port: 0,
      gateway,
      dataDir: tmpDir,
    });
    const info = await daemon.start();

    try {
      const controller = new TuiController({ daemonUrl: info.url });
      await controller.connectDaemonSession({ systemPackId: 'stock-tactical-rpg' });

      // /save-connections, /disconnect-role, /load-connections
      await controller.handleInput('/save-connections daemon-prof');
      await controller.handleInput('/disconnect-role narrator');
      expect(gateway.getConnectionsSnapshot().connections.narrator).toBeUndefined();
      await controller.handleInput('/load-connections daemon-prof');
      expect(gateway.getConnectionsSnapshot().connections.narrator?.model).toBe('daemon-narrator');

      // /sheet-preset & /sampling
      const sheetRes = await controller.handleInput('/sheet-preset superhero-dossier');
      expect(sheetRes.outputLines[0]).toContain('superhero-dossier');
      const sampRes = await controller.handleInput('/sampling temp=0.72 max_tokens=333');
      expect(sampRes.outputLines[0]).toContain('temperature=0.72');

      // /persona set & /persona section
      await controller.handleInput('/persona set Nova | Starlight courier');
      await controller.handleInput('/persona section sec_species Human');
      await controller.handleInput('/persona save nova-1');

      // /characters & /inspect player
      const charsRes = await controller.handleInput('/characters');
      expect(charsRes.outputLines.join('\n')).toContain('Nova');
      const inspectRes = await controller.handleInput('/inspect player');
      expect(inspectRes.outputLines.join('\n')).toContain('Human');

      // /start-combat & /end-turn gameplay command over daemon
      const combatRes = await controller.handleInput('/start-combat bandit_1');
      expect(combatRes.outputLines[0]).toContain('Started combat');
      const endTurnRes = await controller.handleInput('/end-turn');
      expect(endTurnRes.outputLines.join(' ')).toContain('Daemon turn complete');

      controller.dispose();
    } finally {
      await daemon.stop();
    }
  });

  it('5. CLI parses new flags, preserves ConnectionStore fields, and loads preset/persona/save-dir', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'referee-cli-713-'));
    tempDirs.push(tmpDir);

    const playArgs = parseMainCliArgs([
      'play',
      '--save-dir',
      './saves/s1',
      '--resume',
      './saves/s0',
      '--preset',
      './preset.json',
      '--persona',
      './persona.json',
      '--data-dir',
      './data',
    ]);
    expect(playArgs.ok).toBe(true);
    if (playArgs.ok && playArgs.value.command === 'play') {
      expect(playArgs.value.saveDirPath).toBe('./saves/s1');
      expect(playArgs.value.resumePath).toBe('./saves/s0');
      expect(playArgs.value.presetPath).toBe('./preset.json');
      expect(playArgs.value.personaPath).toBe('./persona.json');
      expect(playArgs.value.dataDir).toBe('./data');
    }

    const daemonArgs = parseMainCliArgs([
      'daemon',
      '--data-dir',
      './data',
      '--save-dir',
      './saves/s1',
      '--resume',
      './saves/s0',
      '--preset',
      './preset.json',
      '--persona',
      './persona.json',
    ]);
    expect(daemonArgs.ok).toBe(true);
    if (daemonArgs.ok && daemonArgs.value.command === 'daemon') {
      expect(daemonArgs.value.dataDir).toBe('./data');
      expect(daemonArgs.value.saveDirPath).toBe('./saves/s1');
      expect(daemonArgs.value.resumePath).toBe('./saves/s0');
      expect(daemonArgs.value.presetPath).toBe('./preset.json');
      expect(daemonArgs.value.personaPath).toBe('./persona.json');
    }

    // buildCliModelGateway preserves provider, SamplingParameters, timeoutMs, supportsJsonSchema, activeProfile
    const connFile = path.join(tmpDir, 'referee.connections.json');
    const saveRes = await saveConnectionsFile(connFile, {
      version: 1,
      activeProfile: 'anthropic-main',
      defaultConnection: {
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-5',
        apiKey: 'sk-ant-test',
        temperature: 0.75,
        maxTokens: 1024,
        topP: 0.9,
        topK: 40,
        repetitionPenalty: 1.05,
        timeoutMs: 45000,
        supportsJsonSchema: false,
      },
      profiles: {
        'anthropic-main': {
          defaultConnection: {
            provider: 'anthropic',
            baseUrl: 'https://api.anthropic.com',
            model: 'claude-sonnet-4-5',
            temperature: 0.75,
            timeoutMs: 45000,
            supportsJsonSchema: false,
          },
        },
      },
    });
    expect(saveRes.ok).toBe(true);

    const gwRes = await buildCliModelGateway({ connectionsPath: connFile }, {});
    expect(gwRes.ok).toBe(true);
    if (gwRes.ok) {
      const snap = gwRes.value.getConnectionsSnapshot();
      expect(snap.defaultConnection?.provider).toBe('anthropic');
      expect(snap.defaultConnection?.temperature).toBe(0.75);
      expect(snap.defaultConnection?.maxTokens).toBe(1024);
      expect(snap.defaultConnection?.topP).toBe(0.9);
      expect(snap.defaultConnection?.topK).toBe(40);
      expect(snap.defaultConnection?.repetitionPenalty).toBe(1.05);
      expect(snap.defaultConnection?.timeoutMs).toBe(45000);
      expect(snap.defaultConnection?.supportsJsonSchema).toBe(false);

      const savedBack = await saveCliModelGatewayConnections(connFile, gwRes.value);
      expect(savedBack.ok).toBe(true);
      if (savedBack.ok) {
        expect(savedBack.value.activeProfile).toBe('anthropic-main');
        expect(savedBack.value.defaultConnection?.provider).toBe('anthropic');
      }
    }

    // loadCliPresetFile and loadCliPersonaFile + SessionRuntime.fromSaveDirectory hydration
    const cliPresetPath = path.join(tmpDir, 'cli-preset.json');
    await fs.writeFile(
      cliPresetPath,
      JSON.stringify({ name: 'CLI Preset', temperature: 0.55, amount_gen: 300 }),
      'utf8'
    );
    const cliPresetRes = await loadCliPresetFile(cliPresetPath);
    expect(cliPresetRes.ok).toBe(true);
    if (cliPresetRes.ok) {
      expect(cliPresetRes.value.generation.temperature).toBe(0.55);
    }

    const cliPersonaPath = path.join(tmpDir, 'cli-persona.json');
    await fs.writeFile(
      cliPersonaPath,
      JSON.stringify({ id: 'cli-hero', name: 'Rowan', description: 'Scout' }),
      'utf8'
    );
    const cliPersonaRes = await loadCliPersonaFile(cliPersonaPath);
    expect(cliPersonaRes.ok).toBe(true);
    if (cliPersonaRes.ok) {
      expect(cliPersonaRes.value.name).toBe('Rowan');
    }

    // Verify SessionRuntime save + resume roundtrip compatible with CLI --save-dir / --resume
    const saveDir = path.join(tmpDir, 'cli-save');
    const mockGw = createMockModelGateway({
      narrator: [{ kind: 'text', text: 'Saved turn 1.' }],
      state_tracker: [{ kind: 'json', value: {} }],
    });
    const session1 = new SessionRuntime({
      sessionId: 'cli-session-1',
      systemPack: STOCK_FREEFORM_PACK,
      gateway: mockGw,
      saveDir,
      ...(cliPresetRes.ok ? { userControlRoomLayer: cliPresetRes.value.layer } : {}),
      ...(cliPersonaRes.ok ? { userPersona: cliPersonaRes.value } : {}),
    });
    const turn1 = await session1.executeTurn({ text: 'Hello world' });
    expect(turn1.ok).toBe(true);
    await session1.flushPendingSaves();

    const resumed = await SessionRuntime.fromSaveDirectory(saveDir, {
      sessionId: 'cli-session-1',
      systemPack: STOCK_FREEFORM_PACK,
      gateway: mockGw,
    });
    expect(resumed.ok).toBe(true);
    if (resumed.ok) {
      expect(resumed.value.getState().player.name).toBe('Rowan');
      expect(resumed.value.getConfig().generation?.temperature).toBe(0.55);
    }
  });

  it('renders /help, /characters, /inspect, /connections, /sampling, and errors in paginated output view within narrow Termux bounds', async () => {
    const gateway = createMockModelGateway({
      narrator: [{ kind: 'text', text: 'You step back into the rain.' }],
      state_tracker: [{ kind: 'json', value: {} }],
    });
    gateway.setDefaultConnection({
      provider: 'mock',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'local-model',
    });

    const runtime = new SessionRuntime({
      sessionId: 'tui-output-view-test',
      systemPack: STOCK_SLICE_OF_LIFE_PACK,
      gateway,
      seed: 'tui-output-seed',
    });
    runtime.upsertCharacter('hana', {
      name: 'Hana',
      presentInScene: true,
      mood: 'cheerful',
      sections: { sec_personality: 'Always greets regulars with fresh roast coffee.' },
    });

    const controller = new TuiController({ runtime, gateway });

    // /help switches to output mode and renders inside narrow 50x16 Termux screen
    await controller.handleInput('/help');
    expect(controller.getViewMode()).toBe('output');
    const helpPage1 = controller.renderScreen({ width: 50, height: 16 }, { hidePromptLine: true });
    expect(helpPage1).toContain('HELP | Page 1/');
    expect(helpPage1).toContain('Available Slash Commands:');
    expect(helpPage1).not.toContain('> Type action or /command');
    for (const line of helpPage1.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(50);
    }
    expect(helpPage1.split('\n').length).toBeLessThanOrEqual(16);

    // /next and /prev paginate output cleanly
    await controller.handleInput('/next');
    const helpPage2 = controller.renderScreen({ width: 50, height: 16 }, { hidePromptLine: true });
    expect(helpPage2).toContain('HELP | Page 2/');

    await controller.handleInput('/prev');
    const backToPage1 = controller.renderScreen({ width: 50, height: 16 }, { hidePromptLine: true });
    expect(backToPage1).toContain('HELP | Page 1/');

    // /characters & /inspect & /connections & /sampling render directly in renderScreen
    await controller.handleInput('/characters');
    expect(controller.getViewMode()).toBe('output');
    expect(controller.renderScreen({ width: 80, height: 24 })).toContain('Hana');

    await controller.handleInput('/inspect hana');
    expect(controller.getViewMode()).toBe('output');
    expect(controller.renderScreen({ width: 80, height: 24 })).toContain('Dossier: Hana (hana)');

    await controller.handleInput('/connections');
    expect(controller.getViewMode()).toBe('output');
    expect(controller.renderScreen({ width: 80, height: 24 })).toContain('local-model');

    await controller.handleInput('/sampling');
    expect(controller.getViewMode()).toBe('output');
    expect(controller.renderScreen({ width: 80, height: 24 })).toContain('SAMPLING');

    // /back returns to previous view mode; narrative turn also exits output mode
    await controller.handleInput('/back');
    expect(controller.getViewMode()).toBe('play');

    await controller.handleInput('/help');
    expect(controller.getViewMode()).toBe('output');
    await controller.handleInput('Wave to Hana');
    expect(controller.getViewMode()).toBe('play');
    expect(controller.renderScreen({ width: 80, height: 24 })).toContain('step back into the rain');

    // showErrorMessage renders cleanly in output view without throwing
    controller.showErrorMessage('Network timeout contacting endpoint');
    expect(controller.getViewMode()).toBe('output');
    expect(controller.renderScreen({ width: 80, height: 24 })).toContain(
      'Network timeout contacting endpoint'
    );

    controller.dispose();
  });
});
