//! Typed row loaders. Every function maps database rows into the exact
//! `marks-auth` record types so authorization always flows through the pure
//! validators instead of ad hoc SQL predicates.

use crate::error::{ApiError, ApiResult};
use marks_auth::{
    ChallengeId, ControllerId, ControllerRecord, DeviceCapabilities, DeviceChallengeRecord,
    DeviceId, DocumentAclRecord, DocumentId, DocumentOwner, DocumentRecord, DocumentRole,
    EsbtSiteId, PairingId, PairingRecord, PendingDeviceRecord, PrincipalId, PrincipalRecord,
    ScratchId, ScratchRecord, SessionId, SessionRecord, TicketId,
};
use rusqlite::{Connection, OptionalExtension, params};

pub fn ms(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

/// Exact unsigned values used as SQLite identities must never alias through
/// the timestamp-oriented saturating conversion above.
pub fn exact_i64(value: u64) -> ApiResult<i64> {
    i64::try_from(value).map_err(|_| ApiError::internal())
}

pub fn from_ms(value: i64) -> u64 {
    u64::try_from(value).unwrap_or_default()
}

pub fn role_to_str(role: DocumentRole) -> &'static str {
    match role {
        DocumentRole::Owner => "owner",
        DocumentRole::Editor => "editor",
        DocumentRole::Commenter => "commenter",
        DocumentRole::Viewer => "viewer",
    }
}

pub fn role_from_str(text: &str) -> ApiResult<DocumentRole> {
    // Unknown roles fail closed.
    match text {
        "owner" => Ok(DocumentRole::Owner),
        "editor" => Ok(DocumentRole::Editor),
        "commenter" => Ok(DocumentRole::Commenter),
        "viewer" => Ok(DocumentRole::Viewer),
        _ => Err(ApiError::internal()),
    }
}

pub fn hash32(blob: Vec<u8>) -> ApiResult<[u8; 32]> {
    blob.try_into().map_err(|_| ApiError::internal())
}

fn opt_ms(value: Option<i64>) -> Option<u64> {
    value.map(from_ms)
}

pub fn load_principal(conn: &Connection, id: &PrincipalId) -> ApiResult<Option<PrincipalRecord>> {
    conn.query_row(
        "SELECT id, disabled_at FROM principals WHERE id = ?1",
        params![id.as_str()],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?)),
    )
    .optional()?
    .map(|(id, disabled_at)| {
        Ok(PrincipalRecord {
            id: PrincipalId::new(id).map_err(|_| ApiError::internal())?,
            disabled_at_ms: opt_ms(disabled_at),
        })
    })
    .transpose()
}

pub fn load_scratch(conn: &Connection, id: &ScratchId) -> ApiResult<Option<ScratchRecord>> {
    conn.query_row(
        "SELECT id, capability_hash, expires_at, claimed_by, claimed_at, finalize_expires_at,
                revoked_at
         FROM scratch_workspaces WHERE id = ?1",
        params![id.as_str()],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Vec<u8>>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, Option<i64>>(5)?,
                row.get::<_, Option<i64>>(6)?,
            ))
        },
    )
    .optional()?
    .map(
        |(id, capability_hash, expires_at, claimed_by, claimed_at, finalize, revoked_at)| {
            Ok(ScratchRecord {
                id: ScratchId::new(id).map_err(|_| ApiError::internal())?,
                capability_hash: hash32(capability_hash)?,
                expires_at_ms: from_ms(expires_at),
                claimed_by: claimed_by
                    .map(|value| PrincipalId::new(value).map_err(|_| ApiError::internal()))
                    .transpose()?,
                claimed_at_ms: opt_ms(claimed_at),
                finalize_expires_at_ms: opt_ms(finalize),
                revoked_at_ms: opt_ms(revoked_at),
            })
        },
    )
    .transpose()
}

