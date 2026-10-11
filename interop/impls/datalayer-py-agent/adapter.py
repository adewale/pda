"""Interop adapter for Datalayer's Python Personal Agent SDK.

One process, two ports:

- 8080: the agent's public identity at INTEROP_ORIGIN (default
  https://datalayer-py.agent.interop.test): client metadata at /agent.json
  (the client_id), its JWKS at /jwks.json, and the redirect URI
  /oauth/callback.
- 8081: the interop control API (docs/interop-spec.md sections 4, 5.1, 5.2).
  Each `op` calls the SDK's protocol clients directly (DiscoveryClient,
  SessionClient, DirectSignInClient, DeviceSignInClient,
  MediatedSignInClient, ConversationClient, ApiClient, McpClient,
  OperationsClient, AccountTokenClient, BrowserSessionClient). No model.

The host contributions the SDK asks for (signer, DPoP keys, token and state
stores, protected input, browser handoff) are made here, as Reactor
contributions, like the SDK's own demo kit does.

Interop-only setting (off unless INTEROP_ALLOW_TEST_HOSTS=1, which the image
sets): a URL-safety policy that lets discovery fetch *.interop.test hosts on
private addresses; every other host keeps the SDK's default policy.
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import ssl
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

import httpx
import jwt
import uvicorn
from cryptography.hazmat.primitives.asymmetric import ec
from pydantic import SecretStr
from reactor import PluginManifest  # type: ignore[import-untyped]

from personal_agent_protocol import (
    ConversationClient,
    DeviceSignInClient,
    DirectSignInClient,
    DiscoveryClient,
    DpopHttpClient,
    Message,
    SessionClient,
    generate_message_id,
)
from personal_agent_protocol.accounts import AccountTokenClient, AccountTokenContext
from personal_agent_protocol.apis import ApiClient, conversation_endpoint
from personal_agent_protocol.browser import BrowserSessionClient
from personal_agent_protocol.conversations import StreamReconnected, TextDelta
from personal_agent_protocol.crypto import JoseDpopProofProvider, JoseSigner
from personal_agent_protocol.demo.kit import DpopKeys, MemoryVault
from personal_agent_protocol.errors import PersonalAgentProtocolError
from personal_agent_protocol.mcp import McpClient
from personal_agent_protocol.mediated import MediatedSignInClient
from personal_agent_protocol.models import ClientMetadata, DiscoveredCompany, Operation
from personal_agent_protocol.operations import (
    STANDING_PERMISSION_STORES,
    InMemoryStandingPermissionStore,
    OperationsClient,
    approve,
    operations_endpoint,
)
from personal_agent_protocol.reactor import (
    AUTHORIZATION_STATE_STORES,
    BROWSER_FORM_POSTS,
    BROWSER_HANDOFFS,
    DPOP_PROOF_PROVIDERS,
    PROTECTED_INPUTS,
    SIGNERS,
    TOKEN_STORES,
    URL_SAFETY_POLICIES,
    ProtectedInputRequest,
    PublicUrlSafetyPolicy,
    build_pap_reactor,
    resolve_addresses,
)
from personal_agent_protocol.sessions import SessionToken, generate_pairwise_user_id

NAME = os.environ.get("INTEROP_NAME", "datalayer-py")
ORIGIN = os.environ.get("INTEROP_ORIGIN", f"https://{NAME}.agent.interop.test").rstrip("/")
DOMAIN = urlsplit(ORIGIN).hostname or ""
SECRET = os.environ.get("INTEROP_SECRET", "")
COMMIT = os.environ.get("UPSTREAM_COMMIT", "unknown")
ALLOW_TEST_HOSTS = os.environ.get("INTEROP_ALLOW_TEST_HOSTS") == "1"
CA_FILE = os.environ.get("SSL_CERT_FILE") or "/interop/ca.pem"
TENANT = "interop"

OPS = [
    "discover", "session", "signin", "signin_continue", "send", "read", "sse",
    "api", "web_join", "approve_op", "signout", "state",
]

MANIFEST = {
    "interop": 1,
    "name": NAME,
    "role": "agent",
    "commit": COMMIT,
    "poppy": ["0.1"],
    "extensions": ["operations"],
    "scenarios": [
        "D", "S0", "N", "SD", "SV", "SM", "SX", "SO",
        "C", "CI", "CS", "CA", "AO", "AM", "AS", "W", "O", "O2", "OX",
    ],
    "readings": {"S1": "token-endpoint", "S2": "jwt-60s", "S3": "insertion", "S4": "omit"},
    "relaxations": [
        "INTEROP_ALLOW_TEST_HOSTS=1: a Reactor URL-safety contribution (adapter, not a patch) "
        "lets discovery and metadata fetches reach *.interop.test hosts on private addresses; "
        "other hosts keep the SDK's public-address policy",
        "Trusts the per-run CA at /interop/ca.pem (the adapter builds the httpx client the SDK "
        "is given)",
    ],
}


# Host contributions -------------------------------------------------------------------


class InteropUrlPolicy:
    """The SDK's own policy, with private addresses allowed for *.interop.test only."""

    def __init__(self) -> None:
        self.public = PublicUrlSafetyPolicy(resolve_addresses)
        self.relaxed = PublicUrlSafetyPolicy(resolve_addresses, allow_private_networks=True)

    async def assert_safe(self, url: str):  # type: ignore[no-untyped-def]
        host = (urlsplit(url).hostname or "").lower()
        if host.endswith(".interop.test"):
            return await self.relaxed.assert_safe(url)
        return await self.public.assert_safe(url)


