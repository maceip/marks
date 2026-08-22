/**
 * Parse the in-app performance HUD and decide whether a measure run failed
 * its budgets. Kept separate from Playwright so the policy is unit-tested.
 */

export const USAGE = `Usage:
  node scripts/measure.mjs [sections] [keystrokes] [options]

Measure preview latency on a generated document and optionally fail if the
HUD numbers exceed a budget. Without budget flags the script only prints.

Options:
  --url <url>              App origin (default: MARKS_URL or http://localhost:3000)
  --sections <n>           Generated heading count (default: 220)
  --keystrokes <n>         Edits in the middle of the document (default: 60)
  --budget-first-ms <n>    Fail if first full render takes longer
  --budget-p50 <n>         Fail if HUD p50 (ms) is above this
  --budget-p95 <n>         Fail if HUD p95 (ms) is above this
  --budget-dirty <n>       Fail if last pass dirtied more blocks than this
  --budget-dom <n>         Fail if last pass touched more DOM nodes than this
  --help                   Show this help

Examples:
  node scripts/measure.mjs
  node scripts/measure.mjs 400
  node scripts/measure.mjs --budget-p50 400 --budget-p95 900 --budget-first-ms 45000
  MARKS_URL=http://127.0.0.1:3000 npm run measure -- --budget-p50 400
`;

const FLAG_ALIASES = {
  '--url': 'url',
  '--sections': 'sections',
  '--keystrokes': 'keystrokes',
  '--budget-first-ms': 'budgetFirstMs',
  '--budget-p50': 'budgetP50',
  '--budget-p95': 'budgetP95',
  '--budget-dirty': 'budgetDirty',
  '--budget-dom': 'budgetDom',
};

const ENV_BUDGETS = {
  budgetFirstMs: 'MARKS_MEASURE_BUDGET_FIRST_MS',
  budgetP50: 'MARKS_MEASURE_BUDGET_P50',
  budgetP95: 'MARKS_MEASURE_BUDGET_P95',
  budgetDirty: 'MARKS_MEASURE_BUDGET_DIRTY',
  budgetDom: 'MARKS_MEASURE_BUDGET_DOM',
};

function readNumber(value, flag) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Error: ${flag} must be a non-negative number.\n${USAGE}`);
  }
  return n;
}

export function parseMeasureArgs(argv, env = process.env) {
  const out = {
    help: false,
    url: env.MARKS_URL ?? 'http://localhost:3000',
    sections: 220,
    keystrokes: 60,
    budgetFirstMs: envNumber(env, ENV_BUDGETS.budgetFirstMs),
    budgetP50: envNumber(env, ENV_BUDGETS.budgetP50),
    budgetP95: envNumber(env, ENV_BUDGETS.budgetP95),
    budgetDirty: envNumber(env, ENV_BUDGETS.budgetDirty),
    budgetDom: envNumber(env, ENV_BUDGETS.budgetDom),
  };

  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      out.help = true;
      continue;
    }
    const key = FLAG_ALIASES[token];
    if (key) {
      const value = argv[i + 1];
      if (value == null || value.startsWith('--')) {
        throw new Error(`Error: ${token} requires a value.\n  node scripts/measure.mjs ${token} <n>\n`);
      }
      i += 1;
      if (key === 'url') out.url = value;
      else out[key] = readNumber(value, token);
      continue;
    }
    if (token.startsWith('--')) {
      throw new Error(`Error: unknown option ${token}.\n${USAGE}`);
    }
    positionals.push(token);
  }

  if (positionals[0] != null) out.sections = readNumber(positionals[0], 'sections');
  if (positionals[1] != null) out.keystrokes = readNumber(positionals[1], 'keystrokes');
  return out;
}

function envNumber(env, name) {
  const raw = env[name];
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function parseHud(text) {
  const collapsed = String(text ?? '').replace(/\n+/g, ' ');
  const p50 = matchMs(collapsed, 'p50');
  const p95 = matchMs(collapsed, 'p95');
  const max = matchMs(collapsed, 'max');
  const blocks = /Blocks\s+(\d+)\s+dirty\s+\/\s+(\d+)/i.exec(collapsed);
  const dom = /DOM ops\s+(\d+)/i.exec(collapsed);
  return {
    p50,
    p95,
    max,
    dirty: blocks ? Number(blocks[1]) : null,
    blocks: blocks ? Number(blocks[2]) : null,
    domOps: dom ? Number(dom[1]) : null,
  };
}

function matchMs(text, label) {
  const before = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*ms\\s+${label}\\b`, 'i').exec(text);
  if (before) return Number(before[1]);
  const after = new RegExp(`\\b${label}\\b\\s+(\\d+(?:\\.\\d+)?)\\s*ms`, 'i').exec(text);
  return after ? Number(after[1]) : null;
}

export function evaluateBudgets(metrics, budgets) {
  const checks = [
    ['first-render-ms', metrics.firstRenderMs, budgets.budgetFirstMs],
    ['p50-ms', metrics.p50, budgets.budgetP50],
    ['p95-ms', metrics.p95, budgets.budgetP95],
    ['dirty-blocks', metrics.dirty, budgets.budgetDirty],
    ['dom-ops', metrics.domOps, budgets.budgetDom],
  ];

  const failures = [];
  for (const [name, actual, budget] of checks) {
    if (budget == null) continue;
    if (actual == null || !Number.isFinite(actual)) {
      failures.push({ name, actual: null, budget, reason: 'missing reading' });
      continue;
    }
    if (actual > budget) {
      failures.push({ name, actual, budget, reason: `${actual} > ${budget}` });
    }
  }
  return { ok: failures.length === 0, failures };
}

export function formatBudgetFailures(failures) {
  return failures
    .map((failure) => `  FAIL  ${failure.name}: ${failure.reason}`)
    .join('\n');
}
