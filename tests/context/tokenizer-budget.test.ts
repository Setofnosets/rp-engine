import { getEncoding } from 'js-tiktoken';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOKEN_BUDGETS,
  clipTextToTokenBudget,
  estimateTokens,
  fitItemsToBudget,
  inspectContextBudget,
} from '../../src/context/tokenizer-budget.js';

describe('tokenizer-budget', () => {
  describe('estimateTokens (exact BPE)', () => {
    it('returns 0 for empty or non-string inputs', () => {
      expect(estimateTokens('')).toBe(0);
      expect(estimateTokens('', { mode: 'heuristic' })).toBe(0);
      expect(estimateTokens('   \n\t  ', { mode: 'heuristic' })).toBe(0);
    });

    it('matches o200k_base exact token counts on English, Unicode, JSON, and code fences', () => {
      const o200k = getEncoding('o200k_base');
      const samples = [
        'The quick brown fox jumps over the lazy dog near the riverbank.',
        '日本語テスト 🚀 café naïve résumé — Ελληνικά',
        JSON.stringify({ scene: 'tavern', hp: 42, tags: ['stealth', 'rain'], nested: { ok: true } }),
        '```ts\nexport function roll(sides: number): number {\n  return Math.floor(Math.random() * sides) + 1;\n}\n```',
      ];

      for (const sample of samples) {
        expect(estimateTokens(sample)).toBe(o200k.encode(sample).length);
      }
    });

    it('supports cl100k_base encoding option', () => {
      const cl100k = getEncoding('cl100k_base');
      const sample = 'function attack(target: string, damage: number) { return `${target}:${damage}`; }';
      expect(estimateTokens(sample, { encoding: 'cl100k_base' })).toBe(cl100k.encode(sample).length);
    });

    it('is deterministic and fast on LRU cache hits and handles >2048 entries', () => {
      const text = 'Cached BPE determinism check: the dragon circles the tower.';
      const first = estimateTokens(text);
      const second = estimateTokens(text);
      expect(second).toBe(first);

      const start = performance.now();
      for (let i = 0; i < 500; i += 1) {
        expect(estimateTokens(text)).toBe(first);
      }
      const elapsedMs = performance.now() - start;
      expect(elapsedMs).toBeLessThan(100);

      // Exercise LRU eviction beyond 2048 entries
      for (let i = 0; i < 2100; i += 1) {
        estimateTokens(`lru-evict-entry-${i}`);
      }
      expect(estimateTokens(text)).toBe(first);
    });

    it('supports heuristic fallback mode with whitespace normalization', () => {
      const raw = 'alpha   beta\n\tgamma';
      // normalized: 'alpha beta gamma' (16 chars -> ceil(16/4) = 4)
      expect(estimateTokens(raw, { mode: 'heuristic' })).toBe(4);
    });
  });

  describe('clipTextToTokenBudget & fitItemsToBudget', () => {
    it('clips text so exact BPE token count never exceeds maxTokens', () => {
      const longText = 'word '.repeat(200).trim();
      const clipped = clipTextToTokenBudget(longText, 20);
      expect(clipped.length).toBeGreaterThan(0);
      expect(estimateTokens(clipped)).toBeLessThanOrEqual(20);
    });

    it('fits items greedily and truncates oversized first item', () => {
      const items = [
        { id: 'first', text: 'dragon '.repeat(100).trim() },
        { id: 'second', text: 'extra item that exceeds remaining budget' },
      ];
      const result = fitItemsToBudget(items, 5);
      expect(result.included.length).toBe(1);
      expect(result.droppedCount).toBe(1);
      expect(result.usedTokens).toBeLessThanOrEqual(5);
      expect(estimateTokens(result.included[0]!.text)).toBeLessThanOrEqual(5);
    });
  });

  describe('inspectContextBudget', () => {
    it('reports per-section tokens, utilizationPct, truncated, droppedItems, and overBudget', () => {
      const stateText = 'HP: 100/100, MP: 50/50, Location: Old Mill.';
      const worldText = 'The northern mountains are shrouded in mist.';
      const report = inspectContextBudget(
        {
          state: { text: stateText, truncated: false, droppedItems: 0 },
          world: { text: worldText, truncated: true, droppedItems: 2 },
        },
        {
          state: 100,
          world: 5,
          totalMaxTokens: 500,
        }
      );

      const stateTokens = estimateTokens(stateText);
      const worldTokens = estimateTokens(worldText);

      expect(report.totalTokens).toBe(stateTokens + worldTokens);
      expect(report.totalBudget).toBe(500);
      expect(report.overBudget).toBe(true);
      expect(report.sections).toHaveLength(2);
      expect(report.sections[0]).toEqual({
        section: 'state',
        tokens: stateTokens,
        budget: 100,
        utilizationPct: Math.round(((stateTokens / 100) * 100) * 100) / 100,
        truncated: false,
        droppedItems: 0,
      });
      expect(report.sections[1]).toEqual({
        section: 'world',
        tokens: worldTokens,
        budget: 5,
        utilizationPct: Math.round(((worldTokens / 5) * 100) * 100) / 100,
        truncated: true,
        droppedItems: 2,
      });
    });

    it('uses DEFAULT_TOKEN_BUDGETS.totalMaxTokens when omitted and avoids -0', () => {
      const report = inspectContextBudget({ state: '' }, { state: 100 });
      expect(report.totalBudget).toBe(DEFAULT_TOKEN_BUDGETS.totalMaxTokens);
      expect(report.overBudget).toBe(false);
      expect(Object.is(report.sections[0]?.utilizationPct, -0)).toBe(false);
    });
  });
});
