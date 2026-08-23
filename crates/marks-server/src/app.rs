use crate::agent::{AgentHub, AgentProvider};
use crate::artifact::ArtifactIdentity;
use crate::assets::AssetStore;
use crate::config::Config;
use crate::db::Db;
use crate::health::Health;
use crate::rate::RateLimiter;
use crate::room::Rooms;
use crate::routes;
use axum::routing::{delete, get, post, put};
use axum::{Router, extract::DefaultBodyLimit, middleware};
use rusqlite::params;
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::Semaphore;

pub struct App {
    pub config: Arc<Config>,
    pub artifact: ArtifactIdentity,
    pub db: Arc<Db>,
    pub assets: Arc<AssetStore>,
    pub(crate) bundle_exports: Arc<Semaphore>,
    pub rooms: Rooms,
    pub rate: RateLimiter,
    pub limits: esbt::ResourceLimits,
    pub health: Arc<Health>,
    pub agents: Arc<AgentHub>,
}

impl App {
    pub fn new(config: Config) -> Result<Arc<Self>, String> {
        Self::new_with_agent_provider(config, None)
    }

    /// Provider injection is used by deterministic integration tests. The
    /// production constructor always builds the server-configured provider.
    pub fn new_with_agent_provider(
        config: Config,
        provider: Option<Arc<dyn AgentProvider>>,
    ) -> Result<Arc<Self>, String> {
        let config = Arc::new(config);
        let artifact = ArtifactIdentity::load(config.static_dir.as_deref())?;
        let db =
            Arc::new(Db::open(&config.database).map_err(|error| format!("database: {error:?}"))?);
        let assets = Arc::new(AssetStore::open(config.asset_dir.clone())?);
        let referenced_assets = db
            .read(|connection| {
                let mut statement = connection.prepare("SELECT content_hash FROM asset_blobs")?;
                statement
                    .query_map(params![], |row| row.get::<_, Vec<u8>>(0))?
                    .map(|row| crate::store::hash32(row?))
                    .collect::<crate::error::ApiResult<HashSet<_>>>()
            })
            .map_err(|error| format!("read asset references: {error:?}"))?;
        let sweep = assets
            .sweep_unreferenced(&referenced_assets)
            .map_err(|error| format!("reconcile asset store: {error}"))?;
        if sweep != Default::default() {
            tracing::info!(
                target: "marks_server::assets",
                orphaned_content = sweep.orphaned_content,
                stale_staging = sweep.stale_staging,
                unrecognized = sweep.unrecognized,
                "asset store reconciled"
            );
        }
        let profile = crate::engine_profile::get()?;
        if config.max_frame_bytes < profile.limits.max_message_bytes.saturating_add(27) {
            return Err("MARKS max frame does not cover the shared engine profile".to_owned());
        }
        let limits = profile.limits.resource_limits();
        let rooms = Rooms::new(db.clone(), config.clone(), limits.clone());
        let health = Arc::new(Health::new());
        health
            .probe_database(&db)
            .map_err(|error| format!("database write probe: {error:?}"))?;
        let bundle_exports = Arc::new(Semaphore::new(config.max_concurrent_bundle_exports));
        let agents = AgentHub::new(db.clone(), config.agent.clone(), provider)?;
        Ok(Arc::new(Self {
            config,
            artifact,
            db,
            assets,
            bundle_exports,
            rooms,
            rate: RateLimiter::new(),
            limits,
            health,
            agents,
        }))
    }
}

