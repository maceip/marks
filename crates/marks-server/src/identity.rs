//! Persist the exact `marks-auth` identity path.
//!
//! `crates/marks-auth/tests/identity_wiring.rs` is the composition the HTTP
//! layer must call. Handlers supply randomness and rows; they do not invent a
//! second claim, consume, or actor model.

use crate::error::{ApiError, ApiResult};
use crate::store;
use marks_auth::{
    DeviceId, PairingRecord, PrincipalId, ScratchClaim, ScratchId, claim_scratch_document,
    mark_pairing_consumed, mark_scratch_claimed, owner_acl_row, select_scratch_claim,
};
use rusqlite::{Connection, params};

/// Move every live scratch document onto the winning principal, bump each
/// authorization epoch, revoke outstanding tickets, and write the owner ACL
/// row the protocol requires.
pub fn claim_scratch_documents(
    conn: &Connection,
    scratch_id: &ScratchId,
    principal_id: &PrincipalId,
    browser_device_id: &DeviceId,
    now: u64,
) -> ApiResult<Vec<(String, u64)>> {
    let mut statement =
        conn.prepare("SELECT id FROM documents WHERE scratch_id = ?1 AND deleted_at IS NULL")?;
    let ids: Vec<String> = statement
        .query_map(params![scratch_id.as_str()], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    let mut changed = Vec::new();
    for id in ids {
        let document_id = marks_auth::DocumentId::new(id).map_err(|_| ApiError::internal())?;
        let row = store::load_document(conn, &document_id)?.ok_or_else(ApiError::internal)?;
        let claimed = claim_scratch_document(&row.record, scratch_id, principal_id)
            .map_err(|_| ApiError::conflict())?;
        conn.execute(
            "UPDATE documents
             SET scratch_id = NULL, owner_principal_id = ?2, auth_epoch = ?3
             WHERE id = ?1 AND scratch_id = ?4",
            params![
                claimed.id.as_str(),
                principal_id.as_str(),
                store::ms(claimed.authorization_epoch),
                scratch_id.as_str(),
            ],
        )?;
        let acl = owner_acl_row(claimed.id.clone(), principal_id.clone());
        conn.execute(
            "INSERT OR IGNORE INTO document_acl
                (document_id, principal_id, role, granted_by, created_at)
             VALUES (?1, ?2, ?3, ?2, ?4)",
            params![
                acl.document_id.as_str(),
                acl.principal_id.as_str(),
                store::role_to_str(acl.role),
                store::ms(now),
            ],
        )?;
        conn.execute(
            "UPDATE document_tickets SET revoked_at = ?2
             WHERE document_id = ?1 AND consumed_at IS NULL AND revoked_at IS NULL",
            params![claimed.id.as_str(), store::ms(now)],
        )?;
        conn.execute(
            "UPDATE document_sites
             SET authority_kind = 'principal', principal_id = ?2, device_id = ?3, scratch_id = NULL
             WHERE document_id = ?1 AND scratch_id = ?4",
            params![
                claimed.id.as_str(),
                principal_id.as_str(),
                browser_device_id.as_str(),
                scratch_id.as_str()
            ],
        )?;
        changed.push((claimed.id.as_str().to_owned(), claimed.authorization_epoch));
    }
    Ok(changed)
}

/// First write claims the scratch. A retry by the same principal is
/// idempotent. A different principal is a conflict.
pub fn persist_scratch_claim(
    conn: &Connection,
    scratch_id: &ScratchId,
    principal_id: &PrincipalId,
    now: u64,
) -> ApiResult<()> {
    let scratch = store::load_scratch(conn, scratch_id)?.ok_or_else(ApiError::unauthenticated)?;
    match select_scratch_claim(&scratch, principal_id, now) {
        Ok(ScratchClaim::AlreadyClaimedByCaller) => Ok(()),
        Ok(ScratchClaim::ClaimNow) => {
            let claimed = mark_scratch_claimed(&scratch, principal_id.clone(), now)
                .map_err(|_| ApiError::conflict())?;
            let updated = conn.execute(
                "UPDATE scratch_workspaces
                 SET claimed_by = ?2, claimed_at = ?3, finalize_expires_at = ?4
                 WHERE id = ?1 AND claimed_by IS NULL",
                params![
                    scratch_id.as_str(),
                    principal_id.as_str(),
                    store::ms(claimed.claimed_at_ms.unwrap_or(now)),
                    store::ms(claimed.finalize_expires_at_ms.unwrap_or(now)),
                ],
            )?;
            if updated != 1 {
                return Err(ApiError::conflict());
            }
            Ok(())
        }
        Err(_) => Err(ApiError::conflict()),
    }
}

/// Persist `mark_pairing_consumed`. The UPDATE still requires
/// `consumed_at IS NULL` so two racing approvals cannot both win.
pub fn consume_pairing(
    conn: &Connection,
    pairing: &PairingRecord,
    principal_id: PrincipalId,
    now: u64,
) -> ApiResult<PairingRecord> {
    let consumed =
        mark_pairing_consumed(pairing, principal_id, now).map_err(|_| ApiError::conflict())?;
    let updated = conn.execute(
        "UPDATE pairings SET consumed_at = ?2, approved_principal_id = ?3
         WHERE id = ?1 AND consumed_at IS NULL",
        params![
            consumed.id.as_str(),
            store::ms(consumed.consumed_at_ms.unwrap_or(now)),
            consumed
                .approved_principal_id
                .as_ref()
                .ok_or_else(ApiError::internal)?
                .as_str(),
        ],
    )?;
    if updated != 1 {
        return Err(ApiError::conflict());
    }
    Ok(consumed)
}
