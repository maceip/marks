use crate::agent::{AgentHub, AgentProvider};
use crate::artifact::ArtifactIdentity;
use crate::assets::AssetStore;
use crate::config::Config;
use crate::db::Db;
use crate::health::Health;
use crate::rate::RateLimiter;
use crate::room::Rooms;
use crate::routes;
use axum::body::Body;
use axum::extract::Request;
use axum::http::{Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Router, extract::DefaultBodyLimit, middleware};
use rusqlite::params;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Semaphore;
use tower::util::ServiceExt;
use tower_http::services::{ServeDir, ServeFile};

pub struct App {
    pub config: Arc<Config>,
    pub artifact: ArtifactIdentity,
    pub db: Arc<Db>,
    pub assets: Arc<AssetStore>,
    pub(crate) bundle_exports: Arc<Semaphore>,
    pub(crate) import_jobs: Arc<Semaphore>,
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
        let import_jobs = Arc::new(Semaphore::new(4));
        let agents = AgentHub::new(db.clone(), config.agent.clone(), provider)?;
        Ok(Arc::new(Self {
            config,
            artifact,
            db,
            assets,
            bundle_exports,
            import_jobs,
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
    let practical_link_check =
        post(routes::practical::check_links).layer(DefaultBodyLimit::max(96 * 1024));
    let practical_citation_lookup =
        post(routes::practical::citation_lookup).layer(DefaultBodyLimit::max(4 * 1024));
    let import_file =
        post(routes::imports::file).layer(DefaultBodyLimit::max(routes::imports::MAX_IMPORT_BYTES));
    let import_url = post(routes::imports::url).layer(DefaultBodyLimit::max(
        routes::imports::MAX_URL_REQUEST_BYTES,
    ));
    let api = Router::new()
        // Identity: docs/AUTHN-AUTHZ-PROTOCOL.md §10.
        .route("/v1/auth/scratch", post(routes::auth::scratch_create))
        .route(
            "/v1/auth/scratch/{id}/device",
            put(routes::auth::scratch_bind_device),
        )
        .route(
            "/v1/auth/scratch/{id}/bootstrap",
            post(routes::auth::scratch_self_bootstrap),
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
        .route("/v1/auth/dbsc/register", post(routes::auth::dbsc_register))
        .route("/v1/auth/dbsc/refresh", post(routes::auth::dbsc_refresh))
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
        .route("/v1/agent/capabilities", get(routes::agent::capabilities))
        .route("/v1/agent/runs", agent_create)
        .route("/v1/agent/runs/{id}/events", get(routes::agent::events))
        .route("/v1/agent/runs/{id}/tool-results", agent_tool_result)
        .route("/v1/agent/runs/{id}", delete(routes::agent::cancel))
        // Bounded, authenticated document conversion. URL imports resolve and
        // pin public IPs on every redirect; local files never leave this process.
        .route("/v1/import/file", import_file)
        .route("/v1/import/url", import_url)
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
        .route(
            "/v1/documents/{id}/assets",
            get(routes::assets::list).merge(asset_upload),
        )
        .route("/v1/documents/{id}/link-checks", practical_link_check)
        .route(
            "/v1/documents/{id}/citation-lookup",
            practical_citation_lookup,
        )
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
            let directory = directory.clone();
            let asset_pool = app.config.asset_pool.clone();
            api.fallback(move |request: Request| {
                serve_static(directory.clone(), asset_pool.clone(), request)
            })
        }
        None => api,
    };
    router.layer(middleware::from_fn_with_state(app, crate::headers::harden))
}

/// Static files are served exactly as they exist on disk; the SPA shell
/// answers only top-level navigations. A missing hashed asset or runtime
/// artifact must be a 404, never shell HTML: after a deployment, an old tab
/// requesting a chunk from the previous release would otherwise cache HTML
/// under an immutable JavaScript URL for a year, and rollback cannot repair
/// an already poisoned browser cache.
async fn serve_static(
    directory: PathBuf,
    asset_pool: Option<PathBuf>,
    request: Request,
) -> Response {
    let navigation = is_navigation(&request);
    let method = request.method().clone();
    let pooled_asset = request
        .uri()
        .path()
        .strip_prefix("/assets")
        .filter(|remainder| remainder.starts_with('/'))
        .map(str::to_owned);
    let response = match ServeDir::new(&directory).oneshot(request).await {
        Ok(response) => response.map(Body::new),
        Err(error) => {
            tracing::error!(target: "marks_server::static", %error, "static file service failed");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    if response.status() != StatusCode::NOT_FOUND {
        return response;
    }
    // A hashed asset missing from the active release may belong to an older
    // retained release whose tab is still open. The shared pool holds the
    // union of every retained release's content-hashed assets, so that tab
    // resolves its lazy chunks instead of receiving 404s until it reloads.
    if let Some(asset) = pooled_asset {
        if let Some(pool) = asset_pool {
            let pooled = Request::builder()
                .method(method.clone())
                .uri(asset)
                .body(Body::empty());
            if let Ok(pooled) = pooled {
                let Ok(pooled_response) = ServeDir::new(pool).oneshot(pooled).await;
                if pooled_response.status() != StatusCode::NOT_FOUND {
                    return pooled_response.map(Body::new);
                }
            }
        }
        return response;
    }
    if !navigation {
        return response;
    }
    let shell = Request::builder()
        .method(method)
        .uri("/")
        .body(Body::empty())
        .expect("static shell request");
    match ServeFile::new(directory.join("index.html"))
        .oneshot(shell)
        .await
    {
        Ok(response) => response.map(Body::new),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

/// A navigation is a top-level document request: GET or HEAD, outside the
/// hashed-asset namespace, that a browser marks `Sec-Fetch-Mode: navigate`
/// or `Sec-Fetch-Dest: document`, or that prefers HTML. The signals are a
/// union, never a gate: Firefox does not preserve `navigate` on a fetch a
/// service worker passes through, so a navigation must still be
/// recognizable by its Accept preference alone. Module imports, worker
/// scripts, and Wasm/JSON fetches send neither signal, so they receive
/// honest 404s.
fn is_navigation(request: &Request) -> bool {
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return false;
    }
    if request.uri().path().starts_with("/assets/") {
        return false;
    }
    let header_is = |name: &str, value: &[u8]| {
        request
            .headers()
            .get(name)
            .is_some_and(|header| header.as_bytes() == value)
    };
    header_is("sec-fetch-mode", b"navigate")
        || header_is("sec-fetch-dest", b"document")
        || request
            .headers()
            .get(header::ACCEPT)
            .and_then(|accept| accept.to_str().ok())
            .is_some_and(|accept| accept.contains("text/html"))
}
