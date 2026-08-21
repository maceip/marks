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

export function normalizeKey(key, { lowerModifiers = false } = {}) {
  let next = String(key);
  next = next.replace(/^Control\+/i, 'Control+').replace(/^Meta\+/i, 'Meta+').replace(/^Alt\+/i, 'Alt+');
  if (lowerModifiers) {
    next = next.replace(/^(Control|Meta|Alt|Shift)\+([A-Z])$/, (_, mod, letter) => `${mod}+${letter.toLowerCase()}`);
  }
  return next;
}
