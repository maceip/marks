//! Proves the public validators compose into one identity path.
//!
//! There is no HTTP/database server in this crate. This test is the seam the
//! future `marks-server` must call, in this order, without inventing a second
//! principal or actor model.

use marks_auth::{
    Actor, ControllerBootstrap, ControllerRecord, DeviceCapabilities, DeviceChallengeRecord,
    DeviceId, DeviceRecord, DeviceSessionProof, DocumentAction, DocumentId, DocumentOwner,
    DocumentRecord, DocumentRole, EsbtSiteId, PairingId, PairingRecord, PrincipalId,
    PrincipalRecord, RoomActor, ScratchId, ScratchRecord, SelectedPrincipal, SessionId,
    SessionRecord, TicketId, allocate_esbt_site, authorize_controller_bootstrap,
    authorize_device_session, authorize_document_action, authorize_pairing_finalize,
    authorize_pairing_request, authorize_room_action, bind_pending_device, claim_scratch_document,
    issue_document_ticket, issue_scratch_document_ticket, mark_pairing_consumed,
    mark_scratch_claimed, owner_acl_row, pairing_secret_hash, redeem_document_ticket,
    redeem_scratch_document_ticket, require_active_principal, resolve_document_role,
    scratch_capability_hash, select_principal_for_controller_grant, select_scratch_claim,
    session_secret_hash, validate_claimed_scratch_capability, validate_scratch_capability,
    validate_session,
};
use p256::ecdsa::{Signature, SigningKey, signature::Signer};
use rand_core::OsRng;

