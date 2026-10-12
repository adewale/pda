//! Poppy interop adapter for everruns' Poppy channel (the Company side).
//!
//! Spec: docs/interop-spec.md (version 1), sections 3, 4, 5.1 and 5.3.
//!
//! Built inside the everruns workspace as an integration-test target of
//! `everruns-server` (the Dockerfile copies this file to
//! `crates/server/tests/interop_adapter/main.rs`), because the in-process
//! server assembly everruns itself uses for its Poppy interop tests lives in
//! `crates/server/tests/test_harness.rs`. Nothing here is copied from
//! everruns: the harness file is compiled from the pinned checkout.
//!
//! - Port 8080: everruns' real HTTP router (in-memory mode, its embedded
//!   PostgreSQL), behind a small front that answers the company website's
//!   part: `/.well-known/poppy.json` redirects to the channel's discovery
//!   document, as everruns documents for a real deployment.
//! - Port 8081: the control API (manifest, healthz, reset, hooks).
//! - The image runs `serve`, a supervisor that owns both ports and runs this
//!   adapter as a child process (`child`), started again on every reset
//!   (see the end of this file).
//! - The channel's agent is answered by a stand-in turn runner ("Reply N"),
//!   as in everruns' own channel tests: no model.

#[path = "../test_harness.rs"]
mod test_harness;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};

