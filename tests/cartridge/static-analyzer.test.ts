import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BeatDefinition } from '../../src/beats/beat-ledger.js';
import type { EndingDefinition, RouteDefinition } from '../../src/beats/routes-and-endings.js';
import {
  type CartridgeBundle,
  validateCartridgeStructure,
} from '../../src/cartridge/cartridge-schema.js';
import {
  loadCartridgeFromDirectory,
  resolveEffectivePackForCartridge,
} from '../../src/cartridge/loader.js';
import {
  analyzeCartridgeGraph,
  detectBeatCycles,
  validateCrossFileReferences,
} from '../../src/cartridge/static-analyzer.js';
import {
  loadSystemPackFromFile,
  loadSystemPackFromJson,
  parseAndValidateSystemPack,
} from '../../src/cartridge/system-pack-schema.js';
import { isErr, isOk } from '../../src/core/result.js';
import {
  STOCK_FREEFORM_PACK,
  STOCK_LIVING_WORLD_PACK,
  STOCK_SLICE_OF_LIFE_PACK,
} from '../../src/schema/stock-system-packs.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

function createTier0Bundle(overrides?: Partial<CartridgeBundle>): CartridgeBundle {
  return {
    rootDir: null,
    card: {
      spec: 'cartridge/0.1',
      id: 'cafeteria-slice',
      version: '0.1.0',
      title: 'Lunch at Oakwood High',
      author: 'Test Author',
      description: 'A minimal Tier 0 slice-of-life cartridge.',
      persona: {
        name: 'Maya Lin',
        description: 'A sharp-witted student sitting by the cafeteria window.',
        firstMessage: 'She slides an extra tray across the table. "Saved you a seat."',
      },
    },
    beats: [],
    routes: [],
    endings: [],
    loreFiles: {
      'lore/cafeteria.md': '# Oakwood Cafeteria\nSunlight pours through tall glass windows.',
    },
    endingPromptFiles: {},
    scriptFiles: {},
    ...overrides,
  };
}

function createCrimsonKeepBundle(options?: {
  routes?: RouteDefinition[];
  beats?: BeatDefinition[];
  endings?: EndingDefinition[];
}): CartridgeBundle {
  const routes: RouteDefinition[] = options?.routes ?? [
    {
      id: 'loyal',
      lock: 'route_loyal',
      priority: 2,
      when: {
        all: [
          { clock: 'day', op: '>=', value: 2 },
          { flag: 'archive_discovered' },
          { counter: 'trust', op: '>=', value: 3 },
        ],
      },
      announce: 'You pledge your steel to the Keep.',
    },
    {
      id: 'betrayal',
      lock: 'route_betrayal',
      priority: 1,
      when: {
        all: [
          { clock: 'day', op: '>=', value: 2 },
          { flag: 'archive_discovered' },
          { counter: 'trust', op: '<', value: 3 },
        ],
      },
      announce: 'The Crimson Archive reveals the lie — betrayal path locked.',
    },
  ];

  const beats: BeatDefinition[] = options?.beats ?? [
    {
      id: 'discover-archive',
      class: 'gate',
      priority: 10,
      when: { clock: 'day', op: '>=', value: 2 },
      until: { flag: 'archive_discovered' },
      nudge: 'Search the Crimson Archive.',
    },
    {
      id: 'betrayal-contact',
      route: 'betrayal',
      class: 'nudge',
      priority: 5,
      when: { flag: 'archive_discovered' },
      nudge: 'Meet the Whisperer beneath the Keep.',
    },
    {
      id: 'loyal-oath',
      route: 'loyal',
      class: 'nudge',
      priority: 5,
      when: { flag: 'archive_discovered' },
      nudge: 'Report your findings to the Warden.',
    },
  ];

  const endings: EndingDefinition[] = options?.endings ?? [
    {
      id: 'true-ending',
      route: 'loyal',
      priority: 2,
      when: { flag: 'keep_saved' },
      epilogue: { template: 'The Crimson Keep stands unbroken.' },
      mark: 'ending_true',
    },
    {
      id: 'betrayal-ending',
      route: 'betrayal',
      priority: 1,
      when: { flag: 'keep_fallen' },
      epilogue: { template: 'The Keep burns from within.' },
      mark: 'ending_betrayal',
    },
  ];

  return {
    rootDir: null,
    card: {
      spec: 'cartridge/0.1',
      id: 'crimson-keep',
      version: '1.0.0',
      title: 'The Crimson Keep',
      description: 'Two-route political intrigue campaign.',
      recommendedSystemPack: 'stock-living-world',
      persona: {
        name: 'Warden Kael',
        description: 'Commander of the Crimson Keep.',
      },
    },
    initialState: {
      clocks: {
        turn: 0,
        storyTurn: 0,
        day: 1,
        inGameDate: null,
        slot: 'morning',
        slotsPerDay: ['morning', 'afternoon', 'evening', 'night'],
        held: false,
        holdReason: null,
        timers: {},
      },
      scene: {
        location: 'Keep Courtyard',
        locationId: 'courtyard',
        presentCharacterIds: ['warden'],
        pinnedCharacterIds: [],
        mood: 'tense',
        pacing: 'balanced',
        directorNudge: null,
      },
    },
    initialEntities: {
      locations: {
        courtyard: {
          id: 'courtyard',
          name: 'Keep Courtyard',
          kind: 'landmark',
          status: 'normal',
          controllingFactionId: 'keep_guard',
          connectedLocations: ['archive'],
          discovered: true,
          tags: ['hub'],
          notes: '',
        },
        archive: {
          id: 'archive',
          name: 'Crimson Archive',
          kind: 'vault',
          status: 'normal',
          controllingFactionId: 'keep_guard',
          connectedLocations: ['courtyard'],
          discovered: false,
          tags: ['secret'],
          notes: '',
        },
      },
      factions: {
        keep_guard: {
          id: 'keep_guard',
          name: 'Keep Guard',
          side: 'neutral',
          status: 'active',
          influence: 60,
          headquartersLocationId: 'courtyard',
          goals: ['Protect the Keep'],
        },
      },
      characters: {
        warden: {
          id: 'warden',
          name: 'Warden Kael',
          status: 'active',
          presentInScene: true,
          locationId: 'courtyard',
          formId: null,
          formGroup: null,
          sections: {},
          customFields: {},
          abilities: [],
          goals: ['Maintain order'],
          agenda: 'Defend the realm',
          allegiance: 'keep_guard',
          mood: 'stern',
          traits: ['stoic'],
        },
      },
    },
    beats,
    routes,
    endings,
    loreFiles: {},
    endingPromptFiles: {},
    scriptFiles: {},
  };
}