class RecordingBrowser:
    """The user's browser: remembers the authorization URL for the runner to consent at."""

    def __init__(self) -> None:
        self.opened: str | None = None

    async def open(self, authorization_url: SecretStr) -> None:
        self.opened = authorization_url.get_secret_value()


class FormPoster:
    """The agent's own browser for a browser Session: one form POST, redirects not followed."""

    def __init__(self, http: httpx.AsyncClient) -> None:
        self.http = http
        self.last: httpx.Response | None = None

    async def post(self, endpoint: str, fields: dict[str, SecretStr]) -> None:
        self.last = await self.http.post(
            endpoint,
            data={name: value.get_secret_value() for name, value in fields.items()},
            follow_redirects=False,
        )


class QueuedInput:
    """The user's protected input: answers the runner supplied in `signin_continue`."""

    def __init__(self) -> None:
        self.answers: list[dict[str, str]] = []

    async def collect(self, request: ProtectedInputRequest) -> dict[str, SecretStr]:
        if not self.answers:
            raise PersonalAgentProtocolError("input_missing", "no fields supplied for this step")
        return {name: SecretStr(str(value)) for name, value in self.answers.pop(0).items()}


@dataclass(eq=False)
class Host:
    signer: JoseSigner
    vault: MemoryVault
    browser: RecordingBrowser
    poster: FormPoster
    protected_input: QueuedInput

    def provide_contributions(self, contributions: object) -> None:
        contribute = contributions.contribute  # type: ignore[attr-defined]
        contribute(SIGNERS, self.signer, contribution_id="agent-key")
        contribute(DPOP_PROOF_PROVIDERS, JoseDpopProofProvider(DpopKeys()), contribution_id="dpop")
        contribute(TOKEN_STORES, self.vault, contribution_id="vault")
        contribute(AUTHORIZATION_STATE_STORES, self.vault, contribution_id="vault")
        contribute(PROTECTED_INPUTS, self.protected_input, contribution_id="input")
        contribute(
            STANDING_PERMISSION_STORES, InMemoryStandingPermissionStore(), contribution_id="standing"
        )
        contribute(BROWSER_HANDOFFS, self.browser, contribution_id="browser")
        contribute(BROWSER_FORM_POSTS, self.poster, contribution_id="own-browser")
        if ALLOW_TEST_HOSTS:
            contribute(
                URL_SAFETY_POLICIES, InteropUrlPolicy(), contribution_id="interop-test-hosts", order=0
            )


def http_client() -> httpx.AsyncClient:
    verify: Any = True
    if os.path.exists(CA_FILE):
        verify = ssl.create_default_context(cafile=CA_FILE)
    return httpx.AsyncClient(verify=verify, timeout=30.0, follow_redirects=False)


# State --------------------------------------------------------------------------------


@dataclass
class SessionState:
    pairwise: str
    token: SessionToken | None = None
    account_reference: str | None = None
    pending: dict[str, Any] | None = None


@dataclass
class CompanyState:
    company: DiscoveredCompany
    sessions: dict[str, SessionState] = field(default_factory=dict)
    cursors: dict[str, str] = field(default_factory=dict)
    conversation_labels: dict[str, str] = field(default_factory=dict)
    operations: dict[str, tuple[Operation, str]] = field(default_factory=dict)


