import { EditorView } from '@codemirror/view';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { readClipboardMarkdown } from '../../browser/index.ts';
import type {
  CollabSession,
  ConnectionStatus,
  Peer,
} from '../../collab/types.ts';
import { listLocalAssets } from '../../data/assets.ts';
import { documentRepository } from '../../data/documents.ts';
import { reviewRepository, type DocumentVersion } from '../../data/review.ts';
import { readLocalDocumentText } from '../../demo/workspace.ts';
import { analyzeDocument, applySourceFix, findingCounts } from '../../intelligence/analyze.ts';
import { updateFrontMatter, type FrontMatterPatch } from '../../intelligence/frontmatter.ts';
import {
  crossDocumentBlock,
  extractHeadingSection,
  insertCitationFootnote,
  lineDiff,
  moveHeadingSection,
  normalizeDoi,
  pasteWithIntent,
  renameHeading,
  shiftHeadingDepth,
} from '../../intelligence/operations.ts';
import type {
  DocumentIntelligence,
  IntelligenceFinding,
  IntelligenceHeading,
  PracticalCapability,
  SourceRange,
} from '../../intelligence/types.ts';
import { useDocumentIntelligence } from '../../intelligence/useDocumentIntelligence.ts';
import { createMarkdownIt } from '../../markdown/md.ts';
import { formatBytes } from '../../lib/format.ts';
import type { DocumentAssetDto, DocumentMeta, ExternalLinkCheckDto } from '../../lib/api.ts';
import { loadServiceApi } from '../../lib/service-api.ts';
import { UI_DATA_MODE } from '../../lib/product.ts';
import { PRACTICAL_SURFACES } from '../../lib/practical-surfaces.ts';
import type { Shell } from '../../lib/posture.ts';
import type { ViewMode } from '../shell/TopBar.tsx';
import { Glyph } from '../glyphs/Glyph.tsx';
import { Icon, icons } from '../ui/Icon.tsx';
import { SurfaceMaterial } from '../ui/SurfaceMaterial.tsx';
import '../../styles/practical.css';

type Notify = (title: string, detail?: string, tone?: 'neutral' | 'success' | 'danger') => void;

export interface PracticalInspectorProps {
  capability: PracticalCapability;
  documentId: string;
  documentTitle: string;
  session: CollabSession;
  documents: readonly DocumentMeta[];
  userName: string;
  status: ConnectionStatus;
  peers: readonly Peer[];
  shell: Shell;
  mode: ViewMode;
  selection: { from: number; to: number };
  getView: () => EditorView | null;
  onModeChange: (mode: ViewMode) => void;
  onSelect: (capability: PracticalCapability) => void;
  onOpenDocument: (id: string) => void;
  onClose: () => void;
  onNotify: Notify;
}

function capabilityFindings(analysis: DocumentIntelligence, capability: PracticalCapability): IntelligenceFinding[] {
  if (capability === 'health') return analysis.findings.filter((finding) => finding.severity !== 'info');
  return analysis.findings.filter((finding) => finding.capability === capability);
}

function downloadText(text: string, filename: string, type = 'text/plain;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function exportStem(title: string): string {
  return title.normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'marks-document';
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]!);
}

function Metric({ label, value, detail }: { label: string; value: string | number; detail?: string }) {
  return (
    <div className="practical-metric">
      <strong>{value}</strong>
      <span>{label}</span>
      {detail && <small>{detail}</small>}
    </div>
  );
}

function Empty({ children }: { children: string }) {
  return <p className="practical-empty">{children}</p>;
}

function FindingList({
  findings,
  editable,
  onReveal,
  onFix,
}: {
  findings: readonly IntelligenceFinding[];
  editable: boolean;
  onReveal: (range: SourceRange) => void;
  onFix: (finding: IntelligenceFinding) => void;
}) {
  if (findings.length === 0) return <Empty>No findings in this view.</Empty>;
  return (
    <div className="finding-list">
      {findings.map((finding) => (
        <article key={finding.id} className={`finding-card finding-${finding.severity}`}>
          <header>
            <span className="finding-severity">{finding.severity}</span>
            <strong>{finding.title}</strong>
            {finding.range && <button type="button" onClick={() => onReveal(finding.range!)}>Line {finding.range.line}</button>}
          </header>
          <p>{finding.detail}</p>
          {finding.fix && (
            <button type="button" className="button" disabled={!editable} onClick={() => onFix(finding)}>
              {finding.fix.label}
            </button>
          )}
        </article>
      ))}
    </div>
  );
}

function HealthSurface({ analysis, findings, ...findingProps }: {
  analysis: DocumentIntelligence;
  findings: readonly IntelligenceFinding[];
  editable: boolean;
  onReveal: (range: SourceRange) => void;
  onFix: (finding: IntelligenceFinding) => void;
}) {
  const counts = findingCounts(analysis.findings);
  return (
    <>
      <div className="practical-score-row">
        <div className={`health-orbit health-${analysis.healthScore >= 85 ? 'good' : analysis.healthScore >= 60 ? 'mixed' : 'poor'}`}>
          <strong>{analysis.healthScore}</strong><span>/ 100</span>
        </div>
        <div className="practical-metrics">
          <Metric label="errors" value={counts.error} />
          <Metric label="warnings" value={counts.warning} />
          <Metric label="suggestions" value={counts.suggestion} />
          <Metric label="reading" value={`${Math.max(1, Math.ceil(analysis.reader.readingMinutes))} min`} />
        </div>
      </div>
      <p className="practical-explainer">Health is a triage score, not a grade. It falls only for concrete findings in this exact source revision.</p>
      <FindingList findings={findings} {...findingProps} />
    </>
  );
}

function FindingSurface({
  analysis,
  capability,
  findings,
  editable,
  onReveal,
  onFix,
}: {
  analysis: DocumentIntelligence;
  capability: PracticalCapability;
  findings: readonly IntelligenceFinding[];
  editable: boolean;
  onReveal: (range: SourceRange) => void;
  onFix: (finding: IntelligenceFinding) => void;
}) {
  const metrics = capability === 'render'
    ? [
        ['source lines', analysis.stats.lines],
        ['headings', analysis.stats.headings],
        ['references', analysis.stats.links],
      ] as const
    : capability === 'accessibility'
      ? [
          ['images', analysis.stats.images],
          ['headings', analysis.stats.headings],
          ['links', analysis.stats.links],
        ] as const
      : [
          ['external links', analysis.links.filter((link) => link.kind === 'external').length],
          ['sensitive findings', findings.length],
          ['privacy mode', analysis.frontMatter.known.privacyMode],
        ] as const;
  return (
    <>
      <div className="practical-metrics">{metrics.map(([label, value]) => <Metric key={label} label={label} value={value} />)}</div>
      {capability === 'privacy' && (
        <div className="exposure-map">
          <span><i className="exposure-local" />Markdown analysis stays in this browser worker</span>
          <span><i className="exposure-explicit" />External link and citation lookups run only when pressed</span>
          <span><i className="exposure-agent" />Hosted agent receives pill prompts and command schemas, never document source</span>
        </div>
      )}
      <FindingList findings={findings} editable={editable} onReveal={onReveal} onFix={onFix} />
    </>
  );
}

