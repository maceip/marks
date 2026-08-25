export function childIsRunning(child) {
  return Boolean(child && child.exitCode === null && child.signalCode === null);
}

function waitForChildExit(child, milliseconds) {
  if (!childIsRunning(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), milliseconds);
    child.once('exit', onExit);
  });
}

function signalChild(child, signal) {
  try {
    child.kill(signal);
  } catch (error) {
    if (childIsRunning(child)) throw error;
  }
}

export async function terminateChild(
  child,
  { termTimeoutMs = 3_000, killTimeoutMs = 2_000 } = {},
) {
  if (!childIsRunning(child)) return;

  signalChild(child, 'SIGTERM');
  if (await waitForChildExit(child, termTimeoutMs)) return;
  if (!childIsRunning(child)) return;

  signalChild(child, 'SIGKILL');
  if (await waitForChildExit(child, killTimeoutMs)) return;
  if (!childIsRunning(child)) return;

  throw new Error('marks-server did not terminate after SIGTERM and SIGKILL');
}

export async function terminateChildAndCleanup(child, cleanup, options) {
  await terminateChild(child, options);
  cleanup();
}