describe('system-pack/0.1 schema and file loader', () => {
  it('parses and validates a valid system-pack/0.1 JSON payload and loads from disk', async () => {
    const json = JSON.stringify(STOCK_SLICE_OF_LIFE_PACK);
    const jsonRes = loadSystemPackFromJson(json);
    expect(isOk(jsonRes)).toBe(true);
    if (jsonRes.ok) {
      expect(jsonRes.value.spec).toBe('system-pack/0.1');
      expect(jsonRes.value.id).toBe('stock-slice-of-life');
    }

    const tempDir = await makeTempDir('syspack-');
    const packPath = path.join(tempDir, 'pack.json');
    await writeFile(packPath, JSON.stringify(STOCK_FREEFORM_PACK, null, 2), 'utf8');

    const fileRes = await loadSystemPackFromFile(packPath);
    expect(isOk(fileRes)).toBe(true);
    if (fileRes.ok) {
      expect(fileRes.value.id).toBe('stock-freeform');
    }

    const missingRes = await loadSystemPackFromFile(path.join(tempDir, 'missing.json'));
    expect(isErr(missingRes)).toBe(true);
    if (!missingRes.ok) {
      expect(missingRes.error[0]?.code).toBe('FILE_READ_ERROR');
    }
  });

  it('rejects wrong spec and prototype pollution keys in system packs', () => {
    const badSpecRes = parseAndValidateSystemPack({
      ...STOCK_FREEFORM_PACK,
      spec: 'system-pack/999',
    });
    expect(isErr(badSpecRes)).toBe(true);
    if (!badSpecRes.ok) {
      expect(badSpecRes.error.some((e) => e.code === 'INVALID_SPEC')).toBe(true);
    }

    const pollutedJson =
      '{"spec":"system-pack/0.1","id":"evil","name":"Evil","__proto__":{"polluted":true},"capabilities":{"spatialMode":"scene_only","combatMode":"disabled","progression":"disabled","clocks":"disabled","factions":false,"beats":false,"relationships":false,"chronicle":false},"pcCoreSections":[],"npcCoreSections":[],"gameSystems":[],"blockOrder":[],"syspromptSectionOrder":[]}';
    const pollutedRes = loadSystemPackFromJson(pollutedJson);
    expect(isErr(pollutedRes)).toBe(true);
    if (!pollutedRes.ok) {
      expect(pollutedRes.error.some((e) => e.code === 'UNSAFE_PROPERTY_KEY')).toBe(true);
    }
  });
});

