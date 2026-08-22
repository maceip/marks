import { useState } from 'react';
import {
  LINK_TTL_OPTIONS,
  ROLE_COPY,
  SHARE_GRANT_LINE,
  SHARE_LOCAL_LINE,
  type DocumentRole,
} from '../../lib/identity-copy';
import { SERVICE_ERROR_COPY } from '../../lib/service-errors';
import { Icon, icons } from '../ui/Icon';

type GrantRole = Exclude<DocumentRole, 'owner'>;

interface ShareDialogProps {
  title: string;
  onNotify: (title: string, detail?: string, tone?: 'neutral' | 'success' | 'danger') => void;
}

export function ShareDialog({ title, onNotify }: ShareDialogProps) {
  const [principal, setPrincipal] = useState('');
  const [role, setRole] = useState<GrantRole>('editor');
  const [staged, setStaged] = useState<Array<{ principal: string; role: GrantRole }>>([]);
  const [ttl, setTtl] = useState<(typeof LINK_TTL_OPTIONS)[number]['id']>('1h');
  const [linkRole, setLinkRole] = useState<GrantRole>('viewer');
  const [link, setLink] = useState<{ role: GrantRole; ttl: string } | null>(null);
  const [redeem, setRedeem] = useState('');

  const stageGrant = () => {
    const value = principal.trim();
    if (!value) return;
    if (value.includes('@')) {
      onNotify(SERVICE_ERROR_COPY[400].title, 'Shares grant a Marks principal, not an email address.', 'danger');
      return;
    }
    setStaged((current) => [...current.filter((entry) => entry.principal !== value), { principal: value, role }]);
    setPrincipal('');
    onNotify('Access staged', 'Scratch cannot share. The service will refuse this until a session owner calls it.', 'success');
  };

  const copyPage = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      onNotify('Page link copied', 'This is the document address, not a link grant.', 'success');
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
          {SHARE_LOCAL_LINE}
        </span>
      </div>

      <p className="identity-note">{SHARE_GRANT_LINE}</p>

      <form
        className="share-invite"
        onSubmit={(event) => {
          event.preventDefault();
          stageGrant();
        }}
      >
        <label htmlFor="share-principal">People with access</label>
        <div className="share-input-row">
          <input
            id="share-principal"
            data-autofocus
            placeholder="principal of the person"
            value={principal}
            onChange={(event) => setPrincipal(event.target.value)}
            autoComplete="off"
          />
          <select aria-label="Access level" value={role} onChange={(event) => setRole(event.target.value as GrantRole)}>
            <option value="editor">{ROLE_COPY.editor.label}</option>
            <option value="commenter">{ROLE_COPY.commenter.label}</option>
            <option value="viewer">{ROLE_COPY.viewer.label}</option>
          </select>
          <button type="submit" className="button" disabled={!principal.trim()}>
            Stage
          </button>
        </div>
      </form>

      <div className="access-list">
        <div className="access-person">
          <span className="avatar avatar-self">Y</span>
          <span>
            <strong>You</strong>
            <small>{ROLE_COPY.owner.detail}</small>
          </span>
          <span>{ROLE_COPY.owner.label}</span>
        </div>
        {staged.map((entry) => (
          <div className="access-person" key={entry.principal}>
            <span className="avatar">{entry.principal[0]?.toUpperCase()}</span>
            <span>
              <strong>Staged grant</strong>
              <small>{ROLE_COPY[entry.role].detail}</small>
            </span>
            <button
              type="button"
              className="button"
              onClick={() => setStaged((current) => current.filter((item) => item.principal !== entry.principal))}
            >
              Revoke
            </button>
          </div>
        ))}
      </div>

      <section className="identity-section">
        <h3>Link grant</h3>
        <div className="share-input-row share-link-grant">
          <select aria-label="Link role" value={linkRole} onChange={(event) => setLinkRole(event.target.value as GrantRole)}>
            <option value="editor">{ROLE_COPY.editor.label}</option>
            <option value="commenter">{ROLE_COPY.commenter.label}</option>
            <option value="viewer">{ROLE_COPY.viewer.label}</option>
          </select>
          <select aria-label="Link lifetime" value={ttl} onChange={(event) => setTtl(event.target.value as typeof ttl)}>
            {LINK_TTL_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="button"
            onClick={() => {
              setLink({ role: linkRole, ttl });
              onNotify('Link grant staged', 'No token was minted. Redeem still needs a live session.', 'success');
            }}
          >
            Stage link
          </button>
        </div>
        {link && (
          <div className="share-link-row">
            <span>
              <strong>{ROLE_COPY[link.role].label} · {LINK_TTL_OPTIONS.find((option) => option.id === link.ttl)?.label}</strong>
              <small>Staged only. Scratch callers receive authentication failed, not a sent invite.</small>
            </span>
            <button type="button" className="button" onClick={() => setLink(null)}>
              Revoke link
            </button>
          </div>
        )}
        <form
          className="share-invite"
          onSubmit={(event) => {
            event.preventDefault();
            if (!redeem.trim()) return;
            onNotify(SERVICE_ERROR_COPY[401].title, 'Link redeem requires a live session. Scratch is refused.', 'danger');
            setRedeem('');
          }}
        >
          <label htmlFor="share-redeem">Redeem a link</label>
          <div className="share-input-row">
            <input
              id="share-redeem"
              placeholder="Paste a grant token"
              value={redeem}
              onChange={(event) => setRedeem(event.target.value)}
              autoComplete="off"
            />
            <button type="submit" className="button" disabled={!redeem.trim()}>
              Redeem
            </button>
          </div>
        </form>
      </section>

      <div className="share-link-row">
        <span>
          <strong>{title}</strong>
          <small>Only available in this browser today</small>
        </span>
        <button type="button" className="button primary" onClick={() => void copyPage()}>
          <Icon path={icons.link} /> Copy page
        </button>
      </div>
    </div>
  );
}
