mod config;
mod sync;

use axum::{
    Json, Router,
    extract::{ConnectInfo, Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::get,
};
use github_api::{Client, Error, Viewer};
use std::{
    net::SocketAddr,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::Semaphore;

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Gh,
    Proxy,
    Demo,
}

impl Mode {
    fn label(self) -> &'static str {
        match self {
            Self::Gh => "gh",
            Self::Proxy => "proxy",
            Self::Demo => "demo",
        }
    }
}

#[derive(Clone)]
struct AppState {
    mode: Mode,
    default_owner: Option<String>,
    allowed_users: Vec<String>,
    requests: Arc<Semaphore>,
    config: config::Config,
    cache: Arc<std::sync::Mutex<sync::Cache>>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "github_dashboard=info".into()),
        )
        .init();
    let state = AppState::from_env().map_err(std::io::Error::other)?;
    let port = state.config.port;
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    tracing::info!("Forge listening on http://0.0.0.0:{port}");
    axum::serve(
        listener,
        app(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown())
    .await?;
    Ok(())
}

async fn shutdown() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("install SIGTERM handler");
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}

fn app(state: AppState) -> Router {
    let index =
        Arc::new(include_str!("../static/index.html").replace("{{AUTH_MODE}}", state.mode.label()));
    Router::new()
        .route(
            "/favicon.svg",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "image/svg+xml")],
                    include_str!("../static/favicon.svg"),
                )
            }),
        )
        .route(
            "/",
            get(move || {
                let index = index.clone();
                async move { Html((*index).clone()) }
            }),
        )
        .route(
            "/app.css",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
                    include_str!("../static/app.css"),
                )
            }),
        )
        .route(
            "/theme.js",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
                    include_str!(concat!(env!("OUT_DIR"), "/theme.js")),
                )
            }),
        )
        .route(
            "/app.js",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
                    include_str!(concat!(env!("OUT_DIR"), "/app.js")),
                )
            }),
        )
        .route(
            "/health",
            get(|| async { Json(serde_json::json!({"status":"ok"})) }),
        )
        .route("/api/sync", get(sync::synchronize))
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state)
}

fn local_request(headers: &HeaderMap, peer: Option<SocketAddr>) -> bool {
    if !peer.is_some_and(|p| p.ip().is_loopback()) {
        return false;
    }
    let Some(authority) = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<axum::http::uri::Authority>().ok())
    else {
        return false;
    };
    if !matches!(authority.host(), "localhost" | "127.0.0.1" | "[::1]") {
        return false;
    }
    if let Some(origin) = headers.get(header::ORIGIN) {
        let Ok(origin) = origin.to_str() else {
            return false;
        };
        let Ok(uri) = origin.parse::<axum::http::Uri>() else {
            return false;
        };
        if uri.authority() != Some(&authority) || uri.scheme_str() != Some("http") {
            return false;
        }
    }
    !headers
        .get("sec-fetch-site")
        .is_some_and(|v| v == "cross-site")
}

async fn guard(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|c| c.0);
    let mut response = if state.mode != Mode::Proxy
        && request.uri().path() != "/health"
        && !local_request(request.headers(), peer)
    {
        ApiError(
            StatusCode::FORBIDDEN,
            "Local mode is only accessible from localhost.".into(),
        )
        .into_response()
    } else {
        next.run(request).await
    };
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    headers.insert(header::REFERRER_POLICY, "no-referrer".parse().unwrap());
    headers.insert(header::CONTENT_SECURITY_POLICY,
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://avatars.githubusercontent.com; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'".parse().unwrap());
    response
}

struct ApiError(StatusCode, String);
impl ApiError {
    fn for_mode(mut self, mode: Mode) -> Self {
        if mode == Mode::Gh && self.0 == StatusCode::UNAUTHORIZED {
            self.1 =
                "GitHub CLI authentication is missing or expired. Run gh auth login, then retry."
                    .into();
        }
        self
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(serde_json::json!({"error": self.1}))).into_response()
    }
}
impl From<Error> for ApiError {
    fn from(error: Error) -> Self {
        let status = match error {
            Error::Unauthorized => StatusCode::UNAUTHORIZED,
            Error::Forbidden => StatusCode::FORBIDDEN,
            Error::InvalidOwner | Error::InvalidRepository => StatusCode::BAD_REQUEST,
            Error::NotFound => StatusCode::NOT_FOUND,
            Error::RateLimited => StatusCode::TOO_MANY_REQUESTS,
            Error::Timeout => StatusCode::GATEWAY_TIMEOUT,
            _ => StatusCode::BAD_GATEWAY,
        };
        Self(status, error.to_string())
    }
}