describe('PR-5.1 Tier 0 minimal cartridge & effective pack resolution', () => {
  it('validates minimal Tier 0 cartridge (card + lore/cafeteria.md), resolves stock-slice-of-life, and passes analysis cleanly', () => {
    const tier0 = createTier0Bundle();
    const structRes = validateCartridgeStructure(tier0);
    expect(isOk(structRes)).toBe(true);

    const packRes = resolveEffectivePackForCartridge(tier0);
    expect(isOk(packRes)).toBe(true);
    if (packRes.ok) {
      expect(packRes.value.id).toBe('stock-slice-of-life');
    }

    const explicitRes = resolveEffectivePackForCartridge(tier0, STOCK_FREEFORM_PACK);
    expect(isOk(explicitRes)).toBe(true);
    if (explicitRes.ok) {
      expect(explicitRes.value.id).toBe('stock-freeform');
    }

    const report = analyzeCartridgeGraph(tier0);
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.reachableBeatIds).toEqual([]);
    expect(report.unreachableBeatIds).toEqual([]);
    expect(report.reachableEndingIds).toEqual([]);
    expect(report.unreachableEndingIds).toEqual([]);
    expect(report.deadlockStatesDetected).toBe(false);
  });

  it('returns an error when recommendedSystemPack names an unknown stock pack', () => {
    const badPackCartridge = createTier0Bundle({
      card: {
        ...createTier0Bundle().card,
        recommendedSystemPack: 'nonexistent-pack',
      },
    });
    const res = resolveEffectivePackForCartridge(badPackCartridge);
    expect(isErr(res)).toBe(true);
    if (!res.ok) {
      expect(res.error[0]?.code).toBe('UNKNOWN_SYSTEM_PACK');
    }
  });
});

