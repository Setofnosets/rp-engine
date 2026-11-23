import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  runSimCli,
  runSimPlaythroughCommand,
  runSimValidateCommand,
} from '../../src/cli/sim-cli.js';
import { isOk } from '../../src/core/result.js';

const CARTRIDGE_DIR = path.resolve(process.cwd(), 'cartridges', 'neoterra-s1');

describe('Campaign Regression: NeoTerra S1 (Living World, Agendas & Post-Victory Branches)', () => {
  it('validates NeoTerra S1 static graph and passes runSimCli validate', async () => {
    const valRes = await runSimValidateCommand(CARTRIDGE_DIR);
    expect(isOk(valRes)).toBe(true);
    if (!valRes.ok) return;

    const { report, bundle } = valRes.value;
    expect(bundle.card.recommendedSystemPack).toBe('stock-living-world');
    expect(bundle.initialState?.clocks?.inGameDate).toBe('2037-03-01');
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.deadlockStatesDetected).toBe(false);
    expect(report.reachableBeatIds).toEqual(
      expect.arrayContaining(['opening-arms-deal', 'beast-rumors', 'climax-confrontation'])
    );
    expect(report.reachableEndingIds).toEqual(
      expect.arrayContaining(['hero-victory', 'villain-victory'])
    );

    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const exitCode = await runSimCli(['validate', '--cartridge', CARTRIDGE_DIR], {
      stdout: (s) => stdoutLines.push(s),
      stderr: (s) => stderrLines.push(s),
    });
    expect(exitCode).toBe(0);
    expect(stderrLines).toEqual([]);
    const parsedOut = JSON.parse(stdoutLines[0] ?? '{}') as { ok?: boolean; cartridgeId?: string };
    expect(parsedOut.ok).toBe(true);
    expect(parsedOut.cartridgeId).toBe('neoterra-s1');
  });

  it('plays Hero Victory timeline cleanly before Day 5 deadline', async () => {
    const simRes = await runSimPlaythroughCommand({
      cartridgeDir: CARTRIDGE_DIR,
      seed: 'neoterra-hero-seed',
      events: [
        {
          type: 'turn',
          text: '/travel neon-docks',
          mockNarratorReply: 'Neon reflections ripple across the oil-slick harbor piers.',
        },
        {
          type: 'turn',
          text: 'I intercept the Clarity arms shipment before their trucks leave the docks.',
          mockNarratorReply: 'You lock down the crates while Vaiva flags Clarity transit routes.',
        },
        {
          type: 'turn',
          text: '/travel old-subway',
          mockNarratorReply: 'Damp maglev rails stretch beneath midtown.',
        },
        {
          type: 'turn',
          text: 'I investigate the subway tunnels for signs of the biomechanical beast.',
          mockNarratorReply: 'Scour marks lead away from the relay substation.',
        },
        {
          type: 'turn',
          text: '/travel clarity-hq',
          mockNarratorReply: 'Claire Atropos waits beside the humming grid terminal.',
        },
        {
          type: 'turn',
          text: 'I confront Claire Atropos and disarm the Clarity grid override.',
          mockNarratorReply: 'The relay coils power down as Central Plaza lights stabilize.',
        },
      ],
      expectations: {
        flags: {
          arms_deal_resolved: true,
          beast_rumors_checked: true,
          hero_triumph: true,
          route_hero: true,
          ending_hero_victory: true,
        },
        beatStatuses: {
          'opening-arms-deal': 'resolved',
          'beast-rumors': 'resolved',
          'climax-confrontation': 'resolved',
        },
        activeEndingId: 'hero-victory',
        endingStatus: 'epilogue',
        sceneLocation: 'Clarity HQ',
        factionInfluenceMin: {
          petrabyte: 60,
        },
      },
    });

    expect(isOk(simRes)).toBe(true);
    if (!simRes.ok) return;

    expect(simRes.value.failedAssertions).toEqual([]);
    const finalTurn = simRes.value.turnResults[simRes.value.turnResults.length - 1];
    expect(finalTurn?.triggeredEnding?.id).toBe('hero-victory');
    expect(finalTurn?.compiledPrompt.renderedSections['plot']).toContain('Hero Victory');
  });

  it('plays deadline-expiration Villain Victory -> Resistance post-victory branch with agenda escalation', async () => {
    const simRes = await runSimPlaythroughCommand({
      cartridgeDir: CARTRIDGE_DIR,
      seed: 'neoterra-villain-seed',
      events: [
        {
          type: 'turn',
          text: 'I lay low in Central Plaza while Clarity moves through the city.',
          directorSteering: {
            clockAction: { advanceSlots: 16 },
          },
          mockNarratorReply:
            'Four days slip past in silence as Clarity tightens its grip on the power grid.',
        },
        {
          type: 'choose_branch',
          branchId: 'resistance',
        },
      ],
      expectations: {
        flags: {
          beast_deadline_missed: true,
          villain_ascendant: true,
          route_villain: true,
          ending_villain_victory: true,
          route_post_resistance: true,
          joined_resistance: true,
        },
        beatStatuses: {
          'climax-confrontation': 'closed',
        },
        activeEndingId: 'villain-victory',
        endingStatus: 'continued',
        arc: 'post-victory',
        factionInfluenceMin: {
          clarity: 60,
        },
      },
    });

    expect(isOk(simRes)).toBe(true);
    if (!simRes.ok) return;

    expect(simRes.value.failedAssertions).toEqual([]);
    expect(simRes.value.finalState.clocks.day).toBeGreaterThanOrEqual(5);
    expect(simRes.value.finalState.clocks.inGameDate).toBe('2037-03-05');
    expect(simRes.value.finalState.entities.threats['s1_threat_clarity']?.progress).toBeGreaterThan(20);
  });
});
