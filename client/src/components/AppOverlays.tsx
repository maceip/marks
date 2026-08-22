import { useEffect, useMemo, useRef, useState } from 'react';
import type { CollabSession } from '../collab/types';
import { reviewRepository, type DocumentVersion, type ReviewComment } from '../data/review';
import { DOCUMENT_TEMPLATES, type TemplateId } from '../demo/workspace';
import type { UiPreferences } from '../hooks/useUiPreferences';
import { formatRelativeTime } from '../lib/format';
import { UI_ACTIONS, type UiActionId } from '../lib/ui-actions';
import { surfaceRuntime } from '../surface/runtime';
import { Icon, icons } from './Icon';
import { SurfaceMaterial } from './SurfaceMaterial';
import { Modal } from './ui/Modal';
import '../styles/overlays.css';

export type AppDialog =
  | { type: 'templates' }
  | { type: 'rename'; documentId: string; title: string }
  | { type: 'delete'; documentId: string; title: string }
  | { type: 'share'; documentId: string; title: string }
  | { type: 'preferences' }
  | { type: 'command-palette' };

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
  hasDocument: boolean;
  onCloseDialog: () => void;
  onCloseReview: () => void;
  onAction: (action: UiActionId) => void;
  onCreateFromTemplate: (templateId: TemplateId) => void;
  onRename: (documentId: string, title: string) => void;
  onDelete: (documentId: string) => void;
  onTheme: (theme: 'light' | 'dark') => void;
  onPreferences: (patch: Partial<UiPreferences>) => void;
  onNotify: (title: string, detail?: string, tone?: 'neutral' | 'success' | 'danger') => void;
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
  'ai-compose',
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
}: {
  dialog: Extract<AppDialog, { type: 'delete' }>;
  onDelete: (documentId: string) => void;
}) {
  return (
    <div className="confirm-content">
      <span className="confirm-icon" aria-hidden="true">
        <Icon path={icons.trash} size={20} />
      </span>
      <p>
        <strong>“{dialog.title}”</strong> will be removed from this browser. This prototype does not
        have a remote trash yet.
      </p>
      <div className="dialog-actions">
        <button type="button" className="button danger-button" data-autofocus onClick={() => onDelete(dialog.documentId)}>
          Delete document
        </button>
      </div>
    </div>
  );
}