describe('PR-5.1 directory loading via loadCartridgeFromDirectory', () => {
  it('loads a Tier 0 temporary cartridge directory with card.json and lore/cafeteria.md', async () => {
    const dir = await makeTempDir('cartridge-tier0-');
    await mkdir(path.join(dir, 'lore'), { recursive: true });

    const tier0 = createTier0Bundle();
    await writeFile(path.join(dir, 'card.json'), JSON.stringify(tier0.card, null, 2), 'utf8');
    await writeFile(
      path.join(dir, 'lore', 'cafeteria.md'),
      '# Oakwood Cafeteria\nSunlight pours through tall glass windows.',
      'utf8'
    );

    const loaded = await loadCartridgeFromDirectory(dir);
    expect(isOk(loaded)).toBe(true);
    if (!loaded.ok) {
      return;
    }

    expect(loaded.value.rootDir).toBe(dir);
    expect(loaded.value.card.id).toBe('cafeteria-slice');
    expect(loaded.value.beats).toEqual([]);
    expect(loaded.value.routes).toEqual([]);
    expect(loaded.value.endings).toEqual([]);
    expect(loaded.value.loreFiles['lore/cafeteria.md']).toContain('Oakwood Cafeteria');

    const effectivePack = resolveEffectivePackForCartridge(loaded.value);
    expect(isOk(effectivePack)).toBe(true);
    if (effectivePack.ok) {
      expect(effectivePack.value.id).toBe('stock-slice-of-life');
    }

    const report = analyzeCartridgeGraph(loaded.value);
    expect(report.ok).toBe(true);
    expect(report.deadlockStatesDetected).toBe(false);
  });

  it('loads a full campaign cartridge directory including optional JSON files, scripts, and ending markdown files', async () => {
    const dir = await makeTempDir('cartridge-full-');
    await mkdir(path.join(dir, 'lore'), { recursive: true });
    await mkdir(path.join(dir, 'scripts'), { recursive: true });
    await mkdir(path.join(dir, 'assets', 'endings'), { recursive: true });

    const campaign = createCrimsonKeepBundle();
    const cardWithScripts = {
      ...campaign.card,
      scripts: [{ scriptId: 'patrol', capabilities: ['state:read'] }],
    };
    const beatsWithLoreAndScript: BeatDefinition[] = [
      {
        ...campaign.beats[0]!,
        lore: 'lore/archive.md',
        on_entry: [{ script: 'patrol' }, { inject: 'lore/archive.md' }],
      },
      ...campaign.beats.slice(1),
    ];
    const endingsWithPrompt: EndingDefinition[] = [
      {
        ...campaign.endings[0]!,
        epilogue: { promptPath: 'assets/endings/true.md' },
      },
      campaign.endings[1]!,
    ];

    await writeFile(path.join(dir, 'card.json'), JSON.stringify(cardWithScripts, null, 2), 'utf8');
    await writeFile(
      path.join(dir, 'state.json'),
      JSON.stringify(campaign.initialState, null, 2),
      'utf8'
    );
    await writeFile(
      path.join(dir, 'entities.json'),
      JSON.stringify(campaign.initialEntities, null, 2),
      'utf8'
    );
    await writeFile(
      path.join(dir, 'beats.json'),
      JSON.stringify(beatsWithLoreAndScript, null, 2),
      'utf8'
    );
    await writeFile(
      path.join(dir, 'routes.json'),
      JSON.stringify({ routes: campaign.routes, endings: endingsWithPrompt }, null, 2),
      'utf8'
    );
    await writeFile(path.join(dir, 'lore', 'archive.md'), '# Crimson Archive', 'utf8');
    await writeFile(path.join(dir, 'scripts', 'patrol.js'), 'export function run() {}', 'utf8');
    await writeFile(
      path.join(dir, 'assets', 'endings', 'true.md'),
      '# True Ending\nPeace returns.',
      'utf8'
    );

    const loaded = await loadCartridgeFromDirectory(dir);
    expect(isOk(loaded)).toBe(true);
    if (!loaded.ok) {
      return;
    }

    expect(loaded.value.loreFiles['lore/archive.md']).toBe('# Crimson Archive');
    expect(loaded.value.scriptFiles['scripts/patrol.js']).toBe('export function run() {}');
    expect(loaded.value.endingPromptFiles['assets/endings/true.md']).toContain('True Ending');

    const packRes = resolveEffectivePackForCartridge(loaded.value);
    expect(isOk(packRes)).toBe(true);
    if (packRes.ok) {
      expect(packRes.value.id).toBe(STOCK_LIVING_WORLD_PACK.id);
    }

    const report = analyzeCartridgeGraph(loaded.value);
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.deadlockStatesDetected).toBe(false);
  });

  it('fails directory loading when referenced lore, script, or ending prompt files are missing', async () => {
    const dir = await makeTempDir('cartridge-missing-assets-');
    const campaign = createCrimsonKeepBundle();
    await writeFile(
      path.join(dir, 'card.json'),
      JSON.stringify(
        {
          ...campaign.card,
          scripts: [{ scriptId: 'missing_script', capabilities: ['state:read'] }],
        },
        null,
        2
      ),
      'utf8'
    );
    await writeFile(
      path.join(dir, 'entities.json'),
      JSON.stringify(campaign.initialEntities, null, 2),
      'utf8'
    );
    await writeFile(
      path.join(dir, 'beats.json'),
      JSON.stringify(
        [{ ...campaign.beats[0]!, lore: 'lore/does_not_exist.md' }],
        null,
        2
      ),
      'utf8'
    );
    await writeFile(
      path.join(dir, 'routes.json'),
      JSON.stringify(
        {
          routes: campaign.routes,
          endings: [
            {
              ...campaign.endings[0]!,
              epilogue: { promptPath: 'assets/endings/missing_epilogue.md' },
            },
          ],
        },
        null,
        2
      ),
      'utf8'
    );

    const loaded = await loadCartridgeFromDirectory(dir);
    expect(isErr(loaded)).toBe(true);
    if (!loaded.ok) {
      const codes = loaded.error.map((e) => e.code);
      expect(codes).toContain('MISSING_SCRIPT_FILE');
      expect(codes).toContain('MISSING_LORE_FILE');
      expect(codes).toContain('MISSING_ENDING_PROMPT_FILE');
    }
  });
});

