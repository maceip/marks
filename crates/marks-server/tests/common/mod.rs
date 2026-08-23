//! Integration harness: a real marks-server on a real TCP listener with a
//! temporary SQLite database, plus browser-equivalent crypto helpers.
//!
//! Shared across integration crates; some helpers are unused in a given crate.
#![allow(dead_code)]

pub mod peer;

use base64ct::{Base64UrlUnpadded, Encoding};
use marks_server::{App, Config};
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

pub struct TestServer {
    pub base: String,
    pub addr: SocketAddr,
    pub app: Arc<App>,
    pub db_path: PathBuf,
    shutdown: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
}

impl TestServer {
    pub async fn spawn(db_path: PathBuf) -> TestServer {
        Self::spawn_with(db_path, |_| {}).await
    }

    pub async fn spawn_with(db_path: PathBuf, configure: impl FnOnce(&mut Config)) -> TestServer {
        Self::spawn_with_provider(db_path, configure, None).await
    }

    pub async fn spawn_with_provider(
        db_path: PathBuf,
        configure: impl FnOnce(&mut Config),
        provider: Option<Arc<dyn marks_server::agent::AgentProvider>>,
    ) -> TestServer {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test listener");
        let addr = listener.local_addr().expect("local addr");
        let mut config = Config {
            listen: addr,
            database: db_path.clone(),
            asset_dir: db_path.with_extension("assets"),
            max_asset_bytes: 10 * 1024 * 1024,
            max_asset_bytes_per_document: 128 * 1024 * 1024,
            max_concurrent_bundle_exports: 4,
            backup_dir: None,
            backup_interval_ms: 24 * 60 * 60 * 1000,
            backup_retain: 14,
            origin: format!("http://{addr}"),
            static_dir: None,
            evt_enabled: true,
            evt_locator_key: vec![7_u8; 32],
            evt_locator_key_version: 1,
            evt_adapter_version: "test-adapter-1".to_owned(),
            scratch_ttl_ms: 24 * 60 * 60 * 1000,
            session_ttl_ms: 30 * 24 * 60 * 60 * 1000,
            session_rotate_after_ms: 24 * 60 * 60 * 1000,
            pairing_ttl_ms: 2 * 60 * 1000,
            challenge_ttl_ms: 2 * 60 * 1000,
            compact_every_updates: 4,
            compact_every_operations: marks_server::engine_profile::get()
                .unwrap()
                .server_compact_operations,
            commit_batch_delay_ms: 10,
            commit_batch_max: 64,
            room_idle_ms: 1_000,
            max_resident_rooms: 64,
            max_connections_per_room: 16,
            max_mutations_per_second: 10_000,
            max_mutation_bytes_per_second: 256 * 1024 * 1024,
            websocket_ping_ms: 1_000,
            websocket_idle_ms: 5_000,
            database_heartbeat_ms: 1_000,
            database_heartbeat_stale_ms: 5_000,
            max_frame_bytes: marks_server::engine_profile::get().unwrap().max_frame_bytes,
            agent: Default::default(),
        };
        configure(&mut config);
        let app = App::new_with_agent_provider(config, provider).expect("build app");
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let serve_app = app.clone();
        let task = tokio::spawn(async move {
            marks_server::serve(serve_app, listener, async {
                let _ = shutdown_rx.await;
            })
            .await
            .expect("server run");
        });
        TestServer {
            base: format!("http://{addr}"),
            addr,
            app,
            db_path,
            shutdown: Some(shutdown_tx),
            task: Some(task),
        }
    }

    /// Graceful stop: rooms flush, the port is released.
    pub async fn stop(mut self) -> PathBuf {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
        self.db_path.clone()
    }

    /// Abrupt process loss: no room shutdown hook or final compaction runs.
    pub async fn crash(mut self) -> PathBuf {
        self.shutdown.take();
        if let Some(task) = self.task.take() {
            task.abort();
            let _ = task.await;
        }
        self.db_path.clone()
    }
}

