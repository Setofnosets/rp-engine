import { describe, expect, it } from 'vitest';
import { resolveEffectiveControlRoomConfig } from '../../src/config/control-room-config.js';
import { compileNarratorPrompt } from '../../src/context/prompt-compiler.js';
import { renderWorldStateBlock } from '../../src/context/state-renderer.js';
import { STOCK_LIVING_WORLD_PACK } from '../../src/schema/stock-system-packs.js';
import type { CharacterCardSheet } from '../../src/state/character-card-sheet.js';
import { createWorldState } from '../../src/state/world-state.js';

function makeCardSheet(
  name: string,
  overrides: Partial<CharacterCardSheet> = {}
): CharacterCardSheet {
  return {
    sourceSpec: 'v2',
    name,
    description: `${name} full description prose.`,
    personality: `${name} personality traits.`,
    scenario: `${name} scenario context.`,
    firstMes: `Hello from ${name}.`,
    alternateGreetings: [],
    mesExample: `<START>\n{{user}}: Hi\n{{char}}: ${name} example dialogue.`,
    creatorNotes: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    tags: [],
    portraitAssetPath: `assets/${name.toLowerCase()}.png`,
    embeddedLoreEntries: [],
    ...overrides,
  };
}

describe('PR-7.4: Scene-Scoped Card Sheet & Spatial Prompt Compiler', () => {
  it('keeps 25-character campaign within BPE budget and injects full card prose only for present cast + player persona/canon', () => {
    const config = resolveEffectiveControlRoomConfig(STOCK_LIVING_WORLD_PACK);

    const characters: Record<string, ReturnType<typeof createWorldState>['entities']['characters'][string]> = {};
    for (let i = 1; i <= 25; i += 1) {
      const id = `npc_${String(i).padStart(2, '0')}`;
      characters[id] = {
        id,
        name: `Character ${i}`,
        status: 'active',
        locationId: i <= 2 ? 'tavern' : `district_${i}`,
        formId: null,
        formGroup: null,
        sections: {},
        customFields: {},
        abilities: [],
        goals: [],
        agenda: '',
        presentInScene: i === 1,
        allegiance: 'neutral',
        mood: 'neutral',
        traits: [],
        cardSheet: makeCardSheet(`Character ${i}`, {
          description: `UNIQUE_DESC_${id} `.repeat(12).trim(),
          personality: `UNIQUE_PERS_${id}`,
          mesExample: `UNIQUE_MES_${id}`,
        }),
      };
    }

    const state = createWorldState({
      scene: {
        locationId: 'tavern',
        location: 'The Rusty Lantern',
        presentCharacterIds: ['npc_01'],
      },
      player: {
        name: 'Aria',
        canonCharacterId: 'npc_02',
        personaCard: makeCardSheet('Aria Persona', {
          description: 'PLAYER_PERSONA_DESC',
          personality: 'PLAYER_PERSONA_PERS',
          mesExample: 'PLAYER_PERSONA_MES',
        }),
      },
      entities: {
        characters,
      },
    });

    const totalMaxTokens = 2400;
    const compiled = compileNarratorPrompt({
      state,
      config,
      cardPersona: { name: 'Campaign', description: 'Fantasy RP' },
      recentTranscript: [{ role: 'user', content: 'I look around the tavern.' }],
      latestInput: 'Who is here?',
      budgets: { totalMaxTokens, card: 900 },
    });

    expect(compiled.totalEstimatedTokens).toBeLessThanOrEqual(totalMaxTokens);
    const cardSection = compiled.renderedSections['card'] ?? '';

    // Present character (npc_01), canon character (npc_02), and player personaCard have full prose
    expect(cardSection).toContain('UNIQUE_DESC_npc_01');
    expect(cardSection).toContain('UNIQUE_PERS_npc_01');
    expect(cardSection).toContain('UNIQUE_MES_npc_01');
    expect(cardSection).toContain('UNIQUE_DESC_npc_02');
    expect(cardSection).toContain('PLAYER_PERSONA_DESC');

    // Off-screen characters (npc_03..npc_25) must NOT inject full prose, only 1-line roster summary
    expect(cardSection).not.toContain('UNIQUE_DESC_npc_03');
    expect(cardSection).not.toContain('UNIQUE_PERS_npc_25');
    expect(cardSection).toContain('[OFF-SCREEN ROSTER]');
    expect(cardSection).toContain('- Character 3 (active) @ district_3');
  });

  it('evaluates embedded card lorebook entries with constant, keyword, secondaryKeys, enabled, and insertionOrder', () => {
    const config = resolveEffectiveControlRoomConfig(STOCK_LIVING_WORLD_PACK);

    const state = createWorldState({
      scene: {
        locationId: 'citadel',
        location: 'Citadel',
        presentCharacterIds: ['sage'],
      },
      entities: {
        characters: {
          sage: {
            id: 'sage',
            name: 'Elder Vael',
            status: 'active',
            locationId: 'citadel',
            formId: null,
            formGroup: null,
            sections: {},
            customFields: {},
            abilities: [],
            goals: [],
            agenda: '',
            presentInScene: true,
            allegiance: 'neutral',
            mood: 'neutral',
            traits: [],
            cardSheet: makeCardSheet('Elder Vael', {
              embeddedLoreEntries: [
                {
                  name: 'Second Order',
                  keys: ['artifact'],
                  secondaryKeys: ['moonlight'],
                  content: 'LORE_ORDER_20',
                  constant: false,
                  insertionOrder: 20,
                  enabled: true,
                },
                {
                  name: 'Constant Lore',
                  keys: [],
                  secondaryKeys: [],
                  content: 'LORE_CONSTANT_10',
                  constant: true,
                  insertionOrder: 10,
                  enabled: true,
                },
                {
                  name: 'Disabled Lore',
                  keys: ['artifact'],
                  secondaryKeys: [],
                  content: 'LORE_DISABLED',
                  constant: false,
                  insertionOrder: 5,
                  enabled: false,
                },
                {
                  name: 'Missing Secondary',
                  keys: ['artifact'],
                  secondaryKeys: ['sunlight'],
                  content: 'LORE_MISSING_SECONDARY',
                  constant: false,
                  insertionOrder: 15,
                  enabled: true,
                },
              ],
            }),
          },
        },
      },
    });

    const compiled = compileNarratorPrompt({
      state,
      config,
      cardPersona: { name: 'Campaign', description: 'Fantasy RP' },
      recentTranscript: [{ role: 'user', content: 'We examine the artifact under moonlight.' }],
      latestInput: 'Tell me about it.',
    });

    const worldSection = compiled.renderedSections['world'] ?? '';
    expect(worldSection).toContain('LORE_CONSTANT_10');
    expect(worldSection).toContain('LORE_ORDER_20');
    expect(worldSection).not.toContain('LORE_DISABLED');
    expect(worldSection).not.toContain('LORE_MISSING_SECONDARY');

    // insertionOrder 10 appears before insertionOrder 20
    expect(worldSection.indexOf('LORE_CONSTANT_10')).toBeLessThan(
      worldSection.indexOf('LORE_ORDER_20')
    );
  });

  it('omits unrevealed hiddenAssets and secret connections while rendering suspected/known assets', () => {
    const config = resolveEffectiveControlRoomConfig(STOCK_LIVING_WORLD_PACK);

    const state = createWorldState({
      capabilities: STOCK_LIVING_WORLD_PACK.capabilities,
      scene: {
        locationId: 'keep',
        location: 'Iron Keep',
        presentCharacterIds: [],
      },
      entities: {
        locations: {
          keep: {
            id: 'keep',
            name: 'Iron Keep',
            kind: 'fortress',
            status: 'contested',
            controllingFactionId: null,
            discovered: true,
            tags: [],
            notes: '',
            connectedLocations: ['courtyard', 'secret_vault'],
            connectionsMeta: {
              courtyard: { state: 'open' },
              secret_vault: { state: 'secret' },
            },
            hiddenAssets: {
              armory_cache: {
                id: 'armory_cache',
                name: 'Armory Cache',
                kind: 'loot',
                knowledgeTier: 'known',
                canonStatus: 'intact',
                canonLocked: false,
              },
              tunnel_rumor: {
                id: 'tunnel_rumor',
                name: 'Smuggler Tunnel',
                kind: 'clue',
                knowledgeTier: 'suspected',
                canonStatus: 'intact',
                canonLocked: false,
              },
              royal_phylactery: {
                id: 'royal_phylactery',
                name: 'Royal Phylactery',
                kind: 'loot',
                knowledgeTier: 'unrevealed',
                canonStatus: 'intact',
                canonLocked: false,
              },
            },
          },
          courtyard: {
            id: 'courtyard',
            name: 'Outer Courtyard',
            kind: 'courtyard',
            status: 'safe',
            controllingFactionId: null,
            discovered: true,
            tags: [],
            notes: '',
            connectedLocations: ['keep'],
          },
          secret_vault: {
            id: 'secret_vault',
            name: 'Secret Vault',
            kind: 'vault',
            status: 'locked',
            controllingFactionId: null,
            discovered: false,
            tags: [],
            notes: '',
            connectedLocations: ['keep'],
          },
        },
      },
    });

    const rendered = renderWorldStateBlock({
      state,
      config,
    });

    expect(rendered).toContain('Outer Courtyard (courtyard)');
    expect(rendered).not.toContain('secret_vault');
    expect(rendered).not.toContain('Secret Vault');

    expect(rendered).toContain('Armory Cache (known)');
    expect(rendered).toContain('Smuggler Tunnel (suspected)');
    expect(rendered).not.toContain('Royal Phylactery');
  });
});
