//! Marks authentication and authorization protocol core.
//!
//! This crate deliberately knows nothing about ESBT operations, HTTP, cookies,
//! SQLite, QR rendering, or Chrome's experimental EVT surface. It validates
//! the security facts the Marks server needs before it creates a principal,
//! enrolls a device, issues a session, or admits an actor to a document room.
//!
//! The product protocol is specified in `docs/AUTHN-AUTHZ-PROTOCOL.md`.

mod authorization;
mod crypto;
mod device;
mod device_session;
mod email;
mod id;
mod pairing;
mod scratch;
mod session;
mod ticket;
mod wire;

pub use authorization::{
    Actor, DocumentAction, DocumentRole, RoomActor, ScratchActor, authorize_document_action,
    authorize_room_action,
};
pub use crypto::{bearer_secret_hash, public_key_hash};
pub use device::{CapabilityError, DeviceCapabilities, DeviceRecord};
pub use device_session::{
    AuthenticatedDevice, DeviceChallengeRecord, DeviceSessionError, DeviceSessionProof,
    authorize_device_session,
};
pub use email::{
    AuthorizedEmailPromotion, EmailChallengeRecord, EmailLocator, EmailLocatorError,
    VerifiedEmailEvidence, authorize_email_promotion, derive_email_locator,
    validate_verified_email_evidence,
};
pub use id::{
    ChallengeId, ControllerId, DeviceId, DocumentId, PairingId, PrincipalId, ScratchId, SessionId,
    SiteId, TicketId,
};
pub use pairing::{
    AuthorizedBootstrap, AuthorizedPairing, ControllerBootstrap, ControllerRecord, DeviceGrant,
    PairingError, PairingRecord, authorize_controller_bootstrap, authorize_pairing,
    pairing_secret_hash,
};
pub use scratch::{
    ClaimedScratchAuthority, ScratchAuthority, ScratchError, ScratchRecord,
    scratch_capability_hash, validate_claimed_scratch_capability, validate_scratch_capability,
};
pub use session::{
    AuthenticatedSession, SessionError, SessionRecord, session_secret_hash, validate_session,
};
pub use ticket::{
    DocumentTicketError, DocumentTicketRecord, ScratchDocumentTicketRecord, redeem_document_ticket,
    redeem_scratch_document_ticket, ticket_secret_hash,
};