class Agent:
    """Everything a reset forgets, including the signing key (rotated on reset)."""

    def __init__(self) -> None:
        self.kid = f"key-{int(time.time())}-{secrets.token_hex(4)}"
        self.private_key = ec.generate_private_key(ec.SECP256R1())
        self.http = http_client()
        self.browser = RecordingBrowser()
        self.poster = FormPoster(http_client())
        self.input = QueuedInput()
        self.host = Host(
            JoseSigner(self.private_key, algorithm="ES256", key_id=self.kid),
            MemoryVault(),
            self.browser,
            self.poster,
            self.input,
        )
        self.reactor, _ = build_pap_reactor(
            http_client=self.http,
            plugins=[(PluginManifest(name=f"{NAME}-host", version="1"), self.host)],
        )
        self.transport = DpopHttpClient(reactor=self.reactor, http_client=self.http)
        self.companies: dict[str, CompanyState] = {}

    @property
    def client_id(self) -> str:
        return f"{ORIGIN}/agent.json"

    @property
    def redirect_uri(self) -> str:
        return f"{ORIGIN}/oauth/callback"

    @property
    def jwks(self) -> dict[str, Any]:
        public = json.loads(jwt.algorithms.ECAlgorithm.to_jwk(self.private_key.public_key()))
        return {"keys": [{**public, "kid": self.kid, "use": "sig", "alg": "ES256"}]}

    @property
    def metadata(self) -> dict[str, Any]:
        return {
            "client_id": self.client_id,
            "client_name": "Datalayer Python agent (interop)",
            "jwks_uri": f"{ORIGIN}/jwks.json",
            "redirect_uris": [self.redirect_uri],
            "token_endpoint_auth_method": "private_key_jwt",
            "extensions": {"operations": {"version": "1"}},
        }

    async def aclose(self) -> None:
        await self.http.aclose()
        await self.poster.http.aclose()


agent = Agent()


class StepError(Exception):
    def __init__(self, status: int, error: str, detail: str = "") -> None:
        super().__init__(detail)
        self.status, self.error, self.detail = status, error, detail


class PoppyRefusal(Exception):
    """A Poppy error from the Company that the SDK reports without an HTTP status."""

    def __init__(self, code: str, status: int | None, detail: str = "") -> None:
        super().__init__(detail)
        self.code, self.status, self.detail = code, status, detail


# Ops ----------------------------------------------------------------------------------


async def company_state(host: str) -> CompanyState:
    state = agent.companies.get(host)
    if state is None:
        company = await DiscoveryClient(reactor=agent.reactor, http_client=agent.http).discover(host)
        state = agent.companies[host] = CompanyState(company)
    return state


def who(state: CompanyState, session: SessionState) -> dict[str, str]:
    issuer = state.company.oauth_metadata.issuer if state.company.oauth_metadata else ""
    return {"tenant_id": TENANT, "pairwise_user_id": session.pairwise, "issuer": issuer}


def session_of(state: CompanyState, label: str | None, *, create: bool = False) -> SessionState:
    key = label or "default"
    session = state.sessions.get(key)
    if session is None:
        if not create:
            raise StepError(409, "no_session", f"no Session labelled {key}")
        session = state.sessions[key] = SessionState(generate_pairwise_user_id())
    return session


async def start_session(state: CompanyState, session: SessionState) -> SessionToken:
    metadata = state.company.oauth_metadata
    if metadata is None:
        raise StepError(409, "no_auth", "the Company publishes no auth")
    session.token = await SessionClient(reactor=agent.reactor, http_client=agent.http).start(
        client_id=agent.client_id,
        pairwise_user_id=session.pairwise,
        issuer=metadata.issuer,
        token_endpoint=metadata.token_endpoint,
        tenant_id=TENANT,
    )
    session.account_reference = None
    return session.token


async def token_for(state: CompanyState, label: str | None) -> tuple[SessionState, SessionToken]:
    session = session_of(state, label, create=True)
    if session.token is None:
        await start_session(state, session)
    assert session.token is not None
    return session, session.token


def account_context(state: CompanyState, session: SessionState) -> AccountTokenContext:
    metadata = state.company.oauth_metadata
    assert metadata is not None
    return AccountTokenContext(
        token_endpoint=metadata.token_endpoint,
        revocation_endpoint=metadata.revocation_endpoint,
        issuer=metadata.issuer,
        client_id=agent.client_id,
        tenant_id=TENANT,
        pairwise_user_id=session.pairwise,
    )


def signed_in(session: SessionState) -> dict[str, Any]:
    token = session.token
    assert token is not None
    return {"signed_in": token.signed_in, "account": None, "scope": token.scope}


