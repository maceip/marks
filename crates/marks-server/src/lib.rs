//! The one Rust Marks server process (`docs/V1-SCOPE.md`): identity and
//! sessions, document ACL admission, the `/v1` document API, and one durable
//! native ESBT room per live document over `/collab/esbt/{id}`.
//!
//! Security decisions live in `marks-auth` validators; the collaboration
//! algorithm lives in the pinned `esbt` crate (maceip/ESBT-web). This crate
//! supplies what those deliberately leave out: HTTP, randomness, storage,
//! transactions, rate limits, rooms, and live-socket revocation.

pub mod agent;
pub mod app;
pub mod artifact;
pub mod assets;
pub mod backup;
pub mod config;
pub mod db;
pub mod engine_profile;
pub mod error;
pub mod guard;
pub mod headers;
pub mod health;
pub mod identity;
pub mod ids;
pub mod rate;
pub mod room;
pub mod routes;
pub mod store;

pub use app::{App, router};
pub use config::Config;

use std::net::SocketAddr;
use std::sync::Arc;

/// Bind and serve until `shutdown` resolves, then flush every room.
pub async fn serve(
    app: Arc<App>,
    listener: tokio::net::TcpListener,
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    let (heartbeat_stop, heartbeat_rx) = tokio::sync::watch::channel(false);
    let heartbeat = tokio::spawn(app.health.clone().run_database_heartbeat(
        app.db.clone(),
        app.config.database_heartbeat_ms,
        heartbeat_rx.clone(),
    ));
    let backup = app.config.backup_dir.clone().map(|root| {
        tokio::spawn(crate::backup::run(
            app.db.clone(),
            app.assets.clone(),
            root,
            app.artifact.clone(),
            app.config.backup_interval_ms,
            app.config.backup_retain,
            heartbeat_rx,
        ))
    });
    let service = router(app.clone()).into_make_service_with_connect_info::<SocketAddr>();
    let result = axum::serve(listener, service)
        .with_graceful_shutdown(shutdown)
        .await;
    let _ = heartbeat_stop.send(true);
    let _ = heartbeat.await;
    if let Some(backup) = backup {
        let _ = backup.await;
    }
    result?;
    app.agents.shutdown().await;
    app.rooms.shutdown().await;
    Ok(())
}
