import { useState, type CSSProperties } from 'react';
import type { CommentRecord } from '../browser/comments';
import { colorVar, initials } from '../collab/user';
import { formatRelativeTime } from '../lib/format';
import { Icon, icons } from './Icon';

interface CommentsDrawerProps {
  comments: CommentRecord[];
  draftQuote: string;
  onSubmitDraft: (body: string) => void;
  onCancelDraft: () => void;
  onResolve: (id: string) => void;
  onDelete: (id: string) => void;
  onSelect: (comment: CommentRecord) => void;
  onClose: () => void;
}

export function CommentsDrawer({
  comments,
  draftQuote,
  onSubmitDraft,
  onCancelDraft,
  onResolve,
  onDelete,
  onSelect,
  onClose,
}: CommentsDrawerProps) {
  const [body, setBody] = useState('');
  const open = comments.filter((comment) => !comment.resolved);
  const resolved = comments.filter((comment) => comment.resolved);

  return (
    <aside className="outline-drawer comments-drawer" aria-label="Comments">
      <header className="drawer-head">
        <h2>
          <Icon path={icons.comment} size={14} /> Comments
        </h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close comments">
          <Icon path={icons.close} size={14} />
        </button>
      </header>

      {draftQuote && (
        <form
          className="comment-composer"
          onSubmit={(event) => {
            event.preventDefault();
            const next = body.trim();
            if (!next) return;
            onSubmitDraft(next);
            setBody('');
          }}
        >
          <p className="comment-quote">{draftQuote}</p>
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Add a comment"
            rows={3}
            autoFocus
          />
          <div className="comment-composer-actions">
            <button type="button" className="button subtle" onClick={onCancelDraft}>
              Cancel
            </button>
            <button type="submit" className="button primary" disabled={!body.trim()}>
              Comment
            </button>
          </div>
        </form>
      )}

      <div className="comment-list">
        {open.length === 0 && !draftQuote && <p className="hint">No open comments.</p>}
        {open.map((comment) => (
          <CommentCard
            key={comment.id}
            comment={comment}
            onSelect={onSelect}
            onResolve={onResolve}
            onDelete={onDelete}
          />
        ))}
        {resolved.length > 0 && (
          <p className="comment-resolved-label">
            {resolved.length} resolved
          </p>
        )}
        {resolved.map((comment) => (
          <CommentCard
            key={comment.id}
            comment={comment}
            onSelect={onSelect}
            onResolve={onResolve}
            onDelete={onDelete}
          />
        ))}
      </div>
    </aside>
  );
}

function CommentCard({
  comment,
  onSelect,
  onResolve,
  onDelete,
}: {
  comment: CommentRecord;
  onSelect: (comment: CommentRecord) => void;
  onResolve: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <article className={`comment-card${comment.resolved ? ' resolved' : ''}`}>
      <button type="button" className="comment-card-main" onClick={() => onSelect(comment)}>
        <span
          className="avatar"
          style={{ '--avatar-color': colorVar(comment.colorIndex) } as CSSProperties}
        >
          {initials(comment.author)}
        </span>
        <div>
          <header>
            <strong>{comment.author}</strong>
            <time>{formatRelativeTime(comment.createdAt)}</time>
          </header>
          {comment.quote && <p className="comment-quote">{comment.quote}</p>}
          <p className="comment-body">{comment.body}</p>
        </div>
      </button>
      <div className="comment-card-actions">
        {!comment.resolved && (
          <button type="button" className="link-button" onClick={() => onResolve(comment.id)}>
            Resolve
          </button>
        )}
        <button type="button" className="link-button" onClick={() => onDelete(comment.id)}>
          Delete
        </button>
      </div>
    </article>
  );
}