def message_view(state: CompanyState, label: str, event: Any) -> dict[str, Any]:
    message = event.message
    view: dict[str, Any] = {"role": message.role, "text": message.text, "id": message.id}
    if message.data is not None:
        view["data"] = message.data
    if message.operation is not None:
        state.operations[message.operation.operation_id] = (message.operation, label)
        view["operation"] = message.operation.model_dump(mode="json", exclude_none=True)
    return view


def page_view(state: CompanyState, label: str, events: list[Any]) -> dict[str, Any]:
    messages = [message_view(state, label, e) for e in events if e.message is not None]
    summary = [
        {
            k: v
            for k, v in {
                "id": e.id,
                "type": e.type,
                "error": e.error,
                "scope": e.scope,
                "status": e.status,
            }.items()
            if v is not None
        }
        for e in events
    ]
    return {"messages": messages, "events": summary}


async def op_discover(host: str, params: dict[str, Any]) -> dict[str, Any]:
    agent.companies.pop(host, None)
    state = await company_state(host)
    document = state.company.document
    return {
        "issuer": state.company.oauth_metadata.issuer if state.company.oauth_metadata else None,
        "poppy_version": document.protocol_version,
        "conversations": conversation_endpoint(document) is not None,
        "apis": [api.url for api in document.apis],
        "api_types": [api.type for api in document.apis],
    }


async def op_session(host: str, params: dict[str, Any]) -> dict[str, Any]:
    state = await company_state(host)
    session = session_of(state, params.get("label"), create=True)
    token = await start_session(state, session)
    return {"session_id": token.session_id, "signed_in": token.signed_in, "scope": token.scope}


async def op_signin(host: str, params: dict[str, Any]) -> dict[str, Any]:  # noqa: C901
    state = await company_state(host)
    session, token = await token_for(state, params.get("label"))
    document, metadata = state.company.document, state.company.oauth_metadata
    method = params.get("method", "direct")
    auth = document.auth
    if auth is None or metadata is None:
        raise StepError(409, "no_auth", "the Company publishes no auth")
    declared = getattr(auth, method, None)
    if declared is None:
        raise StepError(409, "method_not_offered", f"the Company offers no {method} sign-in")
    scopes = tuple(params.get("scopes") or getattr(declared, "scopes", None) or ())
    if method == "direct":
        agent.browser.opened = None
        await DirectSignInClient(reactor=agent.reactor, http_client=agent.http).begin(
            authorization_endpoint=metadata.authorization_endpoint,  # type: ignore[arg-type]
            token_endpoint=metadata.token_endpoint,
            issuer=metadata.issuer,
            client_id=agent.client_id,
            redirect_uri=agent.redirect_uri,
            scopes=scopes,
            tenant_id=TENANT,
            pairwise_user_id=session.pairwise,
            session_id=token.session_id,
        )
        session.pending = {"method": "direct"}
        return {"pending": {"url": agent.browser.opened}}
    if method == "device":
        started = await DeviceSignInClient(reactor=agent.reactor, http_client=agent.http).begin(
            device_authorization_endpoint=metadata.device_authorization_endpoint,  # type: ignore[arg-type]
            token_endpoint=metadata.token_endpoint,
            issuer=metadata.issuer,
            client_id=agent.client_id,
            scopes=scopes,
            tenant_id=TENANT,
            pairwise_user_id=session.pairwise,
            session_id=token.session_id,
        )
        session.pending = {"method": "device", "reference": started.reference}
        return {
            "pending": {
                "url": started.verification_uri_complete or started.verification_uri,
                "user_code": started.user_code,
            }
        }
    if method == "mediated":
        session.pending = {"method": "mediated", "scopes": scopes, "reference": None}
        return {"pending": {"fields": [f.name for f in auth.mediated.fields]}}  # type: ignore[union-attr]
    raise StepError(400, "unknown_method", str(method))


