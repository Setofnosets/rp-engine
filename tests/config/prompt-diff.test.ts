import { describe, expect, it } from 'vitest';
import {
  type ControlRoomLayer,
  resetSectionToBaseline,
  resolveEffectiveControlRoomConfig,
  setSectionOverride,
  toggleGameSystemModule,
  upsertCustomField,
} from '../../src/config/control-room-config.js';
import {
  computeControlRoomDiffReport,
  computeNormalizedFingerprint,
  getSectionImpactBadge,
  normalizeDiffText,
} from '../../src/config/prompt-diff.js';
import {
  STOCK_FREEFORM_PACK,
  STOCK_SLICE_OF_LIFE_PACK,
  getStockSystemPack,
} from '../../src/schema/stock-system-packs.js';
import type { SystemPack } from '../../src/schema/tracker-module.js';

describe('Prompt-Diff Fingerprinting', () => {
  it('normalizes CRLF/CR to LF and trims trailing whitespace per line and at EOF', () => {
    const unixText = 'Line 1\n  Indented Line 2\n\nLine 4';
    const windowsText = 'Line 1   \r\n  Indented Line 2\t \r\n\r\nLine 4  \r\n  \r\n';
    const mixedCrText = 'Line 1\t\r  Indented Line 2\n\rLine 4\t';

    expect(normalizeDiffText(windowsText)).toBe(unixText);
    expect(normalizeDiffText(mixedCrText)).toBe(unixText);

    const fpUnix = computeNormalizedFingerprint(unixText);
    const fpWin = computeNormalizedFingerprint(windowsText);
    const fpMixed = computeNormalizedFingerprint(mixedCrText);

    expect(fpWin).toBe(fpUnix);
    expect(fpMixed).toBe(fpUnix);
    expect(fpUnix).toMatch(/^[0-9a-f]{16}$/);

    // Preserves leading indentation & internal blank lines
    expect(computeNormalizedFingerprint('  Indented')).not.toBe(
      computeNormalizedFingerprint('Indented')
    );
    expect(computeNormalizedFingerprint('A\n\nB')).not.toBe(
      computeNormalizedFingerprint('A\nB')
    );
  });

  it('produces deterministic key-order-independent fingerprints across nested JSON structures', () => {
    const objA = {
      z: 1,
      a: 'hello  \r\nworld\r\n',
      nested: {
        second: [true, { d: 'text\r\n', c: 42 }],
        first: undefined,
      },
    };
    const objB = {
      nested: {
        second: [true, { c: 42, d: 'text\n' }],
      },
      a: 'hello\nworld',
      z: 1,
    };

    expect(computeNormalizedFingerprint(objA)).toBe(computeNormalizedFingerprint(objB));

    // Distinguishes primitive types and special numbers
    expect(computeNormalizedFingerprint(null)).not.toBe(computeNormalizedFingerprint('null'));
    expect(computeNormalizedFingerprint(null)).not.toBe(computeNormalizedFingerprint(undefined));
    expect(computeNormalizedFingerprint(1)).not.toBe(computeNormalizedFingerprint('1'));
    expect(computeNormalizedFingerprint(-0)).toBe(computeNormalizedFingerprint(0));
    expect(computeNormalizedFingerprint(NaN)).not.toBe(computeNormalizedFingerprint(Infinity));

    // Handles Sets, Maps, Dates, and circular structures deterministically without throwing
    const circular: Record<string, unknown> = { a: 1 };
    circular['self'] = circular;
    expect(computeNormalizedFingerprint(circular)).toMatch(/^[0-9a-f]{16}$/);
    expect(computeNormalizedFingerprint(new Set(['b', 'a']))).toBe(
      computeNormalizedFingerprint(new Set(['a', 'b']))
    );
    expect(
      computeNormalizedFingerprint(
        new Map([
          ['k2', 'v2\r\n'],
          ['k1', 'v1'],
        ])
      )
    ).toBe(
      computeNormalizedFingerprint(
        new Map([
          ['k1', 'v1'],
          ['k2', 'v2\n'],
        ])
      )
    );
  });

  it('classifies matches_stock, from_cartridge, and user_customized impact badges accurately', () => {
    // Matches stock (even across CRLF / trailing whitespace)
    expect(
      getSectionImpactBadge('system', 'Stock prompt  \r\n', 'Stock prompt\n', undefined)
    ).toBe('matches_stock');

    // Matches stock when cartridge did not alter stock text
    expect(
      getSectionImpactBadge('system', 'Stock prompt', 'Stock prompt', 'Stock prompt')
    ).toBe('matches_stock');

    // From cartridge when cartridge overrides stock and live matches cartridge
    expect(
      getSectionImpactBadge(
        'system',
        'Cartridge prompt\r\n',
        'Stock prompt\n',
        'Cartridge prompt  \n'
      )
    ).toBe('from_cartridge');

    // From cartridge when section is cartridge-only (stockText undefined)
    expect(
      getSectionImpactBadge('custom_rule', 'Cartridge rule', undefined, 'Cartridge rule')
    ).toBe('from_cartridge');

    // User customized when live differs from both stock and cartridge
    expect(
      getSectionImpactBadge('system', 'User prompt', 'Stock prompt', 'Cartridge prompt')
    ).toBe('user_customized');

    // User customized when user clears a stock prompt
    expect(getSectionImpactBadge('system', '', 'Stock prompt', undefined)).toBe(
      'user_customized'
    );

    // Empty live text with no stock and no cartridge baseline is matches_stock (unmodified)
    expect(getSectionImpactBadge('state', '   \r\n', undefined, undefined)).toBe(
      'matches_stock'
    );

    // User-created section with no stock/cartridge baseline is user_customized
    expect(getSectionImpactBadge('custom_sec', 'My custom instructions', undefined, undefined)).toBe(
      'user_customized'
    );
  });

  it('tracks badge transitions through setSectionOverride and resetSectionToBaseline', () => {
    const stockPack: SystemPack = {
      ...getStockSystemPack('stock-freeform')!,
      basePrompts: {
        system: 'Stock System Line 1\nStock System Line 2',
        persona: 'Stock Persona',
      },
    };

    // Scenario A: Stock only (no cartridge)
    let userLayer: ControlRoomLayer = {};
    let resolved = resolveEffectiveControlRoomConfig(stockPack, undefined, userLayer);
    let report = computeControlRoomDiffReport(resolved, stockPack);
    expect(report.promptSections['system']?.badge).toBe('matches_stock');
    expect(report.overallBadge).toBe('matches_stock');

    // Modify section -> user_customized
    userLayer = setSectionOverride(userLayer, 'system', 'Custom System Text');
    resolved = resolveEffectiveControlRoomConfig(stockPack, undefined, userLayer);
    report = computeControlRoomDiffReport(resolved, stockPack);
    expect(report.promptSections['system']?.badge).toBe('user_customized');
    expect(report.promptSections['system']?.unlocked).toBe(true);
    expect(report.promptSections['persona']?.badge).toBe('matches_stock');
    expect(report.overallBadge).toBe('user_customized');

    // Reset back to stock baseline -> matches_stock
    userLayer = resetSectionToBaseline(userLayer, 'system');
    resolved = resolveEffectiveControlRoomConfig(stockPack, undefined, userLayer);
    report = computeControlRoomDiffReport(resolved, stockPack);
    expect(report.promptSections['system']?.badge).toBe('matches_stock');
    expect(report.promptSections['system']?.unlocked).toBe(false);
    expect(report.overallBadge).toBe('matches_stock');

    // Scenario B: Stock + Cartridge
    const cartridgeLayer: ControlRoomLayer = {
      basePrompts: {
        system: 'Cartridge System Prompt',
      },
    };

    userLayer = {};
    resolved = resolveEffectiveControlRoomConfig(stockPack, cartridgeLayer, userLayer);
    report = computeControlRoomDiffReport(resolved, stockPack, cartridgeLayer);
    expect(report.promptSections['system']?.badge).toBe('from_cartridge');
    expect(report.promptSections['persona']?.badge).toBe('matches_stock');
    expect(report.overallBadge).toBe('from_cartridge');

    // User customizes cartridge section -> user_customized
    userLayer = setSectionOverride(userLayer, 'system', 'User Override Over Cartridge');
    resolved = resolveEffectiveControlRoomConfig(stockPack, cartridgeLayer, userLayer);
    report = computeControlRoomDiffReport(resolved, stockPack, cartridgeLayer);
    expect(report.promptSections['system']?.badge).toBe('user_customized');
    expect(report.overallBadge).toBe('user_customized');

    // Reset -> restores from_cartridge
    userLayer = resetSectionToBaseline(userLayer, 'system');
    resolved = resolveEffectiveControlRoomConfig(stockPack, cartridgeLayer, userLayer);
    report = computeControlRoomDiffReport(resolved, stockPack, cartridgeLayer);
    expect(report.promptSections['system']?.badge).toBe('from_cartridge');
    expect(report.overallBadge).toBe('from_cartridge');
  });

  it('reports per-module and per-group badges across gameSystems, capabilities, and tuningDials', () => {
    const cartridgeLayer: ControlRoomLayer = {
      capabilities: {
        beats: true,
      },
      tuningDials: {
        beatPressure: 'generous',
      },
    };
    let userLayer: ControlRoomLayer = {};
    userLayer = toggleGameSystemModule(
      userLayer,
      'relationship_affinity',
      false,
      STOCK_SLICE_OF_LIFE_PACK
    );
    userLayer = upsertCustomField(userLayer, 'sanity_mod', 'sanity', {
      type: 'meter',
      min: 0,
      max: 100,
      default: 100,
      writableByTracker: true,
    });

    const resolved = resolveEffectiveControlRoomConfig(
      STOCK_SLICE_OF_LIFE_PACK,
      cartridgeLayer,
      userLayer
    );
    const report = computeControlRoomDiffReport(
      resolved,
      STOCK_SLICE_OF_LIFE_PACK,
      cartridgeLayer
    );

    expect(report.gameSystems['scene_context']?.badge).toBe('matches_stock');
    expect(report.gameSystems['relationship_affinity']?.badge).toBe('user_customized');
    expect(report.gameSystems['sanity_mod']?.badge).toBe('user_customized');

    expect(report.groupBadges.capabilities).toBe('from_cartridge');
    expect(report.groupBadges.tuningDials).toBe('from_cartridge');
    expect(report.groupBadges.characterSections).toBe('matches_stock');
    expect(report.groupBadges.combatRules).toBe('matches_stock');
    expect(report.groupBadges.gameSystems).toBe('user_customized');
    expect(report.overallBadge).toBe('user_customized');

    expect(report.fingerprints.stock).not.toBe(report.fingerprints.cartridge);
    expect(report.fingerprints.cartridge).not.toBe(report.fingerprints.resolved);

    // Unmodified stock config has identical stock and resolved fingerprints
    const pureResolved = resolveEffectiveControlRoomConfig(STOCK_FREEFORM_PACK);
    const pureReport = computeControlRoomDiffReport(pureResolved, STOCK_FREEFORM_PACK);
    expect(pureReport.overallBadge).toBe('matches_stock');
    expect(pureReport.fingerprints.stock).toBe(pureReport.fingerprints.resolved);
    expect(pureReport.fingerprints.cartridge).toBeUndefined();
  });
});
