use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;
use std::process::Command;

const PLAN_SCHEMA: &str = "marks.product-build-plan.v1";
const MAX_BUILD_PLAN_BYTES: usize = 16 * 1024;

fn quoted_field(line: &str, field: &str) -> Option<String> {
    let marker = format!("{field} = \"");
    let start = line.find(&marker)? + marker.len();
    let tail = &line[start..];
    Some(tail[..tail.find('"')?].to_owned())
}

fn build_revision() -> String {
    match std::env::var("MARKS_BUILD_REVISION") {
        Ok(value) if value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) => {
            value.to_ascii_lowercase()
        }
        Ok(_) => panic!("MARKS_BUILD_REVISION must be exactly 40 hexadecimal characters"),
        Err(std::env::VarError::NotPresent) => "development".to_owned(),
        Err(error) => panic!("cannot read MARKS_BUILD_REVISION: {error}"),
    }
}

fn git_source_dirty(workspace: &Path) -> Option<bool> {
    let output = Command::new("git")
        .args([
            "-C",
            workspace.to_str()?,
            "status",
            "--porcelain=v1",
            "--untracked-files=normal",
            "--",
            ".",
        ])
        .output()
        .ok()?;
    output.status.success().then_some(!output.stdout.is_empty())
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-'))
        && value.as_bytes()[0].is_ascii_lowercase()
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn exact_keys(object: &Map<String, Value>, expected: &[&str], label: &str) {
    let mut actual = object.keys().map(String::as_str).collect::<Vec<_>>();
    actual.sort_unstable();
    let mut expected = expected.to_vec();
    expected.sort_unstable();
    assert_eq!(actual, expected, "{label} has unknown or missing fields");
}

fn object<'a>(value: &'a Value, label: &str) -> &'a Map<String, Value> {
    value
        .as_object()
        .unwrap_or_else(|| panic!("{label} must be a JSON object"))
}

fn string<'a>(object: &'a Map<String, Value>, field: &str, label: &str) -> &'a str {
    object
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("{label}.{field} must be a string"))
}

fn canonical_json(value: &Value) -> String {
    fn append(value: &Value, output: &mut String) {
        match value {
            Value::Null => output.push_str("null"),
            Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
            Value::Number(value) => output.push_str(&value.to_string()),
            Value::String(value) => {
                output.push_str(&serde_json::to_string(value).expect("serialize JSON string"));
            }
            Value::Array(values) => {
                output.push('[');
                for (index, value) in values.iter().enumerate() {
                    if index != 0 {
                        output.push(',');
                    }
                    append(value, output);
                }
                output.push(']');
            }
            Value::Object(object) => {
                output.push('{');
                let mut fields = object.iter().collect::<Vec<_>>();
                fields.sort_unstable_by_key(|(key, _)| *key);
                for (index, (key, value)) in fields.into_iter().enumerate() {
                    if index != 0 {
                        output.push(',');
                    }
                    output.push_str(&serde_json::to_string(key).expect("serialize JSON key"));
                    output.push(':');
                    append(value, output);
                }
                output.push('}');
            }
        }
    }

    let mut output = String::new();
    append(value, &mut output);
    output
}

fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
    bytes
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn enabled_cargo_features() -> Vec<String> {
    let mut features = std::env::vars()
        .filter_map(|(name, value)| {
            let feature = name.strip_prefix("CARGO_FEATURE_")?;
            (value == "1" && feature != "DEFAULT")
                .then(|| feature.to_ascii_lowercase().replace('_', "-"))
        })
        .collect::<Vec<_>>();
    features.sort();
    features.dedup();
    features
}

