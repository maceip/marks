use crate::{PairingId, ScratchId, SessionId, TicketId};
use base64ct::{Base64UrlUnpadded, Encoding};
use thiserror::Error;

pub const SESSION_COOKIE_NAME: &str = "__Host-marks_session";
pub const SCRATCH_AUTHORIZATION_SCHEME: &str = "MarksScratch";
pub const ESBT_SUBPROTOCOL: &str = "marks.esbt.v2";
pub const TICKET_SUBPROTOCOL_PREFIX: &str = "marks.ticket.v1.";
pub const PAIRING_FRAGMENT_PREFIX: &str = "#v1.";

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum BearerError {
    #[error("bearer credential is malformed")]
    Malformed,
    #[error("bearer secret is not 256 bits of base64url")]
    InvalidSecret,
}

pub fn decode_bearer_secret(text: &str) -> Result<[u8; 32], BearerError> {
    let bytes = Base64UrlUnpadded::decode_vec(text).map_err(|_| BearerError::InvalidSecret)?;
    bytes.try_into().map_err(|_| BearerError::InvalidSecret)
}

pub fn encode_bearer_secret(secret: &[u8; 32]) -> String {
    Base64UrlUnpadded::encode_string(secret)
}

/// Parse `__Host-marks_session=<sessionId>.<base64url-secret>` or the value alone.
pub fn parse_session_cookie(raw: &str) -> Result<(SessionId, [u8; 32]), BearerError> {
    let value = raw
        .strip_prefix(SESSION_COOKIE_NAME)
        .and_then(|rest| rest.strip_prefix('='))
        .unwrap_or(raw);
    split_id_secret(value, SessionId::new)
}

/// Parse `MarksScratch <scratchId>.<capability>` or the credential pair alone.
pub fn parse_scratch_authorization(raw: &str) -> Result<(ScratchId, [u8; 32]), BearerError> {
    let value = raw
        .strip_prefix(SCRATCH_AUTHORIZATION_SCHEME)
        .map(str::trim)
        .unwrap_or(raw);
    split_id_secret(value, ScratchId::new)
}

/// Parse `marks.ticket.v1.<ticketId>.<base64url-secret>`.
pub fn parse_ticket_subprotocol(raw: &str) -> Result<(TicketId, [u8; 32]), BearerError> {
    let value = raw
        .strip_prefix(TICKET_SUBPROTOCOL_PREFIX)
        .ok_or(BearerError::Malformed)?;
    split_id_secret(value, TicketId::new)
}

/// Parse `#v1.<pairingId>.<base64url-secret>`.
pub fn parse_pairing_fragment(raw: &str) -> Result<(PairingId, [u8; 32]), BearerError> {
    let value = raw
        .strip_prefix(PAIRING_FRAGMENT_PREFIX)
        .ok_or(BearerError::Malformed)?;
    split_id_secret(value, PairingId::new)
}

fn split_id_secret<T>(
    value: &str,
    parse_id: impl FnOnce(String) -> Result<T, crate::id::IdError>,
) -> Result<(T, [u8; 32]), BearerError> {
    let (id, secret) = value.rsplit_once('.').ok_or(BearerError::Malformed)?;
    let id = parse_id(id.to_owned()).map_err(|_| BearerError::Malformed)?;
    Ok((id, decode_bearer_secret(secret)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_cookie_scratch_header_ticket_and_pairing_round_trip() {
        let secret = [7_u8; 32];
        let encoded = encode_bearer_secret(&secret);

        let (session, parsed) =
            parse_session_cookie(&format!("{SESSION_COOKIE_NAME}=session_12345.{encoded}"))
                .unwrap();
        assert_eq!(session.as_str(), "session_12345");
        assert_eq!(parsed, secret);

        let (scratch, parsed) =
            parse_scratch_authorization(&format!("MarksScratch scratch_123456.{encoded}")).unwrap();
        assert_eq!(scratch.as_str(), "scratch_123456");
        assert_eq!(parsed, secret);

        let (ticket, parsed) = parse_ticket_subprotocol(&format!(
            "{TICKET_SUBPROTOCOL_PREFIX}ticket_12345678.{encoded}"
        ))
        .unwrap();
        assert_eq!(ticket.as_str(), "ticket_12345678");
        assert_eq!(parsed, secret);

        let (pairing, parsed) = parse_pairing_fragment(&format!(
            "{PAIRING_FRAGMENT_PREFIX}pairing_123456.{encoded}"
        ))
        .unwrap();
        assert_eq!(pairing.as_str(), "pairing_123456");
        assert_eq!(parsed, secret);
    }

    #[test]
    fn malformed_bearers_and_short_secrets_fail() {
        assert_eq!(
            parse_session_cookie("session_12345.aaaa"),
            Err(BearerError::InvalidSecret)
        );
        assert_eq!(
            parse_ticket_subprotocol("marks.esbt.v2"),
            Err(BearerError::Malformed)
        );
        assert_eq!(
            parse_pairing_fragment("v1.pairing_123456.aaaa"),
            Err(BearerError::Malformed)
        );
    }
}
