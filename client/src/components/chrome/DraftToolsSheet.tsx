import { useMemo, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import { DRAFT_TOOL_MODES, applyDraftTool, type DraftToolMode } from '../../lib/draft-tools';
import { insertDraftToolResult } from '../../editor/actions';
import { Glyph, type GlyphName } from '../glyphs/Glyph';
import { SurfaceMaterial } from '../ui/SurfaceMaterial';
import '../../styles/chrome.css';

const MODE_COPY: Record<DraftToolMode, { label: string; glyph: GlyphName; detail: string }> = {
  compose: { label: 'Skeleton', glyph: 'compose', detail: 'Start a structured blank draft' },
  rewrite: { label: 'Rewrite', glyph: 'rewrite', detail: 'Tidy the selection' },
  shorten: { label: 'Shorten', glyph: 'summarize', detail: 'Keep the opening thought' },
  expand: { label: 'Expand', glyph: 'expand', detail: 'Turn a line into a stub' },
  summarize: { label: 'Summarize', glyph: 'summarize', detail: 'Headings and first sentences' },
  outline: { label: 'Outline', glyph: 'outline', detail: 'Number the structure' },
  continue: { label: 'Continue', glyph: 'continue', detail: 'Write the next move' },
};

interface DraftToolsSheetProps {
  open: boolean;
  embedded?: boolean;
  documentTitle?: string;
  getView: () => EditorView | null;
  onClose: () => void;
  onNotify?: (title: string, detail?: string, tone?: 'neutral' | 'success' | 'danger') => void;
}

export function DraftToolsSheet({
  open,
  embedded,
  documentTitle,
  getView,
  onClose,
  onNotify,
}: DraftToolsSheetProps) {
  const [mode, setMode] = useState<DraftToolMode>('compose');
  const [instruction, setInstruction] = useState('');
  const preview = useMemo(() => {
    const view = getView();
    const range = view?.state.selection.main;
    const selected = range && !range.empty ? view.state.sliceDoc(range.from, range.to) : '';
    const source = selected || view?.state.doc.toString() || '';
    return applyDraftTool({ mode, source, instruction, title: documentTitle });
  }, [documentTitle, getView, instruction, mode, open]);

  if (!open) return null;

  return (
    <section className={`draft-tools-sheet surface-material-host${embedded ? ' embedded' : ''}`} aria-label="Local draft tools">
      <SurfaceMaterial variant="floating" />
      <header className="draft-tools-head">
        <div>
          <span>Deterministic and local</span>
          <h2>Draft tools</h2>
        </div>
        {!embedded && (
          <button type="button" className="icon-button" aria-label="Close draft tools" onClick={onClose}>
            <Glyph name="clear" size={16} interactive={false} />
          </button>
        )}
      </header>
      <p className="draft-tools-honest">
        Inspectable text rules reshape the current Markdown. No model or network service is called.
      </p>
      <div className="draft-tools-modes" role="tablist" aria-label="Draft transformations">
        {DRAFT_TOOL_MODES.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={mode === id}
            className={mode === id ? 'active' : undefined}
            onClick={() => setMode(id)}
          >
            <Glyph name={MODE_COPY[id].glyph} size={20} />
            <span>{MODE_COPY[id].label}</span>
          </button>
        ))}
      </div>
      <label className="draft-tools-instruction">
        Direction
        <textarea
          value={instruction}
          placeholder={MODE_COPY[mode].detail}
          rows={2}
          onChange={(event) => setInstruction(event.target.value)}
        />
      </label>
      <pre className="draft-tools-preview">{preview.markdown}</pre>
      <div className="draft-tools-actions">
        <button
          type="button"
          className="button primary"
          onClick={() => {
            const view = getView();
            if (!view) return;
            insertDraftToolResult(view, preview.markdown, preview.replace);
            view.focus();
            onNotify?.('Composition applied', preview.note, 'success');
            if (!embedded) onClose();
          }}
        >
          <Glyph name="sparkles" size={16} interactive={false} />
          Apply to page
        </button>
        <span>{preview.note}</span>
      </div>
    </section>
  );
}
