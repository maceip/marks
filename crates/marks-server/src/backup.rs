//! Asset-consistent online backups and fail-closed restore verification.

use crate::artifact::ArtifactIdentity;
use crate::assets::AssetStore;
use crate::db::Db;
use crate::ids::now_ms;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::future::Future;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::task::JoinHandle;
use tokio::time::Instant;

const BACKUP_SCHEMA: &str = "marks-backup.v2";
const BACKUP_CREATE_TIMEOUT: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupAsset {
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupManifest {
    pub schema: String,
    pub created_at_ms: u64,
    pub database_sha256: String,
    pub build_revision: String,
    pub server_engine_revision: String,
    pub component_sha256: String,
    pub assets: Vec<BackupAsset>,
}

fn hash_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn decode_hash(text: &str) -> Result<[u8; 32], String> {
    if text.len() != 64 {
        return Err("asset hash is not 32 bytes".into());
    }
    let mut out = [0_u8; 32];
    for (index, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[index * 2..index * 2 + 2], 16)
            .map_err(|_| "asset hash is not hexadecimal".to_owned())?;
    }
    Ok(out)
}

fn file_sha256(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| format!("open {}: {error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("read {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hash_hex(&hasher.finalize()))
}

fn fsync_directory(path: &Path) -> Result<(), String> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("sync {}: {error}", path.display()))
}

fn asset_rows(database: &Path) -> Result<Vec<BackupAsset>, String> {
    let connection = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("open backup database: {error}"))?;
    let integrity: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|error| format!("backup integrity check: {error}"))?;
    if integrity != "ok" {
        return Err(format!(
            "backup database integrity check returned {integrity:?}"
        ));
    }
    let mut statement = connection
        .prepare("SELECT content_hash, bytes FROM asset_blobs ORDER BY content_hash")
        .map_err(|error| format!("read backup asset table: {error}"))?;
    statement
        .query_map([], |row| {
            let hash: Vec<u8> = row.get(0)?;
            let bytes: i64 = row.get(1)?;
            Ok((hash, bytes))
        })
        .map_err(|error| format!("query backup assets: {error}"))?
        .map(|row| {
            let (hash, bytes) = row.map_err(|error| format!("read backup asset: {error}"))?;
            if hash.len() != 32 || bytes < 0 {
                return Err("backup database contains an invalid asset row".to_owned());
            }
            Ok(BackupAsset {
                sha256: hash_hex(&hash),
                bytes: bytes as u64,
            })
        })
        .collect()
}

#[derive(Debug)]
struct PreparedBackup {
    partial: PathBuf,
    final_path: PathBuf,
    published: bool,
}

impl PreparedBackup {
    fn new(partial: PathBuf, final_path: PathBuf) -> Self {
        Self {
            partial,
            final_path,
            published: false,
        }
    }

    /// The potentially long copy/verification worker never calls this. Only
    /// a bounded publication worker may make the verified immutable tree
    /// visible. If its JoinHandle times out after the rename began, the late
    /// result is still a self-contained older snapshot and cannot mutate live
    /// database or asset state.
    fn publish(self) -> Result<PathBuf, String> {
        self.publish_with_hook(|| {})
    }

    fn publish_with_hook(mut self, before_publish: impl FnOnce()) -> Result<PathBuf, String> {
        before_publish();
        fs::rename(&self.partial, &self.final_path)
            .map_err(|error| format!("publish backup: {error}"))?;
        self.published = true;
        let root = self
            .final_path
            .parent()
            .ok_or_else(|| "backup path has no parent".to_owned())?;
        fsync_directory(root)?;
        Ok(self.final_path.clone())
    }
}

impl Drop for PreparedBackup {
    fn drop(&mut self) {
        if !self.published {
            let _ = fs::remove_dir_all(&self.partial);
        }
    }
}

struct CancelPreparationOnDrop(Arc<AtomicBool>);

impl Drop for CancelPreparationOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

fn finish_preparation(
    prepared: PreparedBackup,
    cancellation: &AtomicBool,
    before_finish: impl FnOnce(),
) -> Result<PreparedBackup, String> {
    before_finish();
    if cancellation.load(Ordering::Acquire) {
        Err("backup preparation cancelled".to_owned())
    } else {
        Ok(prepared)
    }
}