async def op_signin_continue(host: str, params: dict[str, Any]) -> dict[str, Any]:  # noqa: C901
    state = await company_state(host)
    session = session_of(state, params.get("label"))
    pending = session.pending or {}
    method = pending.get("method")
    if method == "direct":
        try:
            result = await DirectSignInClient(
                reactor=agent.reactor, http_client=agent.http
            ).complete(str(params.get("callback_url", "")))
        except PersonalAgentProtocolError as error:
            if error.code == "authorization_denied":
                # The Company's error came on the redirect (error=access_denied), not in a
                # response to the agent, so there is no HTTP status to report.
                session.pending = None
                raise PoppyRefusal("access_denied", None, error.message) from error
            raise
        session.pending = None
        session.token, session.account_reference = result.token, result.account_token_reference
        return signed_in(session)
    if method == "device":
        device = DeviceSignInClient(reactor=agent.reactor, http_client=agent.http)
        deadline = time.monotonic() + float(params.get("timeout", 90))
        while True:
            poll = await device.poll(pending["reference"])
            if poll.status == "complete":
                session.pending = None
                session.token, session.account_reference = poll.token, poll.account_token_reference
                return signed_in(session)
            wait = max(0.2, (poll.retry_at.timestamp() - time.time()) if poll.retry_at else 1.0)
            if time.monotonic() + wait > deadline:
                raise StepError(504, "device_pending", "the user has not approved yet")
            await asyncio.sleep(wait)
    if method == "mediated":
        auth = state.company.document.auth
        assert auth is not None and auth.mediated is not None and session.token is not None
        mediated = MediatedSignInClient(reactor=agent.reactor, http_client=agent.http)
        fields = params.get("fields") or {}
        agent.input.answers = [dict(fields)]
        if pending.get("reference") is None:
            result = await mediated.sign_in(
                mediated=auth.mediated,
                organization=state.company.document.organization,
                issuer=auth.issuer,
                scopes=tuple(pending.get("scopes") or ()),
                token=session.token,
                **{k: v for k, v in who(state, session).items() if k != "issuer"},
            )
        else:
            result = await mediated.submit_code(
                pending["reference"], token=session.token, **who(state, session)
            )
        if result.status == "code_required":
            pending["reference"] = result.reference
            return {"pending": {"fields": ["code"], "sent_to": result.sent_to}}
        if result.status != "complete":
            session.pending = None
            return {"signed_in": False, "status": result.status}
        session.pending = None
        session.token, session.account_reference = result.token, result.account_token_reference
        return signed_in(session)
    raise StepError(409, "nothing_pending", "no sign-in is pending for this Session")


def conversations_url(state: CompanyState) -> str:
    endpoint = conversation_endpoint(state.company.document)
    if endpoint is None:
        raise StepError(409, "no_conversations", "the Company offers no conversation endpoint")
    return endpoint


async def op_send(host: str, params: dict[str, Any]) -> dict[str, Any]:
    state = await company_state(host)
    endpoint = conversations_url(state)
    conversation = params.get("conversation")
    label = params.get("label") or (
        state.conversation_labels.get(conversation, "default") if conversation else "default"
    )
    session, token = await token_for(state, label)
    message = Message(
        id=params.get("message_id") or generate_message_id(agent.reactor),
        sender=params.get("sender", "agent"),
        text=params.get("text"),
        data=params.get("data"),
        context=params.get("context"),
    )
    wait = int(params.get("wait", 5))
    client = ConversationClient(transport=agent.transport)
    if conversation is None:
        response = await client.start(endpoint, message, token=token, wait=wait, **who(state, session))
    else:
        response = await client.send(
            endpoint,
            conversation,
            message,
            token=token,
            cursor=state.cursors.get(conversation),
            wait=wait,
            **who(state, session),
        )
    conversation = response.conversation_id
    state.conversation_labels[conversation] = label
    events = getattr(response, "events", None)
    if events is None:
        page = await client.read_events(
            endpoint, conversation, token=token, cursor=state.cursors.get(conversation), wait=wait,
            **who(state, session),
        )
        events, status, cursor = page.events, page.status, page.cursor
    else:
        status, cursor = response.status, response.cursor  # type: ignore[union-attr]
    state.cursors[conversation] = cursor
    return {
        "conversation": conversation,
        "message_id": message.id,
        "status": status,
        **page_view(state, label, events),
    }


async def op_read(host: str, params: dict[str, Any]) -> dict[str, Any]:
    state = await company_state(host)
    conversation = str(params.get("conversation", ""))
    label = params.get("label") or state.conversation_labels.get(conversation, "default")
    session, token = await token_for(state, label)
    page = await ConversationClient(transport=agent.transport).read_events(
        conversations_url(state),
        conversation,
        token=token,
        cursor=params.get("cursor"),
        wait=int(params["wait"]) if "wait" in params else None,
        **who(state, session),
    )
    state.cursors[conversation] = page.cursor
    return {
        "cursor": page.cursor,
        "has_more": page.has_more,
        "status": page.status,
        **page_view(state, label, page.events),
    }


