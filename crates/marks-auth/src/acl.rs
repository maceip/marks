use crate::{
    DocumentId, DocumentOwner, DocumentRecord, DocumentRole, PrincipalId, bearer_secret_hash,
    require_live_document,
};
use subtle::ConstantTimeEq;
use thiserror::Error;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DocumentAclRecord {
    pub document_id: DocumentId,
    pub principal_id: PrincipalId,
    pub role: DocumentRole,
    pub granted_by: PrincipalId,
    pub revoked_at_ms: Option<u64>,
}

/// Capability-token share, independent of the document ID. Never grants owner.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkGrantRecord {
    pub document_id: DocumentId,
    pub token_hash: [u8; 32],
    pub role: DocumentRole,
    pub expires_at_ms: u64,
    pub revoked_at_ms: Option<u64>,
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum AclError {
    #[error("document is deleted")]
    DocumentDeleted,
    #[error("scratch documents have no principal ACL")]
    ScratchHasNoAcl,
    #[error("principal has no live grant on this document")]
    Denied,
    #[error("share link cannot grant owner")]
    OwnerLinkForbidden,
    #[error("share token is invalid")]
    InvalidToken,
    #[error("share token is revoked")]
    Revoked,
    #[error("share token is expired")]
    Expired,
    #[error("share token is not bound to this document")]
    DocumentMismatch,
}

pub fn authorize_link_grant_role(role: DocumentRole) -> Result<(), AclError> {
    if role == DocumentRole::Owner {
        Err(AclError::OwnerLinkForbidden)
    } else {
        Ok(())
    }
}

/// Resolve the single durable role for a principal-owned document.
///
/// The document owner is always `Owner`. Otherwise the live ACL row wins.
/// Link grants are a separate capability and are not mixed in here.
pub fn resolve_document_role(
    document: &DocumentRecord,
    principal_id: &PrincipalId,
    acl: &[DocumentAclRecord],
) -> Result<DocumentRole, AclError> {
    require_live_document(document).map_err(|_| AclError::DocumentDeleted)?;
    let DocumentOwner::Principal(owner) = &document.owner else {
        return Err(AclError::ScratchHasNoAcl);
    };
    if owner == principal_id {
        return Ok(DocumentRole::Owner);
    }

    acl.iter()
        .find(|row| {
            row.document_id == document.id
                && row.principal_id == *principal_id
                && row.revoked_at_ms.is_none()
        })
        .map(|row| row.role)
        .ok_or(AclError::Denied)
}

pub fn owner_acl_row(document_id: DocumentId, principal_id: PrincipalId) -> DocumentAclRecord {
    DocumentAclRecord {
        document_id,
        principal_id: principal_id.clone(),
        role: DocumentRole::Owner,
        granted_by: principal_id,
        revoked_at_ms: None,
    }
}

pub fn redeem_link_grant(
    grant: &LinkGrantRecord,
    presented_token: &[u8],
    expected_document_id: &DocumentId,
    now_ms: u64,
) -> Result<DocumentRole, AclError> {
    authorize_link_grant_role(grant.role)?;
    if presented_token.len() != 32
        || grant
            .token_hash
            .ct_eq(&bearer_secret_hash(presented_token))
            .unwrap_u8()
            != 1
    {
        return Err(AclError::InvalidToken);
    }
    if grant.revoked_at_ms.is_some() {
        return Err(AclError::Revoked);
    }
    if now_ms >= grant.expires_at_ms {
        return Err(AclError::Expired);
    }
    if &grant.document_id != expected_document_id {
        return Err(AclError::DocumentMismatch);
    }
    Ok(grant.role)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DocumentOwner;

    fn document(owner: PrincipalId) -> DocumentRecord {
        DocumentRecord {
            id: DocumentId::new("document_12345").unwrap(),
            owner: DocumentOwner::Principal(owner),
            authorization_epoch: 1,
            deleted_at_ms: None,
        }
    }

    #[test]
    fn owner_is_always_owner_even_without_an_acl_row() {
        let owner = PrincipalId::new("principal_1234").unwrap();
        assert_eq!(
            resolve_document_role(&document(owner.clone()), &owner, &[]).unwrap(),
            DocumentRole::Owner
        );
    }

    #[test]
    fn live_acl_rows_grant_exactly_one_role() {
        let owner = PrincipalId::new("principal_1234").unwrap();
        let editor = PrincipalId::new("principal_edit1").unwrap();
        let document = document(owner.clone());
        let acl = [DocumentAclRecord {
            document_id: document.id.clone(),
            principal_id: editor.clone(),
            role: DocumentRole::Editor,
            granted_by: owner,
            revoked_at_ms: None,
        }];
        assert_eq!(
            resolve_document_role(&document, &editor, &acl).unwrap(),
            DocumentRole::Editor
        );
        assert_eq!(
            resolve_document_role(
                &document,
                &PrincipalId::new("principal_none1").unwrap(),
                &acl
            ),
            Err(AclError::Denied)
        );
    }

    #[test]
    fn revoked_acl_and_scratch_documents_fail_closed() {
        let owner = PrincipalId::new("principal_1234").unwrap();
        let editor = PrincipalId::new("principal_edit1").unwrap();
        let document = document(owner.clone());
        let acl = [DocumentAclRecord {
            document_id: document.id.clone(),
            principal_id: editor.clone(),
            role: DocumentRole::Editor,
            granted_by: owner.clone(),
            revoked_at_ms: Some(10),
        }];
        assert_eq!(
            resolve_document_role(&document, &editor, &acl),
            Err(AclError::Denied)
        );

        let scratch = DocumentRecord {
            id: document.id,
            owner: DocumentOwner::Scratch(crate::ScratchId::new("scratch_123456").unwrap()),
            authorization_epoch: 1,
            deleted_at_ms: None,
        };
        assert_eq!(
            resolve_document_role(&scratch, &owner, &[]),
            Err(AclError::ScratchHasNoAcl)
        );
    }

    #[test]
    fn link_grants_never_mint_owner_and_bind_the_document() {
        assert_eq!(
            authorize_link_grant_role(DocumentRole::Owner),
            Err(AclError::OwnerLinkForbidden)
        );
        let token = [9_u8; 32];
        let grant = LinkGrantRecord {
            document_id: DocumentId::new("document_12345").unwrap(),
            token_hash: bearer_secret_hash(&token),
            role: DocumentRole::Commenter,
            expires_at_ms: 10_000,
            revoked_at_ms: None,
        };
        assert_eq!(
            redeem_link_grant(
                &grant,
                &token,
                &DocumentId::new("document_12345").unwrap(),
                9_000,
            )
            .unwrap(),
            DocumentRole::Commenter
        );
        assert_eq!(
            redeem_link_grant(
                &grant,
                &token,
                &DocumentId::new("document_other1").unwrap(),
                9_000,
            ),
            Err(AclError::DocumentMismatch)
        );
    }
}