function SchemaSurface({
  analysis,
  mode,
  onSave,
}: {
  analysis: DocumentIntelligence;
  mode: 'schema' | 'publish' | 'quality';
  onSave: (patch: FrontMatterPatch) => void;
}) {
  const known = analysis.frontMatter.known;
  const [title, setTitle] = useState(known.title);
  const [description, setDescription] = useState(known.description);
  const [audience, setAudience] = useState(known.audience);
  const [status, setStatus] = useState(known.status);
  const [tags, setTags] = useState(known.tags.join(', '));
  const [profile, setProfile] = useState(known.publishProfile);
  const [canonical, setCanonical] = useState(known.canonicalUrl);
  const [draft, setDraft] = useState(known.draft);
  const [privacy, setPrivacy] = useState(known.privacyMode);
  const [grade, setGrade] = useState(known.readingGrade);
  const [sentenceWords, setSentenceWords] = useState(known.maxSentenceWords);

  useEffect(() => {
    setTitle(known.title);
    setDescription(known.description);
    setAudience(known.audience);
    setStatus(known.status);
    setTags(known.tags.join(', '));
    setProfile(known.publishProfile);
    setCanonical(known.canonicalUrl);
    setDraft(known.draft);
    setPrivacy(known.privacyMode);
    setGrade(known.readingGrade);
    setSentenceWords(known.maxSentenceWords);
  }, [analysis.revision]);

  if (mode === 'publish') {
    return (
      <form className="practical-form" onSubmit={(event) => { event.preventDefault(); onSave({ publishProfile: profile, canonicalUrl: canonical || null, draft }); }}>
        <fieldset className="profile-choices">
          <legend>Output profile</legend>
          {(['web', 'print', 'readme', 'slides'] as const).map((item) => (
            <label key={item}><input type="radio" name="profile" value={item} checked={profile === item} onChange={() => setProfile(item)} /><strong>{item}</strong><span>{({ web: 'Responsive article', print: 'Paged handoff', readme: 'Repository-native', slides: 'Heading-led deck' })[item]}</span></label>
          ))}
        </fieldset>
        <label>Canonical HTTPS URL<input value={canonical} placeholder="https://example.com/document" onChange={(event) => setCanonical(event.target.value)} /></label>
        <label className="switch-row"><input type="checkbox" checked={draft} onChange={(event) => setDraft(event.target.checked)} />Keep this output marked as draft</label>
        <button className="button primary" type="submit">Save publish profile</button>
      </form>
    );
  }
  if (mode === 'quality') {
    return (
      <form className="practical-form" onSubmit={(event) => { event.preventDefault(); onSave({ audience: audience || null, readingGrade: grade, maxSentenceWords: sentenceWords }); }}>
        <div className="practical-metrics">
          <Metric label="estimated grade" value={analysis.reader.estimatedGrade.toFixed(1)} />
          <Metric label="target grade" value={grade} />
          <Metric label="words / sentence" value={analysis.reader.averageSentenceWords.toFixed(1)} />
          <Metric label="reading ease" value={analysis.reader.fleschReadingEase.toFixed(0)} />
        </div>
        <label>Intended audience<input value={audience} placeholder="New contributors, customers, executives…" onChange={(event) => setAudience(event.target.value)} /></label>
        <label>Maximum reading grade<input type="number" min={1} max={20} value={grade} onChange={(event) => setGrade(Number(event.target.value))} /></label>
        <label>Maximum words in one sentence<input type="number" min={8} max={80} value={sentenceWords} onChange={(event) => setSentenceWords(Number(event.target.value))} /></label>
        <button className="button primary" type="submit">Save quality contract</button>
      </form>
    );
  }
  return (
    <form className="practical-form" onSubmit={(event) => {
      event.preventDefault();
      onSave({
        title: title || null,
        description: description || null,
        audience: audience || null,
        status: status || null,
        tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean).slice(0, 64),
        privacyMode: privacy,
      });
    }}>
      {!analysis.frontMatter.exists && <p className="inline-notice">Saving creates a portable YAML header. Existing Markdown stays below it.</p>}
      <label>Portable title<input value={title} maxLength={240} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>Description<textarea value={description} maxLength={2_000} onChange={(event) => setDescription(event.target.value)} /></label>
      <label>Audience<input value={audience} maxLength={240} onChange={(event) => setAudience(event.target.value)} /></label>
      <label>Status<input value={status} maxLength={80} placeholder="draft, review, approved…" onChange={(event) => setStatus(event.target.value)} /></label>
      <label>Tags<input value={tags} placeholder="design, launch, decision" onChange={(event) => setTags(event.target.value)} /></label>
      <label>Privacy posture<select value={privacy} onChange={(event) => setPrivacy(event.target.value === 'strict' ? 'strict' : 'standard')}><option value="standard">Standard</option><option value="strict">Strict</option></select></label>
      <button className="button primary" type="submit">Save schema</button>
    </form>
  );
}

async function resolvedPublishMarkdown(analysis: DocumentIntelligence, source: string): Promise<string> {
  if (!analysis.blockReferences.length) return source;
  const { extractDocumentSection } = await import('../../markdown/cross-document.ts');
  let result = source;
  for (const reference of [...analysis.blockReferences].sort((left, right) => right.range.from - left.range.from)) {
    try {
      const linked = UI_DATA_MODE === 'service'
        ? await (await loadServiceApi()).downloadDocumentMarkdown(reference.documentId)
        : readLocalDocumentText(reference.documentId);
      const section = extractDocumentSection(linked, reference.heading ?? '');
      const replacement = section ?? `> Linked section “${reference.heading ?? reference.documentId}” is unavailable.`;
      result = `${result.slice(0, reference.range.from)}${replacement}${result.slice(reference.range.to)}`;
    } catch {
      const replacement = `> Linked document “${reference.label ?? reference.documentId}” is unavailable to this publisher.`;
      result = `${result.slice(0, reference.range.from)}${replacement}${result.slice(reference.range.to)}`;
    }
  }
  return result;
}