fn prepare_blocking(
    db: &Db,
    assets: &AssetStore,
    root: &Path,
    artifact: &ArtifactIdentity,
    cancellation: &AtomicBool,
) -> Result<PreparedBackup, String> {
    fs::create_dir_all(root).map_err(|error| format!("create {}: {error}", root.display()))?;
    let created_at_ms = now_ms();
    let partial = root.join(format!(".partial-{created_at_ms}-{}", std::process::id()));
    let final_path = root.join(format!("backup-{created_at_ms:020}"));
    fs::create_dir(&partial)
        .map_err(|error| format!("create backup staging directory: {error}"))?;
    let prepared = PreparedBackup::new(partial.clone(), final_path);
    (|| {
        let database = partial.join("marks.db3");
        db.backup_to(&database)
            .map_err(|error| format!("online SQLite backup: {error:?}"))?;
        if cancellation.load(Ordering::Acquire) {
            return Err("backup preparation cancelled".to_owned());
        }
        let rows = asset_rows(&database)?;
        let asset_root = partial.join("assets");
        fs::create_dir(&asset_root).map_err(|error| format!("create backup assets: {error}"))?;
        for row in &rows {
            if cancellation.load(Ordering::Acquire) {
                return Err("backup preparation cancelled".to_owned());
            }
            assets
                .copy_verified_to(
                    decode_hash(&row.sha256)?,
                    usize::try_from(row.bytes).map_err(|_| "asset is too large".to_owned())?,
                    &asset_root,
                )
                .map_err(|error| format!("copy asset {}: {error}", row.sha256))?;
        }
        let manifest = BackupManifest {
            schema: BACKUP_SCHEMA.to_owned(),
            created_at_ms,
            database_sha256: file_sha256(&database)?,
            build_revision: artifact.build_revision.to_owned(),
            server_engine_revision: artifact.server_engine_revision.to_owned(),
            component_sha256: artifact.component_sha256.clone(),
            assets: rows,
        };
        let manifest_path = partial.join("manifest.json");
        let mut manifest_file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&manifest_path)
            .map_err(|error| format!("create backup manifest: {error}"))?;
        let mut encoded = serde_json::to_vec_pretty(&manifest)
            .map_err(|error| format!("encode backup manifest: {error}"))?;
        encoded.push(b'\n');
        manifest_file
            .write_all(&encoded)
            .and_then(|()| manifest_file.sync_all())
            .map_err(|error| format!("write backup manifest: {error}"))?;
        fsync_directory(&asset_root)?;
        fsync_directory(&partial)?;
        verify_blocking(&partial)?;
        finish_preparation(prepared, cancellation, || {})
    })()
}

pub async fn create_once(
    db: Arc<Db>,
    assets: Arc<AssetStore>,
    root: PathBuf,
    artifact: ArtifactIdentity,
) -> Result<PathBuf, String> {
    create_once_with_timeout(db, assets, root, artifact, BACKUP_CREATE_TIMEOUT).await
}

async fn create_once_with_timeout(
    db: Arc<Db>,
    assets: Arc<AssetStore>,
    root: PathBuf,
    artifact: ArtifactIdentity,
    timeout: Duration,
) -> Result<PathBuf, String> {
    let deadline = Instant::now() + timeout;
    let guard = tokio::time::timeout_at(deadline, assets.backup_guard())
        .await
        .map_err(|_| "backup timed out waiting for the asset guard".to_owned())?;
    let cancellation = Arc::new(AtomicBool::new(false));
    let _cancel_on_drop = CancelPreparationOnDrop(cancellation.clone());
    let worker_cancellation = cancellation.clone();
    let mut preparation = tokio::task::spawn_blocking(move || {
        prepare_blocking(&db, &assets, &root, &artifact, worker_cancellation.as_ref())
    });
    let prepared = await_preparation(&mut preparation, cancellation.as_ref(), deadline).await?;
    if Instant::now() >= deadline {
        return Err("backup preparation timed out".to_owned());
    }
    let mut publication = tokio::task::spawn_blocking(move || prepared.publish());
    let published = await_publication(&mut publication, deadline).await;
    drop(guard);
    published
}