async def op_sse(host: str, params: dict[str, Any]) -> dict[str, Any]:
    state = await company_state(host)
    conversation = str(params.get("conversation", ""))
    label = params.get("label") or state.conversation_labels.get(conversation, "default")
    session, token = await token_for(state, label)
    limit = int(params.get("max_events", 10))
    collected: list[dict[str, Any]] = []

    async def collect() -> None:
        stream = ConversationClient(transport=agent.transport).stream(
            conversations_url(state),
            conversation,
            token=token,
            last_event_id=params.get("cursor"),
            max_reconnects=int(params.get("max_reconnects", 2)),
            **who(state, session),
        )
        async for item in stream:
            if isinstance(item, StreamReconnected):
                collected.append({"id": item.last_event_id, "type": "reconnected", "data": {}})
                continue
            if isinstance(item, TextDelta):
                collected.append({"id": None, "type": "text-delta", "data": item.model_dump(mode="json")})
            else:
                data = item.model_dump(mode="json", exclude_none=True)
                collected.append({"id": item.id, "type": item.type, "data": data})
            if sum(1 for c in collected if c["type"] != "reconnected") >= limit:
                return

    try:
        await asyncio.wait_for(collect(), float(params.get("timeout", 15)))
    except asyncio.TimeoutError:
        pass
    return {"events": collected}


def find_api(state: CompanyState, api: str, kind: str) -> str:
    for descriptor in state.company.document.apis:
        if api in (descriptor.url, descriptor.type) and descriptor.type == kind:
            return descriptor.url
    raise StepError(404, "unknown_api", api)


HTTP_METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE")


async def resolve_operation(
    description: str, operation: str, args: dict[str, Any]
) -> tuple[str, str, Any]:
    """`operation` is "METHOD /path" or an OpenAPI operationId; `args` fill path and query
    parameters by name, and `args["body"]` (or, for a write, the remaining args) is the body.
    URLs are relative to the description's origin (the SDK has no OpenAPI loader)."""

    parts = urlsplit(description)
    origin = f"{parts.scheme}://{parts.netloc}"
    args = dict(args or {})
    verb, _, path = operation.partition(" ")
    parameters: list[dict[str, Any]] = []
    has_body = False
    if verb.upper() not in HTTP_METHODS or not path:
        response = await agent.http.get(description, headers={"Accept": "application/json"})
        if response.status_code != 200:
            raise StepError(502, "openapi_unavailable", f"{description}: {response.status_code}")
        found = None
        for candidate, item in (response.json().get("paths") or {}).items():
            for name, spec in item.items():
                if isinstance(spec, dict) and spec.get("operationId") == operation:
                    found = (name.upper(), candidate, spec, item)
        if found is None:
            raise StepError(404, "unknown_operation", operation)
        verb, path, spec, item = found
        parameters = [*item.get("parameters", []), *spec.get("parameters", [])]
        has_body = "requestBody" in spec
    verb = verb.upper()
    query: dict[str, str] = {}
    for parameter in parameters:
        name = parameter.get("name")
        if name in args and parameter.get("in") == "query":
            query[name] = str(args.pop(name))
    for name in list(args):
        if "{" + name + "}" in path:
            path = path.replace("{" + name + "}", str(args.pop(name)))
    url = path if path.startswith("https://") else f"{origin}{path}"
    if query:
        url += "?" + "&".join(f"{k}={v}" for k, v in query.items())
    body = args.pop("body", None)
    if body is None and verb != "GET" and (has_body or args):
        body = args or {}
    return verb, url, body


async def op_api(host: str, params: dict[str, Any]) -> dict[str, Any]:  # noqa: C901
    state = await company_state(host)
    label = params.get("label") or "default"
    session, token = await token_for(state, label)
    api = str(params.get("api", ""))
    args = params.get("args") or {}
    if "tool" in params:
        url = find_api(state, api, "mcp")
        metadata = state.company.oauth_metadata
        assert metadata is not None
        if session.account_reference is not None:
            refreshed = await AccountTokenClient(
                reactor=agent.reactor, http_client=agent.http
            ).bearer_for_mcp(
                session.account_reference,
                context=account_context(state, session),
                session_id=token.session_id,
                resource=url,
            )
            if refreshed.token is None:
                raise StepError(409, refreshed.status, "no Bearer token for the MCP server")
            bearer = refreshed.token
        else:
            bearer = await SessionClient(reactor=agent.reactor, http_client=agent.http).bearer_for_mcp(
                client_id=agent.client_id,
                pairwise_user_id=session.pairwise,
                issuer=metadata.issuer,
                token_endpoint=metadata.token_endpoint,
                tenant_id=TENANT,
                session_id=token.session_id,
                resource=url,
            )
        result = await McpClient(http_client=agent.http, token=bearer, url=url).call_tool(
            str(params["tool"]), args
        )
        body = result.model_dump(mode="json", exclude_none=True)
        if result.operation is not None:
            state.operations[result.operation.operation_id] = (result.operation, label)
        return {"status": 200, "body": body}
    description = find_api(state, api, "openapi")
    method, url, body = await resolve_operation(description, str(params.get("operation", "")), args)
    response = await ApiClient(transport=agent.transport).call(
        method, url, token=token, body=body, **who(state, session)
    )
    if response.operation is not None:
        state.operations[response.operation.operation_id] = (response.operation, label)
        return {"status": response.status, "body": {"operation": response.operation.model_dump(mode="json", exclude_none=True)}}
    return {"status": response.status, "body": response.body}


