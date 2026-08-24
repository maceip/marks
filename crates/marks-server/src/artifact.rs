use serde::Deserialize;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::Read;
use std::path::Path;

const EMBEDDED_MANIFEST: &str = include_str!("../../../client/public/esbt.wasm.manifest.json");
const ENGINE_PROFILE: &[u8] = include_bytes!("../../../engine-profile.json");
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_WASM_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
struct WasmManifest {
    format: u32,
    engine_revision: String,
    source_dirty: bool,
    source_sha256: String,
    abi_version: u32,
    abi_sha256: String,
    profile_sha256: String,
    wasm_sha256: String,
    compiler: String,
    target: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactIdentity {
    pub schema: &'static str,
    pub server_version: &'static str,
    pub build_revision: &'static str,
    pub server_source_dirty: bool,
    pub server_engine_revision: &'static str,
    pub wasm_engine_revision: String,
    pub wasm_source_dirty: bool,
    pub wasm_source_sha256: String,
    pub wasm_sha256: String,
    pub abi_version: u32,
    pub abi_sha256: String,
    pub profile_sha256: String,
    pub compiler: String,
    pub target: String,
    pub static_artifact_verified: bool,
    pub profile_coherent: bool,
    pub engine_coherent: bool,
    pub release_ready: bool,
}

impl ArtifactIdentity {
    pub fn load(static_dir: Option<&Path>) -> Result<Self, String> {
        let wasm = parse_manifest(EMBEDDED_MANIFEST, "build-bound esbt.wasm manifest")?;
        let static_artifact_verified = match static_dir {
            Some(root) => verify_deployed_artifact(root, &wasm)?,
            None => false,
        };
        let server_engine_revision = env!("MARKS_ESBT_REVISION");
        let build_revision = env!("MARKS_BUILD_REVISION");
        let server_source_dirty = env!("MARKS_SOURCE_DIRTY") == "1";
        let profile_sha256 = hex_digest(Sha256::digest(ENGINE_PROFILE));
        let profile_coherent = wasm.profile_sha256 == profile_sha256;
        let engine_coherent = wasm.engine_revision == server_engine_revision && profile_coherent;
        let release_ready = engine_coherent
            && static_artifact_verified
            && !wasm.source_dirty
            && !server_source_dirty
            && build_revision != "development";
        Ok(Self {
            schema: "marks-artifact.v1",
            server_version: env!("CARGO_PKG_VERSION"),
            build_revision,
            server_source_dirty,
            server_engine_revision,
            wasm_engine_revision: wasm.engine_revision,
            wasm_source_dirty: wasm.source_dirty,
            wasm_source_sha256: wasm.source_sha256,
            wasm_sha256: wasm.wasm_sha256,
            abi_version: wasm.abi_version,
            abi_sha256: wasm.abi_sha256,
            profile_sha256: wasm.profile_sha256,
            compiler: wasm.compiler,
            target: wasm.target,
            static_artifact_verified,
            profile_coherent,
            engine_coherent,
            release_ready,
        })
    }
}

fn parse_manifest(text: &str, label: &str) -> Result<WasmManifest, String> {
    if text.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(format!("{label} exceeds {MAX_MANIFEST_BYTES} bytes"));
    }
    let manifest: WasmManifest =
        serde_json::from_str(text).map_err(|error| format!("{label}: {error}"))?;
    let valid_hash =
        |value: &str| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit());
    if manifest.format != 2
        || manifest.engine_revision.len() != 40
        || !manifest
            .engine_revision
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || !valid_hash(&manifest.source_sha256)
        || !valid_hash(&manifest.abi_sha256)
        || !valid_hash(&manifest.profile_sha256)
        || !valid_hash(&manifest.wasm_sha256)
        || manifest.abi_version == 0
        || manifest.compiler.is_empty()
        || manifest.target != "wasm32-unknown-unknown"
    {
        return Err(format!("{label} has invalid provenance fields"));
    }
    Ok(manifest)
}

fn verify_deployed_artifact(root: &Path, expected: &WasmManifest) -> Result<bool, String> {
    let manifest_path = root.join("esbt.wasm.manifest.json");
    let metadata = manifest_path
        .metadata()
        .map_err(|error| format!("deployed Wasm manifest: {error}"))?;
    if !metadata.is_file() || metadata.len() > MAX_MANIFEST_BYTES {
        return Err("deployed Wasm manifest is not one bounded regular file".to_owned());
    }
    let deployed_text = std::fs::read_to_string(&manifest_path)
        .map_err(|error| format!("deployed Wasm manifest: {error}"))?;
    let deployed = parse_manifest(&deployed_text, "deployed Wasm manifest")?;
    if &deployed != expected {
        return Err("deployed Wasm manifest differs from the server build receipt".to_owned());
    }

    let wasm_path = root.join("esbt.wasm");
    let actual = sha256_file(&wasm_path, MAX_WASM_BYTES)?;
    if actual != deployed.wasm_sha256 {
        return Err("deployed esbt.wasm does not match its provenance manifest".to_owned());
    }
    Ok(true)
}

fn sha256_file(path: &Path, max_bytes: u64) -> Result<String, String> {
    let metadata = path
        .metadata()
        .map_err(|error| format!("deployed esbt.wasm: {error}"))?;
    if !metadata.is_file() || metadata.len() > max_bytes {
        return Err(format!(
            "deployed esbt.wasm is not one regular file of at most {max_bytes} bytes"
        ));
    }
    let mut file = File::open(path).map_err(|error| format!("deployed esbt.wasm: {error}"))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("deployed esbt.wasm: {error}"))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(hex_digest(digest.finalize()))
}

fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
    bytes
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deployed_bytes_must_match_the_build_bound_manifest() {
        let root = std::env::temp_dir().join(format!(
            "marks-artifact-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).expect("static root");
        std::fs::write(root.join("esbt.wasm.manifest.json"), EMBEDDED_MANIFEST).expect("manifest");
        std::fs::write(root.join("esbt.wasm"), b"not the declared Wasm").expect("tampered Wasm");
        let error = ArtifactIdentity::load(Some(&root)).expect_err("tampering must fail");
        assert!(error.contains("does not match"), "{error}");
        let _ = std::fs::remove_dir_all(root);
    }
}
