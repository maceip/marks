import { ICON_NAMES, type IconName } from './catalog.ts';

/**
 * Icons intentionally drawn by the vector fallback rather than backed by a
 * 104×104 PNG in public/icons/isometric.
 */
export const VECTOR_ONLY_ICON_NAMES = ['arrow', 'bubble'] as const satisfies readonly IconName[];

export type VectorOnlyIconName = (typeof VECTOR_ONLY_ICON_NAMES)[number];
export type SheetIconName = Exclude<IconName, VectorOnlyIconName>;

const VECTOR_ONLY_ICON_SET = new Set<IconName>(VECTOR_ONLY_ICON_NAMES);

export function isSheetIconName(name: IconName): name is SheetIconName {
  return !VECTOR_ONLY_ICON_SET.has(name);
}

/** The complete, typed asset manifest. Catalog additions automatically land here. */
export const SHEET_ICON_NAMES: readonly SheetIconName[] = ICON_NAMES.filter(isSheetIconName);

export const SHEET_ICON_SIZE = 104;
