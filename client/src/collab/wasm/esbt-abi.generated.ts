// Generated from abi/esbt-wasm-v1.json by tools/wasm-abi.mjs. Do not edit.

export const ESBT_ABI_VERSION = 1;
export const ESBT_ABI_CUSTOM_SECTION = "esbt.abi";
export const ESBT_ABI_DEFINITION = "{\n  \"schema\": \"esbt.wasm-abi\",\n  \"version\": 1,\n  \"custom_section\": \"esbt.abi\",\n  \"memory\": \"memory\",\n  \"imports\": [],\n  \"functions\": [\n    { \"name\": \"esbt_malloc\", \"parameters\": [{ \"name\": \"length\", \"type\": \"u32\" }], \"result\": \"pointer\" },\n    { \"name\": \"esbt_free\", \"parameters\": [{ \"name\": \"pointer\", \"type\": \"pointer\" }, { \"name\": \"length\", \"type\": \"u32\" }], \"result\": \"void\" },\n    { \"name\": \"esbt_last_len\", \"parameters\": [], \"result\": \"i32\" },\n    { \"name\": \"esbt_last_ptr\", \"parameters\": [], \"result\": \"pointer\" },\n    { \"name\": \"esbt_doc_last_error_code\", \"parameters\": [], \"result\": \"u32\" },\n    { \"name\": \"esbt_doc_create\", \"parameters\": [{ \"name\": \"site0\", \"type\": \"u32\" }, { \"name\": \"site1\", \"type\": \"u32\" }, { \"name\": \"site2\", \"type\": \"u32\" }, { \"name\": \"site3\", \"type\": \"u32\" }], \"result\": \"i32\" },\n    { \"name\": \"esbt_doc_create_configured\", \"parameters\": [{ \"name\": \"site0\", \"type\": \"u32\" }, { \"name\": \"site1\", \"type\": \"u32\" }, { \"name\": \"site2\", \"type\": \"u32\" }, { \"name\": \"site3\", \"type\": \"u32\" }, { \"name\": \"configPointer\", \"type\": \"pointer\" }, { \"name\": \"configLength\", \"type\": \"u32\" }], \"result\": \"i32\" },\n    { \"name\": \"esbt_doc_destroy\", \"parameters\": [{ \"name\": \"handle\", \"type\": \"u32\" }], \"result\": \"i32\" },\n    { \"name\": \"esbt_doc_len\", \"parameters\": [{ \"name\": \"handle\", \"type\": \"u32\" }], \"result\": \"i32\" },\n    { \"name\": \"esbt_doc_hash\", \"parameters\": [{ \"name\": \"handle\", \"type\": \"u32\" }], \"result\": \"u32\" },\n    { \"name\": \"esbt_doc_pending\", \"parameters\": [{ \"name\": \"handle\", \"type\": \"u32\" }], \"result\": \"i32\" },\n    { \"name\": \"esbt_doc_text_utf16\", \"parameters\": [{ \"name\": \"handle\", \"type\": \"u32\" }], \"result\": \"i32\" },\n    { \"name\": \"esbt_doc_visible_edits\", \"parameters\": [{ \"name\": \"handle\", \"type\": \"u32\" }], \"result\": \"i32\" },\n    { \"name\": \"esbt_doc_site\", \"parameters\": [{ \"name\": \"handle\", \"type\": \"u32\" }], \"result\": \"i32\" },\n    { \"name\": \"esbt_doc_version\", \"parameters\": [{ \"name\": \"handle\", \"type\": \"u32\" }], \"result\": \"i32\" },\n    { \"name\": \"esbt_doc_begin\", \"parameters\": [{ \"name\": \"handle\", \"type\": \"u32\" }, { \"name\": \"hasUndoGroup\", \"type\": \"u32\" }, { \"name\": \"groupLow\", \"type\": \"u32\" }, { \"name\": \"groupHigh\", \"type\": \"u32\" }], \"result\": \"i32\" },\n    { \"name\": \"esbt_doc_commit\", \"parameters\": [{ \"name\": \"handle\", \"type\": \"u32\" }], \"result\": \"i32\" },\n    { \"name\": \"esbt_doc_abort\", \"parameters\": [{ \"name\": \"handle\", \"type\": \"u32\" }], \"result\": \"i32\" },\n    { \"name\": \"esbt_doc_insert_utf16\", \"parameters\": [{ \"name\": \"handle\", \"type\": \"u32\" }, { \"name\": \"index\", \"type\": \"u32\" }, { \"name\": \"pointer\", \"type\": \"pointer\" }, { \"name\": \"byteLength\", \"type\": \"u32\" }, { \"name\": \"hasUndoGroup\", \"type\": \"u32\" }, { \"name\": \"groupLow\", \"type\": \"u32\" }, { \"name\": \"groupHigh\", \"type\": \"u32\" }], \"result\": \"i32\" },\n    { \"name\": \"esbt_doc_delete\", \"parameters\": [{ \"name\": \"handle\", \"type\": \"u32\" }, { \"name\": \"index\", \"type\": \"u32\" }, { \"name\": \"length\", \"type\": \"u32\" }, { \"name\": \"hasUndoGroup\", \"type\": \"u32\" }, { \"name\": \"groupLow\", \"type\": \"u32\" }, { \"name\": \"groupHigh\", \"type\": \"u32\" }], \"result\": \"i32\" },\n    { \"name\": \"esbt_doc_replace_utf16\", \"parameters\": [{ \"name\": \"handle\", \"type\": \"u32\" }, { \"name\": \"from\", \"type\": \"u32\" }, { \"name\": \"to\", \"type\": \"u32\" }, { \"name\": \"pointer\", \"type\": \"pointer\" }, { \"name\": \"byteLength\", \"type\": \"u32\" }, { \"name\": \"hasUndoGroup\", \"type\": \"u32\" }, { \"name\": \"groupLow\", \"type\": \"u32\" }, { \"name\": \"groupHigh\", \"type\": \"u32\" }], \"result\": \"i32\" },\n    { \"name\": \"esbt_doc_apply\", \"parameters\": [{ \"name\": \"handle\", \"type\": \"u32\" }, { \"name\": \"pointer\", \"type\": \"pointer\" }, { \"name\": \"length\", \"type\": \"u32\" }], \"result\": \"i32\" },\n    { \"name\": \"esbt_doc_export_update\", \"parameters\": [{ \"name\": \"handle\", \"type\": \"u32\" }, { \"name\": \"versionPointer\", \"type\": \"pointer\" }, { \"name\": \"versionLength\", \"type\": \"u32\" }], \"result\": \"i32\" },\n    { \"name\": \"esbt_doc_export_full_snapshot\", \"parameters\": [{ \"name\": \"handle\", \"type\": \"u32\" }], \"result\": \"i32\" },\n    { \"name\": \"esbt_doc_export_compact_snapshot\", \"parameters\": [{ \"name\": \"handle\", \"type\": \"u32\" }], \"result\": \"i32\" },\n    { \"name\": \"esbt_doc_apply_snapshot\", \"parameters\": [{ \"name\": \"handle\", \"type\": \"u32\" }, { \"name\": \"pointer\", \"type\": \"pointer\" }, { \"name\": \"length\", \"type\": \"u32\" }], \"result\": \"i32\" },\n    { \"name\": \"esbt_doc_anchor\", \"parameters\": [{ \"name\": \"handle\", \"type\": \"u32\" }, { \"name\": \"index\", \"type\": \"u32\" }, { \"name\": \"affinity\", \"type\": \"u32\" }], \"result\": \"i32\" },\n    { \"name\": \"esbt_doc_resolve_anchor\", \"parameters\": [{ \"name\": \"handle\", \"type\": \"u32\" }, { \"name\": \"pointer\", \"type\": \"pointer\" }, { \"name\": \"length\", \"type\": \"u32\" }], \"result\": \"i32\" },\n    { \"name\": \"esbt_doc_insert_at_anchor_utf16\", \"parameters\": [{ \"name\": \"handle\", \"type\": \"u32\" }, { \"name\": \"anchorPointer\", \"type\": \"pointer\" }, { \"name\": \"anchorLength\", \"type\": \"u32\" }, { \"name\": \"textPointer\", \"type\": \"pointer\" }, { \"name\": \"textByteLength\", \"type\": \"u32\" }, { \"name\": \"hasUndoGroup\", \"type\": \"u32\" }, { \"name\": \"groupLow\", \"type\": \"u32\" }, { \"name\": \"groupHigh\", \"type\": \"u32\" }], \"result\": \"i32\" },\n    { \"name\": \"esbt_doc_can_undo\", \"parameters\": [{ \"name\": \"handle\", \"type\": \"u32\" }], \"result\": \"i32\" },\n    { \"name\": \"esbt_doc_can_redo\", \"parameters\": [{ \"name\": \"handle\", \"type\": \"u32\" }], \"result\": \"i32\" },\n    { \"name\": \"esbt_doc_undo\", \"parameters\": [{ \"name\": \"handle\", \"type\": \"u32\" }], \"result\": \"i32\" },\n    { \"name\": \"esbt_doc_redo\", \"parameters\": [{ \"name\": \"handle\", \"type\": \"u32\" }], \"result\": \"i32\" },\n    { \"name\": \"esbt_doc_retained_operations\", \"parameters\": [{ \"name\": \"handle\", \"type\": \"u32\" }], \"result\": \"i32\" },\n    { \"name\": \"esbt_doc_history_floor\", \"parameters\": [{ \"name\": \"handle\", \"type\": \"u32\" }], \"result\": \"i32\" },\n    { \"name\": \"esbt_doc_current_dmax\", \"parameters\": [{ \"name\": \"handle\", \"type\": \"u32\" }], \"result\": \"i32\" },\n    { \"name\": \"esbt_doc_prune_history\", \"parameters\": [{ \"name\": \"handle\", \"type\": \"u32\" }, { \"name\": \"versionPointer\", \"type\": \"pointer\" }, { \"name\": \"versionLength\", \"type\": \"u32\" }], \"result\": \"i32\" }\n  ]\n}\n";
export const ESBT_ABI_FUNCTIONS = Object.freeze([
  {
    "name": "esbt_malloc",
    "arity": 1
  },
  {
    "name": "esbt_free",
    "arity": 2
  },
  {
    "name": "esbt_last_len",
    "arity": 0
  },
  {
    "name": "esbt_last_ptr",
    "arity": 0
  },
  {
    "name": "esbt_doc_last_error_code",
    "arity": 0
  },
  {
    "name": "esbt_doc_create",
    "arity": 4
  },
  {
    "name": "esbt_doc_create_configured",
    "arity": 6
  },
  {
    "name": "esbt_doc_destroy",
    "arity": 1
  },
  {
    "name": "esbt_doc_len",
    "arity": 1
  },
  {
    "name": "esbt_doc_hash",
    "arity": 1
  },
  {
    "name": "esbt_doc_pending",
    "arity": 1
  },
  {
    "name": "esbt_doc_text_utf16",
    "arity": 1
  },
  {
    "name": "esbt_doc_visible_edits",
    "arity": 1
  },
  {
    "name": "esbt_doc_site",
    "arity": 1
  },
  {
    "name": "esbt_doc_version",
    "arity": 1
  },
  {
    "name": "esbt_doc_begin",
    "arity": 4
  },
  {
    "name": "esbt_doc_commit",
    "arity": 1
  },
  {
    "name": "esbt_doc_abort",
    "arity": 1
  },
  {
    "name": "esbt_doc_insert_utf16",
    "arity": 7
  },
  {
    "name": "esbt_doc_delete",
    "arity": 6
  },
  {
    "name": "esbt_doc_replace_utf16",
    "arity": 8
  },
  {
    "name": "esbt_doc_apply",
    "arity": 3
  },
  {
    "name": "esbt_doc_export_update",
    "arity": 3
  },
  {
    "name": "esbt_doc_export_full_snapshot",
    "arity": 1
  },
  {
    "name": "esbt_doc_export_compact_snapshot",
    "arity": 1
  },
  {
    "name": "esbt_doc_apply_snapshot",
    "arity": 3
  },
  {
    "name": "esbt_doc_anchor",
    "arity": 3
  },
  {
    "name": "esbt_doc_resolve_anchor",
    "arity": 3
  },
  {
    "name": "esbt_doc_insert_at_anchor_utf16",
    "arity": 8
  },
  {
    "name": "esbt_doc_can_undo",
    "arity": 1
  },
  {
    "name": "esbt_doc_can_redo",
    "arity": 1
  },
  {
    "name": "esbt_doc_undo",
    "arity": 1
  },
  {
    "name": "esbt_doc_redo",
    "arity": 1
  },
  {
    "name": "esbt_doc_retained_operations",
    "arity": 1
  },
  {
    "name": "esbt_doc_history_floor",
    "arity": 1
  },
  {
    "name": "esbt_doc_current_dmax",
    "arity": 1
  },
  {
    "name": "esbt_doc_prune_history",
    "arity": 3
  }
]);

