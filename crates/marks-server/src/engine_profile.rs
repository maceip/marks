//! The one Marks resource policy shared with the browser through
//! `engine-profile.json`. Keeping numeric limits out of language-specific
//! defaults prevents native/Wasm acceptance drift.

use serde::Deserialize;
use std::sync::OnceLock;

#[derive(Clone, Debug, Deserialize)]
pub struct EngineProfile {
    pub version: u32,
    pub max_frame_bytes: usize,
    pub server_compact_operations: usize,
    pub client_prune_operations: usize,
    pub editor_chunk_units: usize,
    pub limits: EngineLimits,
}

#[derive(Clone, Debug, Deserialize)]
pub struct EngineLimits {
    pub max_message_bytes: usize,
    pub max_operations_per_update: usize,
    pub max_identifier_depth: usize,
    pub max_version_sites: usize,
    pub max_sparse_receipts: usize,
    pub max_snapshot_items: usize,
    pub max_pending_operations: usize,
    pub max_deferred_deletes: usize,
    pub max_document_units: usize,
    pub max_allocation_attempts: usize,
    pub max_retained_operations: usize,
    pub max_undo_transactions: usize,
}

impl EngineLimits {
    pub fn resource_limits(&self) -> esbt::ResourceLimits {
        esbt::ResourceLimits {
            max_message_bytes: self.max_message_bytes,
            max_operations_per_update: self.max_operations_per_update,
            max_identifier_depth: self.max_identifier_depth,
            max_version_sites: self.max_version_sites,
            max_sparse_receipts: self.max_sparse_receipts,
            max_snapshot_items: self.max_snapshot_items,
            max_pending_operations: self.max_pending_operations,
            max_deferred_deletes: self.max_deferred_deletes,
            max_document_units: self.max_document_units,
            max_allocation_attempts: self.max_allocation_attempts,
            max_retained_operations: self.max_retained_operations,
            max_undo_transactions: self.max_undo_transactions,
        }
    }
}

pub fn get() -> Result<&'static EngineProfile, String> {
    static PROFILE: OnceLock<Result<EngineProfile, String>> = OnceLock::new();
    PROFILE
        .get_or_init(|| {
            let profile: EngineProfile =
                serde_json::from_str(include_str!("../../../engine-profile.json"))
                    .map_err(|error| format!("engine-profile.json: {error}"))?;
            if profile.version != 1
                || profile.max_frame_bytes < profile.limits.max_message_bytes.saturating_add(27)
                || profile.server_compact_operations == 0
                || profile.client_prune_operations == 0
                || profile.editor_chunk_units == 0
            {
                return Err("engine-profile.json contains an invalid Marks v1 policy".to_owned());
            }
            Ok(profile)
        })
        .as_ref()
        .map_err(Clone::clone)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_covers_the_marks_mutation_envelope() {
        let profile = get().unwrap();
        assert!(profile.max_frame_bytes >= profile.limits.max_message_bytes + 27);
        assert!(profile.limits.max_document_units <= profile.limits.max_snapshot_items);
        assert!(profile.server_compact_operations <= profile.limits.max_retained_operations);
    }
}
