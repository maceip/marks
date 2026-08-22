use crate::{
    ControllerRecord, PrincipalId, ScratchError, ScratchRecord, VerifiedEmailLocatorRecord,
};
use thiserror::Error;

/// Result of the account-collision rules. The server generates any new
/// `principalId`; callers never accept one from the client.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SelectedPrincipal {
    Create,
    Existing(PrincipalId),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ScratchClaim {
    ClaimNow,
    AlreadyClaimedByCaller,
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum PromotionError {
    #[error("controller is revoked")]
    ControllerRevoked,
    #[error("scratch workspace is expired, revoked, or claimed by another principal")]
    ScratchConflict,
    #[error("verified-email locator is already attached to another principal")]
    LocatorOwnedByOtherPrincipal,
}

pub fn select_principal_for_bootstrap() -> SelectedPrincipal {
    SelectedPrincipal::Create
}

pub fn select_principal_for_controller_grant(
    controller: &ControllerRecord,
) -> Result<SelectedPrincipal, PromotionError> {
    if controller.revoked_at_ms.is_some() {
        return Err(PromotionError::ControllerRevoked);
    }
    Ok(SelectedPrincipal::Existing(controller.principal_id.clone()))
}

pub fn select_principal_for_email_locator(
    existing: Option<&VerifiedEmailLocatorRecord>,
) -> SelectedPrincipal {
    match existing {
        Some(row) if row.revoked_at_ms.is_none() => {
            SelectedPrincipal::Existing(row.principal_id.clone())
        }
        Some(_) | None => SelectedPrincipal::Create,
    }
}

/// Attaching a locator already owned by another principal never merges accounts.
pub fn authorize_locator_attach(
    existing: Option<&VerifiedEmailLocatorRecord>,
    principal_id: &PrincipalId,
) -> Result<(), PromotionError> {
    match existing {
        Some(row) if row.revoked_at_ms.is_none() && row.principal_id != *principal_id => {
            Err(PromotionError::LocatorOwnedByOtherPrincipal)
        }
        Some(_) | None => Ok(()),
    }
}

/// First write claims an unclaimed scratch. A retry by the same principal is
/// idempotent. A different principal is a conflict.
pub fn select_scratch_claim(
    scratch: &ScratchRecord,
    principal_id: &PrincipalId,
    now_ms: u64,
) -> Result<ScratchClaim, PromotionError> {
    if scratch.revoked_at_ms.is_some() || now_ms >= scratch.expires_at_ms {
        return Err(PromotionError::ScratchConflict);
    }
    match &scratch.claimed_by {
        None => Ok(ScratchClaim::ClaimNow),
        Some(claimed) if claimed == principal_id => Ok(ScratchClaim::AlreadyClaimedByCaller),
        Some(_) => Err(PromotionError::ScratchConflict),
    }
}

pub fn claimed_scratch_matches(
    scratch: &ScratchRecord,
    principal_id: &PrincipalId,
) -> Result<(), ScratchError> {
    match &scratch.claimed_by {
        Some(claimed) if claimed == principal_id => Ok(()),
        Some(_) => Err(ScratchError::Claimed),
        None => Err(ScratchError::NotClaimed),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ControllerId, DeviceCapabilities, EmailLocator, scratch_capability_hash};

    fn scratch(claimed_by: Option<PrincipalId>) -> ScratchRecord {
        ScratchRecord {
            id: crate::ScratchId::new("scratch_123456").unwrap(),
            capability_hash: scratch_capability_hash(&[9_u8; 32]),
            expires_at_ms: 10_000,
            claimed_by,
            claimed_at_ms: None,
            finalize_expires_at_ms: None,
            revoked_at_ms: None,
        }
    }

    #[test]
    fn phone_and_evt_collision_rules_do_not_merge_accounts() {
        assert_eq!(select_principal_for_bootstrap(), SelectedPrincipal::Create);

        let controller = ControllerRecord {
            id: ControllerId::new("controller_123").unwrap(),
            principal_id: PrincipalId::new("principal_1234").unwrap(),
            public_key_sec1: vec![4; 33],
            epoch: 1,
            capabilities: DeviceCapabilities::CONTROLLER,
            revoked_at_ms: None,
        };
        assert_eq!(
            select_principal_for_controller_grant(&controller).unwrap(),
            SelectedPrincipal::Existing(controller.principal_id.clone())
        );

        let locator = VerifiedEmailLocatorRecord {
            locator_key_version: 1,
            locator: EmailLocator::from_bytes([3; 32]),
            principal_id: PrincipalId::new("principal_mail1").unwrap(),
            issuer_policy_version: 1,
            revoked_at_ms: None,
        };
        assert_eq!(
            select_principal_for_email_locator(Some(&locator)),
            SelectedPrincipal::Existing(locator.principal_id.clone())
        );
        assert_eq!(
            authorize_locator_attach(
                Some(&locator),
                &PrincipalId::new("principal_other").unwrap()
            ),
            Err(PromotionError::LocatorOwnedByOtherPrincipal)
        );
        authorize_locator_attach(Some(&locator), &locator.principal_id).unwrap();
    }

    #[test]
    fn scratch_claim_is_idempotent_for_the_winning_principal() {
        let principal = PrincipalId::new("principal_1234").unwrap();
        assert_eq!(
            select_scratch_claim(&scratch(None), &principal, 1_000).unwrap(),
            ScratchClaim::ClaimNow
        );
        assert_eq!(
            select_scratch_claim(&scratch(Some(principal.clone())), &principal, 1_000).unwrap(),
            ScratchClaim::AlreadyClaimedByCaller
        );
        assert_eq!(
            select_scratch_claim(
                &scratch(Some(PrincipalId::new("principal_other").unwrap())),
                &principal,
                1_000,
            ),
            Err(PromotionError::ScratchConflict)
        );
    }
}
