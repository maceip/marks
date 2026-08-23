import { EditorView } from '@codemirror/view';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import type { CollabSession } from '../../collab/types.ts';
import { useCommandCenter } from '../../commands/context.tsx';
import type { ProjectedCommand } from '../../commands/types.ts';
import { documentRepository } from '../../data/documents.ts';
import { reviewRepository } from '../../data/review.ts';
import { lineDiff } from '../../intelligence/operations.ts';
import type { SourceRange } from '../../intelligence/types.ts';
import { useDocumentIntelligence } from '../../intelligence/useDocumentIntelligence.ts';
import { WILD_SURFACES } from '../../lib/wild-surfaces.ts';
import type { Shell } from '../../lib/posture.ts';
import {
  applyCounterfactual,
  createCounterfactual,
  deriveIntentions,
  predictConsequences,
} from '../../wild/model.ts';
import {
  deleteCounterfactual,
  listCausalReceipts,
  listContextSignals,
  listCounterfactuals,
  listIntents,
  putContextSignal,
  putCounterfactual,
  putIntent,
  subscribeWildStore,
} from '../../wild/store.ts';
import type {
  CausalReceipt,
  ConsequenceLane,
  ContextSignal,
  CounterfactualPatch,
  IntentCandidate,
  StoredIntent,
  WildCapability,
} from '../../wild/types.ts';
import { Glyph } from '../glyphs/Glyph.tsx';
import type { ViewMode } from '../shell/TopBar.tsx';
import { Icon, icons } from '../ui/Icon.tsx';
import { SurfaceMaterial } from '../ui/SurfaceMaterial.tsx';
import '../../styles/wild.css';

type Notify = (title: string, detail?: string, tone?: 'neutral' | 'success' | 'danger') => void;

export interface WildStudioProps {
  capability: WildCapability;
  documentId: string;
  documentTitle: string;
  session: CollabSession;
  userName: string;
  shell: Shell;
  mode: ViewMode;
  selection: { from: number; to: number };
  getView: () => EditorView | null;
  onModeChange: (mode: ViewMode) => void;
  onSelect: (capability: WildCapability) => void;
  onOpenDocument: (id: string) => void;
  onClose: () => void;
  onNotify: Notify;
}

interface WildData {
  intents: StoredIntent[];
  causal: CausalReceipt[];
  context: ContextSignal[];
  counterfactuals: CounterfactualPatch[];
}

const EMPTY_DATA: WildData = { intents: [], causal: [], context: [], counterfactuals: [] };
const TTL_OPTIONS = [
  { label: '1 day', value: 24 * 60 * 60 * 1_000 },
  { label: '1 week', value: 7 * 24 * 60 * 60 * 1_000 },
  { label: '1 month', value: 30 * 24 * 60 * 60 * 1_000 },
  { label: '1 quarter', value: 90 * 24 * 60 * 60 * 1_000 },
] as const;

function useWildData(documentId: string): WildData {
  const [data, setData] = useState<WildData>(EMPTY_DATA);
  useEffect(() => {
    let active = true;
    let loadVersion = 0;
    const load = () => {
      const version = ++loadVersion;
      void Promise.all([
        listIntents(documentId),
        listCausalReceipts(documentId),
        listContextSignals(documentId),
        listCounterfactuals(documentId),
      ]).then(([intents, causal, context, counterfactuals]) => {
        if (active && version === loadVersion) setData({ intents, causal, context, counterfactuals });
      }).catch(() => {
        if (active && version === loadVersion) setData(EMPTY_DATA);
      });
    };
    load();
    const off = subscribeWildStore(documentId, load);
    return () => { active = false; off(); };
  }, [documentId]);
  return data;
}

function displayTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(value);
}

function relativeAge(value: number): string {
  const elapsed = Math.max(0, Date.now() - value);
  if (elapsed < 60_000) return 'just now';
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 24 * 60 * 60_000) return `${Math.floor(elapsed / (60 * 60_000))}h ago`;
  return `${Math.floor(elapsed / (24 * 60 * 60_000))}d ago`;
}

function sourceRange(text: string, from: number, to: number): SourceRange {
  const before = text.slice(0, from);
  const lineFrom = before.lastIndexOf('\n') + 1;
  return { from, to, line: before.split('\n').length, column: from - lineFrom + 1 };
}