function htmlDocument(title: string, body: string, profile: string, canonical: string): string {
  let canonicalLink = '';
  if (canonical) {
    const url = new URL(canonical);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
      throw new Error('The canonical URL must be absolute HTTPS without credentials or a fragment.');
    }
    canonicalLink = `<link rel="canonical" href="${escapeHtml(url.toString())}">`;
  }
  const safeTitle = escapeHtml(title);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${canonicalLink}<title>${safeTitle}</title>
<style>
:root{color-scheme:light;font:16px/1.65 system-ui,sans-serif;color:#182231;background:#f4f1eb}body{margin:0}article{box-sizing:border-box;max-width:760px;min-height:100vh;margin:auto;padding:64px 48px;background:white}h1,h2,h3{line-height:1.2;letter-spacing:-.025em}img{max-width:100%;height:auto}pre{overflow:auto;padding:14px;border-radius:8px;background:#f2f4f7}blockquote{margin-left:0;padding-left:18px;border-left:3px solid #4779ca;color:#536170}table{width:100%;border-collapse:collapse}th,td{padding:8px;border:1px solid #d8dde4;text-align:left}.profile-slides article{max-width:1100px}.profile-slides h1,.profile-slides h2{break-before:page;margin-top:38vh}.profile-readme article{max-width:980px}@media print{body{background:white}article{max-width:none;padding:0;box-shadow:none}a{color:inherit}.profile-print h1,.profile-print h2{break-after:avoid}.profile-print pre,.profile-print blockquote{break-inside:avoid}}
</style></head><body class="profile-${profile}"><article>${body}</article></body></html>`;
}

function PublishActions({
  analysis,
  source,
  documentTitle,
  onModeChange,
  onNotify,
}: {
  analysis: DocumentIntelligence;
  source: string;
  documentTitle: string;
  onModeChange: (mode: ViewMode) => void;
  onNotify: Notify;
}) {
  const [busy, setBusy] = useState(false);
  const profile = analysis.frontMatter.known.publishProfile;
  const exportProfile = async () => {
    setBusy(true);
    try {
      const resolved = await resolvedPublishMarkdown(analysis, source);
      const bodySource = resolved.slice(analysis.frontMatter.bodyFrom);
      if (profile === 'readme') {
        downloadText(bodySource, 'README.md', 'text/markdown;charset=utf-8');
      } else {
        const { default: DOMPurify } = await import('dompurify');
        const rendered = createMarkdownIt().render(bodySource);
        const safe = String(DOMPurify.sanitize(rendered, {
          USE_PROFILES: { html: true },
          ADD_ATTR: ['target', 'rel', 'align', 'colspan', 'rowspan', 'checked', 'disabled'],
        }));
        downloadText(
          htmlDocument(documentTitle, safe, profile, analysis.frontMatter.known.canonicalUrl),
          `${exportStem(documentTitle)}-${profile}.html`,
          'text/html;charset=utf-8',
        );
      }
      onNotify('Publish artifact created', `The ${profile} profile was compiled from the current source revision.`, 'success');
    } catch (error) {
      onNotify('Publish artifact unavailable', error instanceof Error ? error.message : 'The profile could not compile.', 'danger');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="publish-actions">
      <button type="button" className="button primary" disabled={busy || !analysis.frontMatter.valid} onClick={() => void exportProfile()}>{busy ? 'Compiling linked blocks…' : `Export ${profile}`}</button>
      {profile === 'print' && <button type="button" className="button" onClick={() => { onModeChange('preview'); window.setTimeout(() => window.print(), 180); }}>Print rendered document</button>}
      <small>Readable cross-document blocks are resolved and inlined at export time. Unreadable targets fail visibly instead of leaking content.</small>
    </div>
  );
}

function LinkSurface({
  analysis,
  documentId,
  onReveal,
  onNotify,
}: {
  analysis: DocumentIntelligence;
  documentId: string;
  onReveal: (range: SourceRange) => void;
  onNotify: Notify;
}) {
  const [checks, setChecks] = useState<Map<string, ExternalLinkCheckDto>>(new Map());
  const [checking, setChecking] = useState(false);
  const external = [...new Set(analysis.links.filter((link) => link.kind === 'external').map((link) => link.destination))];
  const check = async () => {
    setChecking(true);
    try {
      let next: ExternalLinkCheckDto[];
      if (UI_DATA_MODE === 'service') {
        next = (await (await loadServiceApi()).checkDocumentLinks(documentId, external.slice(0, 32))).checks;
      } else {
        next = await Promise.all(external.slice(0, 16).map(async (url) => {
          try {
            const response = await fetch(url, { method: 'HEAD', mode: 'cors', redirect: 'follow', signal: AbortSignal.timeout(8_000) });
            return { url, status: response.ok ? 'reachable' : response.status === 404 ? 'missing' : 'unavailable', httpStatus: response.status, finalUrl: response.url || null, checkedAtMs: Date.now() } as ExternalLinkCheckDto;
          } catch {
            return { url, status: 'unavailable', httpStatus: null, finalUrl: null, checkedAtMs: Date.now() } as ExternalLinkCheckDto;
          }
        }));
      }
      setChecks(new Map(next.map((item) => [item.url, item])));
      onNotify('Link check complete', `${next.length} explicit network checks finished.`, 'success');
    } catch (error) {
      onNotify('Link check unavailable', error instanceof Error ? error.message : 'The checker could not finish.', 'danger');
    } finally {
      setChecking(false);
    }
  };
  return (
    <>
      <div className="practical-toolbar"><button type="button" className="button" disabled={!external.length || checking} onClick={() => void check()}>{checking ? 'Checking…' : `Check ${external.length} external link${external.length === 1 ? '' : 's'}`}</button><small>Network requests happen only after this action.</small></div>
      <div className="link-ledger">
        {analysis.links.map((link) => {
          const checked = checks.get(link.destination);
          const status = checked?.status ?? link.status;
          return (
            <article key={link.id}>
              <span className={`link-state link-${status}`} />
              <div><strong>{link.label || link.destination}</strong><code>{link.destination || 'missing definition'}</code><small>{checked ? `${checked.status}${checked.httpStatus ? ` · HTTP ${checked.httpStatus}` : ''}` : link.statusDetail}</small></div>
              <button type="button" onClick={() => onReveal(link.range)}>Line {link.range.line}</button>
            </article>
          );
        })}
        {!analysis.links.length && <Empty>This document contains no links.</Empty>}
      </div>
    </>
  );
}

function CitationSurface({
  analysis,
  documentId,
  editable,
  onInsert,
  onReveal,
  onNotify,
}: {
  analysis: DocumentIntelligence;
  documentId: string;
  editable: boolean;
  onInsert: (source: string) => void;
  onReveal: (range: SourceRange) => void;
  onNotify: Notify;
}) {
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('');
  const [looking, setLooking] = useState(false);
  const lookup = async () => {
    const doi = normalizeDoi(query);
    if (!doi) {
      onNotify('DOI not recognized', 'Paste a DOI such as 10.1000/example.', 'danger');
      return;
    }
    setLooking(true);
    try {
      if (UI_DATA_MODE === 'service') {
        const result = await (await loadServiceApi()).lookupDocumentCitation(documentId, doi);
        setSource(result.citation.citation);
      } else {
        const response = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error(`Crossref returned HTTP ${response.status}.`);
        const message = (await response.json() as { message?: { title?: string[]; author?: Array<{ family?: string; given?: string }>; publisher?: string; URL?: string; issued?: { 'date-parts'?: number[][] } } }).message;
        const authors = message?.author?.map((author) => [author.given, author.family].filter(Boolean).join(' ')).join(', ') || 'Unknown author';
        const year = message?.issued?.['date-parts']?.[0]?.[0];
        setSource(`${authors}. “${message?.title?.[0] || doi}.” ${message?.publisher || ''}${year ? `, ${year}` : ''}. https://doi.org/${doi}.`.replace(/\s+/g, ' '));
      }
    } catch (error) {
      onNotify('Citation lookup unavailable', error instanceof Error ? error.message : 'The DOI lookup failed.', 'danger');
    } finally {
      setLooking(false);
    }
  };
  return (
    <>
      <div className="citation-lookup">
        <label>DOI<input value={query} placeholder="10.1000/example" onChange={(event) => setQuery(event.target.value)} /></label>
        <button type="button" className="button" disabled={looking || !query.trim()} onClick={() => void lookup()}>{looking ? 'Looking up…' : 'Look up DOI'}</button>
        <label>Source record<textarea value={source} placeholder="Author. Title. Publisher, year. URL." onChange={(event) => setSource(event.target.value)} /></label>
        <button type="button" className="button primary" disabled={!editable || !source.trim()} onClick={() => onInsert(source)}>Insert anchored footnote</button>
      </div>
      <div className="citation-list">
        {analysis.citations.map((citation) => (
          <button key={citation.id} type="button" className={citation.defined ? 'is-defined' : 'is-missing'} onClick={() => onReveal(citation.range)}>
            <strong>{citation.key}</strong><span>{citation.style}</span><small>{citation.defined ? 'source reconciled' : 'source missing'}</small>
          </button>
        ))}
        {!analysis.citations.length && <Empty>No citation markers are present yet.</Empty>}
      </div>
    </>
  );
}