pub fn load_pending_device(
    conn: &Connection,
    scratch_id: &ScratchId,
) -> ApiResult<Option<PendingDeviceRecord>> {
    conn.query_row(
        "SELECT id, scratch_id, public_key_sec1, public_key_hash, expires_at
         FROM pending_devices WHERE scratch_id = ?1",
        params![scratch_id.as_str()],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Vec<u8>>(2)?,
                row.get::<_, Vec<u8>>(3)?,
                row.get::<_, i64>(4)?,
            ))
        },
    )
    .optional()?
    .map(|(id, scratch, key, key_hash, expires_at)| {
        Ok(PendingDeviceRecord {
            id: DeviceId::new(id).map_err(|_| ApiError::internal())?,
            scratch_id: ScratchId::new(scratch).map_err(|_| ApiError::internal())?,
            public_key_sec1: key,
            public_key_hash: hash32(key_hash)?,
            expires_at_ms: from_ms(expires_at),
        })
    })
    .transpose()
}

pub fn load_device(
    conn: &Connection,
    id: &DeviceId,
) -> ApiResult<Option<marks_auth::DeviceRecord>> {
    conn.query_row(
        "SELECT id, principal_id, public_key_sec1, key_epoch, capability_bits, revoked_at
         FROM devices WHERE id = ?1",
        params![id.as_str()],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Vec<u8>>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, Option<i64>>(5)?,
            ))
        },
    )
    .optional()?
    .map(|(id, principal, key, key_epoch, bits, revoked_at)| {
        Ok(marks_auth::DeviceRecord {
            id: DeviceId::new(id).map_err(|_| ApiError::internal())?,
            principal_id: PrincipalId::new(principal).map_err(|_| ApiError::internal())?,
            public_key_sec1: key,
            key_epoch: from_ms(key_epoch),
            capabilities: DeviceCapabilities::from_bits(
                u32::try_from(bits).map_err(|_| ApiError::internal())?,
            )
            .map_err(|_| ApiError::internal())?,
            revoked_at_ms: opt_ms(revoked_at),
        })
    })
    .transpose()
}

pub struct StoredSession {
    pub record: SessionRecord,
    pub prev_secret_hash: Option<[u8; 32]>,
    pub rotated_at_ms: Option<u64>,
    /// Hardware key registered through Device Bound Session Credentials.
    pub dbsc_public_key_sec1: Option<Vec<u8>>,
    pub dbsc_bound_at_ms: Option<u64>,
}

pub fn load_session(conn: &Connection, id: &SessionId) -> ApiResult<Option<StoredSession>> {
    conn.query_row(
        "SELECT id, principal_id, device_id, secret_hash, prev_secret_hash, rotated_at,
                expires_at, revoked_at, dbsc_public_key_sec1, dbsc_bound_at
         FROM sessions WHERE id = ?1",
        params![id.as_str()],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Vec<u8>>(3)?,
                row.get::<_, Option<Vec<u8>>>(4)?,
                row.get::<_, Option<i64>>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, Option<i64>>(7)?,
                row.get::<_, Option<Vec<u8>>>(8)?,
                row.get::<_, Option<i64>>(9)?,
            ))
        },
    )
    .optional()?
    .map(
        |(
            id,
            principal,
            device,
            hash,
            prev_hash,
            rotated_at,
            expires_at,
            revoked_at,
            dbsc_key,
            dbsc_bound_at,
        )| {
            Ok(StoredSession {
                record: SessionRecord {
                    id: SessionId::new(id).map_err(|_| ApiError::internal())?,
                    principal_id: PrincipalId::new(principal).map_err(|_| ApiError::internal())?,
                    device_id: DeviceId::new(device).map_err(|_| ApiError::internal())?,
                    secret_hash: hash32(hash)?,
                    expires_at_ms: from_ms(expires_at),
                    revoked_at_ms: opt_ms(revoked_at),
                },
                prev_secret_hash: prev_hash.map(hash32).transpose()?,
                rotated_at_ms: opt_ms(rotated_at),
                dbsc_public_key_sec1: dbsc_key,
                dbsc_bound_at_ms: opt_ms(dbsc_bound_at),
            })
        },
    )
    .transpose()
}