pub fn temp_db(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join("marks-server-tests");
    std::fs::create_dir_all(&dir).expect("create test dir");
    let path = dir.join(format!(
        "{name}-{}.db3",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = std::fs::remove_file(&path);
    path
}

pub fn b64(bytes: &[u8]) -> String {
    Base64UrlUnpadded::encode_string(bytes)
}

pub fn b64d(text: &str) -> Vec<u8> {
    Base64UrlUnpadded::decode_vec(text).expect("base64url")
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

pub struct DeviceKey {
    pub signing: SigningKey,
}

impl DeviceKey {
    pub fn generate() -> Self {
        Self {
            signing: SigningKey::random(&mut rand_core::OsRng),
        }
    }

    /// 65-byte uncompressed SEC1 point, the browser's canonical export.
    pub fn public_sec1(&self) -> Vec<u8> {
        self.signing
            .verifying_key()
            .to_encoded_point(false)
            .as_bytes()
            .to_vec()
    }

    pub fn public_key_hash(&self) -> [u8; 32] {
        marks_auth::public_key_hash(&self.public_sec1())
    }

    pub fn sign_p1363(&self, message: &[u8]) -> Vec<u8> {
        let signature: Signature = self.signing.sign(message);
        signature.to_bytes().to_vec()
    }
}

/// Extract `__Host-marks_session=...` from a Set-Cookie header value.
pub fn cookie_value(set_cookie: &str) -> String {
    set_cookie
        .split(';')
        .next()
        .expect("cookie pair")
        .trim()
        .to_owned()
}

/// A fully promoted principal: scratch → pending device → pairing →
/// first-phone bootstrap → desktop finalize. Returns the desktop session.
pub struct Principal {
    pub cookie: String,
    pub csrf: String,
    pub principal_id: String,
    pub device_id: String,
}

pub async fn create_principal(base: &str, http: &reqwest::Client, tag: &str) -> Principal {
    let scratch: serde_json::Value = http
        .post(format!("{base}/v1/auth/scratch"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let scratch_id = scratch["scratchId"].as_str().unwrap().to_owned();
    let capability = scratch["capability"].as_str().unwrap().to_owned();
    let scratch_auth = format!("MarksScratch {scratch_id}.{capability}");

    let browser_key = DeviceKey::generate();
    let device_id = format!("device_browser_{tag}");
    let bound = http
        .put(format!("{base}/v1/auth/scratch/{scratch_id}/device"))
        .header("Authorization", &scratch_auth)
        .json(&serde_json::json!({
            "deviceId": device_id,
            "publicKey": b64(&browser_key.public_sec1()),
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(bound.status(), 204);

    let pairing: serde_json::Value = http
        .post(format!("{base}/v1/auth/pairings"))
        .header("Authorization", &scratch_auth)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let pairing_id = pairing["pairingId"].as_str().unwrap().to_owned();
    let pairing_secret = pairing["secret"].as_str().unwrap().to_owned();

    let controller_key = DeviceKey::generate();
    let now = now_ms();
    let controller_id = format!("controller_{tag}");
    let controller_device_id = format!("device_phone_{tag}");
    let bootstrap = marks_auth::ControllerBootstrap {
        version: 1,
        controller_id: marks_auth::ControllerId::new(controller_id.clone()).unwrap(),
        controller_device_id: marks_auth::DeviceId::new(controller_device_id.clone()).unwrap(),
        controller_public_key_hash: controller_key.public_key_hash(),
        pairing_id: marks_auth::PairingId::new(pairing_id.clone()).unwrap(),
        scratch_id: marks_auth::ScratchId::new(scratch_id.clone()).unwrap(),
        pending_device_id: marks_auth::DeviceId::new(device_id.clone()).unwrap(),
        pending_device_public_key_hash: browser_key.public_key_hash(),
        issued_at_ms: now,
        expires_at_ms: now + 60_000,
    };
    let signature = controller_key.sign_p1363(&bootstrap.signing_bytes());
    let approved = http
        .post(format!("{base}/v1/auth/pairings/{pairing_id}/bootstrap"))
        .json(&serde_json::json!({
            "secret": pairing_secret,
            "bootstrap": {
                "version": 1,
                "controllerId": controller_id,
                "controllerDeviceId": controller_device_id,
                "controllerPublicKeyHash": b64(&bootstrap.controller_public_key_hash),
                "pairingId": pairing_id,
                "scratchId": scratch_id,
                "pendingDeviceId": device_id,
                "pendingDevicePublicKeyHash": b64(&bootstrap.pending_device_public_key_hash),
                "issuedAtMs": now,
                "expiresAtMs": now + 60_000,
            },
            "controllerPublicKey": b64(&controller_key.public_sec1()),
            "signature": b64(&signature),
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(approved.status(), 201, "bootstrap");
    let approved_body: serde_json::Value = approved.json().await.unwrap();
    let principal_id = approved_body["principalId"].as_str().unwrap().to_owned();

    let finalized = http
        .post(format!("{base}/v1/auth/pairings/{pairing_id}/finalize"))
        .header("Authorization", &scratch_auth)
        .send()
        .await
        .unwrap();
    assert_eq!(finalized.status(), 201, "finalize");
    let cookie = cookie_value(
        finalized
            .headers()
            .get("set-cookie")
            .unwrap()
            .to_str()
            .unwrap(),
    );
    let finalized_body: serde_json::Value = finalized.json().await.unwrap();
    let csrf = finalized_body["csrf"].as_str().unwrap().to_owned();

    Principal {
        cookie,
        csrf,
        principal_id,
        device_id,
    }
}
