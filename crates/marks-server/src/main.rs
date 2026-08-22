use marks_server::{App, Config, serve};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let config = match Config::from_env() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("marks-server configuration error: {error}");
            std::process::exit(2);
        }
    };
    let listen = config.listen;
    let app = match App::new(config) {
        Ok(app) => app,
        Err(error) => {
            eprintln!("marks-server startup error: {error}");
            std::process::exit(2);
        }
    };
    let listener = match tokio::net::TcpListener::bind(listen).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("marks-server cannot bind {listen}: {error}");
            std::process::exit(2);
        }
    };
    tracing::info!(target: "marks_server", %listen, "marks-server listening");

    let shutdown = async {
        let ctrl_c = tokio::signal::ctrl_c();
        #[cfg(unix)]
        {
            let mut term =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("install SIGTERM handler");
            tokio::select! {
                _ = ctrl_c => {},
                _ = term.recv() => {},
            }
        }
        #[cfg(not(unix))]
        {
            let _ = ctrl_c.await;
        }
    };

    if let Err(error) = serve(app, listener, shutdown).await {
        eprintln!("marks-server exited with error: {error}");
        std::process::exit(1);
    }
}
