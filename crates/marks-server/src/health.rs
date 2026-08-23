//! Process liveness and database readiness are intentionally separate.
//!
//! Load balancers may poll liveness frequently, so `/healthz` performs only a
//! cheap read. A process-owned heartbeat commits through the same FULL-sync
//! writer as document updates; `/readyz` reports whether that proof is fresh.

use crate::db::Db;
use crate::error::ApiResult;
use crate::ids::now_ms;
use rusqlite::params;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

pub struct Health {
    last_database_write_ms: AtomicU64,
}

impl Health {
    pub fn new() -> Self {
        Self {
            last_database_write_ms: AtomicU64::new(0),
        }
    }

    /// Prove the durable writer path and remember the commit time only after
    /// the transaction returns successfully.
    pub fn probe_database(&self, db: &Db) -> ApiResult<u64> {
        let checked_at = now_ms();
        db.tx(|connection| {
            connection.execute(
                "UPDATE server_health SET checked_at = ?1 WHERE singleton = 1",
                params![checked_at as i64],
            )?;
            Ok(())
        })?;
        self.last_database_write_ms
            .store(checked_at, Ordering::Release);
        Ok(checked_at)
    }

    pub fn last_database_write_ms(&self) -> u64 {
        self.last_database_write_ms.load(Ordering::Acquire)
    }

    pub fn database_ready(&self, stale_after_ms: u64) -> bool {
        let last = self.last_database_write_ms();
        last != 0 && now_ms().saturating_sub(last) <= stale_after_ms
    }

    pub async fn run_database_heartbeat(
        self: Arc<Self>,
        db: Arc<Db>,
        interval_ms: u64,
        mut stop: tokio::sync::watch::Receiver<bool>,
    ) {
        let mut interval = tokio::time::interval(Duration::from_millis(interval_ms));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = interval.tick() => {
                    if let Err(error) = self.probe_database(&db) {
                        tracing::error!(
                            target: "marks_server::health",
                            ?error,
                            "database write heartbeat failed"
                        );
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
}

impl Default for Health {
    fn default() -> Self {
        Self::new()
    }
}
