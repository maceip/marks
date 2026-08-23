import assert from 'node:assert/strict';
import test from 'node:test';
import { toHostedAgentTools } from './catalog.ts';
import type { AgentToolDefinition } from '../commands/types.ts';

const limits = {
  maxPromptBytes: 8_192,
  maxTools: 2,
  maxSchemaBytes: 1_024,
  maxToolResultBytes: 16_384,
  maxOutputTokens: 4_096,
  maxRunMs: 600_000,
  maxConcurrentRunsPerSession: 2,
};

function tool(commandId: string, risk: AgentToolDefinition['risk']): AgentToolDefinition {
  return {
    type: 'function',
    commandId,
    name: `marks_${commandId.replace('.', '_')}`,
    description: commandId,
    strict: true,
    risk,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  };
}

test('hosted catalog maps consequences and obeys the advertised tool bound', () => {
  const hosted = toHostedAgentTools([
    tool('view.preview', 'read'),
    tool('format.bold', 'write'),
    tool('document.print', 'external'),
  ], limits);
  assert.equal(hosted.length, 2);
  assert.deepEqual(hosted.map(({ effect, durability }) => [effect, durability]), [
    ['read', 'ephemeral'],
    ['write', 'document'],
  ]);
});