async fn request_client(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(Client, String), ApiError> {
    if state.mode == Mode::Gh {
        let token = Client::gh_token(state.config.github.request_timeout).await?;
        let client = Client::with_token_options(token.clone(), state.config.github.clone())?;
        return Ok((client, token));
    }
    let token = headers
        .get("x-forwarded-access-token")
        .and_then(|h| h.to_str().ok())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| {
            ApiError(
                StatusCode::UNAUTHORIZED,
                "Sign in with GitHub to access the dashboard.".into(),
            )
        })?;
    Ok((
        Client::with_token_options(token, state.config.github.clone())?,
        token.to_owned(),
    ))
}

async fn authenticated_context(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(Client, Viewer, String), ApiError> {
    let (client, credential) = request_client(state, headers).await?;
    let viewer = client.viewer().await?;
    // Identity comes from GitHub using the supplied token, never an identity header.
    if state.mode == Mode::Proxy
        && !state
            .allowed_users
            .contains(&viewer.login.to_ascii_lowercase())
    {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "This GitHub account is not allowed to use this dashboard.".into(),
        ));
    }
    Ok((client, viewer, credential))
}

fn timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tower::ServiceExt;

    #[test]
    fn local_credentials_are_protected_from_remote_and_rebinding_requests() {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, "localhost:8080".parse().unwrap());
        assert!(local_request(
            &headers,
            Some("127.0.0.1:9001".parse().unwrap())
        ));
        assert!(!local_request(
            &headers,
            Some("192.168.1.2:9001".parse().unwrap())
        ));
        headers.insert(header::HOST, "attacker.example:8080".parse().unwrap());
        assert!(!local_request(
            &headers,
            Some("127.0.0.1:9001".parse().unwrap())
        ));
        headers.insert(header::HOST, "localhost:8080".parse().unwrap());
        headers.insert(header::ORIGIN, "https://attacker.example".parse().unwrap());
        assert!(!local_request(
            &headers,
            Some("127.0.0.1:9001".parse().unwrap())
        ));
    }

    #[tokio::test]
    async fn initial_html_identifies_authentication_before_any_api_response() {
        for mode in [Mode::Gh, Mode::Demo, Mode::Proxy] {
            let state = AppState {
                mode,
                default_owner: None,
                allowed_users: vec!["davlgd".into()],
                requests: Arc::new(Semaphore::new(4)),
                config: config::Config::default(),
                cache: Arc::default(),
            };
            let response = app(state)
                .oneshot(
                    Request::builder()
                        .uri("/")
                        .header(header::HOST, "localhost:8080")
                        .header("x-forwarded-auth-mode", "proxy")
                        .extension(ConnectInfo("127.0.0.1:1234".parse::<SocketAddr>().unwrap()))
                        .body(axum::body::Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = axum::body::to_bytes(response.into_body(), 100_000)
                .await
                .unwrap();
            let html = std::str::from_utf8(&bytes).unwrap();
            assert!(html.contains(&format!("data-auth-mode=\"{}\"", mode.label())));
            assert!(!html.contains("{{AUTH_MODE}}"));
        }
    }

    #[tokio::test]
    async fn proxy_requires_token_and_health_is_public() {
        let state = AppState {
            mode: Mode::Proxy,
            default_owner: None,
            allowed_users: vec!["davlgd".into()],
            requests: Arc::new(Semaphore::new(4)),
            config: config::Config::default(),
            cache: Arc::default(),
        };
        for (path, expected) in [
            ("/api/sync", StatusCode::UNAUTHORIZED),
            ("/health", StatusCode::OK),
        ] {
            let response = app(state.clone())
                .oneshot(
                    Request::builder()
                        .uri(path)
                        .header("x-forwarded-user", "davlgd")
                        .body(axum::body::Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        }
    }
}