use axum::{
    Json, Router,
    body::Body,
    extract::{Path, Request, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{any, get, post},
};
use everruns_core::events::{EventContext, EventRequest, OutputMessageCompletedData};
use everruns_core::message::RuntimeMessage;
use serde_json::{Value, json};
use test_harness::TestServer;
use tokio::sync::RwLock;

const NAME: &str = "everruns";

/// Answers every turn of the channel's agent with "Reply N".
#[derive(Default)]
struct Replier {
    events: OnceLock<Arc<everruns_server::services::EventService>>,
    turns: AtomicUsize,
}

#[async_trait::async_trait]
impl everruns_core::host::TurnBackend for Replier {
    async fn start_turn(
        &self,
        request: everruns_core::host::TurnRequest,
    ) -> everruns_contracts::error::Result<everruns_core::host::TurnTicket> {
        let n = self.turns.fetch_add(1, Ordering::SeqCst) + 1;
        let events = self.events.get().expect("event service wired").clone();
        let (session_id, turn_id) = (request.session_id, request.turn_id);
        tokio::spawn(async move {
            let output =
                OutputMessageCompletedData::new(RuntimeMessage::assistant(format!("Reply {n}")));
            let _ = events
                .emit(EventRequest::new(session_id, EventContext::empty(), output))
                .await;
            if let Ok(done) = serde_json::from_value::<everruns_core::events::TurnCompletedData>(
                json!({ "turn_id": turn_id, "iterations": 1 }),
            ) {
                let _ = events
                    .emit(EventRequest::new(session_id, EventContext::empty(), done))
                    .await;
            }
        });
        Ok(everruns_core::host::TurnTicket::new(
            request.session_id,
            request.turn_id,
            std::future::pending(),
        ))
    }

    async fn cancel(
        &self,
        _session_id: everruns_contracts::typed_id::SessionId,
    ) -> everruns_contracts::error::Result<bool> {
        Ok(false)
    }

    async fn is_running(&self, _session_id: everruns_contracts::typed_id::SessionId) -> bool {
        false
    }

    async fn active_count(&self) -> usize {
        0
    }
}

/// One running Company: an everruns server with one published Poppy channel.
struct Company {
    base: String,
    channel_id: String,
}

struct App {
    /// `https://everruns.company.interop.test`, from INTEROP_ORIGIN.
    origin: String,
    host: String,
    scheme: String,
    secret: Option<String>,
    commit: String,
    /// `proxy` (default: the front serves the document) or `redirect` (the
    /// 302 everruns' docs describe).
    well_known: String,
    client: reqwest::Client,
    company: RwLock<Option<Arc<Company>>>,
}

async fn start_company(host: &str) -> Result<Company, String> {
    let runner = Arc::new(Replier::default());
    let (server, base) = TestServer::serving_in_memory_with_runner(runner.clone()).await;
    runner.events.set(server.event_service.clone()).ok();
    // The server lives for the process; a reset starts another one.
    let server: &'static TestServer = Box::leak(Box::new(server));
    let agent = server
        .post(
            "/v1/agents",
            json!({
                "name": format!("interop-{}", uuid::Uuid::new_v4().simple()),
                "display_name": "Interop Company agent",
                "description": "Answers personal agents in the Poppy interop grid.",
                "system_prompt": "You are a brief test agent."
            }),
        )
        .await;
    if agent.status() != StatusCode::CREATED {
        return Err(format!("create agent: {} {}", agent.status(), agent.text()));
    }
    let agent_id = agent.json_value()["id"].as_str().unwrap_or_default().to_string();
    let channel = server
        .post(
            &format!("/v1/agents/{agent_id}/channels"),
            json!({
                "channel_type": "poppy",
                "channel_config": {
                    "organization_name": "Everruns Interop Co",
                    "domains": [host],
                }
            }),
        )
        .await;
    if channel.status() != StatusCode::CREATED {
        return Err(format!("create channel: {} {}", channel.status(), channel.text()));
    }
    let channel_id = channel.json_value()["id"].as_str().unwrap_or_default().to_string();
    let published = server
        .post(&format!("/v1/agents/{agent_id}/channels/{channel_id}/publish"), json!({}))
        .await;
    if !published.status().is_success() {
        return Err(format!("publish: {} {}", published.status(), published.text()));
    }
    Ok(Company { base, channel_id })
}

fn issuer(app: &App, company: &Company) -> String {
    format!("{}/api/v1/channels/{}/poppy", app.origin, company.channel_id)
}

/// Port 8080: everything goes to everruns' router, with `Host` and
/// `X-Forwarded-Proto` pinned to INTEROP_ORIGIN (everruns derives its issuer
/// and DPoP `htu` from them).
async fn front(State(app): State<Arc<App>>, request: Request) -> Response {
    let Some(company) = app.company.read().await.clone() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "starting").into_response();
    };
    let (parts, body) = request.into_parts();
    let mut target = parts
        .uri
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| "/".into());
    if parts.uri.path() == "/.well-known/poppy.json" {
        let location = format!(
            "/api/v1/channels/{}/poppy/poppy.json?domain={}",
            company.channel_id, app.host
        );
        if app.well_known == "redirect" {
            return (StatusCode::FOUND, [(header::LOCATION, location)]).into_response();
        }
        target = location;
    }
    let bytes = match axum::body::to_bytes(body, 4 << 20).await {
        Ok(bytes) => bytes,
        Err(_) => return (StatusCode::PAYLOAD_TOO_LARGE, "too large").into_response(),
    };
    let mut outgoing = app
        .client
        .request(parts.method.clone(), format!("{}{target}", company.base));
    for (name, value) in &parts.headers {
        if matches!(
            name.as_str(),
            "host" | "content-length" | "connection" | "transfer-encoding" | "x-forwarded-proto"
                | "x-forwarded-host"
        ) {
            continue;
        }
        outgoing = outgoing.header(name, value);
    }
    let outgoing = outgoing
        .header("host", &app.host)
        .header("x-forwarded-proto", &app.scheme)
        .body(bytes);
    match outgoing.send().await {
        Ok(response) => {
            let mut built = Response::builder().status(response.status().as_u16());
            for (name, value) in response.headers() {
                if matches!(name.as_str(), "connection" | "transfer-encoding") {
                    continue;
                }
                built = built.header(name, value);
            }
            built
                .body(Body::from_stream(response.bytes_stream()))
                .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response())
        }
        Err(error) => (StatusCode::BAD_GATEWAY, error.to_string()).into_response(),
    }
}

