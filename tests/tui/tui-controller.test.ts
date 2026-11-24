import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BeatLedgerState } from '../../src/beats/beat-ledger.js';
import { importSillyTavernCard } from '../../src/cartridge/importers/st-card-importer.js';
import { parseMainCliArgs, loadPlaySessionInputs, runMainCli } from '../../src/cli/main.js';
import type { CombatState, CombatantState } from '../../src/combat/action-validator.js';
import type { GridTile, TacticalGrid } from '../../src/combat/grid-types.js';
import { resolveEffectiveControlRoomConfig } from '../../src/config/control-room-config.js';
import { computeControlRoomDiffReport } from '../../src/config/prompt-diff.js';
import { isOk } from '../../src/core/result.js';
import { createMockModelGateway } from '../../src/gateway/mock-provider.js';
import { SessionRuntime } from '../../src/runtime/session-runtime.js';
import {
  STOCK_SLICE_OF_LIFE_PACK,
  STOCK_TACTICAL_RPG_PACK,
} from '../../src/schema/stock-system-packs.js';
import { RefereeDaemon } from '../../src/server/daemon.js';
import type { AuditEntry } from '../../src/state/audit-log.js';
import { createWorldState } from '../../src/state/world-state.js';
import { TuiController } from '../../src/tui/app.js';
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

  it('8. PR-10.2: Traditional Theater combat, hazards, discoveryState, newsroom, POV badge, and new slash commands', async () => {
    const baseState = createWorldState({
      sessionId: 'tui-pr10-2',
      player: {
        name: 'Lyra',
      },
      scene: {
        location: 'Sunken Shrine',
        locationId: 'loc_shrine',
        mood: 'tense',
      },
      digestEditions: [
        {
          id: 'ed-1',
          day: 3,
          inGameDate: '2026-04-03',
          masthead: 'Ironhold Gazette',
          headlines: ['Shrine Gates Unsealed', 'Guilds Rally'],
          locationIds: ['loc_shrine'],
        },
      ],
    });
    baseState.player.canonCharacterId = 'char_lyra';
    baseState.entities.locations['loc_shrine'] = {
      id: 'loc_shrine',
      name: 'Sunken Shrine',
      kind: 'shrine',
      status: 'active',
      controllingFactionId: null,
      connectedLocations: [],
      tags: [],
      discovered: true,
      notes: '',
      discoveryState: 'discovered',
    };

    const runtime = new SessionRuntime({
      sessionId: 'tui-pr10-2',
      gateway: {
        generate: async () => ({
          text: '',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        }),
      } as never,
    });
    const controller = new TuiController({ runtime });
    const hudLines = renderDynamicHudPane({
      state: baseState,
      config: controller['getSnapshot']().config,
      beatLedger: { records: {}, liveGateId: null, liveNudgeIds: [], activeAmbientIds: [] },
      pendingConfirmationsCount: 0,
      width: 100,
    });
    const hudText = hudLines.join('\n');
    expect(hudText).toContain('[discovered]');
    expect(hudText).toContain('POV: char_lyra');
    expect(hudText).toContain('News (Ironhold Gazette D3): Shrine Gates Unsealed | Guilds Rally');

    const tradCombat = {
      active: true,
      mode: 'traditional' as const,
      turnStyle: 'phased' as const,
      round: 2,
      turnIndex: 0,
      initiativeOrder: ['c1', 'c2'],
      grid: null,
      triggerCountsThisTurn: {},
      combatants: {
        c1: {
          id: 'c1',
          name: 'Lyra',
          team: 'ally' as const,
          coord: { x: 0, y: 0 },
          alive: true,
          hp: 24,
          maxHp: 30,
          ac: 14,
          speed: 30,
          remainingMovement: 30,
          remainingActions: { action: 1, bonus: 1, reaction: 1 },
          resources: {},
          cooldowns: {},
          stats: {},
          statuses: [],
          abilities: [],
          passives: [],
          willpower: 4,
          maxWillpower: 6,
          formationRow: 'front' as const,
          activeTransform: {
            loadoutId: 'wolf_form',
            remainingTurns: 3,
            tempHp: 8,
            revertOnZeroTempHp: true,
            preTransformSnapshot: {},
          },
        },
        c2: {
          id: 'c2',
          name: 'Fire Imp',
          team: 'ally' as const,
          coord: { x: 0, y: 0 },
          alive: true,
          hp: 10,
          maxHp: 10,
          ac: 12,
          speed: 30,
          remainingMovement: 30,
          remainingActions: { action: 1, bonus: 1, reaction: 1 },
          resources: {},
          cooldowns: {},
          stats: {},
          statuses: [],
          abilities: [],
          passives: [],
          willpower: 2,
          maxWillpower: 2,
          formationRow: 'back' as const,
          isSummon: true,
        },
      },
    };
    const tradLines = renderCombatGridPane(tradCombat, 100).join('\n');
    expect(tradLines).toContain('TurnStyle: phased');
    expect(tradLines).toContain('[FRONT]');
    expect(tradLines).toContain('[BACK]');
    expect(tradLines).toContain('[SUMMON]');
    expect(tradLines).toContain('[FORM:wolf_form +8THP]');
    expect(tradLines).toContain('WP 4/6');

    const previewRes = await controller.handleInput('/preview slash c2');
    expect(previewRes.outputLines[0]).toContain('Preview [slash]');
    const travelRes = await controller.handleInput('/travel loc_shrine');
    expect(travelRes.outputLines[0]).toContain('loc_shrine');
    const downtimeRes = await controller.handleInput('/downtime rest');
    expect(downtimeRes.outputLines[0]).toContain('rest');
    const newsRes = await controller.handleInput('/news');
    expect(newsRes.outputLines[0]).toContain('No digest news editions available yet.');
    const cloneRes = await controller.handleInput('/clone branch-a');
    expect(cloneRes.outputLines[0]).toContain('Cloned session');
    const takeoverRes = await controller.handleInput('/takeover char_lyra');
    expect(takeoverRes.outputLines[0]).toContain('char_lyra');
  });
});