/// Load the one-use DBSC challenge a token claims to answer, selected by its
/// stored digest and bound session.
pub fn load_dbsc_challenge(
    conn: &Connection,
    session_id: &SessionId,
    nonce_hash: &[u8; 32],
) -> ApiResult<Option<marks_auth::DbscChallengeRecord>> {
    conn.query_row(
        "SELECT id, session_id, nonce_hash, expires_at, consumed_at
         FROM auth_challenges
         WHERE kind = 'dbsc' AND session_id = ?1 AND nonce_hash = ?2",
        params![session_id.as_str(), nonce_hash.as_slice()],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Vec<u8>>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, Option<i64>>(4)?,
            ))
        },
    )
    .optional()?
    .map(|(id, session, hash, expires_at, consumed_at)| {
        Ok(marks_auth::DbscChallengeRecord {
            id: marks_auth::ChallengeId::new(id).map_err(|_| ApiError::internal())?,
            session_id: SessionId::new(session).map_err(|_| ApiError::internal())?,
            nonce_hash: hash32(hash)?,
            expires_at_ms: from_ms(expires_at),
            consumed_at_ms: opt_ms(consumed_at),
        })
    })
    .transpose()
}

pub fn load_pairing(conn: &Connection, id: &PairingId) -> ApiResult<Option<PairingRecord>> {
    conn.query_row(
        "SELECT id, scratch_id, pending_device_id, pending_device_public_key_hash, secret_hash,
                expires_at, consumed_at, approved_principal_id, word_code_hash
         FROM pairings WHERE id = ?1",
        params![id.as_str()],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Vec<u8>>(3)?,
                row.get::<_, Vec<u8>>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, Option<i64>>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, Option<Vec<u8>>>(8)?,
            ))
        },
    )
    .optional()?
    .map(
        |(
            id,
            scratch,
            pending,
            key_hash,
            secret_hash,
            expires_at,
            consumed_at,
            approved,
            words,
        )| {
            Ok(PairingRecord {
                id: PairingId::new(id).map_err(|_| ApiError::internal())?,
                scratch_id: ScratchId::new(scratch).map_err(|_| ApiError::internal())?,
                pending_device_id: DeviceId::new(pending).map_err(|_| ApiError::internal())?,
                pending_device_public_key_hash: hash32(key_hash)?,
                secret_hash: hash32(secret_hash)?,
                word_code_hash: words.map(hash32).transpose()?,
                expires_at_ms: from_ms(expires_at),
                consumed_at_ms: opt_ms(consumed_at),
                approved_principal_id: approved
                    .map(|value| PrincipalId::new(value).map_err(|_| ApiError::internal()))
                    .transpose()?,
            })
        },
    )
    .transpose()
}

pub fn load_pairing_by_word_hash(
    conn: &Connection,
    word_code_hash: &[u8; 32],
) -> ApiResult<Option<PairingRecord>> {
    let id: Option<String> = conn
        .query_row(
            "SELECT id FROM pairings WHERE word_code_hash = ?1",
            params![word_code_hash.as_slice()],
            |row| row.get(0),
        )
        .optional()?;
    match id {
        Some(id) => {
            let pairing_id = PairingId::new(id).map_err(|_| ApiError::internal())?;
            load_pairing(conn, &pairing_id)
        }
        None => Ok(None),
    }
}

pub fn load_device_challenge(
    conn: &Connection,
    id: &ChallengeId,
) -> ApiResult<Option<DeviceChallengeRecord>> {
    conn.query_row(
        "SELECT id, device_id, nonce_hash, audience, key_epoch, expires_at, consumed_at
         FROM auth_challenges WHERE id = ?1 AND kind = 'device'",
        params![id.as_str()],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Vec<u8>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, Option<i64>>(6)?,
            ))
        },
    )
    .optional()?
    .map(
        |(id, device, nonce_hash, audience, key_epoch, expires_at, consumed_at)| {
            Ok(DeviceChallengeRecord {
                id: ChallengeId::new(id).map_err(|_| ApiError::internal())?,
                device_id: DeviceId::new(device.ok_or_else(ApiError::unauthenticated)?)
                    .map_err(|_| ApiError::internal())?,
                challenge_hash: hash32(nonce_hash)?,
                audience,
                key_epoch: from_ms(key_epoch.ok_or_else(ApiError::unauthenticated)?),
                expires_at_ms: from_ms(expires_at),
                consumed_at_ms: opt_ms(consumed_at),
            })
        },
    )
    .transpose()
}

