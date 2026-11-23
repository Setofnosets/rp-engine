import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CombatantState } from '../../src/combat/action-validator.js';
import {
  runSimPlaythroughCommand,
  runSimValidateCommand,
} from '../../src/cli/sim-cli.js';
import { isOk } from '../../src/core/result.js';

const CARTRIDGE_DIR = path.resolve(process.cwd(), 'cartridges', 'crimson-keep');

function makeCastellanAllyParticipant(): CombatantState {
  return {
    id: 'castellan',
    name: 'Castellan Aldric',
    team: 'ally',
    coord: { x: 1, y: 1 },
    alive: true,
    hp: 40,
    maxHp: 40,
    ac: 14,
    speed: 10,
    remainingMovement: 10,
    remainingActions: { action: 1, bonus: 1, reaction: 1 },
    resources: { stamina: 20 },
    cooldowns: {},
    stats: { str: 12, dex: 4, initiative: 100 },
    statuses: [],
    abilities: ['basic_strike', 'shield_bash'],
    passives: [],
    willpower: 5,
    maxWillpower: 10,
  };
}

function makeVarekParticipant(): CombatantState {
  return {
    id: 'captain_varek',
    name: 'Captain Varek',
    team: 'enemy',
    coord: { x: 2, y: 1 },
    alive: true,
    hp: 10,
    maxHp: 10,
    ac: 1,
    speed: 4,
    remainingMovement: 4,
    remainingActions: { action: 1, bonus: 1, reaction: 1 },
    resources: { stamina: 10 },
    cooldowns: {},
    stats: { str: 2, dex: 1, initiative: 1 },
    statuses: [],
    abilities: ['basic_strike', 'halberd_sweep'],
    passives: [],
    willpower: 2,
    maxWillpower: 10,
  };
}

