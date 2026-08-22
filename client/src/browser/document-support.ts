/**
 * Whether this client may open a stored document.
 *
 * Unknown / missing metadata is treated as openable: the first connect
 * creates an ESBT row. A row tagged `loro` or `yjs` is refused — those
 * encodings are incompatible, and connecting an ESBT replica would
 * overwrite the stored bytes with an empty document.
 */
export function documentIsOpenable(meta: { engine: string } | null | undefined): boolean {
  return !meta || meta.engine === 'esbt';
}