function StructureSurface({
  analysis,
  editable,
  onRename,
  onShift,
  onMove,
  onExtract,
  onReveal,
}: {
  analysis: DocumentIntelligence;
  editable: boolean;
  onRename: (heading: IntelligenceHeading, title: string) => void;
  onShift: (heading: IntelligenceHeading, direction: 'promote' | 'demote') => void;
  onMove: (heading: IntelligenceHeading, direction: 'up' | 'down') => void;
  onExtract: (heading: IntelligenceHeading) => void;
  onReveal: (range: SourceRange) => void;
}) {
  const [selected, setSelected] = useState<number | null>(analysis.headings[0]?.sectionFrom ?? null);
  const heading = analysis.headings.find((item) => item.sectionFrom === selected) ?? analysis.headings[0] ?? null;
  const [name, setName] = useState(heading?.text ?? '');
  useEffect(() => setName(heading?.text ?? ''), [heading?.sectionFrom, heading?.text]);
  if (!heading) return <Empty>Add a heading to create a structure that can be refactored.</Empty>;
  return (
    <div className="structure-layout">
      <div className="structure-tree" role="listbox" aria-label="Document sections">
        {analysis.headings.map((item) => (
          <button key={item.sectionFrom} type="button" role="option" aria-selected={item.sectionFrom === heading.sectionFrom} style={{ '--heading-depth': item.level } as CSSProperties} onClick={() => setSelected(item.sectionFrom)}>
            <span>H{item.level}</span>{item.text}
          </button>
        ))}
      </div>
      <div className="structure-actions">
        <label>Section title<input value={name} maxLength={240} onChange={(event) => setName(event.target.value)} /></label>
        <button type="button" className="button" disabled={!editable || name.trim() === heading.text} onClick={() => onRename(heading, name)}>Rename</button>
        <div className="button-grid">
          <button type="button" className="button" disabled={!editable} onClick={() => onMove(heading, 'up')}>Move up</button>
          <button type="button" className="button" disabled={!editable} onClick={() => onMove(heading, 'down')}>Move down</button>
          <button type="button" className="button" disabled={!editable || heading.level === 1} onClick={() => onShift(heading, 'promote')}>Promote</button>
          <button type="button" className="button" disabled={!editable || heading.level === 6} onClick={() => onShift(heading, 'demote')}>Demote</button>
        </div>
        <button type="button" className="button" onClick={() => onReveal(heading.range)}>Reveal source</button>
        <button type="button" className="button primary" disabled={!editable} onClick={() => onExtract(heading)}>Extract as linked document</button>
        <small>Moving or extracting includes every child heading in the section.</small>
      </div>
    </div>
  );
}

function CollaborationSurface({ session, status, peers }: { session: CollabSession; status: ConnectionStatus; peers: readonly Peer[] }) {
  const stats = session.stats();
  const capabilities = session.capabilities();
  return (
    <>
      <div className="practical-metrics">
        <Metric label="connection" value={status} />
        <Metric label="role" value={capabilities.role ?? 'resolving'} />
        <Metric label="pending operations" value={stats.pendingOperations} />
        <Metric label="local journal" value={stats.localSaved ? 'saved' : 'pending'} />
      </div>
      <div className="people-list">
        {peers.map((peer) => <article key={peer.id}><span className={`avatar marks-user${peer.colorIndex}`}>{peer.name[0]?.toUpperCase()}</span><div><strong>{peer.name}{peer.self ? ' (you)' : ''}</strong><small>{peer.self ? `${capabilities.role ?? 'resolving'} · this replica` : 'live in this room'}</small></div></article>)}
        {!peers.length && <Empty>No live peer receipt is available yet.</Empty>}
      </div>
      <dl className="technical-receipt">
        <div><dt>Engine</dt><dd>{session.engine}</dd></div>
        <div><dt>Snapshot</dt><dd>{formatBytes(stats.snapshotBytes)}</dd></div>
        <div><dt>Retained operations</dt><dd>{stats.retainedOperations.toLocaleString()}</dd></div>
        <div><dt>History floor</dt><dd>{formatBytes(stats.historyFloorBytes)}</dd></div>
        <div><dt>Network</dt><dd>{formatBytes(stats.sent)} sent · {formatBytes(stats.received)} received</dd></div>
      </dl>
    </>
  );
}