describe('Campaign Regression: The Crimson Keep (Tactical RPG & Routes)', () => {
  it('passes static graph validation with all 4 beats and both endings reachable and zero deadlocks', async () => {
    const valRes = await runSimValidateCommand(CARTRIDGE_DIR);
    expect(isOk(valRes)).toBe(true);
    if (!valRes.ok) return;

    const { report, bundle } = valRes.value;
    expect(bundle.card.recommendedSystemPack).toBe('stock-tactical-rpg');
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.deadlockStatesDetected).toBe(false);
    expect(report.reachableBeatIds).toEqual(
      expect.arrayContaining([
        'castellan-intro',
        'defeat-guards',
        'archive-discovery',
        'torchlight-lore',
      ])
    );
    expect(report.reachableEndingIds).toEqual(
      expect.arrayContaining(['true-ending', 'exile-ending'])
    );
  });

  it('plays Loyal Route -> True Ending including tactical grid combat against Captain Varek', async () => {
    const simRes = await runSimPlaythroughCommand({
      cartridgeDir: CARTRIDGE_DIR,
      seed: 'crimson-loyal-seed',
      events: [
        {
          type: 'turn',
          text: 'I greet Castellan Aldric by torchlight and swear an oath to defend the Keep.',
          mockNarratorReply: 'Castellan Aldric inclines his head beside the flickering torch.',
        },
        {
          type: 'turn',
          text: '/travel keep.great_hall',
          mockNarratorReply: 'Captain Varek steps into the Great Hall, halberd raised.',
        },
        {
          type: 'start_combat',
          mode: 'tactical_grid',
          participants: [makeCastellanAllyParticipant(), makeVarekParticipant()],
        },
        {
          type: 'turn',
          text: 'I charge Captain Varek and unleash a Shield Bash!',
          combatActions: [{ type: 'skill', skillId: 'shield_bash', targetId: 'captain_varek' }],
          mockNarratorReply: 'Your shield slams into Varek, breaking his stance.',
        },
        {
          type: 'turn',
          text: 'I press the attack to finish the duel!',
          combatActions: [{ type: 'skill', skillId: 'basic_strike', targetId: 'captain_varek' }],
          mockNarratorReply: 'Varek collapses onto the flagstones as the hall falls silent.',
        },
        {
          type: 'turn',
          text: '/travel keep.archive',
          mockNarratorReply: 'You unbar the heavy door to the Crimson Archive.',
        },
        {
          type: 'turn',
          text: 'I read the founding ledger inside the archive and pledge my loyalty to Castellan Aldric.',
          mockNarratorReply: 'The ledger confirms Aldric fought to seal the Blood Eclipse.',
        },
        {
          type: 'turn',
          text: '/travel keep.great_hall',
          mockNarratorReply: 'You stride back through the vaulted Great Hall toward the sanctum.',
        },
        {
          type: 'turn',
          text: '/travel keep.sanctum',
          mockNarratorReply: 'Crimson light pulses around the Blood Sanctum altar.',
        },
        {
          type: 'turn',
          text: 'I raise the Crimson Seal to restore the ward and banish the eclipse.',
          mockNarratorReply: 'Silver dawn breaks over the quieted sanctum as Aldric kneels.',
        },
      ],
      expectations: {
        flags: {
          met_castellan: true,
          guards_defeated: true,
          archive_discovered: true,
          route_loyal: true,
          route_betrayal: false,
          ending_true: true,
        },
        beatStatuses: {
          'castellan-intro': 'resolved',
          'defeat-guards': 'resolved',
          'archive-discovery': 'resolved',
          'torchlight-lore': 'live',
        },
        activeEndingId: 'true-ending',
        endingStatus: 'epilogue',
        sceneLocation: 'Blood Sanctum',
      },
    });

    expect(isOk(simRes)).toBe(true);
    if (!simRes.ok) return;

    expect(simRes.value.failedAssertions).toEqual([]);
    expect(simRes.value.finalState.entities.characters['captain_varek']?.status).toBe('dead');
    expect(simRes.value.finalState.entities.characters['castellan']?.progression?.xp).toBeGreaterThanOrEqual(100);
    const lastTurn = simRes.value.turnResults[simRes.value.turnResults.length - 1];
    expect(lastTurn?.triggeredEnding?.id).toBe('true-ending');
    expect(lastTurn?.compiledPrompt.renderedSections['plot']).toContain('True Ending');
  });

  it('plays Betrayal Route -> Exile Ending', async () => {
    const simRes = await runSimPlaythroughCommand({
      cartridgeDir: CARTRIDGE_DIR,
      seed: 'crimson-betrayal-seed',
      events: [
        {
          type: 'turn',
          text: 'I greet the Castellan coldly without giving him my oath.',
        },
        {
          type: 'start_combat',
          mode: 'traditional',
          participants: [makeCastellanAllyParticipant(), makeVarekParticipant()],
        },
        {
          type: 'turn',
          text: 'I strike down Captain Varek without hesitation.',
          combatActions: [{ type: 'skill', skillId: 'basic_strike', targetId: 'captain_varek' }],
        },
        {
          type: 'turn',
          text: 'I clear the Great Hall.',
          combatActions: [{ type: 'skill', skillId: 'basic_strike', targetId: 'captain_varek' }],
        },
        {
          type: 'turn',
          text: '/travel keep.archive',
        },
        {
          type: 'turn',
          text: 'I seize the forbidden tome from the archive and decide to betray and usurp the Order.',
        },
        {
          type: 'turn',
          text: '/travel keep.sanctum',
        },
        {
          type: 'turn',
          text: 'I shatter the ward, seize the throne, and cast the Order into exile.',
        },
      ],
      expectations: {
        flags: {
          route_betrayal: true,
          route_loyal: false,
          ending_exile: true,
        },
        beatStatuses: {
          'castellan-intro': 'resolved',
          'defeat-guards': 'resolved',
          'archive-discovery': 'resolved',
        },
        activeEndingId: 'exile-ending',
        endingStatus: 'epilogue',
        sceneLocation: 'Blood Sanctum',
      },
    });

    expect(isOk(simRes)).toBe(true);
    if (!simRes.ok) return;

    expect(simRes.value.failedAssertions).toEqual([]);
    const lastTurn = simRes.value.turnResults[simRes.value.turnResults.length - 1];
    expect(lastTurn?.triggeredEnding?.id).toBe('exile-ending');
    expect(lastTurn?.compiledPrompt.renderedSections['plot']).toContain('Exile Ending');
  });
});
