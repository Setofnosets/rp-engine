import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCartridgeFromDirectory } from '../../src/cartridge/loader.js';
import {
  analyzeCartridgeGraph,
  detectBeatCycles,
  validateCrossFileReferences,
} from '../../src/cartridge/static-analyzer.js';
import { isOk } from '../../src/core/result.js';
import { MockModelProvider, createMockModelGateway } from '../../src/gateway/mock-provider.js';
import { SessionRuntime } from '../../src/runtime/session-runtime.js';
import {
  buildFormIndex,
  evaluateFormTransitionRules,
} from '../../src/state/forms.js';
import { applyPatchBatch } from '../../src/state/reducer.js';
import { bindPlayerToCanonCharacter } from '../../src/state/world-state.js';

const CARTRIDGE_DIR = path.resolve(process.cwd(), 'cartridges', 'neoterra-s1');

function createTestRuntime(
  bundle: Awaited<ReturnType<typeof loadCartridgeFromDirectory>> extends infer R
    ? R extends { ok: true; value: infer V }
      ? V
      : never
    : never,
  sessionId: string,
  narratorText: string
): SessionRuntime {
  const provider = new MockModelProvider({
    handlers: {
      narrator: () => ({
        kind: 'text',
        text: narratorText,
      }),
      state_tracker: () => ({
        kind: 'json',
        value: {},
      }),
      chronicle_router: () => ({
        kind: 'json',
        value: {
          shouldRecord: false,
          category: 'event',
          title: 'Scene Milestone',
          summary: 'The scene progresses.',
          keywords: [],
          involvedEntityIds: [],
        },
      }),
      combat_agent: () => ({
        kind: 'json',
        value: {
          actions: [],
        },
      }),
    },
  });
  const gateway = createMockModelGateway(provider);
  return new SessionRuntime({
    sessionId,
    cartridge: bundle,
    gateway,
    seed: sessionId,
  });
}