function locateSignal(text: string, signal: ContextSignal): SourceRange | null {
  if (text.slice(signal.range.from, signal.range.to) === signal.expected) return signal.range;
  if (!signal.expected) return null;
  const first = text.indexOf(signal.expected);
  if (first < 0 || text.indexOf(signal.expected, first + signal.expected.length) >= 0) return null;
  return sourceRange(text, first, first + signal.expected.length);
}

function downloadJson(value: unknown, filename: string): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function LaneStrip({ lanes, detailed = false }: { lanes: readonly ConsequenceLane[]; detailed?: boolean }) {
  return (
    <div className={`consequence-lanes${detailed ? ' is-detailed' : ''}`}>
      {lanes.map((lane) => (
        <article key={lane.id} data-lane={lane.id} data-impact={lane.impact}>
          <span>{lane.label}</span>
          <strong>{lane.impact}</strong>
          {detailed && <p>{lane.detail}</p>}
        </article>
      ))}
    </div>
  );
}

function IntentSurface({
  analysis,
  stored,
  commands,
  receipts,
  documentId,
  onRun,
  onFocus,
  onNotify,
}: {
  analysis: ReturnType<typeof useDocumentIntelligence>['analysis'];
  stored: readonly StoredIntent[];
  commands: readonly ProjectedCommand[];
  receipts: ReturnType<typeof useCommandCenter>['receipts'];
  documentId: string;
  onRun: (commandId: string) => void;
  onFocus: (commandIds: readonly string[]) => void;
  onNotify: Notify;
}) {
  const [label, setLabel] = useState('');
  const [commandId, setCommandId] = useState('review.document-health');
  const availableCommands = commands.filter((command) => command.enabled);
  const declaredCommandId = availableCommands.some((command) => command.id === commandId)
    ? commandId
    : availableCommands[0]?.id ?? '';
  const inferred = analysis ? deriveIntentions(analysis, receipts) : [];
  const persistedByCandidate = new Map(stored.map((item) => [item.id, item]));
  const candidates = inferred.filter((item) => {
    const state = persistedByCandidate.get(`intent:${documentId}:${item.id}`)?.state;
    return state !== 'dismissed' && state !== 'done';
  });
  const activeStored = stored.filter((item) => item.state === 'pinned');

  const saveCandidate = async (item: IntentCandidate, state: StoredIntent['state']) => {
    const now = Date.now();
    try {
      await putIntent({
        ...item,
        id: `intent:${documentId}:${item.id}`,
        documentId,
        state,
        createdAt: persistedByCandidate.get(`intent:${documentId}:${item.id}`)?.createdAt ?? now,
        updatedAt: now,
      });
    } catch (error) {
      onNotify('Intent not saved', error instanceof Error ? error.message : 'The horizon is unavailable.', 'danger');
    }
  };

  const declare = (event: FormEvent) => {
    event.preventDefault();
    const value = label.trim();
    if (!value) return;
    const now = Date.now();
    void putIntent({
      id: `intent:${documentId}:declared:${crypto.randomUUID()}`,
      documentId,
      label: value.slice(0, 160),
      detail: 'Declared by a person in this document’s intent horizon.',
      commandIds: declaredCommandId ? [declaredCommandId] : [],
      basis: 'declared',
      confidence: 1,
      urgency: 'now',
      state: 'pinned',
      createdAt: now,
      updatedAt: now,
    }).then(() => setLabel('')).catch((error) => {
      onNotify('Intent not saved', error instanceof Error ? error.message : 'The horizon is unavailable.', 'danger');
    });
  };

  const cards: Array<IntentCandidate & { persisted?: StoredIntent }> = [
    ...activeStored.map((item) => ({ ...item, persisted: item })),
    ...candidates.filter((candidate) => !activeStored.some((storedIntent) => storedIntent.id === `intent:${documentId}:${candidate.id}`)),
  ];

  return (
    <>
      <form className="wild-compose-row" onSubmit={declare}>
        <label>
          Declare an outcome
          <input value={label} maxLength={160} placeholder="Prepare this note for engineering review" onChange={(event) => setLabel(event.target.value)} />
        </label>
        <label>
          First visible move
          <select value={declaredCommandId} onChange={(event) => setCommandId(event.target.value)}>
            {availableCommands.map((command) => <option key={command.id} value={command.id}>{command.label}</option>)}
          </select>
        </label>
        <button type="submit" className="button primary">Pin intent</button>
      </form>
      <div className="intent-horizon" aria-label="Current and inferred intentions">
        <div className="horizon-axis" aria-hidden="true"><span>now</span><i /><span>next</span><i /><span>later</span></div>
        {cards.map((item) => (
          <article key={item.persisted?.id ?? item.id} data-urgency={item.urgency} data-basis={item.basis}>
            <header><span>{item.persisted ? item.basis : `${Math.round(item.confidence * 100)}% inferred`}</span><strong>{item.label}</strong></header>
            <p>{item.detail}</p>
            <div>
              {item.commandIds.length > 0 && <button type="button" className="button primary" onClick={() => onRun(item.commandIds[0])}>Run first move</button>}
              {item.commandIds.length > 0 && <button type="button" className="button" onClick={() => onFocus(item.commandIds)}>Show in ribbon</button>}
              {!item.persisted && <button type="button" className="button" onClick={() => void saveCandidate(item, 'pinned')}>Pin</button>}
              {item.persisted && <button type="button" className="button" onClick={() => void putIntent({ ...item.persisted!, state: 'done', updatedAt: Date.now() }).catch((error) => onNotify('Intent not updated', error instanceof Error ? error.message : 'The horizon is unavailable.', 'danger'))}>Done</button>}
              <button type="button" className="button quiet" onClick={() => item.persisted
                ? void putIntent({ ...item.persisted, state: 'dismissed', updatedAt: Date.now() }).catch((error) => onNotify('Intent not updated', error instanceof Error ? error.message : 'The horizon is unavailable.', 'danger'))
                : void saveCandidate(item, 'dismissed')}>Dismiss</button>
            </div>
          </article>
        ))}
        {cards.length === 0 && <p className="wild-empty">The horizon is clear. Declare an outcome, or keep writing until a concrete next move appears.</p>}
      </div>
    </>
  );
}