async fn await_preparation(
    preparation: &mut JoinHandle<Result<PreparedBackup, String>>,
    cancellation: &AtomicBool,
    deadline: Instant,
) -> Result<PreparedBackup, String> {
    match tokio::time::timeout_at(deadline, &mut *preparation).await {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => Err(format!("backup task: {error}")),
        Err(_) => {
            cancellation.store(true, Ordering::Release);
            preparation.abort();
            Err("backup preparation timed out".to_owned())
        }
    }
}

async fn await_publication(
    publication: &mut JoinHandle<Result<PathBuf, String>>,
    deadline: Instant,
) -> Result<PathBuf, String> {
    match tokio::time::timeout_at(deadline, &mut *publication).await {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => Err(format!("backup publication task: {error}")),
        Err(_) => {
            // `spawn_blocking` cannot cancel a rename/fsync already in the
            // kernel. Detach at the absolute deadline so the live-asset guard
            // is released. The worker owns only a fully verified immutable
            // snapshot: it can either clean `.partial` on failure or publish a
            // valid older backup, never alter live state.
            publication.abort();
            Err("backup publication timed out".to_owned())
        }
    }
}

fn verify_blocking(path: &Path) -> Result<BackupManifest, String> {
    let encoded = fs::read(path.join("manifest.json"))
        .map_err(|error| format!("read backup manifest: {error}"))?;
    let manifest: BackupManifest = serde_json::from_slice(&encoded)
        .map_err(|error| format!("decode backup manifest: {error}"))?;
    if manifest.schema != BACKUP_SCHEMA {
        return Err("unsupported backup schema".into());
    }
    let database = path.join("marks.db3");
    if file_sha256(&database)? != manifest.database_sha256 {
        return Err("backup database hash mismatch".into());
    }
    let rows = asset_rows(&database)?;
    if rows != manifest.assets {
        return Err("backup manifest does not match asset metadata".into());
    }
    let stored = AssetStore::open(path.join("assets"))?;
    for row in &rows {
        let hash = decode_hash(&row.sha256)?;
        let expected = usize::try_from(row.bytes).map_err(|_| "asset is too large".to_owned())?;
        stored
            .copy_verified_to(hash, expected, stored.root())
            .map_err(|error| format!("verify backup asset {}: {error}", row.sha256))?;
    }
    Ok(manifest)
}

pub async fn verify(path: PathBuf) -> Result<BackupManifest, String> {
    tokio::task::spawn_blocking(move || verify_blocking(&path))
        .await
        .map_err(|error| format!("verify task: {error}"))?
}

fn restore_blocking(backup: &Path, database: &Path, asset_root: &Path) -> Result<(), String> {
    if database.exists() || asset_root.exists() {
        return Err("restore destinations must not already exist".into());
    }
    let manifest = verify_blocking(backup)?;
    if let Some(parent) = database.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("create database parent {}: {error}", parent.display()))?;
    }
    let temp_database = database.with_extension(format!("restore-{}", std::process::id()));
    let result = (|| {
        fs::copy(backup.join("marks.db3"), &temp_database)
            .map_err(|error| format!("restore database: {error}"))?;
        File::open(&temp_database)
            .and_then(|file| file.sync_all())
            .map_err(|error| format!("sync restored database: {error}"))?;
        if file_sha256(&temp_database)? != manifest.database_sha256 {
            return Err("restored database hash mismatch".into());
        }
        let source_assets = AssetStore::open(backup.join("assets"))?;
        let restored_assets = AssetStore::open(asset_root.to_owned())?;
        for row in &manifest.assets {
            source_assets
                .copy_verified_to(
                    decode_hash(&row.sha256)?,
                    usize::try_from(row.bytes).map_err(|_| "asset is too large".to_owned())?,
                    restored_assets.root(),
                )
                .map_err(|error| format!("restore asset {}: {error}", row.sha256))?;
        }
        fs::rename(&temp_database, database)
            .map_err(|error| format!("publish restored database: {error}"))?;
        if let Some(parent) = database.parent() {
            fsync_directory(parent)?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_database);
        let _ = fs::remove_dir_all(asset_root);
    }
    result
}