#[test]
fn scratch_phone_bootstrap_finalize_session_and_room_actor_are_one_path() {
    let now_ms = 11_000;
    let capability = [9_u8; 32];
    let pairing_secret = [7_u8; 32];
    let session_secret = [5_u8; 32];
    let ticket_secret = [4_u8; 32];

    let scratch = ScratchRecord {
        id: ScratchId::new("scratch_123456").unwrap(),
        capability_hash: scratch_capability_hash(&capability),
        expires_at_ms: 86_400_000,
        claimed_by: None,
        claimed_at_ms: None,
        finalize_expires_at_ms: None,
        revoked_at_ms: None,
    };
    let authority = validate_scratch_capability(&scratch, &capability, now_ms).unwrap();

    let pending_key = SigningKey::random(&mut OsRng);
    let pending_public = pending_key.verifying_key().to_encoded_point(false);
    let pending = bind_pending_device(
        &authority,
        DeviceId::new("device_1234567").unwrap(),
        pending_public.as_bytes(),
        now_ms,
        86_400_000,
    )
    .unwrap();
    authorize_pairing_request(&authority, &pending, now_ms).unwrap();

    let pairing = PairingRecord {
        id: PairingId::new("pairing_123456").unwrap(),
        scratch_id: scratch.id.clone(),
        pending_device_id: pending.id.clone(),
        pending_device_public_key_hash: pending.public_key_hash,
        secret_hash: pairing_secret_hash(&pairing_secret),
        expires_at_ms: now_ms + 120_000,
        consumed_at_ms: None,
        approved_principal_id: None,
    };

    let phone_key = SigningKey::random(&mut OsRng);
    let phone_public = phone_key.verifying_key().to_encoded_point(false);
    let bootstrap = ControllerBootstrap {
        version: 1,
        controller_id: marks_auth::ControllerId::new("controller_phone1").unwrap(),
        controller_device_id: DeviceId::new("device_phone_123").unwrap(),
        controller_public_key_hash: marks_auth::public_key_hash(phone_public.as_bytes()),
        pairing_id: pairing.id.clone(),
        scratch_id: pairing.scratch_id.clone(),
        pending_device_id: pairing.pending_device_id.clone(),
        pending_device_public_key_hash: pairing.pending_device_public_key_hash,
        issued_at_ms: now_ms - 1_000,
        expires_at_ms: pairing.expires_at_ms,
    };
    let signature: Signature = phone_key.sign(&bootstrap.signing_bytes());
    let signature: [u8; 64] = signature.to_bytes().into();
    let authorized = authorize_controller_bootstrap(
        &pairing,
        &pairing_secret,
        &bootstrap,
        phone_public.as_bytes(),
        &signature,
        now_ms,
    )
    .unwrap();

    let principal = PrincipalId::new("principal_1234").unwrap();
    let principal_row = PrincipalRecord {
        id: principal.clone(),
        disabled_at_ms: None,
    };
    require_active_principal(&principal_row).unwrap();

    let controller = ControllerRecord {
        id: authorized.controller_id.clone(),
        principal_id: principal.clone(),
        public_key_sec1: authorized.controller_public_key_sec1.clone(),
        epoch: 1,
        capabilities: DeviceCapabilities::CONTROLLER,
        revoked_at_ms: None,
    };
    assert_eq!(
        select_principal_for_controller_grant(&controller).unwrap(),
        SelectedPrincipal::Existing(principal.clone())
    );

    let document = DocumentRecord {
        id: DocumentId::new("document_12345").unwrap(),
        owner: DocumentOwner::Scratch(scratch.id.clone()),
        authorization_epoch: 1,
        deleted_at_ms: None,
    };
    let scratch_site = allocate_esbt_site([]).unwrap();
    let scratch_ticket = issue_scratch_document_ticket(
        TicketId::new("ticket_scratch1").unwrap(),
        &ticket_secret,
        &scratch,
        &document,
        scratch_site,
        now_ms,
    )
    .unwrap();
    let scratch_actor = redeem_scratch_document_ticket(
        &scratch_ticket,
        &ticket_secret,
        &scratch,
        &document,
        &scratch_site,
        now_ms + 1,
    )
    .unwrap();
    assert!(authorize_room_action(
        &RoomActor::Scratch(scratch_actor),
        DocumentAction::EditText
    ));

    assert_eq!(
        select_scratch_claim(&scratch, &principal, now_ms).unwrap(),
        marks_auth::ScratchClaim::ClaimNow
    );
    let claimed_scratch = mark_scratch_claimed(&scratch, principal.clone(), now_ms).unwrap();
    let claimed_document = claim_scratch_document(&document, &scratch.id, &principal).unwrap();
    let acl = [owner_acl_row(
        claimed_document.id.clone(),
        principal.clone(),
    )];
    assert_eq!(
        resolve_document_role(&claimed_document, &principal, &acl).unwrap(),
        DocumentRole::Owner
    );
    assert_eq!(claimed_document.authorization_epoch, 2);

    assert_eq!(
        redeem_scratch_document_ticket(
            &scratch_ticket,
            &ticket_secret,
            &claimed_scratch,
            &document,
            &scratch_site,
            now_ms + 1,
        ),
        Err(marks_auth::DocumentTicketError::ScratchInactive)
    );

    let pairing = mark_pairing_consumed(&pairing, principal.clone(), now_ms).unwrap();
    let claimed =
        validate_claimed_scratch_capability(&claimed_scratch, &capability, now_ms + 1).unwrap();
    let finalized = authorize_pairing_finalize(&pairing, &pending, &claimed).unwrap();
    assert_eq!(finalized.pending_device_id, pending.id);

    let browser_device = DeviceRecord {
        id: pending.id.clone(),
        principal_id: principal.clone(),
        public_key_sec1: pending.public_key_sec1.clone(),
        key_epoch: 1,
        capabilities: DeviceCapabilities::MEMBER,
        revoked_at_ms: None,
    };
    let session = SessionRecord {
        id: SessionId::new("session_12345").unwrap(),
        principal_id: principal.clone(),
        device_id: browser_device.id.clone(),
        secret_hash: session_secret_hash(&session_secret),
        expires_at_ms: now_ms + 86_400_000,
        revoked_at_ms: None,
    };
    let authenticated =
        validate_session(&session, &session_secret, &browser_device, now_ms).unwrap();

    let challenge_bytes = [6_u8; 32];
    let challenge = DeviceChallengeRecord {
        id: marks_auth::ChallengeId::new("challenge_12345").unwrap(),
        device_id: browser_device.id.clone(),
        key_epoch: browser_device.key_epoch,
        challenge_hash: marks_auth::bearer_secret_hash(&challenge_bytes),
        audience: "https://marks.example".into(),
        expires_at_ms: now_ms + 120_000,
        consumed_at_ms: None,
    };
    let proof = DeviceSessionProof {
        version: 1,
        challenge_id: challenge.id.clone(),
        device_id: browser_device.id.clone(),
        device_key_epoch: browser_device.key_epoch,
        audience: challenge.audience.clone(),
        challenge: challenge_bytes,
        issued_at_ms: now_ms,
        expires_at_ms: challenge.expires_at_ms,
    };
    let device_signature: Signature = pending_key.sign(&proof.signing_bytes());
    let device_signature: [u8; 64] = device_signature.to_bytes().into();
    let silent = authorize_device_session(
        &challenge,
        &browser_device,
        &proof,
        &device_signature,
        now_ms + 1,
    )
    .unwrap();
    assert_eq!(silent.principal_id, principal);

    let site = allocate_esbt_site([EsbtSiteId::SERVER]).unwrap();
    let ticket = issue_document_ticket(
        TicketId::new("ticket_12345678").unwrap(),
        &ticket_secret,
        &authenticated,
        &claimed_document,
        resolve_document_role(&claimed_document, authenticated.principal_id(), &acl).unwrap(),
        site,
        now_ms,
    )
    .unwrap();
    let actor: Actor = redeem_document_ticket(
        &ticket,
        &ticket_secret,
        &authenticated,
        &claimed_document,
        &site,
        now_ms + 1,
    )
    .unwrap();
    assert_eq!(actor.role, DocumentRole::Owner);
    assert!(authorize_room_action(
        &RoomActor::Principal(actor.clone()),
        DocumentAction::EditText
    ));
    assert!(!authorize_document_action(
        DocumentRole::Viewer,
        DocumentAction::EditText
    ));
}
