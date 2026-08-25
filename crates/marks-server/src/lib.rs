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

use futures_util::future::join_all;
use std::future::{Future, IntoFuture};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::task::JoinHandle;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

/// Stop accepting immediately, then give in-flight HTTP responses a short,
/// finite opportunity to drain. This includes streaming bodies: a client that
/// stops reading cannot prevent process shutdown forever.
const HTTP_GRACEFUL_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(10);
/// Heartbeat, backup, agent, and room owners all share this one absolute join
/// deadline. A wedged blocking child is detached after cancellation; the
/// executable's runtime deadline below is the final process-level backstop.
const COMPONENT_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(6);
/// Tokio cannot cancel a blocking filesystem syscall. The production binary
/// consumes its runtime with `shutdown_timeout` so even such a syscall cannot
/// keep the process alive indefinitely after every cooperative owner stopped.
pub const RUNTIME_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

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

    // Observe the shutdown edge independently from Axum. Axum's graceful
    // future intentionally waits for every connection without a force limit;
    // this owner drops that future after our product deadline instead.
    let shutdown_signal = CancellationToken::new();
    let waiter_signal = shutdown_signal.clone();
    let shutdown_waiter = tokio::spawn(async move {
        shutdown.await;
        waiter_signal.cancel();
    });
    let server_signal = shutdown_signal.clone();
    let server = axum::serve(listener, service)
        .with_graceful_shutdown(async move {
            server_signal.cancelled().await;
        })
        .into_future();
    let (result, forced) =
        await_http_server(server, shutdown_signal, HTTP_GRACEFUL_SHUTDOWN_TIMEOUT).await;
    if forced {
        tracing::warn!(
            target: "marks_server::shutdown",
            timeout_ms = HTTP_GRACEFUL_SHUTDOWN_TIMEOUT.as_millis(),
            "forcing shutdown after in-flight HTTP connections missed their deadline"
        );
    }
    if !shutdown_waiter.is_finished() {
        shutdown_waiter.abort();
    }

    let _ = heartbeat_stop.send(true);
    let agent_app = app.clone();
    let agent_shutdown = tokio::spawn(async move {
        agent_app.agents.shutdown().await;
    });
    let room_app = app.clone();
    let room_shutdown = tokio::spawn(async move {
        room_app.rooms.shutdown().await;
    });
    let mut owners = vec![
        ("database heartbeat", heartbeat),
        ("agent hub", agent_shutdown),
        ("document rooms", room_shutdown),
    ];
    if let Some(backup) = backup {
        owners.push(("backup", backup));
    }
    let deadline = Instant::now() + COMPONENT_SHUTDOWN_TIMEOUT;
    join_all(
        owners
            .into_iter()
            .map(|(owner, task)| finish_shutdown_task(owner, task, deadline)),
    )
    .await;
    result
}

async fn await_http_server<F>(
    server: F,
    shutdown: CancellationToken,
    grace: Duration,
) -> (std::io::Result<()>, bool)
where
    F: Future<Output = std::io::Result<()>>,
{
    tokio::pin!(server);
    tokio::select! {
        result = &mut server => (result, false),
        _ = shutdown.cancelled() => {
            match tokio::time::timeout(grace, &mut server).await {
                Ok(result) => (result, false),
                Err(_) => (Ok(()), true),
            }
        }
    }
}

async fn finish_shutdown_task(
    owner: &'static str,
    mut task: JoinHandle<()>,
    deadline: Instant,
) -> bool {
    match tokio::time::timeout_at(deadline, &mut task).await {
        Ok(Ok(())) => true,
        Ok(Err(error)) => {
            tracing::warn!(target: "marks_server::shutdown", owner, %error, "shutdown owner failed");
            false
        }
        Err(_) => {
            task.abort();
            tracing::warn!(target: "marks_server::shutdown", owner, "shutdown owner missed its deadline and was aborted");
            false
        }
    }
}

#[cfg(test)]
mod shutdown_tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[tokio::test]
    async fn uncooperative_http_connection_stops_at_the_grace_deadline() {
        let shutdown = CancellationToken::new();
        shutdown.cancel();
        let (result, forced) = tokio::time::timeout(
            Duration::from_secs(1),
            await_http_server(
                std::future::pending::<std::io::Result<()>>(),
                shutdown,
                Duration::from_millis(25),
            ),
        )
        .await
        .expect("outer proof deadline");

        assert!(result.is_ok());
        assert!(forced);
    }

    #[tokio::test]
    async fn uncooperative_background_owner_is_aborted_at_the_shared_deadline() {
        struct Dropped(Arc<AtomicBool>);
        impl Drop for Dropped {
            fn drop(&mut self) {
                self.0.store(true, Ordering::Release);
            }
        }

        let dropped = Arc::new(AtomicBool::new(false));
        let task_dropped = dropped.clone();
        let task = tokio::spawn(async move {
            let _dropped = Dropped(task_dropped);
            std::future::pending::<()>().await;
        });
        let finished = finish_shutdown_task(
            "test owner",
            task,
            Instant::now() + Duration::from_millis(25),
        )
        .await;

        assert!(!finished);
        tokio::time::timeout(Duration::from_secs(1), async {
            while !dropped.load(Ordering::Acquire) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("aborted owner must drop its resources");
    }
}
