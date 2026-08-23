//! Marks authentication and authorization protocol core.
//!
//! This crate validates the security facts the Marks server needs before it
//! creates a principal, enrolls a device, issues a session, or admits an actor
//! to a document room. The product protocol is
//! `docs/AUTHN-AUTHZ-PROTOCOL.md`.
//!
//! Marks ships this one identity system:
//!
//! - one principal model;
//! - the approved scratch and phone-controller flow;
//! - the approved single-device self-bootstrap for a visitor whose only
//!   device is the one holding the scratch workspace;
//! - the existing rotating session and device model;
//! - the approved optional EVT adapter, behind its server flag;
//! - one ACL model;
//! - one room-ticket model;
//! - one Rust Marks server that consumes these validators;
//! - no auth concepts inside ESBT;
//! - no additional login, provider, or account-recovery systems unless a
//!   demonstrated requirement appears.
//!
//! HTTP, cookies, SQLite, QR rendering, and Chrome EVT parsing stay out of
//! this crate. ESBT stays identity-blind.

mod acl;
mod authorization;
mod bearer;
mod crypto;
mod dbsc;
mod device;
mod device_session;
mod document;
mod email;
mod id;
mod pairing;
mod pending;
mod promotion;
mod scratch;
mod self_bootstrap;
mod session;
mod ticket;
mod wire;
mod words;

pub use acl::{
    AclError, DocumentAclRecord, LinkGrantRecord, authorize_link_grant_role, owner_acl_row,
    redeem_link_grant, resolve_document_role,
};
pub use authorization::{
    Actor, DocumentAction, DocumentRole, RoomActor, ScratchActor, authorize_document_action,
    authorize_room_action,
};
pub use bearer::{
    BearerError, ESBT_SUBPROTOCOL, PAIRING_FRAGMENT_PREFIX, SCRATCH_AUTHORIZATION_SCHEME,
    SESSION_COOKIE_NAME, TICKET_SUBPROTOCOL_PREFIX, decode_bearer_secret, encode_bearer_secret,
    parse_pairing_fragment, parse_scratch_authorization, parse_session_cookie,
    parse_ticket_subprotocol,
};
pub use crypto::{bearer_secret_hash, public_key_hash};
pub use dbsc::{
    AuthorizedDbscRegistration, DbscChallengeRecord, DbscError, authorize_dbsc_refresh,
    authorize_dbsc_registration, dbsc_jwk_to_sec1, peek_dbsc_challenge_hash,
};
pub use device::{
    CapabilityError, DeviceCapabilities, DeviceError, DeviceRecord, authorize_revoke_device,
};
pub use device_session::{
    AuthenticatedDevice, DeviceChallengeRecord, DeviceSessionError, DeviceSessionProof,
    authorize_device_session,
};
pub use document::{
    DocumentError, DocumentOwner, DocumentRecord, PrincipalRecord, bump_authorization_epoch,
    claim_scratch_document, require_active_principal, require_live_document,
    require_principal_document, require_scratch_document,
};
pub use email::{
    AuthorizedEmailPromotion, EmailChallengeRecord, EmailLocator, EmailLocatorError,
    VerifiedEmailEvidence, VerifiedEmailLocatorRecord, authorize_email_promotion,
    derive_email_locator, validate_verified_email_evidence,
};
pub use id::{
    ChallengeId, ControllerId, DeviceId, DocumentId, EsbtSiteId, IdError, PairingId, PrincipalId,
    ScratchId, SessionId, TicketId, allocate_esbt_site,
};
pub use pairing::{
    AuthorizedBootstrap, AuthorizedFinalize, AuthorizedPairing, ControllerBootstrap,
    ControllerRecord, DeviceGrant, PairingError, PairingRecord, authorize_controller_bootstrap,
    authorize_controller_bootstrap_words, authorize_pairing, authorize_pairing_finalize,
    authorize_pairing_inspect, authorize_pairing_inspect_words, authorize_pairing_request,
    authorize_pairing_words, mark_pairing_consumed, pairing_matches_pending, pairing_secret_hash,
};
pub use pending::{
    PendingDeviceError, PendingDeviceRecord, bind_pending_device, require_live_pending_device,
};
pub use promotion::{
    PromotionError, ScratchClaim, SelectedPrincipal, authorize_locator_attach,
    claimed_scratch_matches, select_principal_for_controller_grant,
    select_principal_for_email_locator, select_scratch_claim,
};
pub use scratch::{
    ClaimedScratchAuthority, SCRATCH_FINALIZE_WINDOW_MS, ScratchAuthority, ScratchError,
    ScratchRecord, mark_scratch_claimed, scratch_capability_hash,
    validate_claimed_scratch_capability, validate_scratch_capability,
};
pub use self_bootstrap::{
    AuthorizedSelfBootstrap, SELF_BOOTSTRAP_WINDOW_MS, SelfBootstrap, SelfBootstrapError,
    authorize_self_bootstrap,
};
pub use session::{
    AuthenticatedSession, SessionError, SessionRecord, session_csrf_token, session_secret_hash,
    validate_session, validate_session_csrf,
};
pub use ticket::{
    DOCUMENT_TICKET_TTL_MS, DocumentTicketError, DocumentTicketRecord, ScratchDocumentTicketRecord,
    issue_document_ticket, issue_scratch_document_ticket, redeem_document_ticket,
    redeem_scratch_document_ticket, ticket_secret_hash,
};
pub use words::{
    PAIRING_WORD_COUNT, generate_pairing_words, normalize_pairing_words, pairing_word_code_hash,
};
