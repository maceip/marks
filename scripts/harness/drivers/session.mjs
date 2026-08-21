/**
 * Small helpers shared by the Playwright / Puppeteer / agent-browser adapters.
 */

export function serializeEvaluate(fn, arg) {
  const body = typeof fn === 'string' ? fn : `(${fn.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`;
  return `(() => {
    const value = ${body};
    return value === undefined ? null : value;
  })()`;
}

export function normalizeKey(key) {
  return String(key).replace(/^Control\+/i, 'Control+').replace(/^Meta\+/i, 'Meta+');
}
