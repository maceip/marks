use crate::{DocumentId, PrincipalId, ScratchId};
use thiserror::Error;

/// Exactly one owner namespace. A document is never both scratch-owned and
/// principal-owned, and never ownerless.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DocumentOwner {
    Scratch(ScratchId),
    Principal(PrincipalId),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DocumentRecord {
    pub id: DocumentId,
    pub owner: DocumentOwner,
    pub authorization_epoch: u64,
    pub deleted_at_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PrincipalRecord {
    pub id: PrincipalId,
    pub disabled_at_ms: Option<u64>,
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum DocumentError {
    #[error("document is deleted")]
    Deleted,
    #[error("document is not deleted")]
    NotDeleted,
    #[error("document is not owned by this scratch workspace")]
    ScratchMismatch,
    #[error("document is not owned by this principal")]
    PrincipalMismatch,
    #[error("document is still scratch-owned")]
    StillScratchOwned,
    #[error("document was already claimed by a principal")]
    AlreadyClaimed,
    #[error("principal is disabled")]
    PrincipalDisabled,
}

pub fn require_live_document(document: &DocumentRecord) -> Result<(), DocumentError> {
    if document.deleted_at_ms.is_some() {
        Err(DocumentError::Deleted)
    } else {
        Ok(())
    }
}

/// Recovery authority is deliberately narrower than normal ACL resolution:
/// only the immutable document owner may inspect, restore, or purge a
/// tombstone. This validator does not make a deleted document live.
pub fn require_deleted_document_owner(
    document: &DocumentRecord,
    owner: &DocumentOwner,
) -> Result<(), DocumentError> {
    if document.deleted_at_ms.is_none() {
        return Err(DocumentError::NotDeleted);
    }
    match (&document.owner, owner) {
        (DocumentOwner::Scratch(actual), DocumentOwner::Scratch(expected))
            if actual == expected =>
        {
            Ok(())
        }
        (DocumentOwner::Principal(actual), DocumentOwner::Principal(expected))
            if actual == expected =>
        {
            Ok(())
        }
        (DocumentOwner::Scratch(_), DocumentOwner::Scratch(_)) => {
            Err(DocumentError::ScratchMismatch)
        }
        (DocumentOwner::Principal(_), DocumentOwner::Principal(_)) => {
            Err(DocumentError::PrincipalMismatch)
        }
        (DocumentOwner::Scratch(_), DocumentOwner::Principal(_)) => {
            Err(DocumentError::StillScratchOwned)
        }
        (DocumentOwner::Principal(_), DocumentOwner::Scratch(_)) => {
            Err(DocumentError::AlreadyClaimed)
        }
    }
}

pub fn require_active_principal(principal: &PrincipalRecord) -> Result<(), DocumentError> {
    if principal.disabled_at_ms.is_some() {
        Err(DocumentError::PrincipalDisabled)
    } else {
        Ok(())
    }
}

pub fn require_scratch_document(
    document: &DocumentRecord,
    scratch_id: &ScratchId,
) -> Result<(), DocumentError> {
    require_live_document(document)?;
    match &document.owner {
        DocumentOwner::Scratch(owner) if owner == scratch_id => Ok(()),
        DocumentOwner::Scratch(_) => Err(DocumentError::ScratchMismatch),
        DocumentOwner::Principal(_) => Err(DocumentError::AlreadyClaimed),
    }
}

pub fn require_principal_document(
    document: &DocumentRecord,
    principal_id: &PrincipalId,
) -> Result<(), DocumentError> {
    require_live_document(document)?;
    match &document.owner {
        DocumentOwner::Principal(owner) if owner == principal_id => Ok(()),
        DocumentOwner::Principal(_) => Err(DocumentError::PrincipalMismatch),
        DocumentOwner::Scratch(_) => Err(DocumentError::StillScratchOwned),
    }
}

/// Move a scratch document onto a principal and bump its authorization epoch
/// so outstanding scratch tickets and sockets fail closed. A tombstone remains
/// deleted while its recovery ownership follows the promoted workspace; login
/// must not strand trash behind the now-claimed scratch capability.
pub fn claim_scratch_document(
    document: &DocumentRecord,
    scratch_id: &ScratchId,
    principal_id: &PrincipalId,
) -> Result<DocumentRecord, DocumentError> {
    match &document.owner {
        DocumentOwner::Scratch(owner) if owner == scratch_id => {}
        DocumentOwner::Scratch(_) => return Err(DocumentError::ScratchMismatch),
        DocumentOwner::Principal(_) => return Err(DocumentError::AlreadyClaimed),
    }
    Ok(DocumentRecord {
        id: document.id.clone(),
        owner: DocumentOwner::Principal(principal_id.clone()),
        authorization_epoch: document.authorization_epoch.saturating_add(1),
        deleted_at_ms: document.deleted_at_ms,
    })
}

pub fn bump_authorization_epoch(
    document: &DocumentRecord,
) -> Result<DocumentRecord, DocumentError> {
    require_live_document(document)?;
    Ok(DocumentRecord {
        authorization_epoch: document.authorization_epoch.saturating_add(1),
        ..document.clone()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document(owner: DocumentOwner) -> DocumentRecord {
        DocumentRecord {
            id: DocumentId::new("document_12345").unwrap(),
            owner,
            authorization_epoch: 3,
            deleted_at_ms: None,
        }
    }

    #[test]
    fn claiming_a_scratch_document_changes_owner_and_epoch() {
        let scratch = ScratchId::new("scratch_123456").unwrap();
        let principal = PrincipalId::new("principal_1234").unwrap();
        let claimed = claim_scratch_document(
            &document(DocumentOwner::Scratch(scratch.clone())),
            &scratch,
            &principal,
        )
        .unwrap();

        assert_eq!(claimed.owner, DocumentOwner::Principal(principal));
        assert_eq!(claimed.authorization_epoch, 4);
    }

    #[test]
    fn claiming_a_deleted_scratch_document_preserves_its_tombstone() {
        let scratch = ScratchId::new("scratch_123456").unwrap();
        let principal = PrincipalId::new("principal_1234").unwrap();
        let mut deleted = document(DocumentOwner::Scratch(scratch.clone()));
        deleted.deleted_at_ms = Some(7);

        let claimed = claim_scratch_document(&deleted, &scratch, &principal).unwrap();

        assert_eq!(claimed.owner, DocumentOwner::Principal(principal));
        assert_eq!(claimed.authorization_epoch, 4);
        assert_eq!(claimed.deleted_at_ms, Some(7));
    }

    #[test]
    fn only_the_exact_owner_can_recover_a_tombstone() {
        let owner = PrincipalId::new("principal_owner").unwrap();
        let other = PrincipalId::new("principal_other").unwrap();
        let mut deleted = document(DocumentOwner::Principal(owner.clone()));
        deleted.deleted_at_ms = Some(7);
        assert_eq!(
            require_deleted_document_owner(&deleted, &DocumentOwner::Principal(owner)),
            Ok(())
        );
        assert_eq!(
            require_deleted_document_owner(&deleted, &DocumentOwner::Principal(other)),
            Err(DocumentError::PrincipalMismatch)
        );
    }

    #[test]
    fn a_principal_owned_document_cannot_be_claimed_again() {
        let scratch = ScratchId::new("scratch_123456").unwrap();
        let principal = PrincipalId::new("principal_1234").unwrap();
        assert_eq!(
            claim_scratch_document(
                &document(DocumentOwner::Principal(principal.clone())),
                &scratch,
                &principal,
            ),
            Err(DocumentError::AlreadyClaimed)
        );
    }

    #[test]
    fn deleted_documents_stay_closed() {
        let scratch = ScratchId::new("scratch_123456").unwrap();
        let mut deleted = document(DocumentOwner::Scratch(scratch.clone()));
        deleted.deleted_at_ms = Some(1);
        assert_eq!(
            require_scratch_document(&deleted, &scratch),
            Err(DocumentError::Deleted)
        );
    }
}
