//! Bounded content-addressed asset bytes.
//!
//! SQLite owns document authorization and references. Binary bytes live in a
//! separate atomic filesystem store so a 10 MiB image never occupies the
//! serialized FULL-sync document writer or the room hot path.

use crate::error::{ApiError, ApiResult};
use bytes::Bytes;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::{Mutex, OwnedMutexGuard, OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};

const COPY_BUFFER_BYTES: usize = 1024 * 1024;
const CONTENT_GATE_SHARDS: usize = 64;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct SweepReport {
    pub orphaned_content: u64,
    pub stale_staging: u64,
    pub unrecognized: u64,
}

#[derive(Debug)]
pub struct AssetStore {
    root: PathBuf,
    mutation_gate: Arc<RwLock<()>>,
    content_gates: Box<[Arc<Mutex<()>>]>,
}

impl AssetStore {
    pub fn open(root: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&root)
            .map_err(|error| format!("create asset directory {}: {error}", root.display()))?;
        Ok(Self {
            root,
            mutation_gate: Arc::new(RwLock::new(())),
            content_gates: (0..CONTENT_GATE_SHARDS)
                .map(|_| Arc::new(Mutex::new(())))
                .collect(),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Upload/ref creation and dereference/reclaim hold a shared guard across
    /// both filesystem and SQLite work. A backup takes the exclusive guard,
    /// so its online DB snapshot and copied immutable bytes describe one
    /// possible application state.
    pub async fn mutation_guard(&self) -> OwnedRwLockReadGuard<()> {
        self.mutation_gate.clone().read_owned().await
    }

    pub async fn backup_guard(&self) -> OwnedRwLockWriteGuard<()> {
        self.mutation_gate.clone().write_owned().await
    }

    /// Serialize publication/reclamation only for the same hash shard. This
    /// prevents a failed upload cleanup or last-reference purge from racing a
    /// same-content upload without globally serializing independent images.
    pub async fn content_guard(&self, hash: [u8; 32]) -> OwnedMutexGuard<()> {
        let index = usize::from(hash[0]) % self.content_gates.len();
        self.content_gates[index].clone().lock_owned().await
    }

    pub async fn put(&self, hash: [u8; 32], bytes: Bytes) -> ApiResult<()> {
        let root = self.root.clone();
        tokio::task::spawn_blocking(move || put_blocking(&root, hash, &bytes))
            .await
            .map_err(|_| ApiError::internal())?
            .map_err(|_| ApiError::internal())
    }

    pub async fn read(&self, hash: [u8; 32], expected_bytes: usize) -> ApiResult<Vec<u8>> {
        let root = self.root.clone();
        tokio::task::spawn_blocking(move || read_blocking(&root, hash, expected_bytes))
            .await
            .map_err(|_| ApiError::internal())?
            .map_err(|_| ApiError::internal())
    }

    /// Open immutable content for an HTTP streaming response. Upload and
    /// backup paths authenticate the hash before publishing the file; reads
    /// only repeat the cheap length/type checks instead of hashing and
    /// buffering as much as 64 MiB on every image request.
    pub async fn open_stream(
        &self,
        hash: [u8; 32],
        expected_bytes: usize,
    ) -> ApiResult<tokio::fs::File> {
        let path = content_path(&self.root, &hash);
        let file = tokio::fs::File::open(path)
            .await
            .map_err(|_| ApiError::internal())?;
        let metadata = file.metadata().await.map_err(|_| ApiError::internal())?;
        if !metadata.is_file() || metadata.len() != expected_bytes as u64 {
            return Err(ApiError::internal());
        }
        Ok(file)
    }

    pub async fn remove(&self, hash: [u8; 32]) -> ApiResult<()> {
        let path = content_path(&self.root, &hash);
        tokio::task::spawn_blocking(move || match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        })
        .await
        .map_err(|_| ApiError::internal())?
        .map_err(|_| ApiError::internal())
    }

    pub(crate) fn copy_verified_to(
        &self,
        hash: [u8; 32],
        expected_bytes: usize,
        destination_root: &Path,
    ) -> std::io::Result<()> {
        copy_verified_blocking(&self.root, hash, expected_bytes, destination_root)
    }

    /// Verify archival input before response bytes are committed. Callers
    /// keep a mutation guard while subsequently reopening the same immutable
    /// content, preventing a document purge from racing the stream.
    pub(crate) fn verify_content(
        &self,
        hash: [u8; 32],
        expected_bytes: usize,
    ) -> std::io::Result<()> {
        verify_path(
            &content_path(&self.root, &hash),
            hash,
            expected_bytes,
            "asset failed length/hash verification",
        )
    }

    pub(crate) fn open_verified_content(
        &self,
        hash: [u8; 32],
        expected_bytes: usize,
    ) -> std::io::Result<File> {
        let file = File::open(content_path(&self.root, &hash))?;
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.len() != expected_bytes as u64 {
            return Err(std::io::Error::new(
                ErrorKind::InvalidData,
                "asset changed after verification",
            ));
        }
        Ok(file)
    }

    /// Reconcile crash residue before the server admits traffic. Only files
    /// with a content-store hash shape, plus our own dot-prefixed staging
    /// names, are eligible for removal. An unrelated file in a mistakenly
    /// configured directory is counted and left untouched.
    pub(crate) fn sweep_unreferenced(
        &self,
        referenced: &HashSet<[u8; 32]>,
    ) -> std::io::Result<SweepReport> {
        let mut report = SweepReport::default();
        for prefix_entry in fs::read_dir(&self.root)? {
            let prefix_entry = prefix_entry?;
            let file_type = prefix_entry.file_type()?;
            if !file_type.is_dir() {
                report.unrecognized = report.unrecognized.saturating_add(1);
                continue;
            }
            let prefix = prefix_entry.file_name().to_string_lossy().into_owned();
            if prefix.len() != 2 || !prefix.bytes().all(is_lower_hex) {
                report.unrecognized = report.unrecognized.saturating_add(1);
                continue;
            }
            for entry in fs::read_dir(prefix_entry.path())? {
                let entry = entry?;
                let file_type = entry.file_type()?;
                if !file_type.is_file() {
                    report.unrecognized = report.unrecognized.saturating_add(1);
                    continue;
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with(".upload-") || name.starts_with(".copy-") {
                    fs::remove_file(entry.path())?;
                    report.stale_staging = report.stale_staging.saturating_add(1);
                    continue;
                }
                let Some(hash) = decode_content_hash(&prefix, &name) else {
                    report.unrecognized = report.unrecognized.saturating_add(1);
                    continue;
                };
                if !referenced.contains(&hash) {
                    fs::remove_file(entry.path())?;
                    report.orphaned_content = report.orphaned_content.saturating_add(1);
                }
            }
            if fs::read_dir(prefix_entry.path())?.next().is_none() {
                fs::remove_dir(prefix_entry.path())?;
            }
        }
        Ok(report)
    }
}

fn is_lower_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
}

fn decode_content_hash(prefix: &str, name: &str) -> Option<[u8; 32]> {
    if name.len() != 62 || !name.bytes().all(is_lower_hex) {
        return None;
    }
    let encoded = format!("{prefix}{name}");
    let mut hash = [0_u8; 32];
    for (index, byte) in hash.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&encoded[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(hash)
}

fn read_blocking(root: &Path, hash: [u8; 32], expected_bytes: usize) -> std::io::Result<Vec<u8>> {
    let bytes = fs::read(content_path(root, &hash))?;
    let actual: [u8; 32] = Sha256::digest(&bytes).into();
    if bytes.len() != expected_bytes || actual != hash {
        return Err(std::io::Error::new(
            ErrorKind::InvalidData,
            "asset failed length/hash verification",
        ));
    }
    Ok(bytes)
}

fn copy_verified_blocking(
    source_root: &Path,
    hash: [u8; 32],
    expected_bytes: usize,
    destination_root: &Path,
) -> std::io::Result<()> {
    let destination = content_path(destination_root, &hash);
    let parent = destination.parent().expect("content path has parent");
    fs::create_dir_all(parent)?;
    if destination.exists() {
        return verify_path(
            &destination,
            hash,
            expected_bytes,
            "existing content-addressed asset is corrupt",
        );
    }

    static NEXT_COPY_TEMP: AtomicU64 = AtomicU64::new(1);
    let temp = parent.join(format!(
        ".copy-{}-{}",
        std::process::id(),
        NEXT_COPY_TEMP.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut source = File::open(content_path(source_root, &hash))?;
        let mut destination_file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)?;
        let mut hasher = Sha256::new();
        let mut copied = 0_usize;
        let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
        loop {
            let read = source.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            copied = copied.checked_add(read).ok_or_else(|| {
                std::io::Error::new(ErrorKind::InvalidData, "asset length overflow")
            })?;
            hasher.update(&buffer[..read]);
            destination_file.write_all(&buffer[..read])?;
        }
        let actual: [u8; 32] = hasher.finalize().into();
        if copied != expected_bytes || actual != hash {
            return Err(std::io::Error::new(
                ErrorKind::InvalidData,
                "asset failed length/hash verification",
            ));
        }
        destination_file.sync_all()?;
        drop(destination_file);

        match fs::hard_link(&temp, &destination) {
            Ok(()) => {
                fs::remove_file(&temp)?;
                File::open(parent)?.sync_all()
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                fs::remove_file(&temp)?;
                verify_path(
                    &destination,
                    hash,
                    expected_bytes,
                    "existing content-addressed asset is corrupt",
                )
            }
            Err(error) => Err(error),
        }
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn put_blocking(root: &Path, hash: [u8; 32], bytes: &[u8]) -> std::io::Result<()> {
    let actual: [u8; 32] = Sha256::digest(bytes).into();
    if actual != hash {
        return Err(std::io::Error::new(
            ErrorKind::InvalidInput,
            "asset hash mismatch",
        ));
    }
    let destination = content_path(root, &hash);
    let parent = destination.parent().expect("content path has parent");
    fs::create_dir_all(parent)?;
    if destination.exists() {
        return verify_existing(&destination, hash, bytes.len());
    }

    static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);
    let temp = parent.join(format!(
        ".upload-{}-{}",
        std::process::id(),
        NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp)?;
    if let Err(error) = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        Ok::<_, std::io::Error>(())
    })() {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    drop(file);

    match fs::hard_link(&temp, &destination) {
        Ok(()) => {
            fs::remove_file(&temp)?;
            File::open(parent)?.sync_all()?;
            Ok(())
        }
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            fs::remove_file(&temp)?;
            verify_existing(&destination, hash, bytes.len())
        }
        Err(error) => {
            let _ = fs::remove_file(&temp);
            Err(error)
        }
    }
}

fn verify_existing(path: &Path, hash: [u8; 32], expected_bytes: usize) -> std::io::Result<()> {
    verify_path(
        path,
        hash,
        expected_bytes,
        "existing content-addressed asset is corrupt",
    )
}

fn verify_path(
    path: &Path,
    hash: [u8; 32],
    expected_bytes: usize,
    message: &'static str,
) -> std::io::Result<()> {
    let mut file = File::open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() != expected_bytes as u64 {
        return Err(std::io::Error::new(ErrorKind::InvalidData, message));
    }
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let actual: [u8; 32] = hasher.finalize().into();
    if actual != hash {
        return Err(std::io::Error::new(ErrorKind::InvalidData, message));
    }
    Ok(())
}

fn content_path(root: &Path, hash: &[u8; 32]) -> PathBuf {
    let hex = hash
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    root.join(&hex[..2]).join(&hex[2..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn content_path_is_atomic_deduplicated_and_verified() {
        let root = std::env::temp_dir().join(format!("marks-assets-test-{}", std::process::id()));
        let copied_root =
            std::env::temp_dir().join(format!("marks-assets-copy-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&copied_root);
        let store = AssetStore::open(root.clone()).unwrap();
        let bytes = vec![0x5a; COPY_BUFFER_BYTES + 17];
        let hash: [u8; 32] = Sha256::digest(&bytes).into();
        store.put(hash, Bytes::from(bytes.clone())).await.unwrap();
        store.put(hash, Bytes::from(bytes.clone())).await.unwrap();
        assert_eq!(store.read(hash, bytes.len()).await.unwrap(), bytes);
        store
            .copy_verified_to(hash, bytes.len(), &copied_root)
            .unwrap();
        let copied = AssetStore::open(copied_root.clone()).unwrap();
        copied.verify_content(hash, bytes.len()).unwrap();

        let orphan_bytes = b"crash orphan";
        let orphan_hash: [u8; 32] = Sha256::digest(orphan_bytes).into();
        store
            .put(orphan_hash, Bytes::from_static(orphan_bytes))
            .await
            .unwrap();
        let report = store.sweep_unreferenced(&HashSet::from([hash])).unwrap();
        assert_eq!(report.orphaned_content, 1);
        assert!(
            store
                .verify_content(orphan_hash, orphan_bytes.len())
                .is_err()
        );
        store.verify_content(hash, bytes.len()).unwrap();
        store.remove(hash).await.unwrap();
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(copied_root);
    }
}