async def op_approve_op(host: str, params: dict[str, Any]) -> dict[str, Any]:
    state = await company_state(host)
    operation_id = str(params.get("operation", ""))
    known = state.operations.get(operation_id)
    label = known[1] if known else (params.get("label") or "default")
    session, token = await token_for(state, label)
    endpoint = operations_endpoint(
        state.company.document, ClientMetadata.model_validate(agent.metadata)
    )
    if endpoint is None:
        raise StepError(409, "no_operations", "the Operations extension was not negotiated")
    client = OperationsClient(transport=agent.transport)
    operation = known[0] if known else await client.read(
        endpoint, operation_id, token=token, **who(state, session)
    )
    if params.get("decision", "approve") == "decline":
        cancelled = await client.cancel(endpoint, operation_id, token=token, **who(state, session))
        return {"status": "cancelled", "state": cancelled.state}
    outcome = await client.confirm(
        endpoint, operation, approval=approve(operation), token=token, **who(state, session)
    )
    result: dict[str, Any] = {"status": outcome.status}
    if outcome.operation is not None:
        result["state"] = outcome.operation.state
        result["operation"] = outcome.operation.model_dump(mode="json", exclude_none=True)
    return result


async def op_signout(host: str, params: dict[str, Any]) -> dict[str, Any]:
    state = await company_state(host)
    session = session_of(state, params.get("label"))
    if session.account_reference is None:
        return {"revoked": False}
    revoked = await AccountTokenClient(reactor=agent.reactor, http_client=agent.http).revoke(
        session.account_reference, context=account_context(state, session)
    )
    if revoked.revoked:
        session.account_reference = None
        if session.token is not None:
            # The Company signs the Session out (§4.9); the SDK keeps no local view of that.
            session.token = session.token.model_copy(update={"signed_in": False, "scope": ""})
    return {"revoked": revoked.revoked}


async def op_web_join(host: str, params: dict[str, Any]) -> dict[str, Any]:
    state = await company_state(host)
    session, token = await token_for(state, params.get("label"))
    web = state.company.document.web
    endpoint = getattr(web, "browser_session_endpoint", None) if web is not None else None
    if not endpoint:
        raise StepError(409, "no_browser_sessions", "the Company declares no browser_session_endpoint")
    await BrowserSessionClient(reactor=agent.reactor).join(
        client_id=agent.client_id,
        pairwise_user_id=session.pairwise,
        browser_session_endpoint=endpoint,
        session_id=token.session_id,
        return_to=str(params.get("url") or f"https://{state.company.document.organization.domain}/"),
        company_domain=state.company.document.organization.domain,
    )
    last = agent.poster.last
    joined = last is not None and last.status_code in (302, 303) and "set-cookie" in last.headers
    return {
        "joined": joined,
        "status": None if last is None else last.status_code,
        "location": None if last is None else last.headers.get("location"),
    }


async def op_state(host: str, params: dict[str, Any]) -> dict[str, Any]:
    sessions, accounts = [], []
    for name, state in agent.companies.items():
        for label, session in state.sessions.items():
            token = session.token
            sessions.append(
                {
                    "company": name,
                    "label": label,
                    "session_id": token.session_id if token else None,
                    "signed_in": bool(token and token.signed_in),
                    "scope": token.scope if token else None,
                }
            )
            if session.account_reference is not None:
                accounts.append({"company": name, "label": label})
    return {"sessions": sessions, "accounts": accounts}


HANDLERS = {
    "discover": op_discover,
    "session": op_session,
    "signin": op_signin,
    "signin_continue": op_signin_continue,
    "send": op_send,
    "read": op_read,
    "sse": op_sse,
    "api": op_api,
    "approve_op": op_approve_op,
    "signout": op_signout,
    "web_join": op_web_join,
    "state": op_state,
}


# HTTP ---------------------------------------------------------------------------------


