import { useMemo, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import { AI_MODES, composeLocally, type AiMode } from '../../lib/ai-compose';
import { insertAiResult } from '../../editor/actions';
import { Glyph, type GlyphName } from '../glyphs/Glyph';
import { SurfaceMaterial } from '../SurfaceMaterial';
import '../../styles/chrome.css';

const MODE_COPY: Record<AiMode, { label: string; glyph: GlyphName; detail: string }> = {
  compose: { label: 'Compose', glyph: 'compose', detail: 'Start a structured draft' },
  rewrite: { label: 'Rewrite', glyph: 'rewrite', detail: 'Tidy the selection' },
  shorten: { label: 'Shorten', glyph: 'summarize', detail: 'Keep the opening thought' },
  expand: { label: 'Expand', glyph: 'expand', detail: 'Turn a line into a stub' },
  summarize: { label: 'Summarize', glyph: 'summarize', detail: 'Headings and first sentences' },
  outline: { label: 'Outline', glyph: 'outline', detail: 'Number the structure' },
  continue: { label: 'Continue', glyph: 'continue', detail: 'Write the next move' },
};

interface AiSheetProps {
  open: boolean;
  embedded?: boolean;
  documentTitle?: string;
  getView: () => EditorView | null;
  onClose: () => void;
  onNotify?: (title: string, detail?: string, tone?: 'neutral' | 'success' | 'danger') => void;
}

export function AiSheet({
  open,
  embedded,
  documentTitle,
  getView,
  onClose,
  onNotify,
}: AiSheetProps) {
  const [mode, setMode] = useState<AiMode>('compose');
  const [instruction, setInstruction] = useState('');
  const preview = useMemo(() => {
    const view = getView();
    const range = view?.state.selection.main;
    const selected = range && !range.empty ? view.state.sliceDoc(range.from, range.to) : '';
    const source = selected || view?.state.doc.toString() || '';
    return composeLocally({ mode, source, instruction, title: documentTitle });
  }, [documentTitle, getView, instruction, mode, open]);

  if (!open) return null;

  return (
    <section className={`ai-sheet surface-material-host${embedded ? ' embedded' : ''}`} aria-label="AI composition">
      <SurfaceMaterial variant="floating" intensity={1.04} />
      <header className="ai-sheet-head">
        <div>
          <span>On-device composition</span>
          <h2>AI ribbon</h2>
        </div>
        {!embedded && (
          <button type="button" className="icon-button" aria-label="Close AI" onClick={onClose}>
            <Glyph name="clear" size={16} interactive={false} />
          </button>
        )}
      </header>
      <p className="ai-honest">
        These actions reshape the current Markdown locally. A model can replace this later
        without changing the ribbon.
      </p>
      <div className="ai-modes" role="tablist" aria-label="AI actions">
        {AI_MODES.map((id) => (
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
      <label className="ai-instruction">
        Direction
        <textarea
          value={instruction}
          placeholder={MODE_COPY[mode].detail}
          rows={2}
          onChange={(event) => setInstruction(event.target.value)}
        />
      </label>
      <pre className="ai-preview">{preview.markdown}</pre>
      <div className="ai-actions">
        <button
          type="button"
          className="button primary"
          onClick={() => {
            const view = getView();
            if (!view) return;
            insertAiResult(view, preview.markdown, preview.replace);
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