function RecoverySurface({
  session,
  documentId,
  documentTitle,
  userName,
  onNotify,
}: {
  session: CollabSession;
  documentId: string;
  documentTitle: string;
  userName: string;
  onNotify: Notify;
}) {
  const [busy, setBusy] = useState(false);
  const stats = session.stats();
  const checkpoint = async () => {
    setBusy(true);
    try {
      await session.whenDurable();
      await reviewRepository.createVersion(documentId, userName, `Recovery checkpoint · ${new Date().toLocaleString()}`, session.getText());
      onNotify('Recovery checkpoint saved', 'The source was durable before the named checkpoint was created.', 'success');
    } catch (error) {
      onNotify('Checkpoint unavailable', error instanceof Error ? error.message : 'The checkpoint could not be created.', 'danger');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="recovery-state">
        <span className={`recovery-beacon ${stats.localSaved ? 'is-safe' : 'is-pending'}`} />
        <div><strong>{stats.localSaved ? 'Latest edit is in the local journal' : 'Local journal acknowledgement is pending'}</strong><p>Server durability is separately represented by the connection state and the “wait for durable” action.</p></div>
      </div>
      <div className="practical-metrics">
        <Metric label="pending operations" value={stats.pendingOperations} />
        <Metric label="snapshot" value={formatBytes(stats.snapshotBytes)} />
        <Metric label="history retained" value={stats.retainedOperations.toLocaleString()} />
      </div>
      <div className="recovery-actions">
        <button type="button" className="button primary" disabled={busy || !session.capabilities().saveVersion} onClick={() => void checkpoint()}>{busy ? 'Waiting for durability…' : 'Create named checkpoint'}</button>
        <button type="button" className="button" onClick={() => downloadText(session.getText(), `${exportStem(documentTitle)}-recovery.md`, 'text/markdown;charset=utf-8')}>Download emergency Markdown</button>
        <button type="button" className="button" onClick={() => void session.whenDurable().then(() => onNotify('Durability proven', 'Every edit made before the check is committed.', 'success')).catch((error) => onNotify('Durability not yet proven', error instanceof Error ? error.message : 'Reconnect and retry.', 'danger'))}>Wait for durable receipt</button>
      </div>
    </>
  );
}

function VersionsSurface({
  documentId,
  documentTitle,
  session,
  onOpenDocument,
  onNotify,
}: {
  documentId: string;
  documentTitle: string;
  session: CollabSession;
  onOpenDocument: (id: string) => void;
  onNotify: Notify;
}) {
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [leftId, setLeftId] = useState('current');
  const [rightId, setRightId] = useState('');
  const [loaded, setLoaded] = useState<Record<string, string>>({ current: session.getText() });
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => {
    void reviewRepository.listVersions(documentId, session.getText()).then((items) => {
      setVersions(items);
      setLoaded((current) => ({ ...current, current: session.getText(), ...Object.fromEntries(items.filter((item) => item.markdown !== undefined).map((item) => [item.id, item.markdown!])) }));
      if (!rightId) setRightId(items.find((item) => !item.current)?.id ?? 'current');
    });
  }, [documentId, rightId, session]);
  useEffect(() => { refresh(); return reviewRepository.subscribe(refresh); }, [refresh]);
  const ensure = async (id: string) => {
    if (loaded[id] !== undefined || id === 'current') return;
    const version = await reviewRepository.getVersion(documentId, id);
    if (version?.markdown !== undefined) setLoaded((current) => ({ ...current, [id]: version.markdown! }));
  };
  useEffect(() => { void ensure(leftId); void ensure(rightId); }, [leftId, rightId]);
  const chunks = useMemo(() => lineDiff(loaded[leftId] ?? '', loaded[rightId] ?? ''), [leftId, loaded, rightId]);
  const branch = async () => {
    const markdown = loaded[rightId];
    if (markdown === undefined) return;
    setBusy(true);
    try {
      const selected = versions.find((version) => version.id === rightId);
      const created = await documentRepository.create({ title: `${documentTitle} — ${selected?.label ?? 'branch'}`, content: markdown });
      onNotify('Branch created', 'The source document and saved version remain unchanged.', 'success');
      onOpenDocument(created.id);
    } catch (error) {
      onNotify('Branch unavailable', error instanceof Error ? error.message : 'The new document could not be created.', 'danger');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="version-pickers">
        <label>Before<select value={leftId} onChange={(event) => setLeftId(event.target.value)}>{versions.map((version) => <option key={version.id} value={version.id}>{version.label}</option>)}</select></label>
        <span>→</span>
        <label>After<select value={rightId} onChange={(event) => setRightId(event.target.value)}>{versions.map((version) => <option key={version.id} value={version.id}>{version.label}</option>)}</select></label>
        <button type="button" className="button" disabled={busy || loaded[rightId] === undefined} onClick={() => void branch()}>{busy ? 'Branching…' : 'Branch from “After”'}</button>
      </div>
      <pre className="version-diff" aria-label="Line comparison">{chunks.slice(0, 500).map((chunk, index) => <span key={index} className={`diff-${chunk.kind}`}>{chunk.lines.map((line, lineIndex) => <span key={lineIndex}>{chunk.kind === 'added' ? '+ ' : chunk.kind === 'removed' ? '− ' : '  '}{line}{'\n'}</span>)}</span>)}</pre>
      {chunks.length > 500 && <p className="inline-notice">The visual diff is clipped; branching still uses the complete snapshot.</p>}
    </>
  );
}

function AssetsSurface({ analysis, documentId, onReveal }: { analysis: DocumentIntelligence; documentId: string; onReveal: (range: SourceRange) => void }) {
  const [metadata, setMetadata] = useState<Map<string, DocumentAssetDto>>(new Map());
  useEffect(() => {
    let active = true;
    const request = UI_DATA_MODE === 'service'
      ? loadServiceApi().then((api) => api.listDocumentAssets(documentId)).then((result) => result.assets)
      : listLocalAssets(documentId);
    void request.then((assets) => {
      if (active) setMetadata(new Map(assets.map((asset) => [asset.id, asset])));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [documentId]);
  return (
    <>
      <div className="practical-metrics">
        <Metric label="images" value={analysis.images.length} />
        <Metric label="stored assets" value={metadata.size} />
        <Metric label="external images" value={analysis.images.filter((image) => image.kind === 'external').length} />
        <Metric label="missing alt text" value={analysis.images.filter((image) => !image.alt.trim()).length} />
      </div>
      <div className="asset-list">
        {analysis.images.map((image) => {
          const asset = image.localAssetId ? metadata.get(image.localAssetId) : undefined;
          return <article key={image.id}><Glyph name="image" size={30} /><div><strong>{image.alt || 'No alternative text'}</strong><code>{image.destination}</code><small>{asset ? `${asset.filename} · ${formatBytes(asset.bytes)} · ${asset.mediaType}` : image.kind === 'external' ? 'external image; not included in a portable bundle' : image.kind}</small></div><button type="button" onClick={() => onReveal(image.range)}>Line {image.range.line}</button></article>;
        })}
        {[...metadata.values()].filter((asset) => !analysis.images.some((image) => image.localAssetId === asset.id)).map((asset) => (
          <article key={`orphan:${asset.id}`} className="asset-unreferenced"><Glyph name="trash" size={30} /><div><strong>{asset.filename}</strong><code>{asset.url}</code><small>{formatBytes(asset.bytes)} · stored but no longer referenced; reclaimed with document lifecycle</small></div></article>
        ))}
        {!analysis.images.length && <Empty>No image assets are referenced.</Empty>}
      </div>
    </>
  );
}

function ReaderSurface({ analysis, text }: { analysis: DocumentIntelligence; text: string }) {
  const [simulation, setSimulation] = useState<'article' | 'phone' | 'print' | 'slides'>('article');
  const body = text.slice(analysis.frontMatter.bodyFrom);
  const visibleLines = body.split('\n').filter((line) => line.trim() && !/^\s*(?:```|~~~)/.test(line)).slice(0, 120);
  return (
    <>
      <div className="practical-metrics">
        <Metric label="words" value={analysis.reader.words.toLocaleString()} />
        <Metric label="reading" value={`${Math.max(1, Math.ceil(analysis.reader.readingMinutes))} min`} />
        <Metric label="speaking" value={`${Math.max(1, Math.ceil(analysis.reader.speakingMinutes))} min`} />
        <Metric label="paragraphs" value={analysis.reader.paragraphs} />
      </div>
      <div className="simulation-tabs">{(['article', 'phone', 'print', 'slides'] as const).map((item) => <button key={item} type="button" aria-pressed={simulation === item} onClick={() => setSimulation(item)}>{item}</button>)}</div>
      <div className={`reader-simulation reader-${simulation}`}>
        <header><span>{simulation}</span><small>{analysis.frontMatter.known.audience || 'General audience'}</small></header>
        <div>{visibleLines.map((line, index) => /^#{1,6}\s+/.test(line) ? <h3 key={index}>{line.replace(/^#{1,6}\s+/, '')}</h3> : <p key={index}>{line.replace(/^[-*>]\s*/, '')}</p>)}</div>
      </div>
    </>
  );
}

function LedgerSurface({ analysis, editable, onToggleTask, onAppend, onReveal }: {
  analysis: DocumentIntelligence;
  editable: boolean;
  onToggleTask: (taskId: string) => void;
  onAppend: (kind: 'task' | 'decision', value: string) => void;
  onReveal: (range: SourceRange) => void;
}) {
  const [value, setValue] = useState('');
  const [kind, setKind] = useState<'task' | 'decision'>('task');
  return (
    <>
      <div className="practical-metrics">
        <Metric label="open tasks" value={analysis.tasks.filter((task) => !task.checked).length} />
        <Metric label="completed" value={analysis.tasks.filter((task) => task.checked).length} />
        <Metric label="decisions" value={analysis.decisions.length} />
      </div>
      <form className="ledger-compose" onSubmit={(event) => { event.preventDefault(); if (!value.trim()) return; onAppend(kind, value); setValue(''); }}><select value={kind} onChange={(event) => setKind(event.target.value === 'decision' ? 'decision' : 'task')}><option value="task">Task</option><option value="decision">Decision</option></select><input value={value} placeholder={kind === 'task' ? 'Next action @owner due:YYYY-MM-DD' : 'What was decided and why'} onChange={(event) => setValue(event.target.value)} /><button type="submit" className="button" disabled={!editable || !value.trim()}>Add to Markdown</button></form>
      <div className="ledger-list">
        {analysis.tasks.map((task) => <article key={task.id}><input type="checkbox" checked={task.checked} disabled={!editable} aria-label={`Mark ${task.text} ${task.checked ? 'open' : 'complete'}`} onChange={() => onToggleTask(task.id)} /><button type="button" onClick={() => onReveal(task.range)}><strong>{task.text}</strong><small>{[task.owner && `@${task.owner}`, task.due && `due ${task.due}`].filter(Boolean).join(' · ') || 'No owner or due date'}</small></button></article>)}
        {analysis.decisions.map((decision) => <article key={decision.id} className="decision-row"><Glyph name="diamond" size={22} /><button type="button" onClick={() => onReveal(decision.range)}><strong>{decision.text}</strong><small>Decision · line {decision.range.line}</small></button></article>)}
        {!analysis.tasks.length && !analysis.decisions.length && <Empty>No tasks or explicit Decision: lines are present.</Empty>}
      </div>
    </>
  );
}

function PasteSurface({ editable, onInsert, onNotify }: { editable: boolean; onInsert: (value: string) => void; onNotify: Notify }) {
  const [clipboard, setClipboard] = useState('');
  const [intent, setIntent] = useState<'preserve' | 'plain' | 'quote' | 'code'>('preserve');
  const [provenance, setProvenance] = useState('');
  const read = async () => {
    const value = await readClipboardMarkdown();
    setClipboard(value);
    if (!value) onNotify('Clipboard unavailable', 'Grant clipboard permission or use the normal paste command.', 'danger');
  };
  const preview = clipboard ? pasteWithIntent(clipboard, intent, provenance) : '';
  return (
    <>
      <div className="practical-toolbar"><button type="button" className="button" disabled={!editable} onClick={() => void read()}>Read clipboard</button><small>Marks asks only after your click; clipboard contents stay in this page.</small></div>
      <fieldset className="paste-intents"><legend>Paste as</legend>{(['preserve', 'plain', 'quote', 'code'] as const).map((item) => <label key={item}><input type="radio" name="paste-intent" checked={intent === item} onChange={() => setIntent(item)} />{item}</label>)}</fieldset>
      <label className="practical-field">Optional provenance<input value={provenance} maxLength={500} placeholder="Source URL, interview, or import note" onChange={(event) => setProvenance(event.target.value)} /></label>
      <pre className="paste-preview">{preview || 'Clipboard preview appears here.'}</pre>
      <button type="button" className="button primary" disabled={!editable || !clipboard} onClick={() => onInsert(preview)}>Insert at selection</button>
    </>
  );
}

function BlocksSurface({
  analysis,
  currentDocumentId,
  documents,
  editable,
  onInsert,
  onOpenDocument,
  onNotify,
}: {
  analysis: DocumentIntelligence;
  currentDocumentId: string;
  documents: readonly DocumentMeta[];
  editable: boolean;
  onInsert: (value: string) => void;
  onOpenDocument: (id: string) => void;
  onNotify: Notify;
}) {
  const choices = documents.filter((document) => document.id !== currentDocumentId && !document.deleted_at);
  const [documentId, setDocumentId] = useState(choices[0]?.id ?? '');
  const [heading, setHeading] = useState('');
  const [label, setLabel] = useState('');
  const [targetHeadings, setTargetHeadings] = useState<string[]>([]);
  useEffect(() => {
    if (!documentId) return;
    let active = true;
    const load = UI_DATA_MODE === 'service'
      ? loadServiceApi().then((api) => api.downloadDocumentMarkdown(documentId))
      : Promise.resolve(readLocalDocumentText(documentId));
    void load.then((text) => analyzeDocument(text).headings.map((item) => item.text)).then((items) => { if (active) setTargetHeadings(items); }).catch(() => { if (active) { setTargetHeadings([]); onNotify('Target unavailable', 'The selected document cannot be read by this workspace.', 'danger'); } });
    return () => { active = false; };
  }, [documentId, onNotify]);
  return (
    <>
      <form className="practical-form" onSubmit={(event) => { event.preventDefault(); if (documentId) onInsert(crossDocumentBlock(documentId, heading || undefined, label || undefined)); }}>
        <label>Readable document<select value={documentId} onChange={(event) => { setDocumentId(event.target.value); setHeading(''); }}><option value="">Choose a document</option>{choices.map((document) => <option key={document.id} value={document.id}>{document.title}</option>)}</select></label>
        <label>Section<select value={heading} onChange={(event) => setHeading(event.target.value)}><option value="">Whole document</option>{targetHeadings.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <label>Display label<input value={label} placeholder={choices.find((document) => document.id === documentId)?.title ?? 'Linked document'} onChange={(event) => setLabel(event.target.value)} /></label>
        <button type="submit" className="button primary" disabled={!editable || !documentId}>Insert live document block</button>
      </form>
      <div className="block-list">
        {analysis.blockReferences.map((reference) => <article key={reference.id}><Glyph name="duplicate" size={25} /><div><strong>{reference.label || reference.heading || reference.documentId}</strong><small>{reference.documentId}{reference.heading ? ` · ${reference.heading}` : ''}</small></div><button type="button" onClick={() => onOpenDocument(reference.documentId)}>Open</button></article>)}
        {!analysis.blockReferences.length && <Empty>No cross-document blocks are present.</Empty>}
      </div>
    </>
  );
}

export function PracticalInspector(props: PracticalInspectorProps) {
  const { analysis, analyzing, error } = useDocumentIntelligence(props.session);
  const closeRef = useRef<HTMLButtonElement>(null);
  const closeHandlerRef = useRef(props.onClose);
  const descriptor = PRACTICAL_SURFACES.find((item) => item.capability === props.capability)!;
  const editable = props.session.capabilities().edit && !analyzing;

  useEffect(() => {
    closeHandlerRef.current = props.onClose;
  }, [props.onClose]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') closeHandlerRef.current(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); previous?.focus(); };
  }, []);

  const commit = useCallback(async (next: string, title: string) => {
    if (!props.session.capabilities().edit) {
      props.onNotify(`${title} unavailable`, 'Your current role can inspect but cannot change this document.', 'danger');
      return;
    }
    if (next === props.session.getText()) return;
    props.session.setText(next);
    try {
      await props.session.whenDurable();
      props.onNotify(title, 'The Markdown change is durable.', 'success');
    } catch (commitError) {
      props.onNotify(`${title} saved locally`, commitError instanceof Error ? commitError.message : 'Server durability is pending.', 'neutral');
    }
  }, [props.onNotify, props.session]);

  const reveal = useCallback((range: SourceRange) => {
    if (props.mode === 'preview') props.onModeChange('edit');
    window.setTimeout(() => {
      const view = props.getView();
      if (!view) return;
      view.dispatch({ selection: { anchor: range.from, head: range.to }, effects: EditorView.scrollIntoView(range.from, { y: 'center' }) });
      view.focus();
    }, props.mode === 'preview' ? 80 : 0);
  }, [props]);

  const insertAtSelection = useCallback((value: string, title: string) => {
    const current = props.session.getText();
    const live = props.getView()?.state.selection.main;
    const from = live?.from ?? props.selection.from;
    const to = live?.to ?? props.selection.to;
    void commit(`${current.slice(0, from)}${value}${current.slice(to)}`, title);
  }, [commit, props]);

  if (!analysis) {
    return (
      <aside className="practical-inspector surface-material-host" data-shell={props.shell} data-practical-capability={props.capability} aria-label={descriptor.label} aria-busy="true">
        <SurfaceMaterial variant="panel" intensity={0.97} />
        <header className="practical-head"><div><span>Document intelligence</span><h2>{descriptor.label}</h2></div><button ref={closeRef} type="button" className="icon-button" aria-label="Close document intelligence" onClick={props.onClose}><Icon path={icons.close} /></button></header>
        <p className="practical-loading">{error ?? 'Analyzing the current source revision…'}</p>
      </aside>
    );
  }
  const findings = capabilityFindings(analysis, props.capability);
  const findingProps = {
    editable,
    onReveal: reveal,
    onFix: (finding: IntelligenceFinding) => {
      if (!finding.fix) return;
      try { void commit(applySourceFix(props.session.getText(), finding.fix), finding.fix.label); }
      catch (fixError) { props.onNotify('Finding changed', fixError instanceof Error ? fixError.message : 'Refresh and retry.', 'danger'); }
    },
  };

  let content;
  if (props.capability === 'health') content = <HealthSurface analysis={analysis} findings={findings} {...findingProps} />;
  else if (props.capability === 'render' || props.capability === 'accessibility' || props.capability === 'privacy') content = <FindingSurface analysis={analysis} capability={props.capability} findings={findings} {...findingProps} />;
  else if (props.capability === 'schema' || props.capability === 'publish' || props.capability === 'quality') content = (
    <><SchemaSurface analysis={analysis} mode={props.capability} onSave={(patch) => {
      try { void commit(updateFrontMatter(props.session.getText(), patch), props.capability === 'quality' ? 'Quality contract saved' : props.capability === 'publish' ? 'Publish profile saved' : 'Document schema saved'); }
      catch (schemaError) { props.onNotify('Schema not changed', schemaError instanceof Error ? schemaError.message : 'Front matter is invalid.', 'danger'); }
    }} />{props.capability === 'publish' && <PublishActions analysis={analysis} source={props.session.getText()} documentTitle={props.documentTitle} onModeChange={props.onModeChange} onNotify={props.onNotify} />}{findings.length > 0 && <FindingList findings={findings} {...findingProps} />}</>
  );
  else if (props.capability === 'links') content = <LinkSurface analysis={analysis} documentId={props.documentId} onReveal={reveal} onNotify={props.onNotify} />;
  else if (props.capability === 'citations') content = <CitationSurface analysis={analysis} documentId={props.documentId} editable={editable} onReveal={reveal} onNotify={props.onNotify} onInsert={(source) => {
    const selection = props.getView()?.state.selection.main ?? props.selection;
    try { void commit(insertCitationFootnote(props.session.getText(), selection.from, selection.to, source), 'Citation inserted'); }
    catch (citationError) { props.onNotify('Citation not inserted', citationError instanceof Error ? citationError.message : 'The source range changed.', 'danger'); }
  }} />;
  else if (props.capability === 'structure') content = <StructureSurface analysis={analysis} editable={editable} onReveal={reveal} onRename={(heading, title) => { try { void commit(renameHeading(props.session.getText(), heading, title), 'Section renamed'); } catch (operationError) { props.onNotify('Section not renamed', operationError instanceof Error ? operationError.message : 'The structure changed.', 'danger'); } }} onShift={(heading, direction) => { try { void commit(shiftHeadingDepth(props.session.getText(), heading, direction), `Section ${direction === 'promote' ? 'promoted' : 'demoted'}`); } catch (operationError) { props.onNotify('Section not changed', operationError instanceof Error ? operationError.message : 'The structure changed.', 'danger'); } }} onMove={(heading, direction) => { try { void commit(moveHeadingSection(props.session.getText(), analysis.headings, heading, direction), `Section moved ${direction}`); } catch (operationError) { props.onNotify('Section not moved', operationError instanceof Error ? operationError.message : 'The structure changed.', 'danger'); } }} onExtract={(heading) => {
    void (async () => {
      try {
        const current = props.session.getText();
        if (props.session.capabilities().saveVersion) await reviewRepository.createVersion(props.documentId, props.userName, `Before extracting ${heading.text}`, current);
        const source = current.slice(heading.sectionFrom, heading.sectionTo).trimEnd() + '\n';
        const created = await documentRepository.create({ title: heading.text, content: source });
        const extracted = extractHeadingSection(current, heading, created.id, heading.text);
        await commit(extracted.remaining, 'Section extracted');
        props.onNotify('Section extracted', `“${heading.text}” is a new document and this source now contains a live block.`, 'success');
      } catch (operationError) { props.onNotify('Section not extracted', operationError instanceof Error ? operationError.message : 'The branch could not be created.', 'danger'); }
    })();
  }} />;
  else if (props.capability === 'collaboration') content = <CollaborationSurface session={props.session} status={props.status} peers={props.peers} />;
  else if (props.capability === 'recovery') content = <RecoverySurface session={props.session} documentId={props.documentId} documentTitle={props.documentTitle} userName={props.userName} onNotify={props.onNotify} />;
  else if (props.capability === 'versions') content = <VersionsSurface documentId={props.documentId} documentTitle={props.documentTitle} session={props.session} onOpenDocument={props.onOpenDocument} onNotify={props.onNotify} />;
  else if (props.capability === 'assets') content = <AssetsSurface analysis={analysis} documentId={props.documentId} onReveal={reveal} />;
  else if (props.capability === 'reader') content = <ReaderSurface analysis={analysis} text={props.session.getText()} />;
  else if (props.capability === 'ledger') content = <LedgerSurface analysis={analysis} editable={editable} onReveal={reveal} onToggleTask={(taskId) => {
    const task = analysis.tasks.find((item) => item.id === taskId);
    if (!task) return;
    const current = props.session.getText();
    const expected = current.slice(task.markerRange.from, task.markerRange.to);
    if (!/^\[[ xX]\]$/.test(expected)) return props.onNotify('Task changed', 'Refresh the ledger before toggling it.', 'danger');
    void commit(`${current.slice(0, task.markerRange.from)}${task.checked ? '[ ]' : '[x]'}${current.slice(task.markerRange.to)}`, task.checked ? 'Task reopened' : 'Task completed');
  }} onAppend={(kind, value) => {
    const current = props.session.getText();
    const separator = current.endsWith('\n') ? '\n' : '\n\n';
    const line = kind === 'task' ? `- [ ] ${value.trim()}` : `**Decision:** ${value.trim()}`;
    void commit(`${current}${separator}${line}\n`, kind === 'task' ? 'Task added' : 'Decision recorded');
  }} />;
  else if (props.capability === 'paste') content = <PasteSurface editable={editable} onNotify={props.onNotify} onInsert={(value) => insertAtSelection(value, 'Clipboard inserted')} />;
  else content = <BlocksSurface analysis={analysis} currentDocumentId={props.documentId} documents={props.documents} editable={editable} onInsert={(value) => insertAtSelection(`${value}\n`, 'Document block inserted')} onOpenDocument={props.onOpenDocument} onNotify={props.onNotify} />;

  return (
    <aside className="practical-inspector surface-material-host" data-shell={props.shell} data-practical-capability={props.capability} aria-label={descriptor.label} aria-busy={analyzing}>
      <SurfaceMaterial variant="panel" intensity={0.97} />
      <header className="practical-head">
        <div><span>Document intelligence {analyzing ? '· refreshing' : `· revision ${analysis.revision}`}</span><h2>{descriptor.label}</h2><p>{descriptor.description}</p></div>
        <button ref={closeRef} type="button" className="icon-button" aria-label="Close document intelligence" onClick={props.onClose}><Icon path={icons.close} /></button>
      </header>
      <nav className="practical-nav" aria-label="Document intelligence tools">{PRACTICAL_SURFACES.map((item) => <button key={item.capability} type="button" data-practical-nav={item.capability} aria-current={item.capability === props.capability ? 'page' : undefined} onClick={() => props.onSelect(item.capability)}>{item.shortLabel}</button>)}</nav>
      <div className="practical-body">{error && <p className="inline-notice danger">{error}</p>}{content}</div>
    </aside>
  );
}