function CausalSurface({ receipts }: { receipts: readonly CausalReceipt[] }) {
  if (!receipts.length) return <p className="wild-empty">Run a ribbon or agent command. Its real path will appear here after the guarded runtime finishes.</p>;
  return (
    <div className="causal-ledger">
      {receipts.map((receipt) => (
        <article key={receipt.id} data-status={receipt.status}>
          <header>
            <span>{receipt.source} · {receipt.risk}</span>
            <strong>{receipt.commandLabel}</strong>
            <time dateTime={new Date(receipt.finishedAt).toISOString()}>{relativeAge(receipt.finishedAt)}</time>
          </header>
          <LaneStrip lanes={receipt.lanes} />
          <dl>
            <div><dt>Outcome</dt><dd>{receipt.status}</dd></div>
            <div><dt>Source</dt><dd>{receipt.beforeChars.toLocaleString()} → {receipt.afterChars.toLocaleString()} chars</dd></div>
            <div><dt>Digest</dt><dd><code>{receipt.beforeDigest.slice(0, 8)} → {receipt.afterDigest.slice(0, 8)}</code></dd></div>
            <div><dt>Delta</dt><dd>{receipt.sourceDelta ? `${receipt.sourceDelta.beforeChars} ↔ ${receipt.sourceDelta.afterChars} chars at ${receipt.sourceDelta.from}` : 'none'}</dd></div>
            <div><dt>Reversal</dt><dd>{receipt.counterfactualId ? 'captured on shelf' : 'not needed'}</dd></div>
          </dl>
          {(receipt.error || receipt.message) && <p>{receipt.error ?? receipt.message}</p>}
        </article>
      ))}
    </div>
  );
}

