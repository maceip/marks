/**
 * Preserve delivery order across async message handlers.
 *
 * Browser message events are delivered in order, but the browser does not wait
 * for a promise returned by an event listener. Without an explicit queue, a
 * second message can therefore mutate shared state while the first handler is
 * awaiting a lazy import.
 */
export function createSerialDispatcher<Message>(
  handle: (message: Message) => void | Promise<void>,
  onUnexpectedError: (error: unknown) => void,
): (message: Message) => Promise<void> {
  let tail: Promise<void> = Promise.resolve();

  return (message) => {
    const current = tail.then(() => handle(message));
    // Keep later messages moving even if a handler escapes its own expected
    // error boundary. Attaching the rejection handler here also prevents an
    // ignored worker dispatch promise from becoming an unhandled rejection.
    tail = current.catch(onUnexpectedError);
    return current;
  };
}