describe('PR-5.1 BR-5 beat cycle detection & cross-file reference validation', () => {
  it('detects requires DAG cycles (beatA -> beatB -> beatA) and reports the exact cycle path', () => {
    const cyclicBeats: BeatDefinition[] = [
      {
        id: 'beatA',
        class: 'gate',
        priority: 10,
        requires: ['beatB'],
        when: { flag: 'ready' },
      },
      {
        id: 'beatB',
        class: 'gate',
        priority: 5,
        requires: ['beatA'],
        when: { flag: 'ready' },
      },
    ];

    const cycleErrors = detectBeatCycles(cyclicBeats);
    expect(cycleErrors).toHaveLength(1);
    expect(cycleErrors[0]?.code).toBe('BEAT_CYCLE_DETECTED');
    expect(cycleErrors[0]?.message).toContain('beatA -> beatB -> beatA');

    const bundle = createCrimsonKeepBundle({
      beats: cyclicBeats,
      routes: [],
      endings: [
        {
          id: 'end',
          when: { beat: 'beatA', status: 'resolved' },
          epilogue: { template: 'Done' },
          mark: 'ending_done',
        },
      ],
    });
    const report = analyzeCartridgeGraph(bundle);
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.code === 'BEAT_CYCLE_DETECTED' && e.message.includes('beatA -> beatB -> beatA'))).toBe(true);
    expect(report.unreachableBeatIds).toEqual(['beatA', 'beatB']);
    expect(report.deadlockStatesDetected).toBe(true);
  });

  it('detects cross-file reference failures for unknown requires beat ID and unknown Tier 2 locationId', () => {
    const brokenBundle = createCrimsonKeepBundle({
      beats: [
        {
          id: 'broken-beat',
          class: 'gate',
          priority: 10,
          requires: ['ghost-beat'],
          when: { at: 'nonexistent-hall' },
        },
      ],
    });
    brokenBundle.initialEntities!.characters!.warden!.locationId = 'unknown-tower';
    brokenBundle.initialEntities!.factions!.keep_guard!.headquartersLocationId = 'missing-hq';

    const refErrors = validateCrossFileReferences(brokenBundle);
    const codes = refErrors.map((e) => e.code);
    expect(codes).toContain('UNKNOWN_BEAT_REF');
    expect(codes).toContain('UNKNOWN_LOCATION_REF');
    expect(codes).toContain('UNRESOLVED_LOCATION');

    const report = analyzeCartridgeGraph(brokenBundle);
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.code === 'UNKNOWN_BEAT_REF')).toBe(true);
    expect(report.errors.some((e) => e.code === 'UNRESOLVED_LOCATION')).toBe(true);
  });
});

