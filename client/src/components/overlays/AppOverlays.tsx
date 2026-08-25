import { useEffect, useMemo, useRef, useState } from 'react';
import { useOptionalCommandCenter } from '../../commands/context';
import type { CollabSession, DocumentCapabilities } from '../../collab/types';
import {
  reviewRange,
  reviewRepository,
  type DocumentVersion,
  type ReviewComment,
} from '../../data/review';
import { documentRepository } from '../../data/documents';
import { DOCUMENT_TEMPLATES, type TemplateId } from '../../demo/workspace';
import type { UiPreferences } from '../../hooks/useUiPreferences';
import { formatRelativeTime } from '../../lib/format';
import type { PhoneGhostControl } from '../../lib/phone-ghost';
import { UI_ACTIONS, type UiActionId } from '../../lib/ui-actions';
import { surfaceRuntime } from '../../surface/runtime';
import { AccountSheet } from '../identity/AccountSheet';
import { KeepWorkspace } from '../identity/KeepWorkspace';
import { Glyph } from '../glyphs/Glyph';
import { Icon, Modal, SurfaceMaterial } from '../ui';
import { PairingInspect } from '../identity/PairingInspect';
import { ShareDialog } from '../identity/ShareDialog';
import '../../styles/overlays.css';

export type AppDialog =
  | { type: 'templates' }
  | { type: 'import-url' }
  | { type: 'rename'; documentId: string; title: string }
  | { type: 'delete'; documentId: string; title: string }
  | { type: 'trash' }
  | { type: 'share'; documentId: string; title: string; publicPage: boolean }
  | { type: 'preferences' }
  | { type: 'ghost-overlay' }
  | { type: 'command-palette' }
  | { type: 'keep-workspace' }
  | { type: 'account' }
  | { type: 'pairing-inspect' };

export type ReviewSurface =
  | { type: 'comments'; documentId: string; title: string }
  | { type: 'history'; documentId: string; title: string };

interface AppOverlaysProps {
  dialog: AppDialog | null;
  review: ReviewSurface | null;
  session: CollabSession | null;
  userName: string;
  theme: 'light' | 'dark';
  preferences: UiPreferences;
  phoneGhost: PhoneGhostControl;
  hasDocument: boolean;
  /** Phone posture: login requires opening this public page on a laptop. */
  phone: boolean;
  dataMode: 'local' | 'service';
  capabilities: DocumentCapabilities | null;
  onCloseDialog: () => void;
  onCloseReview: () => void;
  onAction: (action: UiActionId) => void;
  onCreateFromTemplate: (templateId: TemplateId) => void;
  onImportUrl: (url: string) => void;
  onRename: (documentId: string, title: string) => void;
  onDelete: (documentId: string) => void;
  onDocumentsChanged: () => void;
  onTheme: (theme: 'light' | 'dark') => void;
  onPreferences: (patch: Partial<UiPreferences>) => void;
  onNotify: (title: string, detail?: string, tone?: 'neutral' | 'success' | 'danger') => void;
  onPromoted?: () => void;
  onSignedOut?: () => void;
}

const DOCUMENT_ACTIONS = new Set<UiActionId>([
  'rename',
  'duplicate',
  'download',
  'print',
  'delete',
  'share',
  'comments',
  'history',
  'focus',
  'find',
  'draft-tools',
]);

function TemplatesDialog({
  onChoose,
}: {
  onChoose: (templateId: TemplateId) => void;
}) {
  return (
    <div className="template-grid">
      {DOCUMENT_TEMPLATES.map((template, index) => (
        <button
          key={template.id}
          type="button"
          className={`template-card template-${template.accent}`}
          data-autofocus={index === 0 ? '' : undefined}
          onClick={() => onChoose(template.id)}
        >
          <span className="template-preview" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <strong>{template.name}</strong>
          <span>{template.description}</span>
        </button>
      ))}
    </div>
  );
}

function ImportUrlDialog({ onImport }: { onImport: (url: string) => void }) {
  const [url, setUrl] = useState('');
  const valid = useMemo(() => {
    try {
      return ['http:', 'https:'].includes(new URL(url).protocol);
    } catch {
      return false;
    }
  }, [url]);
  return (
    <form
      className="dialog-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) onImport(url.trim());
      }}
    >
      <label>
        Public page URL
        <input
          data-autofocus
          type="url"
          inputMode="url"
          placeholder="https://example.com/article"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
      </label>
      <p className="hint">Marks imports the page’s static text, headings, links, lists, and tables. Scripts are never run.</p>
      <div className="dialog-actions">
        <button type="submit" className="button primary" disabled={!valid}>Import page</button>
      </div>
    </form>
  );
}