pub fn load_controller_for_device(
    conn: &Connection,
    principal_id: &PrincipalId,
    device_id: &DeviceId,
) -> ApiResult<Option<ControllerRecord>> {
    conn.query_row(
        "SELECT c.id, c.principal_id, d.public_key_sec1, c.key_epoch, d.capability_bits,
                c.revoked_at
         FROM controllers c JOIN devices d ON d.id = c.device_id
         WHERE c.principal_id = ?1 AND c.device_id = ?2",
        params![principal_id.as_str(), device_id.as_str()],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Vec<u8>>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, Option<i64>>(5)?,
            ))
        },
    )
    .optional()?
    .map(|(id, principal, key, epoch, bits, revoked_at)| {
        Ok(ControllerRecord {
            id: ControllerId::new(id).map_err(|_| ApiError::internal())?,
            principal_id: PrincipalId::new(principal).map_err(|_| ApiError::internal())?,
            public_key_sec1: key,
            epoch: from_ms(epoch),
            capabilities: DeviceCapabilities::from_bits(
                u32::try_from(bits).map_err(|_| ApiError::internal())?,
            )
            .map_err(|_| ApiError::internal())?,
            revoked_at_ms: opt_ms(revoked_at),
        })
    })
    .transpose()
}

/// Non-authorization metadata the product API also needs.
pub struct DocumentMetaRow {
    pub record: DocumentRecord,
    pub title: String,
    pub title_explicit: bool,
    pub engine: String,
    pub chars: u64,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub snapshot_revision: u64,
    pub public_edit: bool,
    pub anonymous_edit_count: u64,
    pub persisted_at_ms: Option<u64>,
}

pub fn load_document(conn: &Connection, id: &DocumentId) -> ApiResult<Option<DocumentMetaRow>> {
    conn.query_row(
        "SELECT id, scratch_id, owner_principal_id, title, title_explicit, engine, chars,
                auth_epoch, snapshot_revision, created_at, updated_at, deleted_at,
                public_edit, anonymous_edit_count, persisted_at
         FROM documents WHERE id = ?1",
        params![id.as_str()],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, i64>(8)?,
                row.get::<_, i64>(9)?,
                row.get::<_, i64>(10)?,
                row.get::<_, Option<i64>>(11)?,
                row.get::<_, i64>(12)?,
                row.get::<_, i64>(13)?,
                row.get::<_, Option<i64>>(14)?,
            ))
        },
    )
    .optional()?
    .map(
        |(
            id,
            scratch,
            owner,
            title,
            title_explicit,
            engine,
            chars,
            auth_epoch,
            snapshot_revision,
            created_at,
            updated_at,
            deleted_at,
            public_edit,
            anonymous_edit_count,
            persisted_at,
        )| {
            let owner = match (scratch, owner) {
                (Some(scratch), None) => DocumentOwner::Scratch(
                    ScratchId::new(scratch).map_err(|_| ApiError::internal())?,
                ),
                (None, Some(principal)) => DocumentOwner::Principal(
                    PrincipalId::new(principal).map_err(|_| ApiError::internal())?,
                ),
                _ => return Err(ApiError::internal()),
            };
            Ok(DocumentMetaRow {
                record: DocumentRecord {
                    id: DocumentId::new(id).map_err(|_| ApiError::internal())?,
                    owner,
                    authorization_epoch: from_ms(auth_epoch),
                    deleted_at_ms: opt_ms(deleted_at),
                },
                title,
                title_explicit: title_explicit != 0,
                engine,
                chars: from_ms(chars),
                created_at_ms: from_ms(created_at),
                updated_at_ms: from_ms(updated_at),
                snapshot_revision: from_ms(snapshot_revision),
                public_edit: public_edit != 0,
                anonymous_edit_count: from_ms(anonymous_edit_count),
                persisted_at_ms: opt_ms(persisted_at),
            })
        },
    )
    .transpose()
}

