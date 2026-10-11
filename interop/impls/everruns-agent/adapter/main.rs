//! Poppy interop adapter for everruns as a Personal Agent.
//!
//! Spec: docs/interop-spec.md (version 1), sections 3, 4, 5.1 and 5.2.
//!
//! Built inside the everruns workspace as an integration-test target of
//! `everruns-server` (the Dockerfile copies this file to
//! `crates/server/tests/interop_adapter/main.rs`), so it can use everruns'
//! in-process server assembly (`crates/server/tests/test_harness.rs`, compiled
//! from the pinned checkout, not copied).
//!
//! Every step runs `worker_poppy_call`, the internal command behind the
//! `poppy_client` tools (the same entry point everruns' own interop tests
//! drive), through everruns' real egress service. No model is involved.
//!
//! - Port 8080: everruns' router, which publishes the personal agent's client
//!   metadata (`/api/v1/poppy/agent.json`, the `client_id`) and JWKS.
//! - Port 8081: the control API (manifest, healthz, reset, step).

#[path = "../test_harness.rs"]
mod test_harness;

use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    Json, Router,
    body::Body,
    extract::{Request, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{any, get, post},
};
use everruns_server::domains::common::{Ctx, dispatch};
use serde_json::{Value, json};
use test_harness::TestServer;
use tokio::sync::{Mutex, RwLock};

const NAME: &str = "everruns";

/// One running personal agent: an everruns server (its own database, so its
/// own signing key) and the person the agent speaks for.
struct Agent {
    server: &'static TestServer,
    base: String,
    egress: Arc<dyn everruns_core::EgressService>,
    /// The agent (in everruns' sense) whose sessions hold the conversations.
    agent_id: String,
    /// (company, label) -> everruns session id. Each everruns session holds
    /// one conversation per company.
    sessions: Mutex<HashMap<(String, String), String>>,
    /// (company, label, message_id key) -> conversation, for retries.
    retries: Mutex<HashMap<(String, String, String), String>>,
}

struct App {
    origin: String,
    host: String,
    scheme: String,
    secret: Option<String>,
    commit: String,
    client: reqwest::Client,
    agent: RwLock<Option<Arc<Agent>>>,
}

async fn start_agent() -> Result<Agent, String> {
    let (server, base) = TestServer::serving_in_memory().await;
    let server: &'static TestServer = Box::leak(Box::new(server));
    let created = server
        .post(
            "/v1/agents",
            json!({
                "name": format!("pa-{}", uuid::Uuid::new_v4().simple()),
                "display_name": "Personal agent",
                "description": "Talks to companies for its person (Poppy interop).",
                "system_prompt": "You are a brief test agent."
            }),
        )
        .await;
    if created.status() != StatusCode::CREATED {
        return Err(format!("create agent: {} {}", created.status(), created.text()));
    }
    let agent_id = created.json_value()["id"].as_str().unwrap_or_default().to_string();
    Ok(Agent {
        server,
        base,
        egress: Arc::new(everruns_core::host::DirectEgressService::new()),
        agent_id,
        sessions: Mutex::new(HashMap::new()),
        retries: Mutex::new(HashMap::new()),
    })
}

impl Agent {
    fn ctx(&self) -> Ctx {
        let capabilities = Arc::new(everruns_server::services::CapabilityService::new(
            self.server.db.clone(),
            self.server.encryption.clone(),
        ));
        Ctx::new(
            everruns_core::Caller::internal(everruns_core::DEFAULT_ORG_ID),
            self.server.db.clone(),
            capabilities,
            self.server.encryption.clone(),
            Arc::new(everruns_core::DefaultPermissionResolver),
        )
        .with_egress_service(self.egress.clone())
    }

    async fn new_session(&self) -> Result<String, String> {
        let created = self
            .server
            .post("/v1/sessions", json!({ "agent_id": self.agent_id }))
            .await;
        if !created.status().is_success() {
            return Err(format!("create session: {} {}", created.status(), created.text()));
        }
        Ok(created.json_value()["id"].as_str().unwrap_or_default().to_string())
    }

    /// The everruns session for (company, label), created on first use.
    async fn session(&self, company: &str, label: &str) -> Result<String, String> {
        let key = (company.to_string(), label.to_string());
        if let Some(id) = self.sessions.lock().await.get(&key) {
            return Ok(id.clone());
        }
        let id = self.new_session().await?;
        self.sessions.lock().await.insert(key, id.clone());
        Ok(id)
    }