export interface EsbtExports {
  memory: WebAssembly.Memory;
  esbt_malloc(length: number): number;
  esbt_free(pointer: number, length: number): void;
  esbt_last_len(): number;
  esbt_last_ptr(): number;
  esbt_doc_last_error_code(): number;
  esbt_doc_create(site0: number, site1: number, site2: number, site3: number): number;
  esbt_doc_create_configured(site0: number, site1: number, site2: number, site3: number, configPointer: number, configLength: number): number;
  esbt_doc_destroy(handle: number): number;
  esbt_doc_len(handle: number): number;
  esbt_doc_hash(handle: number): number;
  esbt_doc_pending(handle: number): number;
  esbt_doc_text_utf16(handle: number): number;
  esbt_doc_visible_edits(handle: number): number;
  esbt_doc_site(handle: number): number;
  esbt_doc_version(handle: number): number;
  esbt_doc_begin(handle: number, hasUndoGroup: number, groupLow: number, groupHigh: number): number;
  esbt_doc_commit(handle: number): number;
  esbt_doc_abort(handle: number): number;
  esbt_doc_insert_utf16(handle: number, index: number, pointer: number, byteLength: number, hasUndoGroup: number, groupLow: number, groupHigh: number): number;
  esbt_doc_delete(handle: number, index: number, length: number, hasUndoGroup: number, groupLow: number, groupHigh: number): number;
  esbt_doc_replace_utf16(handle: number, from: number, to: number, pointer: number, byteLength: number, hasUndoGroup: number, groupLow: number, groupHigh: number): number;
  esbt_doc_apply(handle: number, pointer: number, length: number): number;
  esbt_doc_export_update(handle: number, versionPointer: number, versionLength: number): number;
  esbt_doc_export_full_snapshot(handle: number): number;
  esbt_doc_export_compact_snapshot(handle: number): number;
  esbt_doc_apply_snapshot(handle: number, pointer: number, length: number): number;
  esbt_doc_anchor(handle: number, index: number, affinity: number): number;
  esbt_doc_resolve_anchor(handle: number, pointer: number, length: number): number;
  esbt_doc_insert_at_anchor_utf16(handle: number, anchorPointer: number, anchorLength: number, textPointer: number, textByteLength: number, hasUndoGroup: number, groupLow: number, groupHigh: number): number;
  esbt_doc_can_undo(handle: number): number;
  esbt_doc_can_redo(handle: number): number;
  esbt_doc_undo(handle: number): number;
  esbt_doc_redo(handle: number): number;
  esbt_doc_retained_operations(handle: number): number;
  esbt_doc_history_floor(handle: number): number;
  esbt_doc_current_dmax(handle: number): number;
  esbt_doc_prune_history(handle: number, versionPointer: number, versionLength: number): number;
}