fn authorized(app: &App, headers: &HeaderMap) -> Result<(), Response> {
    let given = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    match (&app.secret, given) {
        (Some(secret), Some(given)) if secret == given => Ok(()),
        _ => Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "unauthorized", "detail": "Bearer INTEROP_SECRET required" })),
        )
            .into_response()),
    }
}

fn manifest_json(app: &App) -> Value {
    json!({
        "interop": 1,
        "name": NAME,
        "role": "company",
        "commit": app.commit,
        "poppy": ["0.1"],
        "extensions": [],
        "scenarios": ["D", "S0", "C", "CI"],
        "readings": { "S1": "token-endpoint", "S2": "lenient-300s", "S3": "either", "S4": "omit" },
        "relaxations": [
            "EVERRUNS_INTEROP_ALLOW_PRIVATE_NETWORKS=1 (patches/0001): RFC 1918 addresses pass the SSRF guard, so client metadata and JWKS on *.interop.test (the proxy's private address) can be fetched",
            "The adapter front pins Host and X-Forwarded-Proto to INTEROP_ORIGIN; everruns derives the issuer, endpoints and DPoP htu from those headers",
            "In-memory mode (embedded PostgreSQL) and a stand-in turn runner that answers 'Reply N' instead of a model, as in everruns' own channel tests",
            "The front serves the channel's discovery document at /.well-known/poppy.json (the company-website part everruns leaves to the company; EVERRUNS_WELL_KNOWN=redirect answers with the 302 everruns' docs describe instead)",
            "patches/0002 makes the personal agent's signing key loader public (visibility only; not used here, applied so both everruns images build the same everruns-server)"
        ],
        "notes": "Signed-out only: no sign-in, APIs, SSE, operations or DPoP nonces.",
    })
}

async fn manifest(State(app): State<Arc<App>>) -> Json<Value> {
    Json(manifest_json(&app))
}

async fn healthz(State(app): State<Arc<App>>) -> Response {
    match app.company.read().await.as_ref() {
        Some(company) => Json(json!({ "ok": true, "issuer": issuer(&app, company) })).into_response(),
        None => (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "ok": false }))).into_response(),
    }
}

const HOOKS: &[&str] = &["fixture"];

async fn hooks(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    if let Err(denied) = authorized(&app, &headers) {
        return denied;
    }
    Json(json!({ "interop": 1, "hooks": HOOKS })).into_response()
}

async fn hook(
    State(app): State<Arc<App>>,
    Path(name): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(denied) = authorized(&app, &headers) {
        return denied;
    }
    match name.as_str() {
        // Signed-out only: no accounts and no scopes.
        // The hook's result is the response body itself (as the runner reads it).
        "fixture" => Json(json!({
            "accounts": [],
            "scopes": [],
            // The stand-in runner answers any message ("Reply N").
            "prompts": { "hello": "Hello! What are your opening hours?" },
        }))
        .into_response(),
        _ => (
            StatusCode::NOT_IMPLEMENTED,
            Json(json!({
                "error": "unsupported",
                "detail": format!("everruns' Poppy channel has no `{name}` (signed-out only)"),
            })),
        )
            .into_response(),
    }
}