fn validate_plan(
    plan: &Value,
    expected_variant: &str,
    actual_cargo_features: &[String],
    release: bool,
) {
    let root = object(plan, "MARKS_BUILD_PLAN_JSON");
    exact_keys(
        root,
        &[
            "schema",
            "productVariant",
            "deployable",
            "features",
            "client",
            "server",
        ],
        "MARKS_BUILD_PLAN_JSON",
    );
    assert_eq!(
        string(root, "schema", "MARKS_BUILD_PLAN_JSON"),
        PLAN_SCHEMA,
        "MARKS_BUILD_PLAN_JSON has the wrong schema"
    );
    let variant = string(root, "productVariant", "MARKS_BUILD_PLAN_JSON");
    assert!(valid_identifier(variant), "productVariant is invalid");
    assert_eq!(
        variant, expected_variant,
        "MARKS_PRODUCT_VARIANT differs from MARKS_BUILD_PLAN_JSON"
    );
    let deployable = root
        .get("deployable")
        .and_then(Value::as_bool)
        .expect("MARKS_BUILD_PLAN_JSON.deployable must be a boolean");

    let features = object(&root["features"], "MARKS_BUILD_PLAN_JSON.features");
    assert!(!features.is_empty(), "build plan features cannot be empty");
    for (feature, enabled) in features {
        assert!(
            valid_identifier(feature),
            "invalid product feature {feature:?}"
        );
        assert!(
            enabled.is_boolean(),
            "product feature {feature:?} must be a boolean"
        );
    }
    // This relation cannot be inferred from the two generic lists: an
    // untrusted self-hashed plan could otherwise claim the product feature is
    // disabled while asking Cargo to compile it. Keep the source-owned mapping
    // explicit until the plan schema carries a generic feature-to-Cargo map.
    let agent_chat = features
        .get("agent-chat")
        .and_then(Value::as_bool)
        .expect("build plan must resolve the agent-chat feature");
    let client = object(&root["client"], "MARKS_BUILD_PLAN_JSON.client");
    exact_keys(client, &["dataMode"], "MARKS_BUILD_PLAN_JSON.client");
    let data_mode = string(client, "dataMode", "MARKS_BUILD_PLAN_JSON.client");
    assert!(
        matches!(data_mode, "local" | "service"),
        "client.dataMode must be local or service"
    );

    let server = object(&root["server"], "MARKS_BUILD_PLAN_JSON.server");
    exact_keys(server, &["cargoFeatures"], "MARKS_BUILD_PLAN_JSON.server");
    let cargo_features = server["cargoFeatures"]
        .as_array()
        .expect("server.cargoFeatures must be an array")
        .iter()
        .map(|feature| {
            feature
                .as_str()
                .filter(|feature| valid_identifier(feature))
                .unwrap_or_else(|| panic!("server.cargoFeatures contains an invalid feature"))
                .to_owned()
        })
        .collect::<Vec<_>>();
    assert!(
        cargo_features.windows(2).all(|pair| pair[0] < pair[1]),
        "server.cargoFeatures must be sorted and unique"
    );
    assert_eq!(
        cargo_features, actual_cargo_features,
        "compiled Cargo features differ from the canonical build plan"
    );
    assert_eq!(
        agent_chat,
        cargo_features.iter().any(|feature| feature == "agent-chat"),
        "agent-chat product state and server Cargo feature disagree"
    );

    if release {
        assert!(
            deployable,
            "a release build requires a deployable product variant"
        );
        assert_eq!(
            data_mode, "service",
            "a release server must be paired with a service-mode webapp"
        );
    }
}