function ShareDialog({
  dialog,
  onNotify,
}: {
  dialog: Extract<AppDialog, { type: 'share' }>;
  onNotify: AppOverlaysProps['onNotify'];
}) {
  const [email, setEmail] = useState('');
  const [access, setAccess] = useState<'editor' | 'commenter' | 'viewer'>('editor');
  const [staged, setStaged] = useState<Array<{ email: string; access: typeof access }>>([]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      onNotify('Link copied', 'This local prototype link is ready to paste.', 'success');
    } catch {
      onNotify('Copy was blocked', 'Select the address from the browser bar instead.', 'danger');
    }
  };

  return (
    <div className="share-dialog">
      <div className="local-notice">
        <Icon path={icons.check} size={15} />
        <span>
          <strong>Local workspace</strong>
          Access changes are staged in the interface; no invitation is transmitted.
        </span>
      </div>

      <form
        className="share-invite"
        onSubmit={(event) => {
          event.preventDefault();
          const value = email.trim();
          if (!value || !value.includes('@')) return;
          setStaged((current) => [
            ...current.filter((person) => person.email !== value),
            { email: value, access },
          ]);
          setEmail('');
          onNotify('Invite staged locally', `${value} was added to the prototype access list.`, 'success');
        }}
      >
        <label htmlFor="share-email">People with access</label>
        <div className="share-input-row">
          <input
            id="share-email"
            data-autofocus
            type="email"
            placeholder="name@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <select aria-label="Access level" value={access} onChange={(event) => setAccess(event.target.value as typeof access)}>
            <option value="editor">Can edit</option>
            <option value="commenter">Can comment</option>
            <option value="viewer">Can view</option>
          </select>
          <button type="submit" className="button" disabled={!email.includes('@')}>Stage</button>
        </div>
      </form>

      <div className="access-list">
        <div className="access-person">
          <span className="avatar avatar-self">Y</span>
          <span><strong>You</strong><small>Owner · this browser</small></span>
          <span>Owner</span>
        </div>
        {staged.map((person) => (
          <div className="access-person" key={person.email}>
            <span className="avatar">{person.email[0].toUpperCase()}</span>
            <span><strong>{person.email}</strong><small>Staged locally</small></span>
            <span>{person.access === 'editor' ? 'Can edit' : person.access === 'commenter' ? 'Can comment' : 'Can view'}</span>
          </div>
        ))}
      </div>

      <div className="share-link-row">
        <span><strong>{dialog.title}</strong><small>Only available in this browser today</small></span>
        <button type="button" className="button primary" onClick={() => void copyLink()}>
          <Icon path={icons.link} /> Copy link
        </button>
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
  onRun,
}: {
  hasDocument: boolean;
  onRun: (action: UiActionId) => void;
}) {
  const [query, setQuery] = useState('');
  const actions = useMemo(() => {
    const available = UI_ACTIONS.filter((action) => hasDocument || !DOCUMENT_ACTIONS.has(action.id));
    const needle = query.trim().toLowerCase();
    return needle
      ? available.filter((action) => `${action.label} ${action.description} ${action.group}`.toLowerCase().includes(needle))
      : available;
  }, [hasDocument, query]);

  return (
    <div className="command-palette">
      <label className="command-search">
        <Icon path={icons.search} />
        <input
          data-autofocus
          value={query}
          placeholder="Type a command…"
          aria-label="Search commands"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && actions[0]) onRun(actions[0].id);
          }}
        />
        <kbd>esc</kbd>
      </label>
      <div className="command-results" role="listbox" aria-label="Commands">
        {actions.map((action) => (
          <button key={action.id} type="button" role="option" onClick={() => onRun(action.id)}>
            <span><strong>{action.label}</strong><small>{action.description}</small></span>
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
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [comment, setComment] = useState('');
  const [versionLabel, setVersionLabel] = useState('');
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
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
      void reviewRepository.listComments(rendered.documentId).then(setComments);
      if (session) void reviewRepository.listVersions(rendered.documentId, session.getText()).then((next) => {
        setVersions(next);
        setSelectedVersion((current) => current ?? next[0]?.id ?? null);
      });
    };
    refresh();
    return reviewRepository.subscribe(refresh);
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

  return (
    <aside className={`review-drawer surface-material-host${closing ? ' is-closing' : ''}`} aria-label={rendered.type === 'comments' ? 'Comments' : 'Version history'} ref={panelRef}>
      <SurfaceMaterial variant="panel" intensity={0.94} />
      <header className="review-head">
        <div>
          <span>{rendered.type === 'comments' ? 'Review' : 'Document'}</span>
          <h2>{rendered.type === 'comments' ? 'Comments' : 'Version history'}</h2>
        </div>
        <button type="button" className="icon-button" aria-label="Close review panel" onClick={onClose}>
          <Icon path={icons.close} />
        </button>
      </header>

      {rendered.type === 'comments' ? (
        <div className="comments-surface">
          <form
            className="comment-compose"
            onSubmit={(event) => {
              event.preventDefault();
              if (!comment.trim()) return;
              void reviewRepository.addComment(rendered.documentId, userName, comment).then(() => {
                setComment('');
                onNotify('Comment added', 'The thread is stored in this browser.', 'success');
              });
            }}
          >
            <textarea value={comment} placeholder="Leave a comment…" aria-label="New comment" onChange={(event) => setComment(event.target.value)} />
            <button type="submit" className="button primary" disabled={!comment.trim()}>Comment</button>
          </form>
          <div className="comment-list">
            {comments.map((item) => (
              <article key={item.id} className={`comment-card${item.resolved ? ' resolved' : ''}`}>
                <header><span className="avatar">{item.author[0]?.toUpperCase()}</span><span><strong>{item.author}</strong><small>{formatRelativeTime(item.createdAt)}</small></span></header>
                <p>{item.body}</p>
                <button type="button" onClick={() => void reviewRepository.setCommentResolved(item.id, !item.resolved)}>
                  <Icon path={item.resolved ? icons.undo : icons.check} size={13} />
                  {item.resolved ? 'Reopen' : 'Resolve'}
                </button>
              </article>
            ))}
          </div>
        </div>
      ) : (
        <div className="history-surface">
          <form
            className="version-compose"
            onSubmit={(event) => {
              event.preventDefault();
              if (!session) return;
              void reviewRepository.createVersion(rendered.documentId, userName, versionLabel, session.getText()).then((version) => {
                setVersionLabel('');
                setSelectedVersion(version.id);
                onNotify('Version saved', 'A restorable local snapshot was created.', 'success');
              });
            }}
          >
            <input value={versionLabel} placeholder="Name this version" aria-label="Version name" onChange={(event) => setVersionLabel(event.target.value)} />
            <button type="submit" className="button" disabled={!session}>Save version</button>
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
                <pre>{selected.markdown.slice(0, 900) || 'Blank document'}</pre>
                <button type="button" className="button primary" onClick={() => {
                  session?.setText(selected.markdown);
                  onNotify('Version restored', `“${selected.label}” is now the current document.`, 'success');
                }}>
                  Restore this version
                </button>
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
  } else if (renderedDialog?.type === 'rename') {
    title = 'Rename document';
    description = 'The title updates everywhere in this workspace.';
    size = 'small';
    content = <RenameDialog key={renderedDialog.documentId} dialog={renderedDialog} onRename={props.onRename} />;
  } else if (renderedDialog?.type === 'delete') {
    title = 'Delete this document?';
    description = 'This action only affects the local prototype workspace.';
    size = 'small';
    content = <DeleteDialog dialog={renderedDialog} onDelete={props.onDelete} />;
  } else if (renderedDialog?.type === 'share') {
    title = 'Share document';
    description = 'The complete access UI, backed by local prototype state.';
    size = 'large';
    content = <ShareDialog key={renderedDialog.documentId} dialog={renderedDialog} onNotify={props.onNotify} />;
  } else if (renderedDialog?.type === 'preferences') {
    title = 'Appearance';
    description = 'Make Marks feel right without making it heavier.';
    content = <PreferencesDialog theme={props.theme} preferences={props.preferences} onTheme={props.onTheme} onPreferences={props.onPreferences} />;
  } else if (renderedDialog?.type === 'command-palette') {
    title = 'What do you want to do?';
    size = 'large';
    content = <CommandPalette hasDocument={props.hasDocument} onRun={runFromPalette} />;
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
