import { useEffect, useState } from 'react';
import type { DocumentCapabilities } from '../../collab/types';
import type { DocumentShare } from '../../lib/api';
import {
  LINK_TTL_OPTIONS,
  ROLE_COPY,
  SHARE_GRANT_LINE,
  type DocumentRole,
} from '../../lib/identity-copy';
import { documentShareUrl } from '../../lib/share-link';
import { loadServiceApi } from '../../lib/service-api.ts';
import { ServiceError, copyForUnknownFailure } from '../../lib/service-errors';
import { Icon, icons } from '../ui/Icon';

type GrantRole = Exclude<DocumentRole, 'owner'>;

interface ShareDialogProps {
  documentId: string;
  title: string;
  publicPage: boolean;
  capabilities: DocumentCapabilities | null;
  onNotify: (title: string, detail?: string, tone?: 'neutral' | 'success' | 'danger') => void;
}

const TTL_MS: Record<(typeof LINK_TTL_OPTIONS)[number]['id'], number> = {
  '2m': 2 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
};

export function ShareDialog({ documentId, title, publicPage, capabilities, onNotify }: ShareDialogProps) {
  const [principal, setPrincipal] = useState('');
  const [role, setRole] = useState<GrantRole>('editor');
  const [shares, setShares] = useState<DocumentShare[]>([]);
  const [ttl, setTtl] = useState<(typeof LINK_TTL_OPTIONS)[number]['id']>('1h');
  const [linkRole, setLinkRole] = useState<GrantRole>('viewer');
  const [link, setLink] = useState<{ url: string; role: GrantRole; expiresAtMs: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const publicCollaborativePage = publicPage || capabilities?.role === 'scratch';
  const serviceOwner = capabilities?.role === 'owner' && capabilities.manageShares && !publicCollaborativePage;
  useEffect(() => {
    if (!serviceOwner) return;
    let active = true;
    void loadServiceApi()
      .then((api) => api.listDocumentShares(documentId))
      .then(({ shares: next }) => {
        if (active) setShares(next);
      })
      .catch((error) => notifyError(error, onNotify));
    return () => {
      active = false;
    };
  }, [documentId, onNotify, serviceOwner]);

  const grant = async () => {
    const value = principal.trim();
    if (!value || !serviceOwner) return;
    if (value.includes('@')) {
      onNotify('That request was not accepted', 'Enter a Marks account ID, not an email address.', 'danger');
      return;
    }
    setBusy(true);
    try {
      await (await loadServiceApi()).putDocumentShare(documentId, value, role);
      setShares((current) => [
        ...current.filter((entry) => entry.principalId !== value),
        { principalId: value, role },
      ]);
      setPrincipal('');
      onNotify('Access granted', `${value} can now ${ROLE_COPY[role].label.toLowerCase()}.`, 'success');
    } catch (error) {
      notifyError(error, onNotify);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (principalId: string) => {
    if (!serviceOwner) return;
    setBusy(true);
    try {
      await (await loadServiceApi()).deleteDocumentShare(documentId, principalId);
      setShares((current) => current.filter((entry) => entry.principalId !== principalId));
      onNotify('Access removed', 'That account no longer has access.', 'success');
    } catch (error) {
      notifyError(error, onNotify);
    } finally {
      setBusy(false);
    }
  };

  const mintLink = async () => {
    if (!serviceOwner) return;
    setBusy(true);
    try {
      const created = await (await loadServiceApi()).createDocumentLink(
        documentId,
        linkRole,
        TTL_MS[ttl],
      );
      const url = documentShareUrl(documentId, created.token);
      setLink({ url, role: created.role, expiresAtMs: created.expiresAtMs });
      await navigator.clipboard.writeText(url).catch(() => undefined);
      onNotify('Share link created', 'The bearer token is in the URL fragment and was copied when permitted.', 'success');
    } catch (error) {
      notifyError(error, onNotify);
    } finally {
      setBusy(false);
    }
  };

  const revokeLink = async () => {
    if (!serviceOwner) return;
    setBusy(true);
    try {
      await (await loadServiceApi()).revokeDocumentLink(documentId);
      setLink(null);
      onNotify('Share link revoked', 'Existing durable grants remain; the bearer link no longer redeems.', 'success');
    } catch (error) {
      notifyError(error, onNotify);
    } finally {
      setBusy(false);
    }
  };

  const copyPage = async () => {
    try {
      await navigator.clipboard.writeText(`${location.origin}/d/${encodeURIComponent(documentId)}`);
      onNotify(
        publicCollaborativePage ? 'Public page address copied' : 'Page address copied',
        publicCollaborativePage
          ? 'Anyone with this address can open the page and collaborate.'
          : 'The page address was copied. Existing document access rules still apply.',
        'success',
      );
    } catch {
      onNotify('Copy was blocked', 'Select the address from the browser bar instead.', 'danger');
    }
  };

  const unavailable = publicCollaborativePage
    ? 'Anyone with this opaque address can open and edit the page. No sharing setting or bearer link is required.'
    : capabilities?.role === 'local'
    ? 'This is a browser-local document. Keep it in the service before sharing.'
      : capabilities?.role === null
        ? 'Document authority is still being resolved.'
        : 'Only the document owner can change access.';

  return (
    <div className="share-dialog">
      <div className="local-notice">
        <Icon path={serviceOwner || publicCollaborativePage ? icons.check : icons.share} size={15} />
        <span>
          <strong>{publicCollaborativePage ? 'Public collaboration' : serviceOwner ? 'Durable access control' : 'Sharing unavailable'}</strong>
          {serviceOwner ? 'Changes apply to the Rust ACL and live rooms immediately.' : unavailable}
        </span>
      </div>

      {!publicCollaborativePage && <>
        <p className="identity-note">{SHARE_GRANT_LINE}</p>

        <form className="share-invite" onSubmit={(event) => { event.preventDefault(); void grant(); }}>
        <label htmlFor="share-principal">People with access</label>
        <div className="share-input-row">
          <input id="share-principal" data-autofocus placeholder="Marks account ID" value={principal} disabled={!serviceOwner || busy} onChange={(event) => setPrincipal(event.target.value)} autoComplete="off" />
          <select aria-label="Access level" value={role} disabled={!serviceOwner || busy} onChange={(event) => setRole(event.target.value as GrantRole)}>
            <option value="editor">{ROLE_COPY.editor.label}</option>
            <option value="commenter">{ROLE_COPY.commenter.label}</option>
            <option value="viewer">{ROLE_COPY.viewer.label}</option>
          </select>
          <button type="submit" className="button" disabled={!principal.trim() || !serviceOwner || busy}>Grant</button>
        </div>
        </form>

        <div className="access-list">
        <div className="access-person">
          <span className="avatar avatar-self">Y</span>
          <span><strong>You</strong><small>{ROLE_COPY.owner.detail}</small></span>
          <span>{capabilities?.role === 'owner' ? ROLE_COPY.owner.label : 'Current device'}</span>
        </div>
        {shares.map((entry) => (
          <div className="access-person" key={entry.principalId}>
            <span className="avatar">{entry.principalId[0]?.toUpperCase()}</span>
            <span><strong>{entry.principalId}</strong><small>{ROLE_COPY[entry.role].detail}</small></span>
            <button type="button" className="button" disabled={busy} onClick={() => void revoke(entry.principalId)}>Remove</button>
          </div>
        ))}
        </div>

        <section className="identity-section">
        <h3>Bearer link</h3>
        <div className="share-input-row share-link-grant">
          <select aria-label="Link role" value={linkRole} disabled={!serviceOwner || busy} onChange={(event) => setLinkRole(event.target.value as GrantRole)}>
            <option value="editor">{ROLE_COPY.editor.label}</option>
            <option value="commenter">{ROLE_COPY.commenter.label}</option>
            <option value="viewer">{ROLE_COPY.viewer.label}</option>
          </select>
          <select aria-label="Link lifetime" value={ttl} disabled={!serviceOwner || busy} onChange={(event) => setTtl(event.target.value as typeof ttl)}>
            {LINK_TTL_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
          <button type="button" className="button" disabled={!serviceOwner || busy} onClick={() => void mintLink()}>Create and copy</button>
        </div>
        {link && (
          <div className="share-link-row">
            <span>
              <strong>{ROLE_COPY[link.role].label} · expires {new Date(link.expiresAtMs).toLocaleString()}</strong>
              <small>The secret is after #, so it is not sent in HTTP requests or referrers.</small>
            </span>
            <button type="button" className="button" disabled={busy} onClick={() => void navigator.clipboard.writeText(link.url)}>Copy</button>
            <button type="button" className="button" disabled={busy} onClick={() => void revokeLink()}>Revoke link</button>
          </div>
        )}
        </section>
      </>}

      <div className="share-link-row">
        <span>
          <strong>{title}</strong>
          <small>
            {publicCollaborativePage
              ? 'The opaque page address grants public editor access; no extra sharing switch is needed.'
              : 'The plain page address carries no bearer token; existing access rules still apply.'}
          </small>
        </span>
        <button type="button" className="button primary" onClick={() => void copyPage()}><Icon path={icons.link} /> Copy page address</button>
      </div>
    </div>
  );
}

function notifyError(error: unknown, notify: ShareDialogProps['onNotify']): void {
  const copy = error instanceof ServiceError ? error.copy : copyForUnknownFailure();
  notify(copy.title, copy.detail, copy.tone);
}