fn resolve_development_build_plan(
    workspace: &Path,
    actual_cargo_features: &[String],
) -> (String, String, String) {
    assert!(
        actual_cargo_features.is_empty(),
        "development builds with Cargo features require an explicit canonical product build plan"
    );
    let output = Command::new("node")
        .args([
            "--experimental-strip-types",
            "scripts/product-variant.ts",
            "resolve",
            "--variant",
            "stable",
            "--data-mode",
            "local",
            "--format",
            "json",
        ])
        .current_dir(workspace)
        .output()
        .unwrap_or_else(|error| {
            panic!(
                "development build needs Node to resolve the default product plan, or explicit MARKS_PRODUCT_VARIANT/MARKS_BUILD_PLAN_SHA256/MARKS_BUILD_PLAN_JSON: {error}"
            )
        });
    assert!(
        output.status.success(),
        "canonical product variant resolver failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let receipt: Value = serde_json::from_slice(&output.stdout)
        .unwrap_or_else(|error| panic!("product variant resolver returned invalid JSON: {error}"));
    let receipt = object(&receipt, "product variant resolver receipt");
    exact_keys(
        receipt,
        &["schema", "buildPlan", "buildPlanSha256"],
        "product variant resolver receipt",
    );
    assert_eq!(
        string(receipt, "schema", "product variant resolver receipt"),
        "marks.product-build-receipt.v1",
        "product variant resolver returned the wrong receipt schema"
    );
    let plan = receipt
        .get("buildPlan")
        .expect("product variant resolver receipt must include buildPlan");
    let plan_root = object(plan, "product variant resolver buildPlan");
    let variant = string(
        plan_root,
        "productVariant",
        "product variant resolver buildPlan",
    )
    .to_owned();
    let digest = string(
        receipt,
        "buildPlanSha256",
        "product variant resolver receipt",
    )
    .to_owned();
    (variant, digest, canonical_json(plan))
}

fn resolve_build_plan(build_revision: &str, workspace: &Path) -> (String, String, String) {
    let actual_cargo_features = enabled_cargo_features();
    let variant = std::env::var("MARKS_PRODUCT_VARIANT");
    let digest = std::env::var("MARKS_BUILD_PLAN_SHA256");
    let json = std::env::var("MARKS_BUILD_PLAN_JSON");
    let supplied = [variant.is_ok(), digest.is_ok(), json.is_ok()];
    if supplied.iter().any(|value| *value) && !supplied.iter().all(|value| *value) {
        panic!(
            "MARKS_PRODUCT_VARIANT, MARKS_BUILD_PLAN_SHA256, and MARKS_BUILD_PLAN_JSON must be supplied together"
        );
    }
    if build_revision != "development" && !supplied.iter().all(|value| *value) {
        panic!("a release build requires the canonical product build plan environment");
    }

    let (variant, declared_digest, plan_json) = if supplied.iter().all(|value| *value) {
        (
            variant.expect("checked"),
            digest.expect("checked"),
            json.expect("checked"),
        )
    } else {
        resolve_development_build_plan(workspace, &actual_cargo_features)
    };

    assert!(
        plan_json.len() <= MAX_BUILD_PLAN_BYTES,
        "MARKS_BUILD_PLAN_JSON exceeds {MAX_BUILD_PLAN_BYTES} bytes"
    );
    assert!(
        valid_identifier(&variant),
        "MARKS_PRODUCT_VARIANT is invalid"
    );
    assert!(
        valid_hash(&declared_digest),
        "MARKS_BUILD_PLAN_SHA256 must be one lowercase SHA-256 digest"
    );
    let plan: Value = serde_json::from_str(&plan_json)
        .unwrap_or_else(|error| panic!("MARKS_BUILD_PLAN_JSON is invalid JSON: {error}"));
    let canonical = canonical_json(&plan);
    assert_eq!(
        plan_json, canonical,
        "MARKS_BUILD_PLAN_JSON must be canonical minified JSON"
    );
    let observed_digest = hex_digest(Sha256::digest(canonical.as_bytes()));
    assert_eq!(
        declared_digest, observed_digest,
        "MARKS_BUILD_PLAN_SHA256 does not hash MARKS_BUILD_PLAN_JSON"
    );
    validate_plan(
        &plan,
        &variant,
        &actual_cargo_features,
        build_revision != "development",
    );
    (variant, declared_digest, canonical)
}

fn main() {
    println!("cargo:rerun-if-changed=Cargo.toml");
    println!("cargo:rerun-if-changed=../../config/product-variants.ts");
    println!("cargo:rerun-if-changed=../../scripts/product-variant.ts");
    for name in [
        "MARKS_BUILD_REVISION",
        "MARKS_SOURCE_DIRTY",
        "MARKS_PRODUCT_VARIANT",
        "MARKS_BUILD_PLAN_SHA256",
        "MARKS_BUILD_PLAN_JSON",
        "CARGO_FEATURE_AGENT_CHAT",
    ] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    let manifest_dir = std::env::var_os("CARGO_MANIFEST_DIR")
        .map(std::path::PathBuf::from)
        .expect("Cargo supplies CARGO_MANIFEST_DIR");
    let workspace = manifest_dir
        .parent()
        .and_then(Path::parent)
        .expect("marks-server lives under the workspace crates directory");
    let manifest = fs::read_to_string("Cargo.toml").expect("read marks-server Cargo.toml");
    let engine_revision = manifest
        .lines()
        .find(|line| line.trim_start().starts_with("esbt = {"))
        .and_then(|line| quoted_field(line, "rev"))
        .filter(|revision| {
            revision.len() == 40 && revision.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
        .expect("the esbt dependency must have one exact 40-character rev");
    let build_revision = build_revision();
    let declared_dirty =
        std::env::var("MARKS_SOURCE_DIRTY")
            .ok()
            .map(|value| match value.as_str() {
                "0" => false,
                "1" => true,
                _ => panic!("MARKS_SOURCE_DIRTY must be exactly 0 or 1"),
            });
    if build_revision != "development" && declared_dirty.is_none() {
        panic!("a release MARKS_BUILD_REVISION requires an explicit MARKS_SOURCE_DIRTY");
    }
    let observed_dirty = git_source_dirty(workspace);
    if declared_dirty == Some(false) && observed_dirty == Some(true) {
        panic!("MARKS_SOURCE_DIRTY=0 contradicts the dirty Git checkout");
    }
    let source_dirty = declared_dirty.or(observed_dirty).unwrap_or(true);
    let (product_variant, build_plan_sha256, build_plan_json) =
        resolve_build_plan(&build_revision, workspace);
    println!("cargo:rustc-env=MARKS_ESBT_REVISION={engine_revision}");
    println!("cargo:rustc-env=MARKS_BUILD_REVISION={build_revision}");
    println!(
        "cargo:rustc-env=MARKS_SOURCE_DIRTY={}",
        if source_dirty { "1" } else { "0" }
    );
    println!("cargo:rustc-env=MARKS_PRODUCT_VARIANT={product_variant}");
    println!("cargo:rustc-env=MARKS_BUILD_PLAN_SHA256={build_plan_sha256}");
    println!("cargo:rustc-env=MARKS_BUILD_PLAN_JSON={build_plan_json}");
}