async fn run() {
    let name = std::env::var("INTEROP_NAME").unwrap_or_else(|_| NAME.into());
    let origin = std::env::var("INTEROP_ORIGIN")
        .unwrap_or_else(|_| format!("https://{name}.company.interop.test"));
    let origin = origin.trim_end_matches('/').to_string();
    let parsed = url::Url::parse(&origin).expect("INTEROP_ORIGIN is a URL");
    let host = match parsed.port() {
        Some(port) => format!("{}:{port}", parsed.host_str().unwrap_or_default()),
        None => parsed.host_str().unwrap_or_default().to_string(),
    };
    let app = Arc::new(App {
        scheme: parsed.scheme().to_string(),
        host,
        origin,
        secret: std::env::var("INTEROP_SECRET").ok().filter(|s| !s.is_empty()),
        commit: std::env::var("EVERRUNS_COMMIT")
            .or_else(|_| std::env::var("INTEROP_COMMIT"))
            .unwrap_or_else(|_| "unknown".into()),
        well_known: std::env::var("EVERRUNS_WELL_KNOWN").unwrap_or_else(|_| "proxy".into()),
        client: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("client"),
        company: RwLock::new(None),
    });

    let control = Router::new()
        .route("/manifest", get(manifest))
        .route("/healthz", get(healthz))
        .route("/hooks", get(hooks))
        .route("/hooks/{name}", post(hook))
        .with_state(app.clone());
    let front_router = Router::new().fallback(any(front)).with_state(app.clone());
    // The supervisor (below) gives this process its loopback ports.
    let control_at = std::env::var("INTEROP_CHILD_CONTROL").unwrap_or_else(|_| "0.0.0.0:8081".into());
    let front_at = std::env::var("INTEROP_CHILD_FRONT").unwrap_or_else(|_| "0.0.0.0:8080".into());
    let control_listener = tokio::net::TcpListener::bind(&control_at).await.expect("control port");
    let front_listener = tokio::net::TcpListener::bind(&front_at).await.expect("front port");
    tokio::spawn(async move { axum::serve(control_listener, control).await.ok() });
    tokio::spawn(async move { axum::serve(front_listener, front_router).await.ok() });

    match start_company(&app.host).await {
        Ok(company) => {
            eprintln!("everruns company ready: issuer {}", issuer(&app, &company));
            *app.company.write().await = Some(Arc::new(company));
        }
        Err(error) => panic!("could not start the everruns company: {error}"),
    }
    std::future::pending::<()>().await;
}

/// Build-time warm-up: start one in-memory server so the embedded
/// PostgreSQL binaries are downloaded into EVERRUNS_PG_CACHE.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore]
async fn warm() {
    let _server = TestServer::in_memory().await;
}

// ---------------------------------------------------------------------------
// Supervisor: one child process per reset.
//
// Every `TestServer` everruns' harness builds keeps its router, pool and
// background tasks alive for the life of the process (its listener handles
// are leaked on purpose), so starting a new one on each `/reset` grew the
// container by about 280 MB a reset until it was killed. The process the
// image runs (`serve`) is therefore only a supervisor: it owns ports 8080 and
// 8081, runs the adapter proper (`child`) as a child process on loopback
// ports, forwards every request to it, and answers `/reset` by killing the
// child and starting another. A new process is a new embedded PostgreSQL
// (its postgres dies with the child: everruns spawns it with
// PR_SET_PDEATHSIG), a new database and a new key. A child starts in about
// two seconds.

const CHILD_FRONT: &str = "127.0.0.1:18080";
const CHILD_CONTROL: &str = "127.0.0.1:18081";

struct Supervisor {
    secret: Option<String>,
    client: reqwest::Client,
    child: tokio::sync::Mutex<Option<tokio::process::Child>>,
}