    async fn call(&self, session: &str, call: Value) -> Result<Value, String> {
        let params = json!({ "session_id": session, "call": call });
        match dispatch("worker_poppy_call", params, &self.ctx()).await {
            Ok(text) => serde_json::from_str(&text).map_err(|error| error.to_string()),
            Err(error) => Err(error.to_string()),
        }
    }

    /// What the session stores about its conversation with `company`
    /// (`poppy_session_id`, `conversation_id`, `cursor`), never the token.
    async fn stored(&self, session: &str, company: &str) -> Value {
        let Ok(id) = session.parse::<everruns_contracts::typed_id::SessionId>() else {
            return Value::Null;
        };
        match self
            .server
            .db
            .poppy_agent_conversation(id.uuid(), &company.to_ascii_lowercase())
            .await
        {
            Ok(Some(row)) => {
                let mut state = row.state;
                state["issuer"] = json!(row.issuer);
                state
            }
            _ => Value::Null,
        }
    }
}

fn ok(result: Value) -> Response {
    Json(json!({ "ok": true, "result": result })).into_response()
}

fn adapter_error(status: StatusCode, code: &str, detail: impl Into<String>) -> Response {
    (status, Json(json!({ "error": code, "detail": detail.into() }))).into_response()
}

fn unsupported(op: &str, why: &str) -> Response {
    adapter_error(StatusCode::NOT_IMPLEMENTED, "unsupported", format!("{op}: {why}"))
}

/// everruns reports a Company's refusal as a sentence for the model:
/// "{domain} refused the {step}: {code} ({description})" or
/// "the company did not start a Session ({code})". The HTTP status is not
/// kept, so `status` is null unless the code is "HTTP nnn".
fn refusal(message: &str) -> Option<(Option<String>, Option<u16>)> {
    let code = if let Some(at) = message.find(" refused the ") {
        let rest = &message[at + " refused the ".len()..];
        rest.split_once(": ").map(|(_, code)| code.to_string())
    } else if let Some(at) = message.find("did not start a Session (") {
        let rest = &message[at + "did not start a Session (".len()..];
        Some(rest.trim_end_matches(')').to_string())
    } else {
        None
    }?;
    let code = code.split([' ', '(', ')']).filter(|part| !part.is_empty()).collect::<Vec<_>>();
    match code.as_slice() {
        ["HTTP", status, ..] => Some((None, status.parse().ok())),
        [code, ..] => Some((Some(code.to_string()), None)),
        [] => None,
    }
}

/// A failed call: a Company's refusal, the client's own refusal (spec 5.2:
/// `discovery_failed` for documents it won't use, with status 0), or a
/// Company that couldn't be reached (an adapter error).
fn failed(message: String) -> Response {
    if let Some((code, status)) = refusal(&message) {
        return Json(json!({
            "ok": false,
            "poppy_error": code.unwrap_or_else(|| "http_error".into()),
            // everruns keeps only the code, not the HTTP status.
            "status": status,
            "detail": message,
        }))
        .into_response();
    }
    if message.contains("could not be reached") {
        return adapter_error(StatusCode::BAD_GATEWAY, "unreachable", message);
    }
    let discovery = ["poppy.json", "OAuth", "not a domain", "HTTPS", "speaks Poppy", "accept personal agents", "conversation endpoint", "token endpoint", "list its domain"]
        .iter()
        .any(|needle| message.contains(needle));
    Json(json!({
        "ok": false,
        "poppy_error": if discovery { "discovery_failed" } else { "agent_refused" },
        "status": 0,
        "detail": message,
    }))
    .into_response()
}

fn company_messages(answer: &Value) -> Vec<Value> {
    answer["messages"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|message| json!({ "role": "company", "sender": message["from"], "text": message["text"] }))
        .collect()
}

fn wait_seconds(params: &Value, default: u64) -> u64 {
    params["wait"].as_u64().unwrap_or(default).min(30)
}

