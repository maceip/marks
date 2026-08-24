import type { CSSProperties, ReactNode } from 'react';

export function Avatar({
  name,
  color,
  src,
  self,
  activity,
  size = 26,
}: {
  name: string;
  color?: string;
  src?: string;
  self?: boolean;
  activity?: 'editing' | 'active';
  size?: number;
}) {
  const initial = name.trim().slice(0, 1).toUpperCase() || '?';
  return (
    <span
      className={`avatar${activity ? ` avatar-${activity}` : ''}${self ? ' avatar-self' : ''}`}
      style={{ '--avatar-color': color, width: size, height: size } as CSSProperties}
      aria-hidden="true"
    >
      {src ? <img src={src} alt="" /> : initial}
    </span>
  );
}

export function CommentCard({
  author,
  time,
  body,
  resolved,
  quote,
  actions,
  children,
}: {
  author: string;
  time: string;
  body: string;
  resolved?: boolean;
  quote?: string;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <article className={`comment-card${resolved ? ' resolved' : ''}`}>
      {quote && (
        <div className="comment-anchor">
          <span>{resolved ? 'Resolved thread' : 'Anchored selection'}</span>
          <q>{quote}</q>
        </div>
      )}
      <header>
        <Avatar name={author} />
        <span>
          <strong>{author}</strong>
          <small>{time}</small>
        </span>
      </header>
      <p>{body}</p>
      {actions && <div className="comment-actions">{actions}</div>}
      {children}
    </article>
  );
}

export function CommentCompose({
  value,
  placeholder,
  disabled,
  submitLabel = 'Start thread',
  onChange,
  onSubmit,
}: {
  value: string;
  placeholder: string;
  disabled?: boolean;
  submitLabel?: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <form
      className="comment-compose"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <textarea
        value={value}
        maxLength={16 * 1024}
        placeholder={placeholder}
        aria-label={placeholder}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
      <button type="submit" className="button primary" disabled={disabled || !value.trim()}>{submitLabel}</button>
    </form>
  );
}
