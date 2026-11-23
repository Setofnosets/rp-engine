import type { ControlRoomLayer } from '../../config/control-room-config.js';
import { cloneCharacterSections } from '../../schema/character-sections.js';
import { cloneSystemPack } from '../../schema/dynamic-schema-compiler.js';
import {
  type SystemPack,
  cloneGameSystemModule,
  cloneSystemCapabilities,
} from '../../schema/tracker-module.js';
import { isUnsafeRecordKey, setSafeProperty } from '../cartridge-schema.js';

/**
 * Serialize a {@link SystemPack} (`system-pack/0.1`) into deterministic formatted JSON.
 */
export function exportSystemPackToJson(pack: SystemPack): string {
  const cloned = cloneSystemPack(pack);
  return JSON.stringify(cloned, null, 2);
}

/**
 * Convert a {@link SystemPack} into an isolated {@link ControlRoomLayer} overlay
 * suitable for cartridge `systemOverrides` or Control Room preset serialization.
 */
export function exportSystemPackToControlRoomLayer(pack: SystemPack): ControlRoomLayer {
  const layer: ControlRoomLayer = {
    capabilities: cloneSystemCapabilities(pack.capabilities),
    pcCoreSections: cloneCharacterSections(pack.pcCoreSections),
    npcCoreSections: cloneCharacterSections(pack.npcCoreSections),
    gameSystems: pack.gameSystems.map(cloneGameSystemModule),
    blockOrder: [...pack.blockOrder],
    syspromptSectionOrder: [...pack.syspromptSectionOrder],
  };

  if (pack.basePrompts !== undefined) {
    const safePrompts: Record<string, string> = {};
    for (const key of Object.keys(pack.basePrompts).sort()) {
      if (isUnsafeRecordKey(key)) {
        continue;
      }
      const val = Object.getOwnPropertyDescriptor(pack.basePrompts, key)?.value;
      if (typeof val === 'string') {
        setSafeProperty(safePrompts, key, val);
      }
    }
    layer.basePrompts = safePrompts;
  }

  return layer;
}
