use crate::crypto::bearer_matches;
use crate::{
    Actor, AuthenticatedSession, DeviceId, DocumentId, DocumentOwner, DocumentRecord, DocumentRole,
    EsbtSiteId, PrincipalId, ScratchActor, ScratchId, ScratchRecord, SessionId, TicketId,
    bearer_secret_hash, require_live_document, require_scratch_document,
};
use thiserror::Error;

const TICKET_SECRET_BYTES: usize = 32;
pub const DOCUMENT_TICKET_TTL_MS: u64 = 30_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DocumentTicketRecord {
    pub id: TicketId,
    pub secret_hash: [u8; 32],
    pub principal_id: PrincipalId,
    pub session_id: SessionId,
    pub device_id: DeviceId,
    pub document_id: DocumentId,
    pub esbt_site: EsbtSiteId,
    pub role: DocumentRole,
    pub authorization_epoch: u64,
    pub expires_at_ms: u64,
    pub consumed_at_ms: Option<u64>,
    pub revoked_at_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScratchDocumentTicketRecord {
    pub id: TicketId,
    pub secret_hash: [u8; 32],
    pub scratch_id: ScratchId,
    pub document_id: DocumentId,
    pub esbt_site: EsbtSiteId,
    pub authorization_epoch: u64,
    pub expires_at_ms: u64,
    pub consumed_at_ms: Option<u64>,
    pub revoked_at_ms: Option<u64>,
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum DocumentTicketError {
    #[error("document ticket secret is invalid")]
    InvalidSecret,
    #[error("document ticket was already consumed")]
    Consumed,
    #[error("document ticket is revoked")]
    Revoked,
    #[error("document ticket is expired")]
    Expired,
    #[error("document ticket session is expired or revoked")]
    SessionInactive,
    #[error("document ticket is not bound to this session")]
    SessionMismatch,
    #[error("document ticket is not bound to this document")]
    DocumentMismatch,
    #[error("document ticket is not bound to this ESBT replica")]
    SiteMismatch,
    #[error("document is deleted or not owned by this authority")]
    DocumentInactive,
    #[error("document authorization changed after this ticket was issued")]
    AuthorizationStale,
    #[error("scratch document ticket is not bound to this scratch workspace")]
    ScratchMismatch,
    #[error("scratch workspace is expired, revoked, or already claimed")]
    ScratchInactive,
}

fn require_live_presented_ticket(
    secret_hash: &[u8; 32],
    presented_secret: &[u8],
    consumed_at_ms: Option<u64>,
    revoked_at_ms: Option<u64>,
    expires_at_ms: u64,
    now_ms: u64,
) -> Result<(), DocumentTicketError> {
    if !bearer_matches(presented_secret, TICKET_SECRET_BYTES, secret_hash) {
        return Err(DocumentTicketError::InvalidSecret);
    }
    if consumed_at_ms.is_some() {
        return Err(DocumentTicketError::Consumed);
    }
    if revoked_at_ms.is_some() {
        return Err(DocumentTicketError::Revoked);
    }
    if now_ms >= expires_at_ms {
        return Err(DocumentTicketError::Expired);
    }
    Ok(())
}

fn require_live_scratch(scratch: &ScratchRecord, now_ms: u64) -> Result<(), DocumentTicketError> {
    if scratch.revoked_at_ms.is_some()
        || scratch.claimed_by.is_some()
        || now_ms >= scratch.expires_at_ms
    {
        Err(DocumentTicketError::ScratchInactive)
    } else {
        Ok(())
    }
}

/// Redeem a one-use room ticket for a still-unclaimed scratch workspace. The
/// caller first used the scratch capability to mint this ticket; upgrade
/// rechecks the live scratch row, current document ownership, and epoch.
pub fn redeem_scratch_document_ticket(
    ticket: &ScratchDocumentTicketRecord,
    presented_secret: &[u8],
    scratch: &ScratchRecord,
    document: &DocumentRecord,
    expected_esbt_site: &EsbtSiteId,
    now_ms: u64,
) -> Result<ScratchActor, DocumentTicketError> {
    require_live_presented_ticket(
        &ticket.secret_hash,
        presented_secret,
        ticket.consumed_at_ms,
        ticket.revoked_at_ms,
        ticket.expires_at_ms,
        now_ms,
    )?;
    if ticket.scratch_id != scratch.id {
        return Err(DocumentTicketError::ScratchMismatch);
    }
    require_live_scratch(scratch, now_ms)?;
    require_scratch_document(document, &scratch.id)
        .map_err(|_| DocumentTicketError::DocumentInactive)?;
    if ticket.document_id != document.id {
        return Err(DocumentTicketError::DocumentMismatch);
    }
    if &ticket.esbt_site != expected_esbt_site {
        return Err(DocumentTicketError::SiteMismatch);
    }
    if ticket.authorization_epoch != document.authorization_epoch {
        return Err(DocumentTicketError::AuthorizationStale);
    }

    Ok(ScratchActor {
        scratch_id: ticket.scratch_id.clone(),
        document_id: ticket.document_id.clone(),
        esbt_site: ticket.esbt_site,
        authorization_epoch: ticket.authorization_epoch,
    })
}

pub fn ticket_secret_hash(secret: &[u8]) -> [u8; 32] {
    bearer_secret_hash(secret)
}

fn require_client_site(esbt_site: EsbtSiteId) -> Result<EsbtSiteId, DocumentTicketError> {
    if esbt_site == EsbtSiteId::SERVER {
        Err(DocumentTicketError::SiteMismatch)
    } else {
        Ok(esbt_site)
    }
}

fn require_ticket_secret(secret: &[u8]) -> Result<[u8; 32], DocumentTicketError> {
    if secret.len() != TICKET_SECRET_BYTES {
        return Err(DocumentTicketError::InvalidSecret);
    }
    Ok(ticket_secret_hash(secret))
}

/// Mint a 30-second principal ticket after the caller has resolved the role.
pub fn issue_document_ticket(
    id: TicketId,
    secret: &[u8],
    session: &AuthenticatedSession,
    document: &DocumentRecord,
    role: DocumentRole,
    esbt_site: EsbtSiteId,
    now_ms: u64,
) -> Result<DocumentTicketRecord, DocumentTicketError> {
    require_live_document(document).map_err(|_| DocumentTicketError::DocumentInactive)?;
    if matches!(document.owner, DocumentOwner::Scratch(_)) {
        return Err(DocumentTicketError::DocumentInactive);
    }
    if now_ms >= session.expires_at_ms() {
        return Err(DocumentTicketError::SessionInactive);
    }
    Ok(DocumentTicketRecord {
        id,
        secret_hash: require_ticket_secret(secret)?,
        principal_id: session.principal_id().clone(),
        session_id: session.id().clone(),
        device_id: session.device_id().clone(),
        document_id: document.id.clone(),
        esbt_site: require_client_site(esbt_site)?,
        role,
        authorization_epoch: document.authorization_epoch,
        expires_at_ms: now_ms.saturating_add(DOCUMENT_TICKET_TTL_MS),
        consumed_at_ms: None,
        revoked_at_ms: None,
    })
}

/// Mint a 30-second scratch ticket for a still-unclaimed private document.
pub fn issue_scratch_document_ticket(
    id: TicketId,
    secret: &[u8],
    scratch: &ScratchRecord,
    document: &DocumentRecord,
    esbt_site: EsbtSiteId,
    now_ms: u64,
) -> Result<ScratchDocumentTicketRecord, DocumentTicketError> {
    require_scratch_document(document, &scratch.id)
        .map_err(|_| DocumentTicketError::DocumentInactive)?;
    require_live_scratch(scratch, now_ms)?;
    Ok(ScratchDocumentTicketRecord {
        id,
        secret_hash: require_ticket_secret(secret)?,
        scratch_id: scratch.id.clone(),
        document_id: document.id.clone(),
        esbt_site: require_client_site(esbt_site)?,
        authorization_epoch: document.authorization_epoch,
        expires_at_ms: now_ms.saturating_add(DOCUMENT_TICKET_TTL_MS),
        consumed_at_ms: None,
        revoked_at_ms: None,
    })
}

/// Redeem a one-use document ticket into the actor attached to a WebSocket.
/// The caller must mark the ticket consumed atomically before admitting the
/// socket; this pure validator cannot serialize concurrent upgrades.
pub fn redeem_document_ticket(
    ticket: &DocumentTicketRecord,
    presented_secret: &[u8],
    session: &AuthenticatedSession,
    document: &DocumentRecord,
    expected_esbt_site: &EsbtSiteId,
    now_ms: u64,
) -> Result<Actor, DocumentTicketError> {
    require_live_presented_ticket(
        &ticket.secret_hash,
        presented_secret,
        ticket.consumed_at_ms,
        ticket.revoked_at_ms,
        ticket.expires_at_ms,
        now_ms,
    )?;
    require_live_document(document).map_err(|_| DocumentTicketError::DocumentInactive)?;
    if matches!(document.owner, DocumentOwner::Scratch(_)) {
        return Err(DocumentTicketError::DocumentInactive);
    }
    if now_ms >= session.expires_at_ms() {
        return Err(DocumentTicketError::SessionInactive);
    }
    if &ticket.session_id != session.id()
        || &ticket.principal_id != session.principal_id()
        || &ticket.device_id != session.device_id()
    {
        return Err(DocumentTicketError::SessionMismatch);
    }
    if ticket.document_id != document.id {
        return Err(DocumentTicketError::DocumentMismatch);
    }
    if &ticket.esbt_site != expected_esbt_site {
        return Err(DocumentTicketError::SiteMismatch);
    }
    if ticket.authorization_epoch != document.authorization_epoch {
        return Err(DocumentTicketError::AuthorizationStale);
    }

    Ok(Actor {
        principal_id: ticket.principal_id.clone(),
        session_id: ticket.session_id.clone(),
        device_id: ticket.device_id.clone(),
        document_id: ticket.document_id.clone(),
        esbt_site: ticket.esbt_site,
        role: ticket.role,
        authorization_epoch: ticket.authorization_epoch,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        DeviceCapabilities, DeviceRecord, SessionRecord, session_secret_hash, validate_session,
    };

    fn ticket() -> (DocumentTicketRecord, AuthenticatedSession, [u8; 32]) {
        let principal_id = PrincipalId::new("principal_1234").unwrap();
        let session_id = SessionId::new("session_12345").unwrap();
        let device_id = DeviceId::new("device_1234567").unwrap();
        let secret = [4_u8; 32];
        (
            DocumentTicketRecord {
                id: TicketId::new("ticket_12345678").unwrap(),
                secret_hash: ticket_secret_hash(&secret),
                principal_id: principal_id.clone(),
                session_id: session_id.clone(),
                device_id: device_id.clone(),
                document_id: DocumentId::new("document_12345").unwrap(),
                esbt_site: EsbtSiteId::new(2).unwrap(),
                role: DocumentRole::Editor,
                authorization_epoch: 4,
                expires_at_ms: 10_000,
                consumed_at_ms: None,
                revoked_at_ms: None,
            },
            authenticated_session(session_id, principal_id, device_id),
            secret,
        )
    }

    fn authenticated_session(
        session_id: SessionId,
        principal_id: PrincipalId,
        device_id: DeviceId,
    ) -> AuthenticatedSession {
        let session_secret = [7_u8; 32];
        let session = SessionRecord {
            id: session_id,
            principal_id: principal_id.clone(),
            device_id: device_id.clone(),
            secret_hash: session_secret_hash(&session_secret),
            expires_at_ms: 20_000,
            revoked_at_ms: None,
        };
        let device = DeviceRecord {
            id: device_id,
            principal_id,
            public_key_sec1: vec![4; 33],
            key_epoch: 1,
            capabilities: DeviceCapabilities::MEMBER,
            revoked_at_ms: None,
        };
        validate_session(&session, &session_secret, &device, 1_000).unwrap()
    }

    fn principal_document(ticket: &DocumentTicketRecord) -> DocumentRecord {
        DocumentRecord {
            id: ticket.document_id.clone(),
            owner: DocumentOwner::Principal(ticket.principal_id.clone()),
            authorization_epoch: ticket.authorization_epoch,
            deleted_at_ms: None,
        }
    }

    fn scratch_document(
        ticket: &ScratchDocumentTicketRecord,
        scratch_id: ScratchId,
    ) -> DocumentRecord {
        DocumentRecord {
            id: ticket.document_id.clone(),
            owner: DocumentOwner::Scratch(scratch_id),
            authorization_epoch: ticket.authorization_epoch,
            deleted_at_ms: None,
        }
    }

    #[test]
    fn ticket_redeems_to_an_exact_socket_actor() {
        let (ticket, session, secret) = ticket();
        let actor = redeem_document_ticket(
            &ticket,
            &secret,
            &session,
            &principal_document(&ticket),
            &ticket.esbt_site,
            9_000,
        )
        .unwrap();

        assert_eq!(actor.principal_id, ticket.principal_id);
        assert_eq!(actor.document_id, ticket.document_id);
        assert_eq!(actor.esbt_site, ticket.esbt_site);
        assert_eq!(actor.role, DocumentRole::Editor);
    }

    #[test]
    fn replay_cross_document_and_cross_site_redemption_fail() {
        let (mut replayed_ticket, session, secret) = ticket();
        replayed_ticket.consumed_at_ms = Some(8_000);
        assert_eq!(
            redeem_document_ticket(
                &replayed_ticket,
                &secret,
                &session,
                &principal_document(&replayed_ticket),
                &replayed_ticket.esbt_site,
                9_000,
            ),
            Err(DocumentTicketError::Consumed)
        );

        let (ticket, session, secret) = ticket();
        let mut other_document = principal_document(&ticket);
        other_document.id = DocumentId::new("document_other1").unwrap();
        assert_eq!(
            redeem_document_ticket(
                &ticket,
                &secret,
                &session,
                &other_document,
                &ticket.esbt_site,
                9_000,
            ),
            Err(DocumentTicketError::DocumentMismatch)
        );
        assert_eq!(
            redeem_document_ticket(
                &ticket,
                &secret,
                &session,
                &principal_document(&ticket),
                &EsbtSiteId::new(9).unwrap(),
                9_000,
            ),
            Err(DocumentTicketError::SiteMismatch)
        );
    }

    #[test]
    fn ticket_is_bound_to_the_issuing_session() {
        let (ticket, _session, secret) = ticket();
        let other_session = authenticated_session(
            SessionId::new("session_other1").unwrap(),
            ticket.principal_id.clone(),
            ticket.device_id.clone(),
        );
        assert_eq!(
            redeem_document_ticket(
                &ticket,
                &secret,
                &other_session,
                &principal_document(&ticket),
                &ticket.esbt_site,
                9_000,
            ),
            Err(DocumentTicketError::SessionMismatch)
        );
    }

    #[test]
    fn acl_epoch_change_invalidates_an_unconsumed_ticket() {
        let (ticket, session, secret) = ticket();
        let mut document = principal_document(&ticket);
        document.authorization_epoch += 1;
        assert_eq!(
            redeem_document_ticket(
                &ticket,
                &secret,
                &session,
                &document,
                &ticket.esbt_site,
                9_000,
            ),
            Err(DocumentTicketError::AuthorizationStale)
        );
    }

    #[test]
    fn live_scratch_ticket_redeems_without_inventing_a_principal() {
        let secret = [5_u8; 32];
        let scratch = ScratchRecord {
            id: ScratchId::new("scratch_123456").unwrap(),
            capability_hash: [0; 32],
            expires_at_ms: 20_000,
            claimed_by: None,
            claimed_at_ms: None,
            finalize_expires_at_ms: None,
            revoked_at_ms: None,
        };
        let ticket = ScratchDocumentTicketRecord {
            id: TicketId::new("ticket_scratch1").unwrap(),
            secret_hash: ticket_secret_hash(&secret),
            scratch_id: scratch.id.clone(),
            document_id: DocumentId::new("document_12345").unwrap(),
            esbt_site: EsbtSiteId::new(2).unwrap(),
            authorization_epoch: 2,
            expires_at_ms: 10_000,
            consumed_at_ms: None,
            revoked_at_ms: None,
        };

        let actor = redeem_scratch_document_ticket(
            &ticket,
            &secret,
            &scratch,
            &scratch_document(&ticket, scratch.id.clone()),
            &ticket.esbt_site,
            9_000,
        )
        .unwrap();
        assert_eq!(actor.scratch_id, scratch.id);
    }

    #[test]
    fn claiming_scratch_invalidates_its_unconsumed_room_ticket() {
        let secret = [5_u8; 32];
        let scratch_id = ScratchId::new("scratch_123456").unwrap();
        let scratch = ScratchRecord {
            id: scratch_id.clone(),
            capability_hash: [0; 32],
            expires_at_ms: 20_000,
            claimed_by: Some(PrincipalId::new("principal_1234").unwrap()),
            claimed_at_ms: Some(8_000),
            finalize_expires_at_ms: Some(8_000 + crate::SCRATCH_FINALIZE_WINDOW_MS),
            revoked_at_ms: None,
        };
        let ticket = ScratchDocumentTicketRecord {
            id: TicketId::new("ticket_scratch1").unwrap(),
            secret_hash: ticket_secret_hash(&secret),
            scratch_id: scratch_id.clone(),
            document_id: DocumentId::new("document_12345").unwrap(),
            esbt_site: EsbtSiteId::new(2).unwrap(),
            authorization_epoch: 2,
            expires_at_ms: 10_000,
            consumed_at_ms: None,
            revoked_at_ms: None,
        };

        assert_eq!(
            redeem_scratch_document_ticket(
                &ticket,
                &secret,
                &scratch,
                &scratch_document(&ticket, scratch_id.clone()),
                &ticket.esbt_site,
                9_000,
            ),
            Err(DocumentTicketError::ScratchInactive)
        );
    }

    #[test]
    fn issued_principal_ticket_redeems_to_the_same_actor() {
        let (existing, session, secret) = ticket();
        let document = DocumentRecord {
            id: existing.document_id.clone(),
            owner: DocumentOwner::Principal(existing.principal_id.clone()),
            authorization_epoch: existing.authorization_epoch,
            deleted_at_ms: None,
        };
        let issued = issue_document_ticket(
            existing.id.clone(),
            &secret,
            &session,
            &document,
            DocumentRole::Editor,
            existing.esbt_site,
            9_000,
        )
        .unwrap();
        let actor = redeem_document_ticket(
            &issued,
            &secret,
            &session,
            &document,
            &issued.esbt_site,
            9_500,
        )
        .unwrap();
        assert_eq!(actor.role, DocumentRole::Editor);
        assert_eq!(actor.esbt_site.as_u32(), 2);
        assert_eq!(
            issue_document_ticket(
                existing.id,
                &secret,
                &session,
                &document,
                DocumentRole::Editor,
                EsbtSiteId::SERVER,
                9_000,
            ),
            Err(DocumentTicketError::SiteMismatch)
        );
    }
}