pub async fn restore(
    backup: PathBuf,
    database: PathBuf,
    asset_root: PathBuf,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || restore_blocking(&backup, &database, &asset_root))
        .await
        .map_err(|error| format!("restore task: {error}"))?
}

fn prune(root: &Path, retain: usize) -> Result<(), String> {
    let mut backups = fs::read_dir(root)
        .map_err(|error| format!("list backups: {error}"))?
        .filter_map(Result::ok)
        .filter(|entry| {
            entry.file_type().is_ok_and(|kind| kind.is_dir())
                && entry.file_name().to_string_lossy().starts_with("backup-")
        })
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    backups.sort();
    let remove = backups.len().saturating_sub(retain);
    for path in backups.into_iter().take(remove) {
        fs::remove_dir_all(&path).map_err(|error| format!("prune {}: {error}", path.display()))?;
    }
    fsync_directory(root)
}

pub async fn run(
    db: Arc<Db>,
    assets: Arc<AssetStore>,
    root: PathBuf,
    artifact: ArtifactIdentity,
    interval_ms: u64,
    retain: usize,
    mut stop: tokio::sync::watch::Receiver<bool>,
) {
    let mut interval = tokio::time::interval(Duration::from_millis(interval_ms));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = interval.tick() => {
                let created = complete_or_stop(
                    &mut stop,
                    create_once(db.clone(), assets.clone(), root.clone(), artifact.clone()),
                ).await;
                let Some(created) = created else {
                    return;
                };
                match created {
                    Ok(path) => {
                        tracing::info!(target: "marks_server::backup", backup = %path.display(), "backup verified and published");
                        let prune_root = root.clone();
                        let mut pruning = tokio::task::spawn_blocking(move || prune(&prune_root, retain));
                        let pruned = complete_or_stop(&mut stop, &mut pruning).await;
                        let Some(pruned) = pruned else {
                            // A running blocking syscall cannot be cancelled,
                            // but the backup owner and `serve` no longer wait
                            // for it. The binary runtime has its own final
                            // shutdown deadline.
                            pruning.abort();
                            return;
                        };
                        match pruned {
                            Ok(Ok(())) => {}
                            Ok(Err(error)) => tracing::error!(target: "marks_server::backup", %error, "backup retention failed"),
                            Err(error) => tracing::error!(target: "marks_server::backup", %error, "backup retention task failed"),
                        }
                    }
                    Err(error) => tracing::error!(target: "marks_server::backup", %error, "backup failed"),
                }
            }
            changed = stop.changed() => {
                if changed.is_err() || *stop.borrow() {
                    return;
                }
            }
        }
    }
}

/// Poll stop concurrently with one backup phase. Keeping the stop branch at
/// this level matters: awaiting a `spawn_blocking` join inside a selected timer
/// branch otherwise prevents the watch receiver from being polled at all.
async fn complete_or_stop<T>(
    stop: &mut tokio::sync::watch::Receiver<bool>,
    work: impl Future<Output = T>,
) -> Option<T> {
    if *stop.borrow() {
        return None;
    }
    tokio::pin!(work);
    loop {
        tokio::select! {
            result = &mut work => return Some(result),
            changed = stop.changed() => {
                if changed.is_err() || *stop.borrow() {
                    return None;
                }
            }
        }
    }
}

