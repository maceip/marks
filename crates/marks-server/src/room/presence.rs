//! Validation and identity binding for the small Marks presence envelope.

use marks_auth::RoomIdentity;
use serde_json::{Map, Value};

const MAX_ENTRIES: usize = 256;
const MAX_KEY: usize = 256;
const MAX_VALUE: usize = 16 * 1024;

fn uint(input: &[u8], at: &mut usize) -> Option<u64> {
    let mut value = 0u64;
    let mut shift = 0;
    loop {
        let byte = *input.get(*at)?;
        *at += 1;
        value |= u64::from(byte & 0x7f).checked_shl(shift)?;
        if byte & 0x80 == 0 {
            return Some(value);
        }
        shift += 7;
        if shift > 63 {
            return None;
        }
    }
}

fn put_uint(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        out.push(byte | if value == 0 { 0 } else { 0x80 });
        if value == 0 {
            break;
        }
    }
}

fn field<'a>(input: &'a [u8], at: &mut usize, max: usize) -> Option<&'a [u8]> {
    let len = usize::try_from(uint(input, at)?).ok()?;
    if len > max {
        return None;
    }
    let end = at.checked_add(len)?;
    let bytes = input.get(*at..end)?;
    *at = end;
    Some(bytes)
}

fn put_field(out: &mut Vec<u8>, value: &[u8]) {
    put_uint(out, value.len() as u64);
    out.extend_from_slice(value);
}

/// Re-key a connection's mutable entries and replace all user identity data.
pub fn bind(
    payload: &[u8],
    connection_id: u64,
    identity: &RoomIdentity,
    color: u8,
) -> Option<Vec<u8>> {
    let mut at = 0;
    if payload.get(at).copied()? != 5 {
        return None;
    }
    at += 1;
    let count = usize::try_from(uint(payload, &mut at)?).ok()?;
    if count > MAX_ENTRIES {
        return None;
    }
    let mut entries = Vec::with_capacity(count);
    for _ in 0..count {
        let key = std::str::from_utf8(field(payload, &mut at, MAX_KEY)?).ok()?;
        let suffix = if key.ends_with("-cm-user") {
            "cm-user"
        } else if key.ends_with("-cm-selection") {
            "cm-selection"
        } else {
            return None;
        };
        let key = format!("connection-{connection_id}-{suffix}");
        let flags = *payload.get(at)?;
        at += 1;
        if flags == 1 {
            entries.push((key, flags, 0, Vec::new()));
            continue;
        }
        if flags != 0 {
            return None;
        }
        let age = uint(payload, &mut at)?;
        let mut value: Value = serde_json::from_slice(field(payload, &mut at, MAX_VALUE)?).ok()?;
        if suffix == "cm-user" {
            let mut object = Map::new();
            object.insert(
                "participantId".into(),
                Value::String(identity.participant_id.clone()),
            );
            object.insert(
                "connectionId".into(),
                Value::String(connection_id.to_string()),
            );
            object.insert("name".into(), Value::String(identity.display_name.clone()));
            object.insert("colorIndex".into(), Value::from(color));
            if let Some(avatar) = &identity.avatar {
                object.insert("avatar".into(), Value::String(avatar.clone()));
            }
            value = Value::Object(object);
        }
        entries.push((key, flags, age, serde_json::to_vec(&value).ok()?));
    }
    if at != payload.len() {
        return None;
    }
    let mut out = vec![5];
    put_uint(&mut out, entries.len() as u64);
    for (key, flags, age, value) in entries {
        put_field(&mut out, key.as_bytes());
        out.push(flags);
        if flags == 0 {
            put_uint(&mut out, age);
            put_field(&mut out, &value);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_overwrites_impersonated_identity() {
        let mut input = vec![5, 1, 9];
        input.extend_from_slice(b"7-cm-user");
        input.extend_from_slice(&[0, 0, 16]);
        input.extend_from_slice(br#"{"name":"Admin"}"#);
        let identity = RoomIdentity {
            participant_id: "principal-safe".into(),
            display_name: "Safe Name".into(),
            avatar: None,
            preferred_color: 1,
        };
        let output = bind(&input, 42, &identity, 6).unwrap();
        let text = String::from_utf8_lossy(&output);
        assert!(text.contains("principal-safe"));
        assert!(text.contains("Safe Name"));
        assert!(!text.contains("Admin"));
        assert!(!text.contains("session"));
    }
}
