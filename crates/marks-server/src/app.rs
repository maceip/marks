use crate::config::Config;
use crate::db::Db;
use crate::rate::RateLimiter;
use crate::room::Rooms;
use crate::routes;
use axum::Router;
use axum::routing::{delete, get, post, put};
use std::sync::Arc;

pub struct App {
    pub config: Arc<Config>,
    pub db: Arc<Db>,
    pub rooms: Rooms,
    pub rate: RateLimiter,
    pub limits: esbt::ResourceLimits,
}

impl App {
    pub fn new(config: Config) -> Result<Arc<Self>, String> {
        let config = Arc::new(config);
        let db =
            Arc::new(Db::open(&config.database).map_err(|error| format!("database: {error:?}"))?);
        let limits = esbt::ResourceLimits {
            max_message_bytes: config.max_frame_bytes.max(16 * 1024 * 1024),
            ..esbt::ResourceLimits::default()
        };
        let rooms = Rooms::new(db.clone(), config.clone(), limits.clone());
        Ok(Arc::new(Self {
            config,
            db,
            rooms,
            rate: RateLimiter::new(),
            limits,
        }))
    }
}

pub fn router(app: Arc<App>) -> Router {
    let api = Router::new()
        // Identity: docs/AUTHN-AUTHZ-PROTOCOL.md §10.
        .route("/v1/auth/scratch", post(routes::auth::scratch_create))
        .route(
            "/v1/auth/scratch/{id}/device",
            put(routes::auth::scratch_bind_device),
        )
        .route("/v1/auth/pairings", post(routes::auth::pairing_create))
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
        // Documents.
        .route(
            "/v1/documents",
            get(routes::documents::list).post(routes::documents::create),
        )
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
        .route("/v1/documents/{id}/export", get(routes::documents::export))
        .route(
            "/v1/documents/{id}/snapshot",
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
        // Rooms. The retired engine paths are refused explicitly.
        .route("/collab/esbt/{id}", get(crate::room::ws::collab_esbt))
        .route("/collab/loro/{id}", get(crate::room::ws::collab_retired))
        .route("/collab/yjs/{id}", get(crate::room::ws::collab_retired))
        .route("/healthz", get(routes::health))
        .with_state(app.clone());

    match &app.config.static_dir {
        Some(directory) => {
            let index = directory.join("index.html");
            api.fallback_service(
                tower_http::services::ServeDir::new(directory)
                    .fallback(tower_http::services::ServeFile::new(index)),
            )
        }
        None => api,
    }
}
