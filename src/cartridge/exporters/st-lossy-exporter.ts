import type { BeatDefinition } from '../../beats/beat-ledger.js';
import type { PredicateAst } from '../../beats/predicate-ast.js';
import { type CartridgeBundle, getSafeProperty } from '../cartridge-schema.js';

export interface SillyTavernV2LorebookEntry {
  id: number;
  keys: string[];
  secondary_keys: string[];
  comment: string;
  content: string;
  constant: boolean;
  selective: boolean;
  insertion_order: number;
  enabled: boolean;
  position: 'before_char' | 'after_char';
  extensions: Record<string, unknown>;
}

export interface SillyTavernV2CharacterBook {
  name: string;
  description: string;
  scan_depth: number;
  token_budget: number;
  recursive_scanning: boolean;
  extensions: Record<string, unknown>;
  entries: SillyTavernV2LorebookEntry[];
}

export interface SillyTavernV2CardData {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  creator_notes: string;
  system_prompt: string;
  post_history_instructions: string;
  alternate_greetings: string[];
  character_book?: SillyTavernV2CharacterBook;
  tags: string[];
  creator: string;
  character_version: string;
  extensions: Record<string, unknown>;
}

export interface SillyTavernV2Card {
  spec: 'chara_card_v2';
  spec_version: '2.0';
  data: SillyTavernV2CardData;
}

function collectMentionKeywords(ast: PredicateAst | undefined, out: string[]): void {
  if (!ast || typeof ast !== 'object') {
    return;
  }
  if ('mentions' in ast && Array.isArray(ast.mentions)) {
    for (const kw of ast.mentions) {
      if (typeof kw === 'string') {
        const trimmed = kw.trim();
        if (trimmed.length > 0 && !out.includes(trimmed)) {
          out.push(trimmed);
        }
      }
    }
    return;
  }
  if ('all' in ast && Array.isArray(ast.all)) {
    for (const child of ast.all) {
      collectMentionKeywords(child, out);
    }
    return;
  }
  if ('any' in ast && Array.isArray(ast.any)) {
    for (const child of ast.any) {
      collectMentionKeywords(child, out);
    }
  }
}

function resolveBeatLoreContent(
  beat: BeatDefinition,
  loreFiles: Readonly<Record<string, string>>
): string {
  if (typeof beat.lore === 'string' && beat.lore.trim().length > 0) {
    const direct = getSafeProperty(loreFiles, beat.lore);
    if (typeof direct === 'string' && direct.trim().length > 0) {
      return direct;
    }
    const prefixed = beat.lore.startsWith('lore/') ? beat.lore : `lore/${beat.lore}`;
    const resolved = getSafeProperty(loreFiles, prefixed);
    if (typeof resolved === 'string' && resolved.trim().length > 0) {
      return resolved;
    }
  }
  return beat.nudge ?? '';
}

/**
 * Lossy export of a {@link CartridgeBundle} into a SillyTavern V2 (`chara_card_v2`)
 * character card object containing flattened persona prose and keyword-triggered
 * `character_book` lorebook entries.
 */
export function exportCartridgeToSillyTavernV2(bundle: CartridgeBundle): SillyTavernV2Card {
  const persona = bundle.card.persona;
  const loreFiles = bundle.loreFiles ?? {};
  const entries: SillyTavernV2LorebookEntry[] = [];
  const exportedLorePaths = new Set<string>();

  const sortedBeats = [...bundle.beats].sort((a, b) => {
    if (b.priority !== a.priority) {
      return b.priority - a.priority;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  let nonAmbientBeatsCount = 0;
  for (const beat of sortedBeats) {
    if (beat.class !== 'ambient') {
      nonAmbientBeatsCount += 1;
    }
    const keys: string[] = [];
    collectMentionKeywords(beat.when, keys);
    const content = resolveBeatLoreContent(beat, loreFiles);

    if (typeof beat.lore === 'string') {
      exportedLorePaths.add(beat.lore);
      if (!beat.lore.startsWith('lore/')) {
        exportedLorePaths.add(`lore/${beat.lore}`);
      }
    }

    if (content.trim().length === 0) {
      continue;
    }
    if (keys.length === 0 && beat.class !== 'ambient') {
      continue;
    }

    entries.push({
      id: entries.length,
      keys,
      secondary_keys: [],
      comment: beat.id,
      content,
      constant: keys.length === 0,
      selective: false,
      insertion_order: beat.priority,
      enabled: true,
      position: 'before_char',
      extensions: {},
    });
  }

  // Export remaining lore files not already emitted via beats
  const remainingLoreKeys = Object.keys(loreFiles).sort();
  for (const lorePath of remainingLoreKeys) {
    if (exportedLorePaths.has(lorePath)) {
      continue;
    }
    if (
      lorePath === 'lore/example-dialogue.md' ||
      lorePath === 'lore/creator-notes.md' ||
      lorePath === 'lore/alternate-greetings.md'
    ) {
      continue;
    }
    const content = getSafeProperty(loreFiles, lorePath);
    if (typeof content !== 'string' || content.trim().length === 0) {
      continue;
    }
    entries.push({
      id: entries.length,
      keys: [],
      secondary_keys: [],
      comment: lorePath,
      content,
      constant: true,
      selective: false,
      insertion_order: 10,
      enabled: true,
      position: 'before_char',
      extensions: {},
    });
  }

  const lossyNotes: string[] = [];
  if (nonAmbientBeatsCount > 0) {
    lossyNotes.push(`${nonAmbientBeatsCount} state-machine beat(s) flattened/omitted in lossy ST V2 export.`);
  }
  if (bundle.routes.length > 0 || bundle.endings.length > 0) {
    lossyNotes.push(
      `${bundle.routes.length} route(s) and ${bundle.endings.length} ending(s) omitted (unsupported in ST V2).`
    );
  }
  const existingCreatorNotes = getSafeProperty(loreFiles, 'lore/creator-notes.md') ?? '';
  const creatorNotes = [existingCreatorNotes.trim(), lossyNotes.join(' ')]
    .filter((s) => s.length > 0)
    .join('\n\n');

  const mesExample = getSafeProperty(loreFiles, 'lore/example-dialogue.md') ?? '';

  const data: SillyTavernV2CardData = {
    name: persona.name,
    description: persona.description,
    personality: '',
    scenario: persona.scenario ?? '',
    first_mes: persona.firstMessage ?? '',
    mes_example: mesExample,
    creator_notes: creatorNotes,
    system_prompt: persona.systemPrompt ?? '',
    post_history_instructions: '',
    alternate_greetings: [],
    tags: bundle.card.recommendedSystemPack ? [bundle.card.recommendedSystemPack] : [],
    creator: bundle.card.author ?? '',
    character_version: bundle.card.version,
    extensions: {
      referee_lossy_export: {
        sourceCartridgeId: bundle.card.id,
        droppedRoutes: bundle.routes.length,
        droppedEndings: bundle.endings.length,
      },
    },
    ...(entries.length > 0
      ? {
          character_book: {
            name: `${bundle.card.title} Lorebook`,
            description: bundle.card.description,
            scan_depth: 4,
            token_budget: 2048,
            recursive_scanning: false,
            extensions: {},
            entries,
          },
        }
      : {}),
  };

  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data,
  };
}

/**
 * Convenience wrapper returning pretty-printed JSON for {@link exportCartridgeToSillyTavernV2}.
 */
export function exportCartridgeToSillyTavernV2Json(bundle: CartridgeBundle): string {
  return JSON.stringify(exportCartridgeToSillyTavernV2(bundle), null, 2);
}