async def lifespan(receive: Any, send: Any) -> None:
    while (message := await receive())["type"] != "lifespan.shutdown":
        if message["type"] == "lifespan.startup":
            await send({"type": "lifespan.startup.complete"})
    await send({"type": "lifespan.shutdown.complete"})


async def respond(
    send: Any, status: int, body: object, content_type: str = "application/json",
    extra: list[tuple[bytes, bytes]] | None = None,
) -> None:
    payload = body.encode() if isinstance(body, str) else json.dumps(body).encode()
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [(b"content-type", content_type.encode()), *(extra or [])],
        }
    )
    await send({"type": "http.response.body", "body": payload})


async def website(scope: dict[str, Any], receive: Any, send: Any) -> None:
    """The agent's public identity documents and redirect URI."""

    if scope["type"] == "lifespan":
        await lifespan(receive, send)
        return
    if scope["type"] != "http":
        return
    path = scope["path"]
    no_store = [(b"cache-control", b"no-store")]
    if path == "/agent.json":
        await respond(send, 200, agent.metadata, extra=no_store)
    elif path == "/jwks.json":
        await respond(send, 200, agent.jwks, extra=no_store)
    elif path == "/oauth/callback":
        await respond(send, 200, "<!doctype html><title>Signed in</title>You can close this page.",
                      "text/html; charset=utf-8", no_store)
    else:
        await respond(send, 404, {"error": "not_found"})


async def control(scope: dict[str, Any], receive: Any, send: Any) -> None:  # noqa: C901
    global agent
    if scope["type"] == "lifespan":
        await lifespan(receive, send)
        return
    if scope["type"] != "http":
        return
    body = b""
    while True:
        message = await receive()
        body += message.get("body", b"")
        if not message.get("more_body"):
            break
    method, path = scope["method"], scope["path"]
    if method == "GET" and path == "/manifest":
        await respond(send, 200, MANIFEST)
        return
    if method == "GET" and path == "/healthz":
        await respond(send, 200, {"ok": True})
        return
    headers = {k.decode().lower(): v.decode() for k, v in scope["headers"]}
    if not SECRET or headers.get("authorization") != f"Bearer {SECRET}":
        await respond(send, 401, {"error": "unauthorized", "detail": "Bearer INTEROP_SECRET"})
        return
    if method == "POST" and path == "/reset":
        await agent.aclose()
        agent = Agent()
        await respond(send, 200, {"ok": True, "result": {"kid": agent.kid}})
        return
    if not (method == "POST" and path == "/step"):
        await respond(send, 404, {"error": "not_found", "detail": path})
        return
    try:
        request = json.loads(body)
        op, host, params = request["op"], str(request.get("company", "")).lower(), request.get("params") or {}
    except (ValueError, KeyError, TypeError):
        await respond(send, 400, {"error": "invalid_request", "detail": "{op, company, params}"})
        return
    handler = HANDLERS.get(op)
    if handler is None:
        await respond(send, 501, {"error": "unsupported", "detail": op})
        return
    try:
        result = await handler(host, params)
    except StepError as error:
        await respond(send, error.status, {"error": error.error, "detail": error.detail})
        return
    except PoppyRefusal as refusal:
        await respond(
            send, 200,
            {"ok": False, "poppy_error": refusal.code, "status": refusal.status, "detail": refusal.detail},
        )
        return
    except PersonalAgentProtocolError as error:
        status = error.status_code
        if status is not None and status >= 400:
            # The Company refused: a Poppy error, not an adapter failure.
            code = "access_denied" if error.code == "authorization_denied" else error.code
            await respond(
                send, 200,
                {"ok": False, "poppy_error": code, "status": status, "detail": error.message,
                 **({"details": error.details} if error.details else {})},
            )
        else:
            # The SDK refused what the Company sent (or never reached it).
            await respond(send, 422, {"error": error.code, "detail": error.message})
        return
    except Exception as error:  # noqa: BLE001 - the adapter reports, never crashes
        await respond(send, 500, {"error": "adapter_error", "detail": repr(error)})
        return
    await respond(send, 200, {"ok": True, "result": result})


async def main() -> None:
    servers = [
        uvicorn.Server(uvicorn.Config(website, host="0.0.0.0", port=8080, log_level="warning")),  # noqa: S104
        uvicorn.Server(uvicorn.Config(control, host="0.0.0.0", port=8081, log_level="warning")),  # noqa: S104
    ]
    await asyncio.gather(*(server.serve() for server in servers))


if __name__ == "__main__":
    asyncio.run(main())
