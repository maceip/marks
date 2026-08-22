pub(crate) fn put_u8(output: &mut Vec<u8>, value: u8) {
    output.push(value);
}

pub(crate) fn put_u32(output: &mut Vec<u8>, value: u32) {
    output.extend_from_slice(&value.to_be_bytes());
}

pub(crate) fn put_u64(output: &mut Vec<u8>, value: u64) {
    output.extend_from_slice(&value.to_be_bytes());
}

pub(crate) fn put_text(output: &mut Vec<u8>, value: &str) {
    put_bytes(output, value.as_bytes());
}

pub(crate) fn put_bytes(output: &mut Vec<u8>, value: &[u8]) {
    let length = u32::try_from(value.len()).expect("signed protocol field exceeds u32::MAX");
    put_u32(output, length);
    output.extend_from_slice(value);
}