function ConsequenceSurface({ commands, onRun, onFocus }: {
  commands: readonly ProjectedCommand[];
  onRun: (commandId: string) => void;
  onFocus: (commandIds: readonly string[]) => void;
}) {
  const choices = commands.filter((command) => command.enabled);
  const [commandId, setCommandId] = useState(choices[0]?.id ?? 'review.document-health');
  const [staged, setStaged] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const command = choices.find((item) => item.id === commandId) ?? choices[0];
  const lanes = command ? predictConsequences(command) : [];
  const boundary = command?.risk === 'external' || command?.risk === 'destructive';
  useEffect(() => { setStaged(null); setArmed(false); }, [commandId]);
  if (!command) return <p className="wild-empty">No command is available in the current role and document mode.</p>;
  return (
    <div className="consequence-workbench">
      <label className="wild-field">Command to stage<select value={command.id} onChange={(event) => setCommandId(event.target.value)}>{choices.map((item) => <option key={item.id} value={item.id}>{item.label} · {item.category}</option>)}</select></label>
      <header><Glyph name={command.glyph} size={34} /><div><span>{command.category} / {command.group}</span><h3>{command.label}</h3><p>{command.description}</p></div></header>
      <LaneStrip lanes={lanes} detailed />
      {boundary && <label className="boundary-arm"><input type="checkbox" checked={armed} onChange={(event) => setArmed(event.target.checked)} /><span><strong>Arm outside boundary</strong>This command can open an external, sharing, download, print, or destructive surface.</span></label>}
      <div className="wild-actions">
        <button type="button" className="button" onClick={() => { setStaged(command.id); onFocus([command.id]); }}>Stage and show in ribbon</button>
        <button type="button" className="button primary" disabled={staged !== command.id || (boundary && !armed)} onClick={() => onRun(command.id)}>Run staged command</button>
      </div>
      <small className="wild-footnote">Staging predicts from the registered command contract. The guarded runtime rechecks role, mode, selection, and hydration when you run it.</small>
    </div>
  );
}