describe('PR-5.1 BR-7 unreachable ending, deadlock, and Crimson Keep graph verification', () => {
  it('passes a valid Crimson Keep-style 2-route graph cleanly with zero errors and zero deadlocks', () => {
    const crimson = createCrimsonKeepBundle();
    const report = analyzeCartridgeGraph(crimson);

    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.reachableBeatIds).toEqual([
      'discover-archive',
      'betrayal-contact',
      'loyal-oath',
    ]);
    expect(report.unreachableBeatIds).toEqual([]);
    expect(report.reachableEndingIds).toEqual(['true-ending', 'betrayal-ending']);
    expect(report.unreachableEndingIds).toEqual([]);
    expect(report.deadlockStatesDetected).toBe(false);

    // Determinism check: repeated invocation yields identical structure
    const report2 = analyzeCartridgeGraph(crimson);
    expect(report2).toEqual(report);
  });

  it('flags an ending requiring two mutually exclusive route locks in the same group as unreachable', () => {
    const bundleWithImpossibleEnding = createCrimsonKeepBundle({
      endings: [
        {
          id: 'true-ending',
          route: 'loyal',
          priority: 2,
          when: { flag: 'keep_saved' },
          epilogue: { template: 'Loyal victory.' },
          mark: 'ending_true',
        },
        {
          id: 'betrayal-ending',
          route: 'betrayal',
          priority: 1,
          when: { flag: 'keep_fallen' },
          epilogue: { template: 'Betrayal victory.' },
          mark: 'ending_betrayal',
        },
        {
          id: 'impossible-golden-ending',
          route: 'loyal',
          priority: 10,
          when: { all: [{ flag: 'route_loyal' }, { flag: 'route_betrayal' }] },
          epilogue: { template: 'Impossible coexistence.' },
          mark: 'ending_impossible',
        },
      ],
    });

    const report = analyzeCartridgeGraph(bundleWithImpossibleEnding);
    expect(report.ok).toBe(false);
    expect(report.reachableEndingIds).toEqual(['true-ending', 'betrayal-ending']);
    expect(report.unreachableEndingIds).toEqual(['impossible-golden-ending']);
    expect(
      report.errors.some(
        (e) => e.code === 'UNREACHABLE_ENDING' && e.path === 'endings.impossible-golden-ending'
      )
    ).toBe(true);
    expect(report.deadlockStatesDetected).toBe(false);
  });

  it('detects non-ending deadlock states when a reachable route has no reachable ending and when a deadline closes a mandatory gate', () => {
    // Case 1: Locking betrayal route has no ending (only true-ending on loyal exists)
    const missingRouteEndingBundle = createCrimsonKeepBundle({
      endings: [
        {
          id: 'true-ending',
          route: 'loyal',
          priority: 1,
          when: { flag: 'keep_saved' },
          epilogue: { template: 'Keep saved.' },
          mark: 'ending_true',
        },
      ],
    });
    const r1 = analyzeCartridgeGraph(missingRouteEndingBundle);
    expect(r1.ok).toBe(false);
    expect(r1.deadlockStatesDetected).toBe(true);
    expect(r1.errors.some((e) => e.code === 'DEADLOCK_DETECTED')).toBe(true);

    // Case 2: Mandatory gate closes at day >= 2 before when (day >= 5) can ever fire
    const closedBeforeWhenBundle = createCrimsonKeepBundle({
      routes: [],
      beats: [
        {
          id: 'late-gate',
          class: 'gate',
          priority: 10,
          when: { clock: 'day', op: '>=', value: 5 },
          until: { flag: 'done' },
          deadline: { clock: 'day', op: '>=', value: 2 },
          deadlinePolicy: 'close',
        },
      ],
      endings: [
        {
          id: 'win',
          when: { beat: 'late-gate', status: 'resolved' },
          epilogue: { template: 'Won.' },
          mark: 'ending_win',
        },
      ],
    });
    const r2 = analyzeCartridgeGraph(closedBeforeWhenBundle);
    expect(r2.ok).toBe(false);
    expect(r2.unreachableBeatIds).toEqual(['late-gate']);
    expect(r2.unreachableEndingIds).toEqual(['win']);
    expect(r2.deadlockStatesDetected).toBe(true);
  });

  it('allows endings spanning distinct route groups while detecting unreachable strict-role gates and unknown tactical skill IDs', () => {
    const multiGroupBundle = createCrimsonKeepBundle({
      routes: [
        {
          id: 'loyal',
          group: 'faction',
          lock: 'route_loyal',
          priority: 2,
          when: { flag: 'pledged' },
        },
        {
          id: 'aria-romance',
          group: 'romance',
          lock: 'route_romance_aria',
          priority: 1,
          when: { flag: 'aria_confession' },
        },
      ],
      beats: [
        {
          id: 'strict-dead-gate',
          class: 'gate',
          flexibility: 'strict',
          priority: 10,
          roles: {
            mentor: { default: 'warden' },
          },
          when: { flag: 'start' },
          until: { flag: 'mentor_met' },
        },
      ],
      endings: [
        {
          id: 'loyal-romance-ending',
          route: 'loyal',
          priority: 5,
          when: { flag: 'route_romance_aria' },
          epilogue: { template: 'Together forever.' },
          mark: 'ending_loyal_romance',
        },
      ],
    });

    // Make warden dead -> strict-dead-gate short-circuits -> unreachable!
    multiGroupBundle.initialEntities!.characters!.warden!.status = 'dead';
    const r = analyzeCartridgeGraph(multiGroupBundle);
    expect(r.ok).toBe(false);
    expect(r.reachableEndingIds).toEqual(['loyal-romance-ending']);
    expect(r.unreachableBeatIds).toEqual(['strict-dead-gate']);
    expect(r.errors.some((e) => e.code === 'UNREACHABLE_GATE')).toBe(true);

    // Tactical skill cross-reference validation
    const tacticalBundle = createTier0Bundle({
      card: {
        ...createTier0Bundle().card,
        recommendedSystemPack: 'stock-tactical-rpg',
      },
      initialEntities: {
        characters: {
          hero: {
            id: 'hero',
            name: 'Hero',
            status: 'active',
            presentInScene: true,
            locationId: null,
            formId: null,
            formGroup: null,
            sections: {},
            customFields: {},
            abilities: ['basic_strike', 'nonexistent_ult'],
            goals: [],
            agenda: '',
            allegiance: 'player',
            mood: 'ready',
            traits: [],
          },
        },
      },
    });
    const skillErrs = validateCrossFileReferences(tacticalBundle);
    expect(skillErrs.some((e) => e.code === 'UNKNOWN_SKILL_ID')).toBe(true);
  });

  it('isolates SystemPack clones against caller mutation and rejects prototype pollution in cartridge files', async () => {
    const input = JSON.parse(JSON.stringify(STOCK_SLICE_OF_LIFE_PACK)) as Record<string, unknown>;
    const parsed = parseAndValidateSystemPack(input);
    expect(isOk(parsed)).toBe(true);
    if (parsed.ok) {
      parsed.value.capabilities.beats = true;
      parsed.value.blockOrder.push('EXTRA');
      const reParsed = parseAndValidateSystemPack(input);
      expect(isOk(reParsed)).toBe(true);
      if (reParsed.ok) {
        expect(reParsed.value.capabilities.beats).toBe(false);
        expect(reParsed.value.blockOrder).not.toContain('EXTRA');
      }
    }

    const dir = await makeTempDir('cartridge-proto-');
    await writeFile(
      path.join(dir, 'card.json'),
      '{"spec":"cartridge/0.1","id":"safe","version":"1.0.0","title":"Safe","description":"Desc","__proto__":{"polluted":true},"persona":{"name":"NPC","description":"Desc"}}',
      'utf8'
    );
    const loaded = await loadCartridgeFromDirectory(dir);
    expect(isErr(loaded)).toBe(true);
    if (!loaded.ok) {
      expect(loaded.error.some((e) => e.code === 'UNSAFE_PROPERTY_KEY')).toBe(true);
    }
  });
});

