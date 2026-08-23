import { COMMANDS, getCommand } from './registry.ts';
import type { CommandId } from './types';

const STORAGE_KEY = 'marks:ribbon-profile:v1';

export interface RibbonProfile {
  expanded: boolean;
  pinned: CommandId[];
  touched: boolean;
}

export const DEFAULT_PINNED_COMMANDS = COMMANDS
  .filter((command) => command.pinByDefault)
  .map((command) => command.id);

export function defaultRibbonProfile(): RibbonProfile {
  return { expanded: false, pinned: [...DEFAULT_PINNED_COMMANDS], touched: false };
}

export function readRibbonProfile(storage: Pick<Storage, 'getItem'> = localStorage): RibbonProfile {
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? '') as Partial<RibbonProfile>;
    const pinned = Array.isArray(parsed.pinned)
      ? [...new Set(parsed.pinned.filter((id): id is string => typeof id === 'string' && Boolean(getCommand(id))))].slice(0, 12)
      : [...DEFAULT_PINNED_COMMANDS];
    return {
      expanded: parsed.expanded === true,
      pinned,
      touched: parsed.touched === true,
    };
  } catch {
    return defaultRibbonProfile();
  }
}

export function writeRibbonProfile(
  profile: RibbonProfile,
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  storage.setItem(STORAGE_KEY, JSON.stringify({
    expanded: profile.expanded,
    pinned: [...new Set(profile.pinned)].filter((id) => Boolean(getCommand(id))).slice(0, 12),
    touched: true,
  }));
}