function GhostOverlayDialog({
  control,
  onNotify,
}: {
  control: PhoneGhostControl;
  onNotify: AppOverlaysProps['onNotify'];
}) {
  const setEnabled = (enabled: boolean) => {
    control.setEnabled(enabled);
    onNotify(
      enabled ? 'Ghost overlay on' : 'Ghost overlay off',
      enabled
        ? 'Rendered Markdown will stay visible while you edit on this phone.'
        : 'Your source editor now uses the full phone canvas.',
      'success',
    );
  };
  const setShift = (shift: PhoneGhostControl['shift']) => {
    control.setShift(shift);
    onNotify(
      shift === 'start' ? 'Showing the left half' : 'Showing the right half',
      'You can also slide the rendered page with two fingers while editing.',
      'neutral',
    );
  };

  return (
    <div className="ghost-overlay-dialog">
      <div className="ghost-overlay-intro">
        <Icon name="ghostOverlay" size={76} interactive={false} />
        <p>
          A faint rendered copy stays on the right while you edit. It lets you
          check the compiled Markdown without leaving the source.
        </p>
      </div>

      <label className="ghost-overlay-switch">
        <span>
          <strong>Show while editing</strong>
          <small>On by default on this phone; your choice is remembered.</small>
        </span>
        <input
          data-autofocus
          type="checkbox"
          role="switch"
          checked={control.enabled}
          onChange={(event) => setEnabled(event.currentTarget.checked)}
        />
      </label>

      <fieldset className="ghost-overlay-halves" disabled={!control.enabled}>
        <legend>Rendered page position</legend>
        <div className="segmented-control">
          <button
            type="button"
            aria-pressed={control.shift === 'start'}
            onClick={() => setShift('start')}
          >
            Left half
          </button>
          <button
            type="button"
            aria-pressed={control.shift === 'end'}
            onClick={() => setShift('end')}
          >
            Right half
          </button>
        </div>
      </fieldset>

      <div className="ghost-overlay-gesture">
        <span className="ghost-fingers" aria-hidden="true"><i /><i /><b>↔</b></span>
        <p>
          <strong>Move it with two fingers.</strong>
          Slide left or right to show the other half of the rendered page.
          One finger still edits and scrolls; pinch still zooms.
        </p>
      </div>
    </div>
  );
}

function RenameDialog({
  dialog,
  onRename,
}: {
  dialog: Extract<AppDialog, { type: 'rename' }>;
  onRename: (documentId: string, title: string) => void;
}) {
  const [title, setTitle] = useState(dialog.title);
  return (
    <form
      className="dialog-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (title.trim()) onRename(dialog.documentId, title);
      }}
    >
      <label>
        Document name
        <input
          data-autofocus
          value={title}
          maxLength={90}
          onChange={(event) => setTitle(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
        />
      </label>
      <div className="dialog-actions">
        <button type="submit" className="button primary" disabled={!title.trim()}>
          Rename
        </button>
      </div>
    </form>
  );
}

function DeleteDialog({
  dialog,
  onDelete,
  dataMode,
}: {
  dialog: Extract<AppDialog, { type: 'delete' }>;
  onDelete: (documentId: string) => void;
  dataMode: AppOverlaysProps['dataMode'];
}) {
  return (
    <div className="confirm-content">
      <span className="confirm-icon" aria-hidden="true">
        <Icon name="trash" size={20} />
      </span>
      <p>
        <strong>“{dialog.title}”</strong>{' '}
        {dataMode === 'service'
          ? 'will move to durable trash for 30 days and any live collaborators will be disconnected.'
          : 'will move to this browser’s trash for 30 days.'}
      </p>
      <div className="dialog-actions">
        <button type="button" className="button danger-button" data-autofocus onClick={() => onDelete(dialog.documentId)}>
          Move to trash
        </button>
      </div>
    </div>
  );
}

