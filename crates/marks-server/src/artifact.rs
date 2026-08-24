use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::File;
use std::io::Read;
use std::path::Path;

const EMBEDDED_MANIFEST: &str = include_str!("../../../client/public/esbt.component.manifest.json");
const ENGINE_PROFILE: &[u8] = include_bytes!("../../../engine-profile.json");
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_COMPONENT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_WIT_BYTES: u64 = 1024 * 1024;
const MAX_CORE_MODULES: usize = 16;
const COMPONENT_HEADER: &[u8] = b"\0asm\x0d\0\x01\0";
const CORE_MODULE_HEADER: &[u8] = b"\0asm\x01\0\0\0";

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
struct ArtifactFile {
    path: String,
    bytes: u64,
    sha256: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
struct ComponentManifest {
    schema: String,
    format: u32,
    engine_revision: String,
    source_dirty: bool,
    source_sha256: String,
    profile_sha256: String,
    wit_package: String,
    wit_sha256: String,
    wire_version: u32,
    transpiler_package: String,
    transpiler_version: String,
    component: ArtifactFile,
    wrapper: ArtifactFile,
    core_modules: Vec<ArtifactFile>,
    compiler: String,
    target: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactFileIdentity {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}

impl From<ArtifactFile> for ArtifactFileIdentity {
    fn from(value: ArtifactFile) -> Self {
        Self {
            path: value.path,
            bytes: value.bytes,
            sha256: value.sha256,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactIdentity {
    pub schema: &'static str,
    pub server_version: &'static str,
    pub build_revision: &'static str,
    pub server_source_dirty: bool,
    pub server_engine_revision: &'static str,
    pub component_engine_revision: String,
    pub component_source_dirty: bool,
    pub component_source_sha256: String,
    pub component_sha256: String,
    pub component_bytes: u64,
    pub browser_wrapper_sha256: String,
    pub browser_wrapper_bytes: u64,
    pub browser_core_modules: Vec<ArtifactFileIdentity>,
    pub wit_package: String,
    pub wit_sha256: String,
    pub wire_version: u32,
    pub transpiler_package: String,
    pub transpiler_version: String,
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
        let component = parse_manifest(EMBEDDED_MANIFEST, "build-bound ESBT component manifest")?;
        let static_artifact_verified = match static_dir {
            Some(root) => verify_deployed_artifact(root, &component)?,
            None => false,
        };
        let server_engine_revision = env!("MARKS_ESBT_REVISION");
        let build_revision = env!("MARKS_BUILD_REVISION");
        let server_source_dirty = env!("MARKS_SOURCE_DIRTY") == "1";
        let profile_sha256 = hex_digest(Sha256::digest(ENGINE_PROFILE));
        let profile_coherent = component.profile_sha256 == profile_sha256;
        let engine_coherent =
            component.engine_revision == server_engine_revision && profile_coherent;
        let release_ready = engine_coherent
            && static_artifact_verified
            && !component.source_dirty
            && !server_source_dirty
            && build_revision != "development";
        Ok(Self {
            schema: "marks-artifact.component",
            server_version: env!("CARGO_PKG_VERSION"),
            build_revision,
            server_source_dirty,
            server_engine_revision,
            component_engine_revision: component.engine_revision,
            component_source_dirty: component.source_dirty,
            component_source_sha256: component.source_sha256,
            component_sha256: component.component.sha256,
            component_bytes: component.component.bytes,
            browser_wrapper_sha256: component.wrapper.sha256,
            browser_wrapper_bytes: component.wrapper.bytes,
            browser_core_modules: component
                .core_modules
                .into_iter()
                .map(ArtifactFileIdentity::from)
                .collect(),
            wit_package: component.wit_package,
            wit_sha256: component.wit_sha256,
            wire_version: component.wire_version,
            transpiler_package: component.transpiler_package,
            transpiler_version: component.transpiler_version,
            profile_sha256: component.profile_sha256,
            compiler: component.compiler,
            target: component.target,
            static_artifact_verified,
            profile_coherent,
            engine_coherent,
            release_ready,
        })
    }
}

fn parse_manifest(text: &str, label: &str) -> Result<ComponentManifest, String> {
    if text.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(format!("{label} exceeds {MAX_MANIFEST_BYTES} bytes"));
    }
    let manifest: ComponentManifest =
        serde_json::from_str(text).map_err(|error| format!("{label}: {error}"))?;
    let core_paths: HashSet<&str> = manifest
        .core_modules
        .iter()
        .map(|entry| entry.path.as_str())
        .collect();
    if manifest.schema != "esbt.component-artifact"
        || manifest.format != 1
        || !valid_revision(&manifest.engine_revision)
        || !valid_hash(&manifest.source_sha256)
        || !valid_hash(&manifest.profile_sha256)
        || manifest.wit_package != "esbt:document@1.0.0"
        || !valid_hash(&manifest.wit_sha256)
        || manifest.wire_version != 1
        || manifest.transpiler_package != "@bytecodealliance/jco-transpile"
        || !valid_semver(&manifest.transpiler_version)
        || manifest.component.path != "/esbt.component.wasm"
        || !valid_file(&manifest.component)
        || manifest.wrapper.path != "client:collab/wasm/generated/esbt.js"
        || !valid_file(&manifest.wrapper)
        || manifest.core_modules.is_empty()
        || manifest.core_modules.len() > MAX_CORE_MODULES
        || core_paths.len() != manifest.core_modules.len()
        || manifest
            .core_modules
            .iter()
            .any(|entry| !valid_core_path(&entry.path) || !valid_file(entry))
        || !valid_compiler(&manifest.compiler)
        || manifest.target != "wasm32-unknown-unknown"
    {
        return Err(format!("{label} has invalid component provenance fields"));
    }
    Ok(manifest)
}

fn valid_revision(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_semver(value: &str) -> bool {
    let fields: Vec<&str> = value.split('.').collect();
    fields.len() == 3
        && fields
            .iter()
            .all(|field| !field.is_empty() && field.bytes().all(|byte| byte.is_ascii_digit()))
}

fn valid_compiler(value: &str) -> bool {
    let Some(version) = value.strip_prefix("rustc ") else {
        return false;
    };
    let Some(version) = version.split_once(' ').map(|(version, _)| version) else {
        return false;
    };
    valid_semver(version)
}

fn valid_file(file: &ArtifactFile) -> bool {
    file.bytes > 0 && file.bytes <= MAX_COMPONENT_BYTES && valid_hash(&file.sha256)
}

fn valid_core_path(path: &str) -> bool {
    let Some(suffix) = path.strip_prefix("/esbt.core") else {
        return false;
    };
    let Some(index) = suffix.strip_suffix(".wasm") else {
        return false;
    };
    index.is_empty() || (!index.starts_with('0') && index.bytes().all(|byte| byte.is_ascii_digit()))
}

fn verify_deployed_artifact(root: &Path, expected: &ComponentManifest) -> Result<bool, String> {
    let manifest_path = root.join("esbt.component.manifest.json");
    let metadata = manifest_path
        .metadata()
        .map_err(|error| format!("deployed component manifest: {error}"))?;
    if !metadata.is_file() || metadata.len() > MAX_MANIFEST_BYTES {
        return Err("deployed component manifest is not one bounded regular file".to_owned());
    }
    let deployed_text = std::fs::read_to_string(&manifest_path)
        .map_err(|error| format!("deployed component manifest: {error}"))?;
    let deployed = parse_manifest(&deployed_text, "deployed component manifest")?;
    if &deployed != expected {
        return Err("deployed component manifest differs from the server build receipt".to_owned());
    }

    let revision = std::fs::read_to_string(root.join("esbt.component.rev"))
        .map_err(|error| format!("deployed component revision: {error}"))?;
    if revision != format!("{}\n", deployed.engine_revision) {
        return Err("deployed component revision stamp differs from its manifest".to_owned());
    }

    verify_file(
        &root.join(deployed.component.path.trim_start_matches('/')),
        "deployed ESBT component",
        &deployed.component.sha256,
        Some(deployed.component.bytes),
        MAX_COMPONENT_BYTES,
        Some(COMPONENT_HEADER),
    )?;
    verify_file(
        &root.join("esbt.wit"),
        "deployed ESBT WIT contract",
        &deployed.wit_sha256,
        None,
        MAX_WIT_BYTES,
        None,
    )?;
    for module in &deployed.core_modules {
        verify_file(
            &root.join(module.path.trim_start_matches('/')),
            "deployed ESBT browser core module",
            &module.sha256,
            Some(module.bytes),
            MAX_COMPONENT_BYTES,
            Some(CORE_MODULE_HEADER),
        )?;
    }
    Ok(true)
}

fn verify_file(
    path: &Path,
    label: &str,
    expected_hash: &str,
    expected_bytes: Option<u64>,
    max_bytes: u64,
    expected_header: Option<&[u8]>,
) -> Result<(), String> {
    let metadata = path
        .metadata()
        .map_err(|error| format!("{label}: {error}"))?;
    if !metadata.is_file()
        || metadata.len() == 0
        || metadata.len() > max_bytes
        || expected_bytes.is_some_and(|bytes| metadata.len() != bytes)
    {
        return Err(format!("{label} is not the declared bounded regular file"));
    }
    let mut file = File::open(path).map_err(|error| format!("{label}: {error}"))?;
    let mut digest = Sha256::new();
    let mut prefix = Vec::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("{label}: {error}"))?;
        if read == 0 {
            break;
        }
        if let Some(header) = expected_header {
            let remaining = header.len().saturating_sub(prefix.len());
            prefix.extend_from_slice(&buffer[..read.min(remaining)]);
        }
        digest.update(&buffer[..read]);
    }
    if expected_header.is_some_and(|header| prefix != header) {
        return Err(format!("{label} has the wrong WebAssembly binary kind"));
    }
    if hex_digest(digest.finalize()) != expected_hash {
        return Err(format!("{label} does not match its provenance manifest"));
    }
    Ok(())
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
    fn every_deployed_component_file_is_bound_and_kind_checked() {
        let root = std::env::temp_dir().join(format!(
            "marks-artifact-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).expect("static root");
        let public = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../client/public");
        let manifest = parse_manifest(EMBEDDED_MANIFEST, "test manifest").expect("manifest");
        for name in [
            "esbt.component.manifest.json",
            "esbt.component.rev",
            "esbt.component.wasm",
            "esbt.wit",
        ] {
            std::fs::copy(public.join(name), root.join(name)).expect("copy component file");
        }
        for module in &manifest.core_modules {
            let name = module.path.trim_start_matches('/');
            std::fs::copy(public.join(name), root.join(name)).expect("copy core module");
        }
        assert!(ArtifactIdentity::load(Some(&root)).is_ok());

        std::fs::write(
            root.join("esbt.component.wasm"),
            b"not the declared component",
        )
        .expect("tampered component");
        let error = ArtifactIdentity::load(Some(&root)).expect_err("tampering must fail");
        assert!(
            error.contains("declared") || error.contains("does not match"),
            "{error}"
        );
        let _ = std::fs::remove_dir_all(root);
    }
}
