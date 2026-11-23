import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCartridgeFromDirectory } from '../../src/cartridge/loader.js';
import {
  runSimPlaythroughCommand,
  runSimValidateCommand,
} from '../../src/cli/sim-cli.js';
import { isOk } from '../../src/core/result.js';

const CARTRIDGE_DIR = path.resolve(process.cwd(), 'cartridges', 'slice-of-life-cafe');

describe('Campaign Regression: Slice-of-Life Cafe (Tier 0)', () => {
  it('loads Tier 0 cartridge with zero entities.json, zero combat.json, and zero map, passing static validation', async () => {
    const loadRes = await loadCartridgeFromDirectory(CARTRIDGE_DIR);
    expect(isOk(loadRes)).toBe(true);
    if (!loadRes.ok) return;

    expect(loadRes.value.card.recommendedSystemPack).toBe('stock-slice-of-life');
    expect(loadRes.value.initialEntities).toBeUndefined();
    expect(loadRes.value.combat).toBeUndefined();
    expect(loadRes.value.loreFiles['lore/menu.md']).toContain('Double Espresso');

    const valRes = await runSimValidateCommand(CARTRIDGE_DIR);
    expect(isOk(valRes)).toBe(true);
    if (!valRes.ok) return;

    expect(valRes.value.report.ok).toBe(true);
    expect(valRes.value.report.errors).toEqual([]);
    expect(valRes.value.report.warnings).toEqual([]);
    expect(valRes.value.report.deadlockStatesDetected).toBe(false);
    expect(valRes.value.report.reachableBeatIds).toContain('cafe-menu-lore');
  });

  it('triggers ambient menu lore on "espresso" mention, updates scene.location & clothing, and keeps zero RPG stat pollution', async () => {
    const simRes = await runSimPlaythroughCommand({
      cartridgeDir: CARTRIDGE_DIR,
      seed: 'cafe-seed-1',
      events: [
        {
          type: 'turn',
          text: 'Hey Maya, could I get a double espresso and a seat by the window?',
          mockNarratorReply:
            'Maya grins and pulls a fresh double espresso, sliding it toward the sunlit window booth.',
          mockTrackerJson: {
            scene: {
              location: 'Window Booth',
              mood: 'cozy',
            },
            pc_sections: {
              sec_equipment: 'Cream cardigan over linen shirt',
            },
          },
        },
        {
          type: 'turn',
          text: 'Thanks! This rain makes the cafe feel extra peaceful.',
          mockNarratorReply:
            'You settle into the booth while Maya wipes the counter, raindrops beading down the glass.',
          mockTrackerJson: {
            scene: {
              mood: 'serene',
            },
          },
        },
      ],
      expectations: {
        sceneLocation: 'Window Booth',
        beatStatuses: {
          'cafe-menu-lore': 'dormant',
        },
      },
    });

    expect(isOk(simRes)).toBe(true);
    if (!simRes.ok) return;

    expect(simRes.value.failedAssertions).toEqual([]);
    expect(simRes.value.turnResults).toHaveLength(2);

    const turn1 = simRes.value.turnResults[0];
    expect(turn1?.beatLedger.records['cafe-menu-lore']?.status).toBe('live');
    expect(turn1?.compiledPrompt.renderedSections['world']).toContain('Double Espresso');
    expect(turn1?.compiledPrompt.renderedSections['world']).toContain('Warm Almond Croissant');

    const { finalState } = simRes.value;
    expect(finalState.capabilities.spatialMode).toBe('scene_only');
    expect(finalState.capabilities.combatMode).toBe('disabled');
    expect(finalState.capabilities.progression).toBe('disabled');
    expect(finalState.capabilities.factions).toBe(false);

    // Clothing & scene location updated cleanly
    expect(finalState.scene.location).toBe('Window Booth');
    expect(finalState.scene.locationId).toBeNull();
    expect(finalState.player.sections['sec_equipment']).toBe('Cream cardigan over linen shirt');
    expect(Object.keys(finalState.entities.locations)).toHaveLength(0);

    // Zero RPG stat pollution in state or rendered [STATE] block
    expect(finalState.player.progression).toBeUndefined();
    expect(finalState.player.resources).toBeUndefined();
    const stateSection = simRes.value.turnResults[1]?.compiledPrompt.renderedSections['state'] ?? '';
    expect(stateSection).not.toContain('HP ');
    expect(stateSection).not.toContain('XP ');
    expect(stateSection).not.toContain('Lv ');
    expect(stateSection).not.toContain('Factions:');
  });
});