pub fn load_acl(conn: &Connection, document_id: &DocumentId) -> ApiResult<Vec<DocumentAclRecord>> {
    let mut statement = conn.prepare(
        "SELECT document_id, principal_id, role, granted_by, revoked_at
         FROM document_acl WHERE document_id = ?1",
    )?;
    let rows = statement.query_map(params![document_id.as_str()], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, Option<i64>>(4)?,
        ))
    })?;
    let mut records = Vec::new();
    for row in rows {
        let (document, principal, role, granted_by, revoked_at) = row?;
        records.push(DocumentAclRecord {
            document_id: DocumentId::new(document).map_err(|_| ApiError::internal())?,
            principal_id: PrincipalId::new(principal).map_err(|_| ApiError::internal())?,
            role: role_from_str(&role)?,
            granted_by: PrincipalId::new(granted_by).map_err(|_| ApiError::internal())?,
            revoked_at_ms: opt_ms(revoked_at),
        });
    }
    Ok(records)
}

pub fn occupied_sites(conn: &Connection, document_id: &DocumentId) -> ApiResult<Vec<EsbtSiteId>> {
    let mut statement =
        conn.prepare("SELECT site_id FROM document_sites WHERE document_id = ?1")?;
    let rows = statement.query_map(params![document_id.as_str()], |row| row.get::<_, i64>(0))?;
    let mut sites = Vec::new();
    for row in rows {
        let value = u32::try_from(row?).map_err(|_| ApiError::internal())?;
        sites.push(EsbtSiteId::new(value).map_err(|_| ApiError::internal())?);
    }
    Ok(sites)
}

type SiteOwnerRow = (String, Option<String>, Option<String>, Option<String>);

/// Reserved or reuse-validated client site for one document connection.
#[allow(clippy::too_many_arguments)] // one row's exact authority binding
pub fn allocate_site(
    conn: &Connection,
    document_id: &DocumentId,
    requested: Option<u32>,
    authority_kind: &str,
    scratch_id: Option<&ScratchId>,
    principal_id: Option<&PrincipalId>,
    device_id: Option<&DeviceId>,
    now_ms: u64,
) -> ApiResult<EsbtSiteId> {
    if let Some(requested) = requested {
        let owned: Option<SiteOwnerRow> = conn
            .query_row(
                "SELECT authority_kind, scratch_id, principal_id, device_id
                 FROM document_sites WHERE document_id = ?1 AND site_id = ?2",
                params![document_id.as_str(), i64::from(requested)],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        if let Some((kind, row_scratch, row_principal, row_device)) = owned {
            let same_authority = kind == authority_kind
                && row_scratch.as_deref() == scratch_id.map(|value| value.as_str())
                && row_principal.as_deref() == principal_id.map(|value| value.as_str())
                && row_device.as_deref() == device_id.map(|value| value.as_str());
            if same_authority {
                return EsbtSiteId::new(requested).map_err(|_| ApiError::internal());
            }
            // A site registered to another authority is never reissued.
            return Err(ApiError::forbidden());
        }
    }
    let site = marks_auth::allocate_esbt_site(occupied_sites(conn, document_id)?)
        .map_err(|_| ApiError::internal())?;
    conn.execute(
        "INSERT INTO document_sites
            (document_id, site_id, authority_kind, scratch_id, principal_id, device_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            document_id.as_str(),
            i64::from(site.as_u32()),
            authority_kind,
            scratch_id.map(|value| value.as_str()),
            principal_id.map(|value| value.as_str()),
            device_id.map(|value| value.as_str()),
            ms(now_ms),
        ],
    )?;
    Ok(site)
}

pub struct StoredPrincipalTicket {
    pub record: marks_auth::DocumentTicketRecord,
}

pub struct StoredScratchTicket {
    pub record: marks_auth::ScratchDocumentTicketRecord,
}

pub enum StoredTicket {
    Principal(StoredPrincipalTicket),
    Scratch(StoredScratchTicket),
}

pub fn load_ticket(conn: &Connection, id: &TicketId) -> ApiResult<Option<StoredTicket>> {
    let row = conn
        .query_row(
            "SELECT id, secret_hash, authority_kind, scratch_id, principal_id, session_id,
                    device_id, document_id, site_id, role, auth_epoch, expires_at, consumed_at,
                    revoked_at
             FROM document_tickets WHERE id = ?1",
            params![id.as_str()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Vec<u8>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, i64>(10)?,
                    row.get::<_, i64>(11)?,
                    row.get::<_, Option<i64>>(12)?,
                    row.get::<_, Option<i64>>(13)?,
                ))
            },
        )
        .optional()?;
    let Some((
        id,
        secret_hash,
        kind,
        scratch,
        principal,
        session,
        device,
        document,
        site,
        role,
        auth_epoch,
        expires_at,
        consumed_at,
        revoked_at,
    )) = row
    else {
        return Ok(None);
    };
    let id = TicketId::new(id).map_err(|_| ApiError::internal())?;
    let secret_hash = hash32(secret_hash)?;
    let document_id = DocumentId::new(document).map_err(|_| ApiError::internal())?;
    let esbt_site = EsbtSiteId::new(u32::try_from(site).map_err(|_| ApiError::internal())?)
        .map_err(|_| ApiError::internal())?;
    match kind.as_str() {
        "principal" => Ok(Some(StoredTicket::Principal(StoredPrincipalTicket {
            record: marks_auth::DocumentTicketRecord {
                id,
                secret_hash,
                principal_id: PrincipalId::new(principal.ok_or_else(ApiError::internal)?)
                    .map_err(|_| ApiError::internal())?,
                session_id: SessionId::new(session.ok_or_else(ApiError::internal)?)
                    .map_err(|_| ApiError::internal())?,
                device_id: DeviceId::new(device.ok_or_else(ApiError::internal)?)
                    .map_err(|_| ApiError::internal())?,
                document_id,
                esbt_site,
                role: role_from_str(&role.ok_or_else(ApiError::internal)?)?,
                authorization_epoch: from_ms(auth_epoch),
                expires_at_ms: from_ms(expires_at),
                consumed_at_ms: opt_ms(consumed_at),
                revoked_at_ms: opt_ms(revoked_at),
            },
        }))),
        "scratch" => Ok(Some(StoredTicket::Scratch(StoredScratchTicket {
            record: marks_auth::ScratchDocumentTicketRecord {
                id,
                secret_hash,
                scratch_id: ScratchId::new(scratch.ok_or_else(ApiError::internal)?)
                    .map_err(|_| ApiError::internal())?,
                document_id,
                esbt_site,
                authorization_epoch: from_ms(auth_epoch),
                expires_at_ms: from_ms(expires_at),
                consumed_at_ms: opt_ms(consumed_at),
                revoked_at_ms: opt_ms(revoked_at),
            },
        }))),
        _ => Err(ApiError::internal()),
    }
}

