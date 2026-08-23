import type { ProjectedCommandGroup } from './types.ts';

export interface RibbonLayout {
  width: number;
  signature: string;
  visible: string[];
  collapsed: string[];
}

const GROUP_GAP = 12;
const OVERFLOW_WIDTH = 76;
const HYSTERESIS = 24;

export function estimateGroupWidth(group: ProjectedCommandGroup): number {
  const galleries = group.commands.filter((command) => command.presentation === 'gallery').length;
  const buttons = group.commands.length - galleries;
  return Math.max(96, 24 + buttons * 58 + galleries * 82);
}

export function solveRibbonLayout(
  groups: readonly ProjectedCommandGroup[],
  availableWidth: number,
  previous?: RibbonLayout,
): RibbonLayout {
  const width = Math.max(160, Math.floor(availableWidth));
  const signature = groups.map((group) => `${group.id}:${group.commands.map((command) => command.id).join(',')}`).join('|');
  if (previous && previous.signature === signature && Math.abs(previous.width - width) < HYSTERESIS) {
    return { ...previous, width };
  }

  const ranked = [...groups].sort((a, b) => b.priority - a.priority);
  const costs = new Map(groups.map((group) => [group.id, estimateGroupWidth(group) + GROUP_GAP]));
  const visible = new Set<string>();
  let used = 0;
  for (const group of ranked) {
    const cost = costs.get(group.id) ?? 120;
    const remainingGroups = groups.length - visible.size - 1;
    const reserve = remainingGroups > 0 ? OVERFLOW_WIDTH : 0;
    if (visible.size === 0 || used + cost + reserve <= width) {
      visible.add(group.id);
      used += cost;
    }
  }
  return {
    width,
    signature,
    visible: groups.filter((group) => visible.has(group.id)).map((group) => group.id),
    collapsed: groups.filter((group) => !visible.has(group.id)).map((group) => group.id),
  };
}