function HalfLifeSurface({
  signals,
  session,
  selection,
  editable,
  onReveal,
  onNotify,
}: {
  signals: readonly ContextSignal[];
  session: CollabSession;
  selection: { from: number; to: number };
  editable: boolean;
  onReveal: (range: SourceRange) => void;
  onNotify: Notify;
}) {
  const [label, setLabel] = useState('');
  const [ttlMs, setTtlMs] = useState<number>(7 * 24 * 60 * 60 * 1_000);
  const visible = signals.filter((signal) => signal.active && !signal.dismissed);
  const add = (event: FormEvent) => {
    event.preventDefault();
    const current = session.getText();
    const expected = current.slice(selection.from, selection.to);
    if (!expected) {
      onNotify('Select a claim first', 'Context half-life attaches to an exact source range.', 'neutral');
      return;
    }
    if (expected.length > 4_096) {
      onNotify('Selection is too large', 'Keep one explicit context signal under 4,096 characters.', 'neutral');
      return;
    }
    const now = Date.now();
    void putContextSignal({
      id: `context:${session.docId}:explicit:${crypto.randomUUID()}`,
      documentId: session.docId,
      kind: 'explicit',
      label: label.trim().slice(0, 160) || `Review “${expected.replace(/\s+/g, ' ').slice(0, 60)}”`,
      detail: 'A person explicitly marked this source as time-sensitive context.',
      expected,
      range: sourceRange(current, selection.from, selection.to),
      firstSeenAt: now,
      lastSeenAt: now,
      reviewedAt: now,
      ttlMs,
      active: true,
      dismissed: false,
    }).then(() => setLabel('')).catch((error) => onNotify('Signal not saved', error instanceof Error ? error.message : 'Context storage is unavailable.', 'danger'));
  };

  const reveal = (signal: ContextSignal) => {
    const range = locateSignal(session.getText(), signal);
    if (!range) {
      onNotify('Claim moved or changed', 'Marks could not find one unique safe occurrence of the recorded source.', 'danger');
      return;
    }
    onReveal(range);
    if (range.from !== signal.range.from) {
      void putContextSignal({ ...signal, range, lastSeenAt: Date.now() }).catch(() => undefined);
    }
  };

  const saveSignal = (signal: ContextSignal) => {
    void putContextSignal(signal).catch((error) => onNotify('Signal not updated', error instanceof Error ? error.message : 'Context storage is unavailable.', 'danger'));
  };

  return (
    <>
      <form className="wild-compose-row" onSubmit={add}>
        <label>Mark selected claim<input value={label} maxLength={160} placeholder="Recheck compatibility statement" onChange={(event) => setLabel(event.target.value)} /></label>
        <label>Review cadence<select value={ttlMs} onChange={(event) => setTtlMs(Number(event.target.value))}>{TTL_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <button type="submit" className="button primary" disabled={!editable}>Add signal</button>
      </form>
      <div className="half-life-list">
        {visible.map((signal) => {
          const base = signal.reviewedAt ?? signal.firstSeenAt;
          const elapsed = Math.max(0, Date.now() - base);
          const remaining = Math.max(0, signal.ttlMs - elapsed);
          const percent = Math.max(0, Math.min(100, (remaining / Math.max(1, signal.ttlMs)) * 100));
          return (
            <article key={signal.id} data-expired={remaining === 0 || undefined}>
              <header><span>{signal.kind.replace('-', ' ')}</span><strong>{signal.label}</strong><button type="button" onClick={() => reveal(signal)}>Line {signal.range.line}</button></header>
              <p>{signal.detail}</p>
              <div className="decay-meter"><i style={{ width: `${percent}%` }} /><span>{remaining === 0 ? 'review due' : `${Math.ceil(remaining / (24 * 60 * 60 * 1_000))}d context remaining`}</span></div>
              <div className="wild-actions">
                <select aria-label={`Cadence for ${signal.label}`} value={signal.ttlMs} onChange={(event) => saveSignal({ ...signal, ttlMs: Number(event.target.value) })}>{TTL_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
                <button type="button" className="button" onClick={() => saveSignal({ ...signal, reviewedAt: Date.now(), lastSeenAt: Date.now() })}>Reviewed now</button>
                <button type="button" className="button quiet" onClick={() => saveSignal({ ...signal, dismissed: true })}>Dismiss</button>
              </div>
            </article>
          );
        })}
        {!visible.length && <p className="wild-empty">No aging claims are active. Relative dates, version claims, deadlines, and external dependencies appear automatically.</p>}
      </div>
    </>
  );
}

function CounterfactualSurface({
  patches,
  documentTitle,
  session,
  selection,
  userName,
  onOpenDocument,
  onNotify,
}: {
  patches: readonly CounterfactualPatch[];
  documentTitle: string;
  session: CollabSession;
  selection: { from: number; to: number };
  userName: string;
  onOpenDocument: (id: string) => void;
  onNotify: Notify;
}) {
  const [label, setLabel] = useState('');
  const [note, setNote] = useState('');
  const [replacement, setReplacement] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [removeArmedId, setRemoveArmedId] = useState<string | null>(null);
  const visible = patches.filter((patch) => showArchived || !patch.archived);
  const firstVisibleId = visible[0]?.id ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(visible[0]?.id ?? null);
  const selected = patches.find((patch) => patch.id === selectedId) ?? visible[0] ?? null;
  const current = session.getText();
  let preview: { text: string; from: number; rebased: boolean } | null = null;
  let previewError: string | null = null;
  if (selected) {
    try { preview = applyCounterfactual(current, selected); }
    catch (error) { previewError = error instanceof Error ? error.message : 'This alternative is stale.'; }
  }
  const diff = selected && preview ? lineDiff(current, preview.text) : [];

  useEffect(() => {
    if (!selectedId && firstVisibleId) setSelectedId(firstVisibleId);
    else if (selectedId && !patches.some((patch) => patch.id === selectedId)) setSelectedId(firstVisibleId);
  }, [firstVisibleId, patches, selectedId]);

  useEffect(() => { setRemoveArmedId(null); }, [selected?.id]);

  const create = (event: FormEvent) => {
    event.preventDefault();
    void createCounterfactual(session.docId, label, note, session.getText(), selection.from, selection.to, replacement)
      .then(async (patch) => { await putCounterfactual(patch); setSelectedId(patch.id); setLabel(''); setNote(''); setReplacement(''); })
      .catch((error) => onNotify('Alternative not saved', error instanceof Error ? error.message : 'The patch could not be created.', 'danger'));
  };

  const apply = async () => {
    if (!selected) return;
    try {
      if (!session.capabilities().edit) throw new Error('Your current role cannot change this document.');
      if (!session.capabilities().saveVersion) throw new Error('Applying an alternative requires version-checkpoint authority. Branch it instead.');
      const next = applyCounterfactual(session.getText(), selected);
      await reviewRepository.createVersion(session.docId, userName, `Before alternative · ${selected.label}`, session.getText());
      session.setText(next.text);
      let durabilityError: unknown = null;
      try { await session.whenDurable(); } catch (error) { durabilityError = error; }
      try {
        await putCounterfactual({ ...selected, archived: true, appliedAt: Date.now(), updatedAt: Date.now() });
      } catch {
        // Source and checkpoint are authoritative even if local shelf metadata is full or unavailable.
      }
      if (durabilityError) {
        onNotify('Alternative applied locally', durabilityError instanceof Error ? durabilityError.message : 'Remote durability is still pending.', 'neutral');
      } else {
        onNotify('Alternative applied', `${next.rebased ? 'Re-anchored uniquely, then a' : 'A'} durable version checkpoint was created first.`, 'success');
      }
    } catch (error) {
      onNotify('Alternative not applied', error instanceof Error ? error.message : 'The source changed.', 'danger');
    }
  };

  const branch = async () => {
    if (!selected) return;
    try {
      const next = applyCounterfactual(session.getText(), selected);
      const created = await documentRepository.create({ title: `${documentTitle} — ${selected.label}`.slice(0, 240), content: next.text });
      onNotify('Alternative branched', 'The current document was not overwritten.', 'success');
      onOpenDocument(created.id);
    } catch (error) {
      onNotify('Branch not created', error instanceof Error ? error.message : 'The alternative is stale.', 'danger');
    }
  };

  const remove = async () => {
    if (!selected) return;
    if (removeArmedId !== selected.id) {
      setRemoveArmedId(selected.id);
      return;
    }
    try {
      await deleteCounterfactual(session.docId, selected.id);
      setRemoveArmedId(null);
      setSelectedId(null);
      onNotify('Alternative removed', 'The local patch was removed from this document’s shelf.', 'success');
    } catch (error) {
      onNotify('Alternative not removed', error instanceof Error ? error.message : 'Local possibility storage is unavailable.', 'danger');
    }
  };

  return (
    <div className="counterfactual-layout">
      <form className="counterfactual-compose" onSubmit={create}>
        <label>Alternative label<input value={label} maxLength={160} placeholder="Shorter opening" onChange={(event) => setLabel(event.target.value)} /></label>
        <label>Why keep it<textarea value={note} maxLength={1_000} placeholder="Useful if the audience already knows the background…" onChange={(event) => setNote(event.target.value)} /></label>
        <label>Replace current selection with<textarea value={replacement} maxLength={512 * 1024} placeholder="Alternative Markdown" onChange={(event) => setReplacement(event.target.value)} /></label>
        <button type="submit" className="button primary">Place on shelf</button>
      </form>
      <div className="counterfactual-shelf">
        <header><strong>Possibilities</strong><label><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />Archived</label></header>
        <div className="shelf-cards">
          {visible.map((patch) => <button key={patch.id} type="button" aria-selected={selected?.id === patch.id} onClick={() => setSelectedId(patch.id)}><span>{patch.source} · {relativeAge(patch.createdAt)}</span><strong>{patch.label}</strong><small>{patch.expected.length} → {patch.replacement.length} chars</small></button>)}
          {!visible.length && <p className="wild-empty">Select source and preserve an alternative, or run a source-changing command to capture its automatic reversal.</p>}
        </div>
      </div>
      {selected && (
        <section className="counterfactual-preview">
          <header><div><span>{selected.source} alternative · {displayTime(selected.createdAt)}</span><h3>{selected.label}</h3><p>{selected.note || 'No note was recorded.'}</p></div><span className={previewError ? 'stale' : 'safe'}>{previewError ? 'stale' : preview?.rebased ? 'uniquely re-anchored' : 'exact anchor'}</span></header>
          {previewError ? <p className="inline-notice danger">{previewError}</p> : <pre>{diff.map((chunk, index) => <span key={index} className={`diff-${chunk.kind}`}>{chunk.lines.slice(0, 120).map((line, lineIndex) => <span key={lineIndex}>{chunk.kind === 'added' ? '+ ' : chunk.kind === 'removed' ? '− ' : '  '}{line}{'\n'}</span>)}</span>)}</pre>}
          <div className="wild-actions">
            <button type="button" className="button primary" disabled={Boolean(previewError) || !session.capabilities().edit || !session.capabilities().saveVersion} onClick={() => void apply()}>Checkpoint and apply</button>
            <button type="button" className="button" disabled={Boolean(previewError)} onClick={() => void branch()}>Branch as document</button>
            <button type="button" className="button" onClick={() => downloadJson({ format: 'marks.counterfactual.v1', patch: selected }, `${selected.label.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'alternative'}.marks-alternative.json`)}>Export patch</button>
            <button type="button" className="button quiet" onClick={() => void putCounterfactual({ ...selected, archived: !selected.archived, updatedAt: Date.now() }).catch((error) => onNotify('Shelf not updated', error instanceof Error ? error.message : 'Local possibility storage is unavailable.', 'danger'))}>{selected.archived ? 'Restore' : 'Archive'}</button>
            <button type="button" className="button quiet" data-remove-armed={removeArmedId === selected.id || undefined} onClick={() => void remove()}>{removeArmedId === selected.id ? 'Confirm remove' : 'Remove local copy'}</button>
          </div>
        </section>
      )}
    </div>
  );
}

export function WildStudio(props: WildStudioProps) {
  const center = useCommandCenter();
  const { analysis, analyzing, error } = useDocumentIntelligence(props.session);
  const data = useWildData(props.documentId);
  const closeRef = useRef<HTMLButtonElement>(null);
  const closeHandlerRef = useRef(props.onClose);
  const descriptor = WILD_SURFACES.find((item) => item.capability === props.capability)!;
  const commands = useMemo(() => center.commands('palette'), [center]);

  useEffect(() => { closeHandlerRef.current = props.onClose; }, [props.onClose]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') closeHandlerRef.current(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); previous?.focus(); };
  }, []);

  const reveal = useCallback((range: SourceRange) => {
    if (props.mode === 'preview') props.onModeChange('edit');
    window.setTimeout(() => {
      const view = props.getView();
      if (!view) return;
      view.dispatch({ selection: { anchor: range.from, head: range.to }, effects: EditorView.scrollIntoView(range.from, { y: 'center' }) });
      view.focus();
    }, props.mode === 'preview' ? 80 : 0);
  }, [props.getView, props.mode, props.onModeChange]);

  const run = useCallback((commandId: string) => {
    center.focusCommands([commandId], 8_000);
    void center.invoke(commandId).then((receipt) => {
      if (receipt.status === 'succeeded') props.onNotify('Command completed', receipt.message, 'success');
    });
  }, [center, props.onNotify]);

  let content;
  if (props.capability === 'intent') content = <IntentSurface analysis={analysis} stored={data.intents} commands={commands} receipts={center.receipts} documentId={props.documentId} onRun={run} onFocus={center.focusCommands} onNotify={props.onNotify} />;
  else if (props.capability === 'causal') content = <CausalSurface receipts={data.causal} />;
  else if (props.capability === 'consequences') content = <ConsequenceSurface commands={commands} onRun={run} onFocus={center.focusCommands} />;
  else if (props.capability === 'half-life') content = <HalfLifeSurface signals={data.context} session={props.session} selection={props.getView()?.state.selection.main ?? props.selection} editable={props.session.capabilities().edit} onReveal={reveal} onNotify={props.onNotify} />;
  else content = <CounterfactualSurface patches={data.counterfactuals} documentTitle={props.documentTitle} session={props.session} selection={props.getView()?.state.selection.main ?? props.selection} userName={props.userName} onOpenDocument={props.onOpenDocument} onNotify={props.onNotify} />;

  return (
    <aside className="wild-studio surface-material-host" data-shell={props.shell} data-wild-capability={props.capability} aria-label={descriptor.label} aria-busy={analyzing && props.capability === 'intent'}>
      <SurfaceMaterial variant="panel" intensity={0.98} />
      <header className="wild-head">
        <div><span>Possibility layer {analyzing && props.capability === 'intent' ? '· reading signals' : '· browser local'}</span><h2>{descriptor.label}</h2><p>{descriptor.description}</p></div>
        <button ref={closeRef} type="button" className="icon-button" aria-label="Close possibility layer" onClick={props.onClose}><Icon path={icons.close} /></button>
      </header>
      <nav className="wild-nav" aria-label="Possibility tools">{WILD_SURFACES.map((item) => <button key={item.capability} type="button" data-wild-nav={item.capability} aria-current={item.capability === props.capability ? 'page' : undefined} onClick={() => props.onSelect(item.capability)}>{item.shortLabel}</button>)}</nav>
      <div className="wild-body">{error && props.capability === 'intent' && <p className="inline-notice danger">{error}</p>}{content}</div>
    </aside>
  );
}
