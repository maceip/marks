import assert from 'node:assert/strict';
import test from 'node:test';
import { registerMarksWebMcp } from './webmcp.ts';
import type { AgentToolDefinition, CommandReceipt } from './types.ts';

const tools: AgentToolDefinition[] = [{
  type: 'function',
  name: 'marks_format_bold',
  description: 'Toggle strong emphasis',
  strict: true,
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  commandId: 'format.bold',
  risk: 'write',
}];

test('WebMCP registers registry tools and routes execution through the guarded runtime', async () => {
  const registered: Array<{ tool: any; signal?: AbortSignal }> = [];
  const focused: string[][] = [];
  const executed: Array<{ id: string; input: Record<string, unknown> }> = [];
  const dispose = await registerMarksWebMcp({
    tools: () => tools,
    focus: (ids) => focused.push(ids),
    execute: async (commandId, input) => {
      executed.push({ id: commandId, input });
      return {
        id: 'run-1',
        commandId,
        source: 'bridge',
        status: 'succeeded',
        input,
        proposedAt: 1,
        finishedAt: 2,
        message: 'Bold is durable.',
      } satisfies CommandReceipt;
    },
  }, {
    registerTool: (tool, registration) => { registered.push({ tool, signal: registration?.signal }); },
  });

  assert.deepEqual(registered.map(({ tool }) => tool.name), [
    'marks_list_available_commands',
    'marks_format_bold',
  ]);
  const result = JSON.parse(await registered[1].tool.execute({}, { signal: new AbortController().signal }));
  assert.deepEqual(focused, [['format.bold']]);
  assert.deepEqual(executed, [{ id: 'format.bold', input: {} }]);
  assert.equal(result.status, 'succeeded');
  assert.equal(registered[1].tool.annotations.readOnlyHint, false);

  dispose();
  assert.equal(registered[0].signal?.aborted, true);
});