export function checkedEsbtExports(module: WebAssembly.Module, rawExports: WebAssembly.Exports): EsbtExports {
  const fail = (detail: string): never => {
    throw new TypeError(`esbt: Wasm ABI mismatch (${detail})`);
  };
  const sections = WebAssembly.Module.customSections(module, ESBT_ABI_CUSTOM_SECTION);
  if (sections.length !== 1) fail('missing embedded ABI definition');
  let embedded;
  try {
    embedded = new TextDecoder('utf-8', { fatal: true }).decode(sections[0]);
  } catch {
    fail('embedded ABI definition is not UTF-8');
  }
  if (embedded !== ESBT_ABI_DEFINITION) fail('binding and artifact definitions differ');

  const imports = WebAssembly.Module.imports(module);
  if (imports.length !== 0) fail('artifact unexpectedly imports host capabilities');
  const descriptors = new Map(
    WebAssembly.Module.exports(module).map((descriptor) => [descriptor.name, descriptor.kind]),
  );
  if (descriptors.get("memory") !== 'memory') fail('memory export is absent');
  if (!(rawExports["memory"] instanceof WebAssembly.Memory)) {
    fail('memory export has the wrong runtime type');
  }

  const declared = new Set(ESBT_ABI_FUNCTIONS.map((fn) => fn.name));
  for (const descriptor of WebAssembly.Module.exports(module)) {
    if (descriptor.name.startsWith('esbt_') && !declared.has(descriptor.name)) {
      fail(`undeclared engine export ${descriptor.name}`);
    }
  }
  for (const expected of ESBT_ABI_FUNCTIONS) {
    if (descriptors.get(expected.name) !== 'function') fail(`missing function ${expected.name}`);
    const value = rawExports[expected.name];
    if (typeof value !== 'function' || value.length !== expected.arity) {
      fail(`wrong arity for ${expected.name}`);
    }
  }
  return rawExports as unknown as EsbtExports;
}