async fn step(app: &App, agent: &Agent, body: Value) -> Response {
    let op = body["op"].as_str().unwrap_or_default().to_string();
    let company = body["company"].as_str().unwrap_or_default().to_ascii_lowercase();
    let params = body.get("params").cloned().unwrap_or_else(|| json!({}));
    let label = params["label"].as_str().unwrap_or("default").to_string();
    let _ = app;
    match op.as_str() {
        "discover" => {
            // everruns' own client (`PoppyAgent::discover`, what the
            // poppy_discover tool runs); its tool answer leaves out the issuer.
            let key = match everruns_server::domains::poppy_agent::signing_key(
                &agent.server.db,
                agent.server.encryption.as_ref(),
            )
            .await
            {
                Ok(key) => key,
                Err(error) => {
                    return adapter_error(StatusCode::INTERNAL_SERVER_ERROR, "adapter", error.to_string());
                }
            };
            let client = everruns_server::domains::poppy_agent::protocol::PoppyAgent::new(
                agent.egress.clone(),
                Arc::new(key),
                everruns_server::domains::poppy_agent::client_id(
                    &everruns_server::domains::poppy_agent::public_base_url(),
                ),
            );
            match client.discover(&company).await {
                Ok(found) => ok(json!({
                    "issuer": found.issuer,
                    "poppy_version": found.document["protocol_version"],
                    "conversations": found.conversations.is_some(),
                    "apis": found.document["apis"].as_array().cloned().unwrap_or_default()
                        .iter().map(|api| api["type"].clone()).collect::<Vec<_>>(),
                    "name": found.name,
                })),
                Err(message) => failed(message),
            }
        }
        "session" => {
            // The label's everruns session. If it already holds a Poppy
            // Session, that is the answer (everruns renews it on next use).
            // Otherwise a read there discovers, starts a signed-out Session,
            // stores it, and then stops for want of a conversation.
            let session = match agent.session(&company, &label).await {
                Ok(session) => session,
                Err(error) => return adapter_error(StatusCode::INTERNAL_SERVER_ERROR, "adapter", error),
            };
            let stored = agent.stored(&session, &company).await;
            if stored["poppy_session_id"].is_string() {
                return ok(json!({
                    "session_id": stored["poppy_session_id"],
                    "signed_in": false,
                    "scope": Value::Null,
                    "issuer": stored["issuer"],
                }));
            }
            match agent
                .call(&session, json!({ "action": "read", "company": company }))
                .await
            {
                Err(message) if message.contains("there is no conversation with") => {
                    let stored = agent.stored(&session, &company).await;
                    ok(json!({
                        "session_id": stored["poppy_session_id"],
                        "signed_in": false,
                        // everruns doesn't keep the token response's scope.
                        "scope": Value::Null,
                        "issuer": stored["issuer"],
                    }))
                }
                Err(message) => failed(message),
                Ok(other) => adapter_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "adapter",
                    format!("unexpected read answer {other}"),
                ),
            }
        }
        "send" => {
            let Some(text) = params["text"].as_str() else {
                return adapter_error(StatusCode::BAD_REQUEST, "bad_params", "send needs text");
            };
            let session = match agent.session(&company, &label).await {
                Ok(session) => session,
                Err(error) => return adapter_error(StatusCode::INTERNAL_SERVER_ERROR, "adapter", error),
            };
            let stored = agent.stored(&session, &company).await;
            let current = stored["conversation_id"].as_str().map(str::to_string);
            // A message_id given in params is a retry key (spec 5.2): the
            // same key is the same message, in the same conversation.
            let retry_of = match params["message_id"].as_str() {
                Some(key) => agent
                    .retries
                    .lock()
                    .await
                    .get(&(company.clone(), label.clone(), key.to_string()))
                    .cloned(),
                None => None,
            };
            let asked = params["conversation"].as_str().map(str::to_string).or(retry_of);
            let new_conversation = match (asked.as_deref(), current.as_deref()) {
                (None, None) => false,
                (None, Some(_)) => true,
                (Some(asked), Some(current)) if asked == current => false,
                (Some(asked), _) => {
                    return unsupported(
                        "send",
                        &format!(
                            "everruns keeps one conversation per company per session; {asked} is not the current one"
                        ),
                    );
                }
            };
            let message_id = params["message_id"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| format!("msg_{}", uuid::Uuid::new_v4().simple()));
            match agent
                .call(
                    &session,
                    json!({
                        "action": "send", "company": company, "text": text,
                        "message_id": message_id, "new_conversation": new_conversation,
                        // Default 0: everruns moves its cursor past whatever a
                        // send returns, so a reply waited for here would never
                        // show up in a later `read`.
                        "wait_seconds": wait_seconds(&params, 0),
                    }),
                )
                .await
            {
                Ok(answer) => {
                    if let (Some(key), Some(conversation)) =
                        (params["message_id"].as_str(), answer["conversation_id"].as_str())
                    {
                        agent.retries.lock().await.insert(
                            (company.clone(), label.clone(), key.to_string()),
                            conversation.to_string(),
                        );
                    }
                    ok(json!({
                        "conversation": answer["conversation_id"],
                        "message_id": message_id,
                        "status": answer["status"],
                        "responder": answer["responder"],
                        "messages": company_messages(&answer),
                    }))
                }
                Err(message) => failed(message),
            }
        }
        "read" => {
            if params.get("cursor").is_some_and(|cursor| !cursor.is_null()) {
                return unsupported("read", "everruns keeps its own cursor; it takes none");
            }
            let session = match agent.session(&company, &label).await {
                Ok(session) => session,
                Err(error) => return adapter_error(StatusCode::INTERNAL_SERVER_ERROR, "adapter", error),
            };
            if let Some(asked) = params["conversation"].as_str() {
                let stored = agent.stored(&session, &company).await;
                if stored["conversation_id"].as_str() != Some(asked) {
                    return unsupported("read", &format!("{asked} is not this session's conversation"));
                }
            }
            match agent
                .call(
                    &session,
                    json!({ "action": "read", "company": company, "wait_seconds": wait_seconds(&params, 0) }),
                )
                .await
            {
                Ok(answer) => {
                    let stored = agent.stored(&session, &company).await;
                    ok(json!({
                        "messages": company_messages(&answer),
                        "cursor": stored["cursor"],
                        // everruns doesn't read or follow has_more.
                        "has_more": Value::Null,
                        "status": answer["status"],
                    }))
                }
                Err(message) => failed(message),
            }
        }
        "state" => {
            let sessions = agent.sessions.lock().await.clone();
            let mut listed = Vec::new();
            for ((company, label), session) in sessions {
                let stored = agent.stored(&session, &company).await;
                listed.push(json!({
                    "company": company,
                    "label": label,
                    "issuer": stored["issuer"],
                    "session_id": stored["poppy_session_id"],
                    "conversation": stored["conversation_id"],
                    "cursor": stored["cursor"],
                    "signed_in": false,
                }));
            }
            ok(json!({ "sessions": listed, "accounts": [] }))
        }
        "signin" | "signin_continue" | "signout" => {
            unsupported(&op, "everruns' personal agent has no sign-in yet (signed-out only)")
        }
        "sse" => unsupported(&op, "everruns' personal agent doesn't read event streams"),
        "api" => unsupported(&op, "everruns' personal agent doesn't call Company APIs"),
        "web_join" => unsupported(&op, "no browser Session join"),
        "approve_op" => unsupported(&op, "no Operations extension"),
        _ => unsupported(&op, "unknown op"),
    }
}