impl Supervisor {
    /// Kill the running child, if any, and start a new one; ready once its
    /// `/healthz` answers 200.
    async fn restart(&self) -> Result<(), String> {
        let mut slot = self.child.lock().await;
        if let Some(mut old) = slot.take() {
            let _ = old.kill().await;
        }
        let exe = std::env::current_exe().map_err(|error| error.to_string())?;
        let mut child = tokio::process::Command::new(exe)
            .args(["child", "--ignored", "--exact", "--nocapture", "--test-threads=1"])
            .env("INTEROP_CHILD_FRONT", CHILD_FRONT)
            .env("INTEROP_CHILD_CONTROL", CHILD_CONTROL)
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| format!("spawn: {error}"))?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        loop {
            if let Ok(Some(status)) = child.try_wait() {
                return Err(format!("the adapter process exited while starting ({status})"));
            }
            if let Ok(response) = self
                .client
                .get(format!("http://{CHILD_CONTROL}/healthz"))
                .send()
                .await
                && response.status().is_success()
            {
                *slot = Some(child);
                return Ok(());
            }
            if std::time::Instant::now() > deadline {
                let _ = child.kill().await;
                return Err("the adapter process wasn't ready within 60 s".into());
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }
}

/// Forward `request` unchanged to `target` (a loopback address).
async fn forward(client: &reqwest::Client, target: &str, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let path = parts
        .uri
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| "/".into());
    let bytes = match axum::body::to_bytes(body, 16 << 20).await {
        Ok(bytes) => bytes,
        Err(_) => return (StatusCode::PAYLOAD_TOO_LARGE, "too large").into_response(),
    };
    let mut outgoing = client.request(parts.method.clone(), format!("http://{target}{path}"));
    for (name, value) in &parts.headers {
        if matches!(name.as_str(), "content-length" | "connection" | "transfer-encoding") {
            continue;
        }
        outgoing = outgoing.header(name, value);
    }
    match outgoing.body(bytes).send().await {
        Ok(response) => {
            let mut built = Response::builder().status(response.status().as_u16());
            for (name, value) in response.headers() {
                if matches!(name.as_str(), "connection" | "transfer-encoding") {
                    continue;
                }
                built = built.header(name, value);
            }
            built
                .body(Body::from_stream(response.bytes_stream()))
                .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response())
        }
        Err(error) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "starting", "detail": error.to_string() })),
        )
            .into_response(),
    }
}

async fn supervised_reset(State(sup): State<Arc<Supervisor>>, headers: HeaderMap) -> Response {
    let given = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    if !matches!((&sup.secret, given), (Some(secret), Some(given)) if secret == given) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "unauthorized", "detail": "Bearer INTEROP_SECRET required" })),
        )
            .into_response();
    }
    match sup.restart().await {
        Ok(()) => match sup.client.get(format!("http://{CHILD_CONTROL}/healthz")).send().await {
            Ok(response) => {
                let health = response.json::<Value>().await.unwrap_or_else(|_| json!({}));
                let mut answer = json!({ "ok": true });
                if let Some(issuer) = health.get("issuer") {
                    answer["issuer"] = issuer.clone();
                }
                Json(answer).into_response()
            }
            Err(error) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "reset_failed", "detail": error.to_string() })),
            )
                .into_response(),
        },
        Err(detail) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "reset_failed", "detail": detail })),
        )
            .into_response(),
    }
}

async fn supervise() {
    let sup = Arc::new(Supervisor {
        secret: std::env::var("INTEROP_SECRET").ok().filter(|s| !s.is_empty()),
        client: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("client"),
        child: tokio::sync::Mutex::new(None),
    });
    let control = Router::new()
        .route("/reset", post(supervised_reset))
        .fallback(any(|State(sup): State<Arc<Supervisor>>, request: Request| async move {
            forward(&sup.client, CHILD_CONTROL, request).await
        }))
        .with_state(sup.clone());
    let front_router = Router::new()
        .fallback(any(|State(sup): State<Arc<Supervisor>>, request: Request| async move {
            forward(&sup.client, CHILD_FRONT, request).await
        }))
        .with_state(sup.clone());
    let control_listener = tokio::net::TcpListener::bind("0.0.0.0:8081").await.expect("8081");
    let front_listener = tokio::net::TcpListener::bind("0.0.0.0:8080").await.expect("8080");
    tokio::spawn(async move { axum::serve(control_listener, control).await.ok() });
    tokio::spawn(async move { axum::serve(front_listener, front_router).await.ok() });
    if let Err(error) = sup.restart().await {
        panic!("could not start the adapter process: {error}");
    }
    std::future::pending::<()>().await;
}

/// `interop_adapter serve --ignored --exact`: the supervisor, until killed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore]
async fn serve() {
    supervise().await;
}

/// `interop_adapter child --ignored --exact`: the adapter proper, on the
/// loopback ports the supervisor gives it, until the supervisor kills it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore]
async fn child() {
    run().await;
}