/// Rebuild the authoritative room replica from durable state: the compacted
/// snapshot plus every journaled update above it. Returns the replica and the
/// current committed revision.
pub fn hydrate_document(
    conn: &Connection,
    document_id: &DocumentId,
    limits: &esbt::ResourceLimits,
) -> ApiResult<(esbt::Document, u64)> {
    let (snapshot, snapshot_revision): (Option<Vec<u8>>, i64) = conn.query_row(
        "SELECT snapshot, snapshot_revision FROM documents WHERE id = ?1",
        params![document_id.as_str()],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let mut document = esbt::Document::new(
        EsbtSiteId::SERVER.to_engine_site(),
        esbt::replica::ReplicaConfig::default(),
        limits.clone(),
    )
    .map_err(|_| ApiError::internal())?;
    if let Some(snapshot) = snapshot {
        document
            .apply_snapshot_bytes(&snapshot)
            .map_err(|error| corrupt(document_id, "snapshot", error))?;
    }
    let mut revision = from_ms(snapshot_revision);
    let mut statement = conn.prepare(
        "SELECT revision, payload FROM document_updates
         WHERE document_id = ?1 AND revision > ?2 ORDER BY revision",
    )?;
    let rows = statement.query_map(params![document_id.as_str(), snapshot_revision], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
    })?;
    for row in rows {
        let (row_revision, payload) = row?;
        document
            .apply_bytes(&payload)
            .map_err(|error| corrupt(document_id, "journal", error))?;
        revision = from_ms(row_revision);
    }
    Ok((document, revision))
}

fn corrupt(document_id: &DocumentId, stage: &str, error: esbt::EngineError) -> ApiError {
    tracing::error!(
        target: "marks_server::room",
        document = document_id.as_str(),
        stage,
        code = ?error.code,
        "durable document state failed to replay"
    );
    ApiError::internal()
}
