/**
 * Whether this client may open a stored document.
 *
 * Missing metadata is never authority to create a document. New documents are
 * created explicitly by an authorized HTTP request; a guessed, deleted, or
 * inaccessible ID remains closed. Only `esbt` documents are openable.
 */
export function documentIsOpenable(meta: { engine: string } | null | undefined): boolean {
  return meta?.engine === 'esbt';
}