/// Port 8080: everruns' router, Host pinned to INTEROP_ORIGIN.
async fn front(State(app): State<Arc<App>>, request: Request) -> Response {
    let Some(agent) = app.agent.read().await.clone() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "starting").into_response();
    };
    let (parts, body) = request.into_parts();
    let target = parts
        .uri
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| "/".into());
    let bytes = match axum::body::to_bytes(body, 4 << 20).await {
        Ok(bytes) => bytes,
        Err(_) => return (StatusCode::PAYLOAD_TOO_LARGE, "too large").into_response(),
    };
    let mut outgoing = app
        .client
        .request(parts.method.clone(), format!("{}{target}", agent.base));
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
        _ => Err(adapter_error(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "Bearer INTEROP_SECRET required",
        )),
    }
}

async fn manifest(State(app): State<Arc<App>>) -> Json<Value> {
    let notes = format!(
        "Drives worker_poppy_call (the poppy_client tools' command) directly; no model. Signed-out only. client_id: {}/api/v1/poppy/agent.json",
        app.origin
    );
    Json(json!({
        "interop": 1,
        "name": NAME,
        "role": "agent",
        "commit": app.commit,
        "poppy": ["0.1"],
        "extensions": [],
        "scenarios": ["D", "S0", "C", "CI"],
        "readings": { "S1": "token-endpoint", "S2": "any", "S3": "append", "S4": "omit", "S23": "per-origin" },
        "relaxations": [
            "EVERRUNS_INTEROP_ALLOW_PRIVATE_NETWORKS=1 (patches/0001): RFC 1918 addresses pass the egress SSRF guard, because *.interop.test resolves to the proxy's private address",
            "In-memory mode (embedded PostgreSQL); the client_id is INTEROP_ORIGIN + /api/v1/poppy/agent.json via configure_public_base_url",
            "The adapter front pins Host and X-Forwarded-Proto to INTEROP_ORIGIN",
            "patches/0002 renumbers two of the three migrations that share version 218 at this commit (a fresh database can't be migrated otherwise)",
            "patches/0003 makes the Poppy client module public (visibility only) so `discover` calls PoppyAgent::discover, whose result carries the issuer"
        ],
        "notes": notes,
    }))
}

