//! Compact Marks-owned commit protocol layered around opaque ESBT bytes.
//!
//! ESBT remains responsible for CRDT encoding. Marks adds the minimum data
//! needed to make a browser mutation retry-safe and its UI durability claim
//! truthful: a protocol version, mutation kind, stable 128-bit id, and an
//! explicit committed receipt carrying the durable SQLite revision.

const MUTATION_MAGIC: &[u8; 4] = b"MKMT";
const COMMITTED_MAGIC: &[u8; 4] = b"MKCM";
const PROTOCOL_VERSION: u8 = 1;
const MUTATION_HEADER_BYTES: usize = 4 + 1 + 1 + 16 + 4;
const COMMITTED_HEADER_BYTES: usize = 4 + 1 + 16 + 8 + 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum MutationKind {
    Update = 1,
    Snapshot = 2,
}

impl MutationKind {
    pub fn from_byte(value: u8) -> Option<Self> {
        match value {
            1 => Some(Self::Update),
            2 => Some(Self::Snapshot),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Mutation<'a> {
    pub id: [u8; 16],
    pub kind: MutationKind,
    pub payload: &'a [u8],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Committed<'a> {
    pub id: [u8; 16],
    pub revision: u64,
    pub version: &'a [u8],
}

pub fn decode_mutation(bytes: &[u8]) -> Option<Mutation<'_>> {
    if bytes.len() < MUTATION_HEADER_BYTES || &bytes[..4] != MUTATION_MAGIC {
        return None;
    }
    if bytes[4] != PROTOCOL_VERSION {
        return None;
    }
    let kind = MutationKind::from_byte(bytes[5])?;
    let id = bytes[6..22].try_into().ok()?;
    let payload_len = u32::from_le_bytes(bytes[22..26].try_into().ok()?) as usize;
    if payload_len == 0 || bytes.len() != MUTATION_HEADER_BYTES.checked_add(payload_len)? {
        return None;
    }
    Some(Mutation {
        id,
        kind,
        payload: &bytes[MUTATION_HEADER_BYTES..],
    })
}

pub fn encode_mutation(id: [u8; 16], kind: MutationKind, payload: &[u8]) -> Option<Vec<u8>> {
    let payload_len = u32::try_from(payload.len()).ok()?;
    if payload_len == 0 {
        return None;
    }
    let mut out = Vec::with_capacity(MUTATION_HEADER_BYTES + payload.len());
    out.extend_from_slice(MUTATION_MAGIC);
    out.push(PROTOCOL_VERSION);
    out.push(kind as u8);
    out.extend_from_slice(&id);
    out.extend_from_slice(&payload_len.to_le_bytes());
    out.extend_from_slice(payload);
    Some(out)
}

pub fn encode_committed(id: [u8; 16], revision: u64, version: &[u8]) -> Option<Vec<u8>> {
    let version_len = u32::try_from(version.len()).ok()?;
    let mut out = Vec::with_capacity(COMMITTED_HEADER_BYTES + version.len());
    out.extend_from_slice(COMMITTED_MAGIC);
    out.push(PROTOCOL_VERSION);
    out.extend_from_slice(&id);
    out.extend_from_slice(&revision.to_le_bytes());
    out.extend_from_slice(&version_len.to_le_bytes());
    out.extend_from_slice(version);
    Some(out)
}

pub fn decode_committed(bytes: &[u8]) -> Option<Committed<'_>> {
    if bytes.len() < COMMITTED_HEADER_BYTES
        || &bytes[..4] != COMMITTED_MAGIC
        || bytes[4] != PROTOCOL_VERSION
    {
        return None;
    }
    let id = bytes[5..21].try_into().ok()?;
    let revision = u64::from_le_bytes(bytes[21..29].try_into().ok()?);
    let version_len = u32::from_le_bytes(bytes[29..33].try_into().ok()?) as usize;
    if bytes.len() != COMMITTED_HEADER_BYTES.checked_add(version_len)? {
        return None;
    }
    Some(Committed {
        id,
        revision,
        version: &bytes[COMMITTED_HEADER_BYTES..],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mutation_round_trip_and_strict_lengths() {
        let id = [7_u8; 16];
        let encoded = encode_mutation(id, MutationKind::Update, b"engine").unwrap();
        let decoded = decode_mutation(&encoded).unwrap();
        assert_eq!(decoded.id, id);
        assert_eq!(decoded.kind, MutationKind::Update);
        assert_eq!(decoded.payload, b"engine");

        assert!(decode_mutation(&encoded[..encoded.len() - 1]).is_none());
        let mut trailing = encoded;
        trailing.push(0);
        assert!(decode_mutation(&trailing).is_none());
    }

    #[test]
    fn committed_receipt_has_stable_binary_layout() {
        let encoded = encode_committed([9_u8; 16], 42, b"vv").unwrap();
        assert_eq!(&encoded[..4], COMMITTED_MAGIC);
        assert_eq!(encoded[4], PROTOCOL_VERSION);
        assert_eq!(&encoded[5..21], &[9_u8; 16]);
        assert_eq!(u64::from_le_bytes(encoded[21..29].try_into().unwrap()), 42);
        assert_eq!(u32::from_le_bytes(encoded[29..33].try_into().unwrap()), 2);
        assert_eq!(&encoded[33..], b"vv");
        let decoded = decode_committed(&encoded).unwrap();
        assert_eq!(decoded.id, [9_u8; 16]);
        assert_eq!(decoded.revision, 42);
        assert_eq!(decoded.version, b"vv");
        assert!(decode_committed(&encoded[..34]).is_none());
    }
}