describe('PR-10.3: Static analyzer extensions (formRules, combat config, spatial geometry & cardSheet lore)', () => {
  it('validates FormTransitionRule refs, when predicates, and emits cycle/unreachable warnings', () => {
    const bundle = createCrimsonKeepBundle();
    bundle.initialEntities!.forms = [
      {
        id: 'warden_base',
        characterId: 'warden',
        formGroup: 'warden_forms',
        displayName: 'Warden Base',
        legalTargets: ['warden_ascended'],
      },
      {
        id: 'warden_ascended',
        characterId: 'warden',
        formGroup: 'warden_forms',
        displayName: 'Warden Ascended',
        legalTargets: ['warden_base'],
      },
      {
        id: 'warden_orphan',
        characterId: 'warden',
        formGroup: 'warden_forms',
        displayName: 'Warden Orphan',
        legalTargets: [],
      },
    ];
    bundle.initialEntities!.characters!.warden!.formId = 'warden_base';
    bundle.initialEntities!.characters!.warden!.formGroup = 'warden_forms';
    bundle.initialEntities!.formRules = [
      {
        id: 'rule_ascend',
        formGroup: 'warden_forms',
        fromFormId: 'warden_base',
        toFormId: 'warden_ascended',
        when: { flag: 'ascended_flag' },
        priority: 10,
      },
      {
        id: 'rule_revert',
        formGroup: 'warden_forms',
        fromFormId: 'warden_ascended',
        toFormId: 'warden_base',
        when: { flag: 'reverted_flag' },
        priority: 5,
      },
      {
        id: 'rule_unreachable',
        formGroup: 'warden_forms',
        fromFormId: 'warden_orphan',
        toFormId: 'warden_ascended',
        when: { flag: 'never_reached' },
        priority: 1,
      },
    ];

    const report = analyzeCartridgeGraph(bundle);
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.warnings.some((w) => w.code === 'FORM_RULE_CYCLE')).toBe(true);
    expect(report.warnings.some((w) => w.code === 'UNREACHABLE_FORM_RULE')).toBe(true);

    // Invalid form rule reference & unknown character in secretIdentity
    bundle.initialEntities!.formRules = [
      ...bundle.initialEntities!.formRules,
      {
        id: 'rule_bad',
        formGroup: 'warden_forms',
        fromFormId: 'nonexistent_form',
        toFormId: 'warden_base',
        when: { beat: 'nonexistent_beat', status: 'resolved' },
        priority: 1,
        secretIdentity: {
          knownByCharacterIds: ['ghost_npc'],
          unmaskOnPublicTransform: true,
        },
      },
    ];
    const badErrors = validateCrossFileReferences(bundle);
    const badCodes = badErrors.map((e) => e.code);
    expect(badCodes).toContain('FORM_NOT_FOUND');
    expect(badCodes).toContain('UNKNOWN_BEAT_REF');
    expect(badCodes).toContain('UNKNOWN_CHARACTER_REF');
  });

  it('validates CartridgeCombatConfig (summons, formLoadouts, effectTemplates) and LocationEntity geometry/connectionsMeta/hiddenAssets & cardSheet', () => {
    const bundle = createCrimsonKeepBundle();
    bundle.combat = {
      summons: {
        bad_summon: {
          id: 'bad_summon',
          name: 'Bad Summon',
          maxHp: 10,
          ac: 10,
          speed: 4,
          stats: { str: 2 },
          abilities: ['missing_summon_skill'],
          durationTurns: 2,
          maxActivePerCaster: 1,
          despawnOnSummonerDefeat: true,
          initiativePolicy: 'after_summoner',
        },
      },
      formLoadouts: {
        bad_loadout: {
          id: 'bad_loadout',
          displayName: 'Bad Form',
          abilities: ['missing_form_skill'],
          replaceAbilities: false,
          durationTurns: 3,
          persistFormIdToWorld: 'missing_world_form',
        },
      },
      effectTemplates: {
        bad_tpl: {
          id: 'bad_tpl',
          skillId: 'missing_tpl_skill',
          source: 'test',
          steps: [
            {
              kind: 'summon',
              role: '$caster',
              summonId: 'missing_summon_id',
            },
          ],
        },
      },
    };
    bundle.initialEntities!.forms = [
      {
        id: 'valid_form',
        characterId: 'warden',
        formGroup: 'warden_forms',
        displayName: 'Valid Form',
        legalTargets: [],
      },
    ];
    const firstLocId = Object.keys(bundle.initialEntities!.locations!)[0]!;
    const firstLoc = bundle.initialEntities!.locations![firstLocId]!;
    firstLoc.geometry = {
      x: Number.NaN,
      y: 10,
      polygon: [[0, 0]],
      mapRef: { layer: '', id: 'node_1' },
    };
    firstLoc.connectionsMeta = {
      nonexistent_target: { state: 'open' },
    };
    firstLoc.hiddenAssets = {
      secret_tunnel: {
        id: 'secret_tunnel',
        kind: 'subdungeon',
        name: 'Secret Tunnel',
        knowledgeTier: 'unrevealed',
        canonStatus: 'intact',
        canonLocked: false,
        linkedLocationId: 'missing_linked_loc',
      },
    };
    (bundle.initialEntities!.characters!.warden as unknown as Record<string, unknown>).cardSheet = {
      sourceSpec: 'v2',
      name: 'Warden',
      description: 'Desc',
      personality: '',
      scenario: '',
      firstMes: '',
      alternateGreetings: [],
      mesExample: '',
      creatorNotes: '',
      systemPrompt: '',
      postHistoryInstructions: '',
      tags: [],
      portraitAssetPath: '',
      embeddedLoreEntries: [
        {
          keys: ['keep'],
          secondaryKeys: [],
          content: 'Lore',
          constant: 'not_a_bool',
          insertionOrder: 10,
          enabled: true,
        },
      ],
    };

    const errs = validateCrossFileReferences(bundle);
    const paths = errs.map((e) => e.path);
    expect(paths).toContain('combat.summons.bad_summon.abilities[0]');
    expect(paths).toContain('combat.formLoadouts.bad_loadout.abilities[0]');
    expect(paths).toContain('combat.formLoadouts.bad_loadout.persistFormIdToWorld');
    expect(paths).toContain('combat.effectTemplates.bad_tpl.skillId');
    expect(paths).toContain('combat.effectTemplates.bad_tpl.steps[0].summonId');
    expect(paths).toContain(`initialEntities.locations.${firstLocId}.geometry.x`);
    expect(paths).toContain(`initialEntities.locations.${firstLocId}.geometry.mapRef.layer`);
    expect(paths).toContain(`initialEntities.locations.${firstLocId}.connectionsMeta.nonexistent_target`);
    expect(paths).toContain(`initialEntities.locations.${firstLocId}.hiddenAssets.secret_tunnel.linkedLocationId`);
    expect(paths).toContain('initialEntities.characters.warden.cardSheet.embeddedLoreEntries[0].constant');
  });
});