async fn healthz(State(app): State<Arc<App>>) -> Response {
    if app.agent.read().await.is_some() {
        Json(json!({ "ok": true })).into_response()
    } else {
        (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "ok": false }))).into_response()
    }
}

async fn reset(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    if let Err(denied) = authorized(&app, &headers) {
        return denied;
    }
    // A new server is a new database: new signing key (rotated), no Users,
    // Sessions, tokens or conversations.
    match start_agent().await {
        Ok(agent) => {
            *app.agent.write().await = Some(Arc::new(agent));
            ok(json!({}))
        }
        Err(detail) => adapter_error(StatusCode::INTERNAL_SERVER_ERROR, "reset_failed", detail),
    }
}

async fn step_route(State(app): State<Arc<App>>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    if let Err(denied) = authorized(&app, &headers) {
        return denied;
    }
    let Some(agent) = app.agent.read().await.clone() else {
        return adapter_error(StatusCode::SERVICE_UNAVAILABLE, "starting", "not ready");
    };
    step(&app, &agent, body).await
}

async fn run() {
    let name = std::env::var("INTEROP_NAME").unwrap_or_else(|_| NAME.into());
    let origin = std::env::var("INTEROP_ORIGIN")
        .unwrap_or_else(|_| format!("https://{name}.agent.interop.test"));
    let origin = origin.trim_end_matches('/').to_string();
    let parsed = url::Url::parse(&origin).expect("INTEROP_ORIGIN is a URL");
    let host = match parsed.port() {
        Some(port) => format!("{}:{port}", parsed.host_str().unwrap_or_default()),
        None => parsed.host_str().unwrap_or_default().to_string(),
    };
    // The client_id: {origin}/api/v1/poppy/agent.json. First call wins.
    everruns_server::domains::poppy_agent::configure_public_base_url(&format!("{origin}/api"));
    let app = Arc::new(App {
        scheme: parsed.scheme().to_string(),
        host,
        origin,
        secret: std::env::var("INTEROP_SECRET").ok().filter(|s| !s.is_empty()),
        // The image's pinned upstream commit; INTEROP_COMMIT (the registry's) is
        // what the runner asked for, and should be the same.
        commit: std::env::var("EVERRUNS_COMMIT")
            .or_else(|_| std::env::var("INTEROP_COMMIT"))
            .unwrap_or_else(|_| "unknown".into()),
        client: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("client"),
        agent: RwLock::new(None),
    });
    let control = Router::new()
        .route("/manifest", get(manifest))
        .route("/healthz", get(healthz))
        .route("/reset", post(reset))
        .route("/step", post(step_route))
        .with_state(app.clone());
    let front_router = Router::new().fallback(any(front)).with_state(app.clone());
    let control_listener = tokio::net::TcpListener::bind("0.0.0.0:8081").await.expect("8081");
    let front_listener = tokio::net::TcpListener::bind("0.0.0.0:8080").await.expect("8080");
    tokio::spawn(async move { axum::serve(control_listener, control).await.ok() });
    tokio::spawn(async move { axum::serve(front_listener, front_router).await.ok() });
    match start_agent().await {
        Ok(agent) => {
            eprintln!(
                "everruns personal agent ready: client_id {}",
                everruns_server::domains::poppy_agent::client_id(
                    &everruns_server::domains::poppy_agent::public_base_url()
                )
            );
            *app.agent.write().await = Some(Arc::new(agent));
        }
        Err(error) => panic!("could not start the everruns personal agent: {error}"),
    }
    std::future::pending::<()>().await;
}

/// `interop_adapter serve --ignored --exact`: run until killed.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore]
async fn serve() {
    run().await;
}

/// Build-time warm-up: downloads the embedded PostgreSQL binaries.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore]
async fn warm() {
    let _server = TestServer::in_memory().await;
}
