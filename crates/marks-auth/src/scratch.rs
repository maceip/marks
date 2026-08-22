use crate::crypto::bearer_matches;
use crate::{PrincipalId, ScratchId, bearer_secret_hash};
use thiserror::Error;

const CAPABILITY_BYTES: usize = 32;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScratchRecord {
    pub id: ScratchId,
    pub capability_hash: [u8; 32],
    pub expires_at_ms: u64,
    pub claimed_by: Option<PrincipalId>,
    pub claimed_at_ms: Option<u64>,
    pub finalize_expires_at_ms: Option<u64>,
    pub revoked_at_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScratchAuthority {
    pub scratch_id: ScratchId,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClaimedScratchAuthority {
    pub scratch_id: ScratchId,
    pub principal_id: PrincipalId,
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum ScratchError {
    #[error("scratch capability is invalid")]
    InvalidCapability,
    #[error("scratch workspace is expired")]
    Expired,
    #[error("scratch workspace was already claimed")]
    Claimed,
    #[error("scratch workspace has not been claimed")]
    NotClaimed,
    #[error("scratch workspace is revoked")]
    Revoked,
    #[error("scratch finalize window has expired")]
    FinalizeExpired,
}

fn validate_capability(
    scratch: &ScratchRecord,
    presented_capability: &[u8],
) -> Result<(), ScratchError> {
    if bearer_matches(
        presented_capability,
        CAPABILITY_BYTES,
        &scratch.capability_hash,
    ) {
        Ok(())
    } else {
        Err(ScratchError::InvalidCapability)
    }
}

fn validate_live(scratch: &ScratchRecord, now_ms: u64) -> Result<(), ScratchError> {
    if scratch.revoked_at_ms.is_some() {
        return Err(ScratchError::Revoked);
    }
    if now_ms >= scratch.expires_at_ms {
        return Err(ScratchError::Expired);
    }
    Ok(())
}

pub fn scratch_capability_hash(capability: &[u8]) -> [u8; 32] {
    bearer_secret_hash(capability)
}

/// Validate the temporary tab capability. A successful result is authority
/// over a scratch workspace, not an authenticated Marks principal.
pub fn validate_scratch_capability(
    scratch: &ScratchRecord,
    presented_capability: &[u8],
    now_ms: u64,
) -> Result<ScratchAuthority, ScratchError> {
    validate_capability(scratch, presented_capability)?;
    validate_live(scratch, now_ms)?;
    if scratch.claimed_by.is_some() {
        return Err(ScratchError::Claimed);
    }

    Ok(ScratchAuthority {
        scratch_id: scratch.id.clone(),
    })
}

/// Validate the original tab capability after a phone or EVT transaction has
/// claimed the scratch workspace. This is the narrow bridge that lets that tab
/// receive its first rotating session cookie; it does not allow a second claim.
pub fn validate_claimed_scratch_capability(
    scratch: &ScratchRecord,
    presented_capability: &[u8],
    now_ms: u64,
) -> Result<ClaimedScratchAuthority, ScratchError> {
    validate_capability(scratch, presented_capability)?;
    validate_live(scratch, now_ms)?;
    let principal_id = scratch.claimed_by.clone().ok_or(ScratchError::NotClaimed)?;
    match scratch.finalize_expires_at_ms {
        Some(deadline) if now_ms < deadline => {}
        _ => return Err(ScratchError::FinalizeExpired),
    }
    Ok(ClaimedScratchAuthority {
        scratch_id: scratch.id.clone(),
        principal_id,
    })
}

/// Five-minute finalize-only window after a successful claim.
pub const SCRATCH_FINALIZE_WINDOW_MS: u64 = 5 * 60 * 1000;

pub fn mark_scratch_claimed(
    scratch: &ScratchRecord,
    principal_id: PrincipalId,
    now_ms: u64,
) -> Result<ScratchRecord, ScratchError> {
    validate_live(scratch, now_ms)?;
    if scratch.claimed_by.is_some() {
        return Err(ScratchError::Claimed);
    }
    Ok(ScratchRecord {
        claimed_by: Some(principal_id),
        claimed_at_ms: Some(now_ms),
        finalize_expires_at_ms: Some(now_ms.saturating_add(SCRATCH_FINALIZE_WINDOW_MS)),
        ..scratch.clone()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> (ScratchRecord, [u8; 32]) {
        let capability = [9_u8; 32];
        (
            ScratchRecord {
                id: ScratchId::new("scratch_123456").unwrap(),
                capability_hash: scratch_capability_hash(&capability),
                expires_at_ms: 10_000,
                claimed_by: None,
                claimed_at_ms: None,
                finalize_expires_at_ms: None,
                revoked_at_ms: None,
            },
            capability,
        )
    }

    #[test]
    fn capability_is_temporary_authority_not_a_principal() {
        let (record, capability) = scratch();
        assert_eq!(
            validate_scratch_capability(&record, &capability, 9_999),
            Ok(ScratchAuthority {
                scratch_id: record.id.clone()
            })
        );
        assert_eq!(
            validate_scratch_capability(&record, &[1_u8; 32], 9_999),
            Err(ScratchError::InvalidCapability)
        );
        assert_eq!(
            validate_scratch_capability(&record, &capability[..31], 9_999),
            Err(ScratchError::InvalidCapability)
        );
    }

    #[test]
    fn claimed_revoked_and_expired_scratch_workspaces_fail_closed() {
        let (mut record, capability) = scratch();
        record.expires_at_ms = 20_000;
        record.claimed_by = Some(PrincipalId::new("principal_1234").unwrap());
        record.claimed_at_ms = Some(8_000);
        record.finalize_expires_at_ms = Some(9_500);
        assert_eq!(
            validate_scratch_capability(&record, &capability, 9_000),
            Err(ScratchError::Claimed)
        );
        assert_eq!(
            validate_claimed_scratch_capability(&record, &capability, 9_000),
            Ok(ClaimedScratchAuthority {
                scratch_id: record.id.clone(),
                principal_id: PrincipalId::new("principal_1234").unwrap(),
            })
        );
        assert_eq!(
            validate_claimed_scratch_capability(&record, &capability, 9_500),
            Err(ScratchError::FinalizeExpired)
        );

        let (mut record, capability) = scratch();
        record.revoked_at_ms = Some(8_000);
        assert_eq!(
            validate_scratch_capability(&record, &capability, 9_000),
            Err(ScratchError::Revoked)
        );

        let (record, capability) = scratch();
        assert_eq!(
            validate_scratch_capability(&record, &capability, 10_000),
            Err(ScratchError::Expired)
        );
    }

    #[test]
    fn unclaimed_workspace_cannot_finalize_a_session() {
        let (record, capability) = scratch();
        assert_eq!(
            validate_claimed_scratch_capability(&record, &capability, 9_000),
            Err(ScratchError::NotClaimed)
        );
    }
}