function TrashDialog({
  onChanged,
  onNotify,
}: {
  onChanged: () => void;
  onNotify: AppOverlaysProps['onNotify'];
}) {
  const [documents, setDocuments] = useState<Awaited<ReturnType<typeof documentRepository.listTrash>>>([]);
  const [loading, setLoading] = useState(true);

  const refresh = () => {
    setLoading(true);
    void documentRepository.listTrash()
      .then(setDocuments)
      .catch(() => onNotify('Trash unavailable', 'The recovery index could not be loaded.', 'danger'))
      .finally(() => setLoading(false));
  };

  useEffect(refresh, []);

  return (
    <div className="trash-surface">
      <p>Documents remain recoverable for 30 days. Permanent deletion is disabled until each document’s retention date.</p>
      {loading && <p className="hint">Loading trash…</p>}
      {!loading && documents.length === 0 && <p className="hint">Trash is empty.</p>}
      <div className="trash-list">
        {documents.map((document) => {
          const canPurge = (document.purge_at ?? Number.POSITIVE_INFINITY) <= Date.now();
          return (
            <article key={document.id}>
              <span><strong>{document.title}</strong><small>Trashed {formatRelativeTime(document.deleted_at ?? Date.now())} · permanent deletion {new Date(document.purge_at ?? Date.now()).toLocaleDateString()}</small></span>
              <div>
                <button type="button" className="button" onClick={() => {
                  void documentRepository.restore(document.id).then((restored) => {
                    if (!restored) throw new Error('restore refused');
                    onChanged();
                    refresh();
                    onNotify('Document restored', `“${restored.title}” is back in the workspace.`, 'success');
                  }).catch(() => onNotify('Restore unavailable', 'Only the owner can restore this document.', 'danger'));
                }}>Restore</button>
                <button type="button" className="button danger-button" disabled={!canPurge} title={canPurge ? 'Permanently delete' : 'Available after the 30-day retention window'} onClick={() => {
                  void documentRepository.purge(document.id).then(() => {
                    onChanged();
                    refresh();
                    onNotify('Document permanently deleted', 'Its document, review, and collaboration records were reclaimed.', 'success');
                  }).catch(() => onNotify('Permanent deletion unavailable', 'The retention window has not elapsed.', 'danger'));
                }}>Delete forever</button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function PreferencesDialog({
  theme,
  preferences,
  onTheme,
  onPreferences,
}: Pick<AppOverlaysProps, 'theme' | 'preferences' | 'onTheme' | 'onPreferences'>) {
  return (
    <div className="preferences-grid">
      <fieldset>
        <legend>Appearance</legend>
        <div className="choice-row">
          {(['light', 'dark'] as const).map((choice) => (
            <button
              key={choice}
              type="button"
              className={`appearance-choice${theme === choice ? ' selected' : ''}`}
              aria-pressed={theme === choice}
              data-autofocus={choice === 'light' ? '' : undefined}
              onClick={() => onTheme(choice)}
            >
              <span className={`theme-swatch swatch-${choice}`}><i /><i /><i /></span>
              {choice === 'light' ? 'Light' : 'Dark'}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend>Ribbon density</legend>
        <div className="segmented-control">
          {(['comfortable', 'compact'] as const).map((density) => (
            <button
              key={density}
              type="button"
              aria-pressed={preferences.density === density}
              onClick={() => onPreferences({ density })}
            >
              {density === 'comfortable' ? 'Comfortable' : 'Compact'}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="preference-switches">
        <legend>Effects</legend>
        <label>
          <span><strong>Liquid glass</strong><small>{surfaceRuntime.label} material · automatically scaled</small></span>
          <input type="checkbox" role="switch" checked={preferences.glass} onChange={(event) => onPreferences({ glass: event.target.checked })} />
        </label>
        <label>
          <span><strong>Interface motion</strong><small>Panel, menu, and view transitions</small></span>
          <input type="checkbox" role="switch" checked={preferences.motion} onChange={(event) => onPreferences({ motion: event.target.checked })} />
        </label>
      </fieldset>
    </div>
  );
}

function CommandPalette({
  hasDocument,
  onRunLegacy,
  onClose,
}: {
  hasDocument: boolean;
  onRunLegacy: (action: UiActionId) => void;
  onClose: () => void;
}) {
  const commandCenter = useOptionalCommandCenter();
  const [query, setQuery] = useState('');
  const actions = useMemo(() => {
    const available = commandCenter
      ? commandCenter.commands('palette').map((command) => ({
          id: command.id,
          label: command.label,
          description: command.unavailableReason ?? command.description,
          group: command.category,
          shortcut: command.shortcut,
          enabled: command.enabled,
          glyph: command.glyph,
        }))
      : UI_ACTIONS
          .filter((action) => hasDocument || !DOCUMENT_ACTIONS.has(action.id))
          .map((action) => ({ ...action, enabled: true, glyph: undefined }));
    const needle = query.trim().toLowerCase();
    return needle
      ? available.filter((action) => `${action.label} ${action.description} ${action.group}`.toLowerCase().includes(needle))
      : available;
  }, [commandCenter, hasDocument, query]);

  const run = (id: string) => {
    const command = actions.find((action) => action.id === id);
    if (!command?.enabled) return;
    if (commandCenter) {
      onClose();
      window.setTimeout(() => void commandCenter.invoke(id, 'palette'), 0);
    } else {
      onRunLegacy(id as UiActionId);
    }
  };

  return (
    <div className="command-palette">
      <label className="command-search">
        <Icon name="search" />
        <input
          data-autofocus
          value={query}
          placeholder="Type a command…"
          aria-label="Search commands"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              const first = actions.find((action) => action.enabled);
              if (first) run(first.id);
            }
          }}
        />
        <kbd>esc</kbd>
      </label>
      <div className="command-results" role="listbox" aria-label="Commands">
        {actions.map((action) => (
          <button key={action.id} type="button" role="option" disabled={!action.enabled} aria-disabled={!action.enabled} data-command-id={commandCenter ? action.id : undefined} onClick={() => run(action.id)}>
            <span>{action.glyph && <Glyph name={action.glyph} size={20} />}<span><strong>{action.label}</strong><small>{action.description}</small></span></span>
            <span><em>{action.group}</em>{action.shortcut && <kbd>{action.shortcut}</kbd>}</span>
          </button>
        ))}
        {actions.length === 0 && <p>No command matches “{query}”.</p>}
      </div>
    </div>
  );
}

function ReviewDrawer({
  review,
  session,
  userName,
  onClose,
  onNotify,
}: Pick<AppOverlaysProps, 'review' | 'session' | 'userName' | 'onCloseReview' | 'onNotify'> & {
  onClose: () => void;
}) {
  const [rendered, setRendered] = useState<ReviewSurface | null>(review);
  const [closing, setClosing] = useState(false);
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [commentCursor, setCommentCursor] = useState<string | null>(null);
  const [loadingEarlierComments, setLoadingEarlierComments] = useState(false);
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [comment, setComment] = useState('');
  const [versionLabel, setVersionLabel] = useState('');
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const [loadingVersion, setLoadingVersion] = useState(false);
  const [savingVersion, setSavingVersion] = useState(false);
  const [restoringVersion, setRestoringVersion] = useState(false);
  const [capturedRange, setCapturedRange] = useState<ReturnType<CollabSession['captureReviewRange']> | null>(null);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<{
    kind: 'comment' | 'reply';
    commentId: string;
    replyId?: string;
    body: string;
  } | null>(null);
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (review) {
      setRendered(review);
      setClosing(false);
      return;
    }
    if (!rendered) return;
    setClosing(true);
    const timer = window.setTimeout(() => {
      setRendered(null);
      setClosing(false);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [rendered, review]);

  useEffect(() => {
    if (!rendered) return;
    const refresh = () => {
      if (rendered.type === 'comments') {
        void reviewRepository.listComments(rendered.documentId).then((page) => {
          setComments(page.comments);
          setCommentCursor(page.nextCursor);
        }).catch(() => {
          onNotify('Comments unavailable', 'Your current document role cannot load this thread.', 'danger');
        });
      } else if (session) {
        void reviewRepository.listVersions(rendered.documentId, session.getText()).then((next) => {
          setVersions(next);
          setSelectedVersion((current) =>
            current && next.some((version) => version.id === current)
              ? current
              : next[0]?.id ?? null,
          );
        }).catch(() => {
          onNotify('History unavailable', 'Your current document role cannot load saved versions.', 'danger');
        });
      }
    };
    refresh();
    return reviewRepository.subscribe(refresh);
  }, [onNotify, rendered, session]);

  useEffect(() => {
    if (!rendered || rendered.type !== 'history' || !selectedVersion) return;
    const selected = versions.find((version) => version.id === selectedVersion);
    if (!selected || selected.markdown !== undefined || selected.current) return;
    let active = true;
    setLoadingVersion(true);
    void reviewRepository.getVersion(rendered.documentId, selected.id)
      .then((loaded) => {
        if (!active || !loaded) return;
        setVersions((current) => current.map((version) => version.id === loaded.id ? loaded : version));
      })
      .catch(() => onNotify('Version unavailable', 'The saved Markdown could not be loaded.', 'danger'))
      .finally(() => {
        if (active) setLoadingVersion(false);
      });
    return () => {
      active = false;
    };
  }, [onNotify, rendered, selectedVersion, versions]);

  useEffect(() => {
    if (!rendered || rendered.type !== 'comments' || !session?.hydrated()) {
      setCapturedRange(null);
      return;
    }
    try {
      setCapturedRange(session.captureReviewRange());
    } catch {
      setCapturedRange(null);
    }
  }, [rendered, session]);

  useEffect(() => {
    if (!rendered || closing) return;
    const previous = document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>('textarea, button')?.focus());
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, [closing, onClose, rendered]);

  if (!rendered) return null;
  const selected = versions.find((version) => version.id === selectedVersion) ?? null;
  const capabilities = session?.capabilities();

  return (
    <aside className={`review-drawer surface-material-host${closing ? ' is-closing' : ''}`} aria-label={rendered.type === 'comments' ? 'Comments' : 'Version history'} ref={panelRef}>
      <SurfaceMaterial variant="panel" />
      <header className="review-head">
        <div>
          <span>{rendered.type === 'comments' ? 'Review' : 'Document'}</span>
          <h2>{rendered.type === 'comments' ? 'Comments' : 'Version history'}</h2>
        </div>
        <button type="button" className="icon-button" aria-label="Close review panel" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>

      {rendered.type === 'comments' ? (
        <div className="comments-surface">
          <form
            className="comment-compose"
            onSubmit={(event) => {
              event.preventDefault();
              if (!comment.trim() || !capturedRange) return;
              void reviewRepository.addComment(rendered.documentId, userName, comment, capturedRange).then(() => {
                setComment('');
                onNotify(
                  'Comment added',
                  reviewRepository.mode === 'service'
                    ? 'The thread is durably stored with the document.'
                    : 'The thread is stored in this browser.',
                  'success',
                );
              }).catch(() => onNotify('Comment not added', 'Your current role cannot comment on this document.', 'danger'));
            }}
          >
            {capturedRange && (
              <div className="comment-anchor-preview">
                <strong>{capturedRange.quote ? 'Commenting on selection' : 'Commenting at cursor'}</strong>
                {capturedRange.quote && <q>{capturedRange.quote}</q>}
              </div>
            )}
            <textarea value={comment} maxLength={16 * 1024} placeholder={capabilities?.comment ? 'Leave a comment…' : 'Your role can read but not comment'} aria-label="New comment" disabled={!capabilities?.comment} onChange={(event) => setComment(event.target.value)} />
            <button type="submit" className="button primary" disabled={!comment.trim() || !capabilities?.comment || !capturedRange}>Start thread</button>
          </form>
          <div className="comment-list">
            {comments.map((item) => {
              const range = reviewRange(item);
              let rangeExact = false;
              if (range && session) {
                try {
                  rangeExact = session.resolveReviewRange(range).exact;
                } catch {
                  rangeExact = false;
                }
              }
              const replyDraft = replyDrafts[item.id] ?? '';
              return (
                <article key={item.id} className={`comment-card${item.resolved ? ' resolved' : ''}`}>
                  {range && (
                    <button
                      type="button"
                      className="comment-anchor"
                      onClick={() => session?.revealReviewRange(range)}
                    >
                      <span>{rangeExact ? 'Anchored selection' : 'Recovered location'}</span>
                      <q>{item.quote || 'Cursor position'}</q>
                    </button>
                  )}
                  <header><span className="avatar">{item.author[0]?.toUpperCase()}</span><span><strong>{item.author}</strong><small>{formatRelativeTime(item.createdAt)}{item.editedAt ? ' · edited' : ''}</small></span></header>
                  {editing?.kind === 'comment' && editing.commentId === item.id ? (
                    <form className="comment-edit" onSubmit={(event) => {
                      event.preventDefault();
                      if (!editing.body.trim()) return;
                      void reviewRepository.updateComment(rendered.documentId, item.id, { body: editing.body })
                        .then(() => setEditing(null))
                        .catch(() => onNotify('Comment not changed', 'Only the author can edit this message.', 'danger'));
                    }}>
                      <textarea value={editing.body} maxLength={16 * 1024} onChange={(event) => setEditing({ ...editing, body: event.target.value })} />
                      <span><button type="submit" className="button">Save</button><button type="button" className="button" onClick={() => setEditing(null)}>Cancel</button></span>
                    </form>
                  ) : (
                    <p className={item.deleted ? 'deleted-message' : undefined}>{item.deleted ? 'Message deleted' : item.body}</p>
                  )}
                  <div className="comment-actions">
                    <button type="button" disabled={!capabilities?.comment} onClick={() => void reviewRepository.updateComment(rendered.documentId, item.id, { resolved: !item.resolved }).catch(() => onNotify('Comment not changed', 'Your current role cannot resolve this thread.', 'danger'))}>
                      <Icon name={item.resolved ? 'undo' : 'check'} size={13} />
                      {item.resolved ? 'Reopen' : 'Resolve'}
                    </button>
                    {item.own && !item.deleted && <button type="button" onClick={() => setEditing({ kind: 'comment', commentId: item.id, body: item.body })}>Edit</button>}
                    {item.own && !item.deleted && <button type="button" onClick={() => void reviewRepository.deleteComment(rendered.documentId, item.id).catch(() => onNotify('Comment not deleted', 'Only the author can delete this message.', 'danger'))}>Delete</button>}
                  </div>
                  {item.replies.length > 0 && (
                    <div className="comment-replies">
                      {item.replies.map((reply) => (
                        <div key={reply.id} className="comment-reply">
                          <header><strong>{reply.author}</strong><small>{formatRelativeTime(reply.createdAt)}{reply.editedAt ? ' · edited' : ''}</small></header>
                          {editing?.kind === 'reply' && editing.replyId === reply.id ? (
                            <form className="comment-edit" onSubmit={(event) => {
                              event.preventDefault();
                              if (!editing.body.trim()) return;
                              void reviewRepository.updateReply(rendered.documentId, item.id, reply.id, editing.body)
                                .then(() => setEditing(null))
                                .catch(() => onNotify('Reply not changed', 'Only the author can edit this reply.', 'danger'));
                            }}>
                              <textarea value={editing.body} maxLength={16 * 1024} onChange={(event) => setEditing({ ...editing, body: event.target.value })} />
                              <span><button type="submit" className="button">Save</button><button type="button" className="button" onClick={() => setEditing(null)}>Cancel</button></span>
                            </form>
                          ) : <p className={reply.deleted ? 'deleted-message' : undefined}>{reply.deleted ? 'Message deleted' : reply.body}</p>}
                          {reply.own && !reply.deleted && <div className="comment-actions"><button type="button" onClick={() => setEditing({ kind: 'reply', commentId: item.id, replyId: reply.id, body: reply.body })}>Edit</button><button type="button" onClick={() => void reviewRepository.deleteReply(rendered.documentId, item.id, reply.id).catch(() => onNotify('Reply not deleted', 'Only the author can delete this reply.', 'danger'))}>Delete</button></div>}
                        </div>
                      ))}
                    </div>
                  )}
                  <form className="reply-compose" onSubmit={(event) => {
                    event.preventDefault();
                    if (!replyDraft.trim()) return;
                    void reviewRepository.addReply(rendered.documentId, item.id, userName, replyDraft)
                      .then(() => setReplyDrafts((current) => ({ ...current, [item.id]: '' })))
                      .catch(() => onNotify('Reply not added', 'Your current role cannot reply to this thread.', 'danger'));
                  }}>
                    <input value={replyDraft} maxLength={16 * 1024} disabled={!capabilities?.comment} placeholder="Reply…" aria-label={`Reply to ${item.author}`} onChange={(event) => setReplyDrafts((current) => ({ ...current, [item.id]: event.target.value }))} />
                    <button type="submit" disabled={!capabilities?.comment || !replyDraft.trim()}>Reply</button>
                  </form>
                </article>
              );
            })}
            {commentCursor && (
              <button
                type="button"
                className="button"
                disabled={loadingEarlierComments}
                onClick={() => {
                  const cursor = commentCursor;
                  setLoadingEarlierComments(true);
                  void reviewRepository.listComments(rendered.documentId, cursor)
                    .then((page) => {
                      setComments((current) => {
                        const seen = new Set(current.map((item) => item.id));
                        return [...current, ...page.comments.filter((item) => !seen.has(item.id))];
                      });
                      setCommentCursor(page.nextCursor);
                    })
                    .catch(() => onNotify('Earlier comments unavailable', 'The next review page could not be loaded.', 'danger'))
                    .finally(() => setLoadingEarlierComments(false));
                }}
              >
                {loadingEarlierComments ? 'Loading earlier threads…' : 'Load earlier threads'}
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="history-surface">
          <form
            className="version-compose"
            onSubmit={(event) => {
              event.preventDefault();
              if (!session || savingVersion) return;
              setSavingVersion(true);
              void session.whenDurable()
                .then(() => reviewRepository.createVersion(rendered.documentId, userName, versionLabel, session.getText()))
                .then((version) => {
                  setVersionLabel('');
                  setSelectedVersion(version.id);
                  onNotify(
                    'Version saved',
                    reviewRepository.mode === 'service'
                      ? 'Every prior edit was committed before the server captured this Markdown.'
                      : 'A restorable local snapshot was created after its journal checkpoint.',
                    'success',
                  );
                })
                .catch(() => onNotify('Version not saved', 'Reconnect to commit pending edits, or remove an older saved version.', 'danger'))
                .finally(() => setSavingVersion(false));
            }}
          >
            <input value={versionLabel} maxLength={160} placeholder="Name this version" aria-label="Version name" disabled={!capabilities?.saveVersion} onChange={(event) => setVersionLabel(event.target.value)} />
            <button type="submit" className="button" disabled={!session || !capabilities?.saveVersion || !versionLabel.trim() || savingVersion}>{savingVersion ? 'Waiting for durable save…' : 'Save version'}</button>
          </form>
          <div className="history-layout">
            <div className="version-list" role="listbox" aria-label="Saved versions">
              {versions.map((version) => (
                <button key={version.id} type="button" role="option" aria-selected={selectedVersion === version.id} onClick={() => setSelectedVersion(version.id)}>
                  <strong>{version.label}</strong>
                  <span>{version.author} · {formatRelativeTime(version.createdAt)}</span>
                </button>
              ))}
            </div>
            {selected && (
              <div className="version-preview">
                <span>Snapshot preview</span>
                <pre>{loadingVersion ? 'Loading saved Markdown…' : selected.markdown?.slice(0, 900) || 'Blank document'}</pre>
                <button type="button" className="button primary" disabled={!capabilities?.edit || selected.markdown === undefined || selected.current || restoringVersion} onClick={() => {
                  if (selected.markdown === undefined) return;
                  session?.setText(selected.markdown);
                  if (!session) return;
                  setRestoringVersion(true);
                  void session.whenDurable()
                    .then(() => onNotify('Version restored', `“${selected.label}” was applied as a new, durable edit.`, 'success'))
                    .catch(() => onNotify('Restore pending', 'The edit is in the local journal and will commit after reconnect.', 'neutral'))
                    .finally(() => setRestoringVersion(false));
                }}>
                  {restoringVersion ? 'Committing restore…' : 'Restore this version'}
                </button>
                {!selected.current && capabilities?.saveVersion && (
                  <button type="button" className="button" onClick={() => {
                    void reviewRepository.deleteVersion(rendered.documentId, selected.id)
                      .then(() => onNotify('Version deleted', 'Its saved label was removed; shared content is reclaimed when unused.', 'success'))
                      .catch(() => onNotify('Version not deleted', 'Your current role cannot delete this version.', 'danger'));
                  }}>
                    Delete saved version
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}

export function AppOverlays(props: AppOverlaysProps) {
  const [renderedDialog, setRenderedDialog] = useState<AppDialog | null>(props.dialog);

  useEffect(() => {
    if (props.dialog) setRenderedDialog(props.dialog);
  }, [props.dialog]);

  const runFromPalette = (action: UiActionId) => {
    props.onCloseDialog();
    window.setTimeout(() => props.onAction(action), 0);
  };

  let title = '';
  let description: string | undefined;
  let size: 'small' | 'medium' | 'large' = 'medium';
  let content = null;

  if (renderedDialog?.type === 'templates') {
    title = 'Choose a starting point';
    description = 'Useful structure, still completely yours.';
    size = 'large';
    content = <TemplatesDialog onChoose={props.onCreateFromTemplate} />;
  } else if (renderedDialog?.type === 'import-url') {
    title = 'Import from URL';
    description = 'Turn a public web page into portable Markdown.';
    size = 'small';
    content = <ImportUrlDialog onImport={props.onImportUrl} />;
  } else if (renderedDialog?.type === 'rename') {
    title = 'Rename document';
    description = 'The title updates everywhere in this workspace.';
    size = 'small';
    content = <RenameDialog key={renderedDialog.documentId} dialog={renderedDialog} onRename={props.onRename} />;
  } else if (renderedDialog?.type === 'delete') {
    title = 'Move this document to trash?';
    description = 'It remains recoverable for 30 days.';
    size = 'small';
    content = <DeleteDialog dialog={renderedDialog} onDelete={props.onDelete} dataMode={props.dataMode} />;
  } else if (renderedDialog?.type === 'trash') {
    title = 'Trash';
    description = 'Restore now; permanently delete only after retention.';
    size = 'large';
    content = <TrashDialog onChanged={props.onDocumentsChanged} onNotify={props.onNotify} />;
  } else if (renderedDialog?.type === 'share') {
    title = 'Share document';
    description = renderedDialog.publicPage
      ? 'This opaque page URL already grants public editor access.'
      : 'Private pages use named roles and rotatable bearer links.';
    size = 'large';
    content = <ShareDialog key={renderedDialog.documentId} documentId={renderedDialog.documentId} title={renderedDialog.title} publicPage={renderedDialog.publicPage} capabilities={props.capabilities} onNotify={props.onNotify} />;
  } else if (renderedDialog?.type === 'keep-workspace') {
    title = 'Log In';
    description = props.phone ? 'Open this page on a laptop to log in.' : 'Scan the QR code with your phone.';
    content = (
      <KeepWorkspace
        onNotify={props.onNotify}
        onPromoted={props.onPromoted}
        phone={props.phone}
      />
    );
  } else if (renderedDialog?.type === 'account') {
    title = 'Account';
    description = 'Manage where you are logged in.';
    content = (
      <AccountSheet
        onNotify={props.onNotify}
        onSignedOut={props.onSignedOut}
      />
    );
  } else if (renderedDialog?.type === 'preferences') {
    title = 'Appearance';
    description = 'Make Marks feel right without making it heavier.';
    content = <PreferencesDialog theme={props.theme} preferences={props.preferences} onTheme={props.onTheme} onPreferences={props.onPreferences} />;
  } else if (renderedDialog?.type === 'ghost-overlay') {
    title = 'Rendered Markdown ghost';
    description = 'Keep the compiled page in sight while you edit on a phone.';
    size = 'small';
    content = <GhostOverlayDialog control={props.phoneGhost} onNotify={props.onNotify} />;
  } else if (renderedDialog?.type === 'pairing-inspect') {
    title = 'Log In';
    description = 'Scan the QR code or enter the login code from your other device.';
    content = <PairingInspect state="waiting" onNotify={props.onNotify} />;
  } else if (renderedDialog?.type === 'command-palette') {
    title = 'What do you want to do?';
    size = 'large';
    content = <CommandPalette hasDocument={props.hasDocument} onRunLegacy={runFromPalette} onClose={props.onCloseDialog} />;
  }

  return (
    <>
      <Modal
        open={Boolean(props.dialog)}
        title={title}
        description={description}
        size={size}
        onClose={props.onCloseDialog}
      >
        {content}
      </Modal>
      <ReviewDrawer
        review={props.review}
        session={props.session}
        userName={props.userName}
        onCloseReview={props.onCloseReview}
        onClose={props.onCloseReview}
        onNotify={props.onNotify}
      />
    </>
  );
}
