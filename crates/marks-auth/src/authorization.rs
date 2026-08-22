use crate::{DeviceId, DocumentId, PrincipalId, ScratchId, SessionId, SiteId};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentRole {
    Owner,
    Editor,
    Commenter,
    Viewer,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DocumentAction {
    Read,
    PublishPresence,
    Export,
    EditText,
    Comment,
    ManageShares,
    Delete,
}

/// Identity already resolved by the Marks session/ticket boundary. ESBT gets
/// the `site_id`; product policy consumes every other field.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Actor {
    pub principal_id: PrincipalId,
    pub session_id: SessionId,
    pub device_id: DeviceId,
    pub document_id: DocumentId,
    pub site_id: SiteId,
    pub role: DocumentRole,
    pub authorization_epoch: u64,
}

/// Temporary capability authority for a scratch-owned document. It has no
/// principal/session/device fields and must never be displayed as a person.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScratchActor {
    pub scratch_id: ScratchId,
    pub document_id: DocumentId,
    pub site_id: SiteId,
    pub authorization_epoch: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RoomActor {
    Principal(Actor),
    Scratch(ScratchActor),
}

pub fn authorize_document_action(role: DocumentRole, action: DocumentAction) -> bool {
    use DocumentAction::*;
    use DocumentRole::*;

    match role {
        Owner => true,
        Editor => matches!(action, Read | PublishPresence | Export | EditText | Comment),
        Commenter => matches!(action, Read | PublishPresence | Export | Comment),
        Viewer => matches!(action, Read | PublishPresence | Export),
    }
}

pub fn authorize_room_action(actor: &RoomActor, action: DocumentAction) -> bool {
    match actor {
        RoomActor::Principal(actor) => authorize_document_action(actor.role, action),
        RoomActor::Scratch(_) => matches!(
            action,
            DocumentAction::Read
                | DocumentAction::PublishPresence
                | DocumentAction::Export
                | DocumentAction::EditText
                | DocumentAction::Delete
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_role_matrix_is_fail_closed() {
        use DocumentAction::*;
        use DocumentRole::*;

        let actions = [
            Read,
            PublishPresence,
            Export,
            EditText,
            Comment,
            ManageShares,
            Delete,
        ];
        let cases = [
            (Owner, [true, true, true, true, true, true, true]),
            (Editor, [true, true, true, true, true, false, false]),
            (Commenter, [true, true, true, false, true, false, false]),
            (Viewer, [true, true, true, false, false, false, false]),
        ];

        for (role, expected) in cases {
            for (action, allowed) in actions.into_iter().zip(expected) {
                assert_eq!(
                    authorize_document_action(role, action),
                    allowed,
                    "unexpected authorization for {role:?} performing {action:?}"
                );
            }
        }
    }

    #[test]
    fn scratch_authority_can_edit_its_private_document_but_cannot_comment_or_share() {
        let actor = RoomActor::Scratch(ScratchActor {
            scratch_id: ScratchId::new("scratch_123456").unwrap(),
            document_id: DocumentId::new("document_12345").unwrap(),
            site_id: SiteId::new("site_123456789").unwrap(),
            authorization_epoch: 1,
        });
        assert!(authorize_room_action(&actor, DocumentAction::EditText));
        assert!(!authorize_room_action(&actor, DocumentAction::Comment));
        assert!(!authorize_room_action(&actor, DocumentAction::ManageShares));
    }
}