describe('Campaign Regression: NeoTerra S1 (Canon Rebuild, Form Rules, Takeover & Endings)', () => {
  it('loads rebuilt cartridges/neoterra-s1 with 0 graph errors, 0 beat cycles, geometry, cardSheets, and formRules', async () => {
    const loadRes = await loadCartridgeFromDirectory(CARTRIDGE_DIR);
    expect(isOk(loadRes)).toBe(true);
    if (!loadRes.ok) return;

    const bundle = loadRes.value;
    expect(bundle.card.id).toBe('neoterra-s1');
    expect(bundle.card.title).toBe('Season 1 — Omnilia (Clarity Arc)');
    expect(bundle.card.recommendedSystemPack).toBe('stock-living-world');
    expect(bundle.initialState?.clocks?.inGameDate).toBe('2037-03-01');

    expect(detectBeatCycles(bundle.beats)).toHaveLength(0);
    expect(validateCrossFileReferences(bundle)).toHaveLength(0);

    const report = analyzeCartridgeGraph(bundle, { maxExploreStates: 4096 });
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.deadlockStatesDetected).toBe(false);
    expect(report.reachableBeatIds).toEqual(
      expect.arrayContaining([
        's1.opening.arms-deal',
        's1.opening.beast-rumors',
        's1.escalation.first-conversion',
        's1.climax.claire-confrontation',
        's1.resolution.clarity-falls',
      ])
    );
    expect(report.reachableEndingIds).toEqual(
      expect.arrayContaining([
        's1.ending.resolution',
        's1.ending.villain-victory',
        's1.ending.post-resistance',
        's1.ending.post-join-villain',
      ])
    );

    // Canon factions & threats
    expect(Object.keys(bundle.initialEntities?.factions ?? {})).toEqual(
      expect.arrayContaining(['clarity', 'petrabyte', 'neoterra-pd', 'crisis-coalition'])
    );
    expect(Object.keys(bundle.initialEntities?.threats ?? {})).toEqual(
      expect.arrayContaining(['s1.threat.clarity', 's1.threat.bcp'])
    );

    // Geometry coordinates & mapAssets preserved
    const plaza = bundle.initialEntities?.locations?.['central-plaza'];
    expect(plaza?.geometry).toEqual({
      x: 995,
      y: 698,
      districtId: 'downtown',
      regionId: 'region:center',
      mapRef: { layer: 'keyLocation', id: 'key:city-core' },
    });
    expect(plaza?.mapAssets?.imagePath).toBe('NeoTerra.png');

    // Full CharacterCardSheet & forms preserved
    const vaiva = bundle.initialEntities?.characters?.['s1.vaiva.colorgarde'];
    expect(vaiva?.cardSheet?.description).toContain('Colorgarde');
    expect(vaiva?.cardSheet?.firstMes).toContain('Colorgarde');
    expect(vaiva?.cardSheet?.mesExample).toContain('PetraByte');
    expect(vaiva?.sections['sec_body']).toBeDefined();

    const formRules = bundle.initialEntities?.formRules ?? [];
    expect(formRules.map((r) => r.id)).toEqual(
      expect.arrayContaining([
        'rule.s1.vaiva.corrupted',
        'rule.s1.aurelia.corrupted',
        'rule.s1.tindur.corrupted',
        'rule.s1.claire.cleansed',
        'rule.s1.claire.cleansed.reverse',
      ])
    );
  });

  it('supports reactive formRules evaluation and canonCharacterId takeover for s1.vaiva.colorgarde', async () => {
    const loadRes = await loadCartridgeFromDirectory(CARTRIDGE_DIR);
    expect(isOk(loadRes)).toBe(true);
    if (!loadRes.ok) return;

    const bundle = loadRes.value;
    const runtime = createTestRuntime(
      bundle,
      'neoterra-form-takeover-seed',
      'Light refracts across PetraByte Tower.'
    );

    const formIndex = buildFormIndex(bundle.initialEntities?.forms ?? []);
    const formRules = bundle.initialEntities?.formRules ?? [];

    // Takeover s1.vaiva.colorgarde
    const takenOver = bindPlayerToCanonCharacter(runtime.getState(), 's1.vaiva.colorgarde', formIndex);
    expect(takenOver.player.canonCharacterId).toBe('s1.vaiva.colorgarde');
    expect(takenOver.player.characterId).toBe('s1.vaiva.colorgarde');
    expect(takenOver.player.name).toBe('Vaiva Colorgarde');
    expect(takenOver.player.locationId).toBe('petrabyte-tower');
    expect(takenOver.scene.presentCharacterIds).not.toContain('s1.vaiva.colorgarde');

    // Trigger reactive form rule: Vaiva -> Light Shade (permanent)
    const flaggedStateRes = applyPatchBatch(
      takenOver,
      {
        eventId: 'evt-flag-corrupt',
        source: 'beat',
        operations: [{ op: 'set', path: 'flags.rule_s1_vaiva_corrupted', value: true }],
      },
      { formIndex }
    );
    expect(isOk(flaggedStateRes)).toBe(true);
    if (!flaggedStateRes.ok) return;

    const formOps = evaluateFormTransitionRules(flaggedStateRes.value.nextState, formIndex, formRules);
    expect(formOps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          op: 'form_transform',
          characterId: 's1.vaiva.colorgarde',
          targetFormId: 's1.light.shade.corrupted.colorgarde',
          lockPermanent: true,
        }),
      ])
    );

    const transformedRes = applyPatchBatch(
      flaggedStateRes.value.nextState,
      {
        eventId: 'evt-apply-form',
        source: 'beat',
        operations: formOps,
      },
      { formIndex }
    );
    expect(isOk(transformedRes)).toBe(true);
    if (!transformedRes.ok) return;

    const vaivaAfter = transformedRes.value.nextState.entities.characters['s1.vaiva.colorgarde'];
    expect(vaivaAfter?.formId).toBe('s1.light.shade.corrupted.colorgarde');
    expect(vaivaAfter?.lockedForms?.['s1.light.shade.corrupted.colorgarde']).toBe(true);
  });

  it('plays Hero Victory timeline cleanly before Turn 90 deadline', async () => {
    const loadRes = await loadCartridgeFromDirectory(CARTRIDGE_DIR);
    expect(isOk(loadRes)).toBe(true);
    if (!loadRes.ok) return;

    const runtime = createTestRuntime(
      loadRes.value,
      'neoterra-hero-seed',
      'Claire Atropos is captured and Clarity Incorporated collapses.'
    );

    const turn1 = await runtime.executeTurn({ text: '/travel clarity-hq' });
    expect(isOk(turn1)).toBe(true);
    if (!turn1.ok) return;

    const turn2 = await runtime.executeTurn({
      text: 'Colorgarde intercepts the Clarity arms shipment and brings Claire Atropos down.',
      directorSteering: {
        beatOverrides: [
          { beatId: 's1.opening.arms-deal', status: 'resolved' },
          { beatId: 's1.opening.beast-rumors', status: 'resolved' },
          { beatId: 's1.escalation.first-conversion', status: 'resolved' },
          { beatId: 's1.climax.claire-confrontation', status: 'resolved' },
          { beatId: 's1.resolution.clarity-falls', status: 'resolved' },
        ],
      },
    });
    expect(isOk(turn2)).toBe(true);
    if (!turn2.ok) return;

    expect(turn2.value.triggeredEnding?.id).toBe('s1.ending.resolution');
    const state = runtime.getState();
    expect(state.flags['ending_s1_resolution']).toBe(true);
    expect(state.meta.activeEndingId).toBe('s1.ending.resolution');
    expect(state.meta.endingStatus).toBe('epilogue');
    expect(state.scene.location).toBe('Clarity Incorporated HQ');
  });

  it('plays deadline-expiration Villain Victory -> Resistance and Join-Villain post-victory branches', { timeout: 20000 }, async () => {
    const loadRes = await loadCartridgeFromDirectory(CARTRIDGE_DIR);
    expect(isOk(loadRes)).toBe(true);
    if (!loadRes.ok) return;

    const runToDeadlineAndBranch = async (branchId: 'resistance' | 'join-villain') => {
      const runtime = createTestRuntime(
        loadRes.value,
        `neoterra-villain-${branchId}`,
        'Clarity tightens its grip over Neo Terra.'
      );
      for (let i = 0; i < 90; i += 1) {
        const res = await runtime.executeTurn({ text: `Patrol turn ${i + 1}` });
        expect(isOk(res)).toBe(true);
        if (!res.ok) throw new Error('Turn failed');
      }
      const beforeBranch = runtime.getState();
      expect(beforeBranch.meta.activeEndingId).toBe('s1.ending.villain-victory');
      expect(beforeBranch.flags['ending_s1_villain_victory']).toBe(true);

      const branchRes = runtime.choosePostEndingBranch(branchId);
      expect(isOk(branchRes)).toBe(true);
      return runtime.getState();
    };

    const resistanceState = await runToDeadlineAndBranch('resistance');
    expect(resistanceState.meta.arc).toBe('post-victory');
    expect(resistanceState.meta.endingStatus).toBe('continued');
    expect(resistanceState.flags['post_victory_s1_resistance_chosen']).toBe(true);
    expect(resistanceState.flags['route_s1_post_resistance']).toBe(true);

    const joinState = await runToDeadlineAndBranch('join-villain');
    expect(joinState.meta.arc).toBe('post-victory');
    expect(joinState.meta.endingStatus).toBe('continued');
    expect(joinState.flags['post_victory_s1_join_chosen']).toBe(true);
    expect(joinState.flags['route_s1_post_join_villain']).toBe(true);
  });
});