pub fn router(app: Arc<App>) -> Router {
    let asset_upload =
        post(routes::assets::upload).layer(DefaultBodyLimit::max(app.config.max_asset_bytes));
    let agent_create = post(routes::agent::create_run).layer(DefaultBodyLimit::max(
        crate::agent::protocol::MAX_AGENT_BODY_BYTES,
    ));
    let agent_tool_result = post(routes::agent::tool_result).layer(DefaultBodyLimit::max(
        crate::agent::protocol::MAX_AGENT_BODY_BYTES,
    ));
    let api = Router::new()
        // Identity: docs/AUTHN-AUTHZ-PROTOCOL.md §10.
        .route("/v1/auth/scratch", post(routes::auth::scratch_create))
        .route(
            "/v1/auth/scratch/{id}/device",
            put(routes::auth::scratch_bind_device),
        )
        .route("/v1/auth/pairings", post(routes::auth::pairing_create))
        .route(
            "/v1/auth/pairings/lookup",
            post(routes::auth::pairing_lookup),
        )
        .route(
            "/v1/auth/pairings/{id}/inspect",
            post(routes::auth::pairing_inspect),
        )
        .route(
            "/v1/auth/pairings/{id}/bootstrap",
            post(routes::auth::pairing_bootstrap),
        )
        .route(
            "/v1/auth/pairings/{id}/approve",
            post(routes::auth::pairing_approve),
        )
        .route(
            "/v1/auth/pairings/{id}/finalize",
            post(routes::auth::pairing_finalize),
        )
        .route(
            "/v1/auth/device/challenges",
            post(routes::auth::device_challenge),
        )
        .route("/v1/auth/device/redeem", post(routes::auth::device_redeem))
        .route(
            "/v1/auth/session",
            get(routes::auth::session_get).delete(routes::auth::session_delete),
        )
        .route("/v1/auth/devices", get(routes::auth::devices_list))
        .route("/v1/auth/devices/{id}", delete(routes::auth::device_revoke))
        .route("/v1/auth/evt/challenges", post(routes::auth::evt_challenge))
        .route("/v1/auth/evt/redeem", post(routes::auth::evt_redeem))
        // Session-only in-page agent gateway. Browser requests cannot select
        // a provider, endpoint, model, or credential.
        .route(
            "/v1/agent/capabilities",
            get(routes::agent::capabilities),
        )
        .route("/v1/agent/runs", agent_create)
        .route(
            "/v1/agent/runs/{id}/events",
            get(routes::agent::events),
        )
        .route(
            "/v1/agent/runs/{id}/tool-results",
            agent_tool_result,
        )
        .route("/v1/agent/runs/{id}", delete(routes::agent::cancel))
        // Documents.
        .route(
            "/v1/documents",
            get(routes::documents::list).post(routes::documents::create),
        )
        .route("/v1/trash", get(routes::documents::trash_list))
        .route(
            "/v1/documents/{id}",
            get(routes::documents::get)
                .patch(routes::documents::rename)
                .delete(routes::documents::delete),
        )
        .route(
            "/v1/documents/{id}/duplicate",
            post(routes::documents::duplicate),
        )
        .route(
            "/v1/documents/{id}/restore",
            post(routes::documents::restore),
        )
        .route("/v1/documents/{id}/purge", delete(routes::documents::purge))
        .route("/v1/documents/{id}/export", get(routes::documents::export))
        .route(
            "/v1/documents/{id}/export-bundle",
            get(routes::assets::export_bundle),
        )
        .route("/v1/documents/{id}/assets", asset_upload)
        .route("/a/{document}/{asset}", get(routes::assets::get))
        .route(
            "/v1/documents/{id}/snapshot",
            get(routes::documents::snapshot),
        )
        .route(
            "/v1/scratch/documents/{id}/snapshot",
            get(routes::documents::snapshot),
        )
        .route(
            "/v1/documents/{id}/session",
            post(routes::documents::principal_room_session),
        )
        .route(
            "/v1/scratch/documents/{id}/session",
            post(routes::documents::scratch_room_session),
        )
        // Sharing.
        .route(
            "/v1/documents/{id}/shares",
            get(routes::documents::shares_list),
        )
        .route(
            "/v1/documents/{id}/shares/{principal}",
            put(routes::documents::share_put).delete(routes::documents::share_delete),
        )
        .route(
            "/v1/documents/{id}/link",
            post(routes::documents::link_create).delete(routes::documents::link_revoke),
        )
        .route(
            "/v1/documents/{id}/link/redeem",
            post(routes::documents::link_redeem),
        )
        // Review metadata is deliberately outside the CRDT transport. It has
        // its own ACL checks, bounded storage, and portable Markdown versions.
        .route(
            "/v1/documents/{id}/comments",
            get(routes::review::comments_list).post(routes::review::comment_create),
        )
        .route(
            "/v1/documents/{id}/comments/{comment}",
            put(routes::review::comment_update).delete(routes::review::comment_delete),
        )
        .route(
            "/v1/documents/{id}/comments/{comment}/replies",
            post(routes::review::reply_create),
        )
        .route(
            "/v1/documents/{id}/comments/{comment}/replies/{reply}",
            put(routes::review::reply_update).delete(routes::review::reply_delete),
        )
        .route(
            "/v1/documents/{id}/versions",
            get(routes::review::versions_list).post(routes::review::version_create),
        )
        .route(
            "/v1/documents/{id}/versions/{version}",
            get(routes::review::version_get).delete(routes::review::version_delete),
        )
        // Rooms. The retired engine paths are refused explicitly.
        .route("/collab/esbt/{id}", get(crate::room::ws::collab_esbt))
        .route("/collab/loro/{id}", get(crate::room::ws::collab_retired))
        .route("/collab/yjs/{id}", get(crate::room::ws::collab_retired))
        .route("/healthz", get(routes::health))
        .route("/readyz", get(routes::ready))
        .route("/v1/artifact", get(routes::artifact))
        .with_state(app.clone());

    let router = match &app.config.static_dir {
        Some(directory) => {
            let index = directory.join("index.html");
            api.fallback_service(
                tower_http::services::ServeDir::new(directory)
                    .fallback(tower_http::services::ServeFile::new(index)),
            )
        }
        None => api,
    };
    router.layer(middleware::from_fn_with_state(app, crate::headers::harden))
}