#[cfg(test)]
mod shutdown_tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    fn test_root() -> PathBuf {
        static NEXT_TEST: AtomicU64 = AtomicU64::new(1);
        std::env::temp_dir().join(format!(
            "marks-backup-timeout-{}-{}",
            std::process::id(),
            NEXT_TEST.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[tokio::test]
    async fn stop_interrupts_an_uncooperative_backup_phase() {
        let (stop_tx, mut stop_rx) = tokio::sync::watch::channel(false);
        let proof = tokio::spawn(async move {
            complete_or_stop(&mut stop_rx, std::future::pending::<()>()).await
        });
        tokio::task::yield_now().await;
        stop_tx.send(true).unwrap();

        let result = tokio::time::timeout(Duration::from_secs(1), proof)
            .await
            .expect("backup owner must observe stop")
            .expect("backup proof task");
        assert!(result.is_none());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn timed_out_preparation_releases_guard_and_never_publishes_late() {
        let root = test_root();
        let asset_root = root.join("asset-store");
        fs::create_dir_all(&root).unwrap();
        let assets = Arc::new(AssetStore::open(asset_root).unwrap());
        let guard = assets.backup_guard().await;
        let partial = root.join(".partial-proof");
        let published = root.join("backup-proof");
        fs::create_dir(&partial).unwrap();
        fs::write(partial.join("prepared"), b"not yet published").unwrap();

        let cancellation = Arc::new(AtomicBool::new(false));
        let worker_cancellation = cancellation.clone();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        let prepared = PreparedBackup::new(partial.clone(), published.clone());
        let mut task = tokio::task::spawn_blocking(move || {
            let result = finish_preparation(prepared, worker_cancellation.as_ref(), || {
                let _ = started_tx.send(());
                let _ = release_rx.recv();
            });
            let _ = done_tx.send(result.is_err());
            result
        });
        started_rx
            .await
            .expect("preparation reached completion gate");
        let error = await_preparation(
            &mut task,
            cancellation.as_ref(),
            Instant::now() + Duration::from_millis(25),
        )
        .await
        .expect_err("wedged preparation must time out");
        assert!(error.contains("timed out"));

        drop(guard);
        let mutation_guard = tokio::time::timeout(Duration::from_secs(1), assets.mutation_guard())
            .await
            .expect("global asset guard released at the deadline");
        drop(mutation_guard);
        assert!(!published.exists(), "timed-out worker published a backup");

        release_tx.send(()).expect("release late preparation");
        assert!(
            tokio::time::timeout(Duration::from_secs(1), done_rx)
                .await
                .expect("late preparation completed")
                .expect("late preparation proof channel")
        );
        tokio::time::timeout(Duration::from_secs(1), async {
            while partial.exists() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("late worker discarded only its partial directory");
        assert!(!published.exists(), "late preparation became visible");
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn timed_out_publication_releases_guard_and_late_snapshot_is_isolated() {
        let root = test_root();
        let asset_root = root.join("asset-store");
        fs::create_dir_all(&root).unwrap();
        let assets = Arc::new(AssetStore::open(asset_root).unwrap());
        let guard = assets.backup_guard().await;
        let partial = root.join(".partial-publish-proof");
        let published = root.join("backup-publish-proof");
        fs::create_dir(&partial).unwrap();
        fs::write(partial.join("verified-snapshot"), b"immutable proof").unwrap();

        // In production this type can only be returned after the complete
        // database/asset tree was verified. The hook models a metadata/fsync
        // syscall that stops making progress after that point.
        let prepared = PreparedBackup::new(partial.clone(), published.clone());
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        let mut task = tokio::task::spawn_blocking(move || {
            let result = prepared.publish_with_hook(|| {
                let _ = started_tx.send(());
                let _ = release_rx.recv();
            });
            let _ = done_tx.send(result.is_ok());
            result
        });
        started_rx.await.expect("publication worker reached commit");
        let error = await_publication(&mut task, Instant::now() + Duration::from_millis(25))
            .await
            .expect_err("wedged publication must time out");
        assert!(error.contains("timed out"));

        drop(guard);
        let mutation_guard = tokio::time::timeout(Duration::from_secs(1), assets.mutation_guard())
            .await
            .expect("global asset guard released at publication deadline");
        drop(mutation_guard);

        release_tx.send(()).expect("release late publication");
        assert!(
            tokio::time::timeout(Duration::from_secs(1), done_rx)
                .await
                .expect("late publication completed")
                .expect("late publication proof channel")
        );
        assert!(!partial.exists());
        assert_eq!(
            fs::read(published.join("verified-snapshot")).unwrap(),
            b"immutable proof"
        );
        let _ = fs::remove_dir_all(root);
    }
}
