import { hashString } from '../markdown/blocks.ts';
import type { PresenceLocation } from './types.ts';

export function sourcePresenceLocation(text: string, position: number): PresenceLocation {
  const clamped = Math.max(0, Math.min(position, text.length));
  const lines = text.split('\n');
  let offset = 0;
  let line = 0;
  for (; line < lines.length - 1 && offset + lines[line].length < clamped; line += 1) offset += lines[line].length + 1;
  let startLine = line;
  while (startLine > 0 && lines[startLine - 1].trim() !== '') startLine -= 1;
  let endLine = line + 1;
  while (endLine < lines.length && lines[endLine].trim() !== '') endLine += 1;
  let blockStart = 0;
  for (let index = 0; index < startLine; index += 1) blockStart += lines[index].length + 1;
  const blockSource = lines.slice(startLine, endLine).join('\n');
  let heading: string | undefined;
  let headingLine: number | undefined;
  for (let index = line; index >= 0; index -= 1) {
    const match = /^ {0,3}#{1,6}\s+(.+?)\s*$/.exec(lines[index]);
    if (match) { heading = match[1].replace(/\s+#+\s*$/, ''); headingLine = index; break; }
  }
  return { blockStart, blockEnd: blockStart + blockSource.length, blockKey: hashString(blockSource), heading, headingLine };
}
