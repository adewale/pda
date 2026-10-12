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
from urllib.parse import quote, urlencode, urljoin, urlsplit

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
_DOMAIN = os.environ.get("INTEROP_DOMAIN") or f"{NAME}.agent.interop.test"
ORIGIN = os.environ.get("INTEROP_ORIGIN", f"https://{_DOMAIN}").rstrip("/")
DOMAIN = urlsplit(ORIGIN).hostname or ""
SECRET = os.environ.get("INTEROP_SECRET", "")
COMMIT = os.environ.get("INTEROP_COMMIT") or os.environ.get("UPSTREAM_COMMIT", "unknown")
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
        "D", "S0", "N", "SD", "SV", "SVN", "SM", "SMC", "SX", "SXV", "R", "SE", "SO",
        "C", "CI", "CS", "CA", "AO", "AM", "AS", "RL", "O", "OX",
    ],
    "readings": {"S1": "endpoint", "S2": "jwt-60s", "S3": "insertion", "S4": "omit"},
    "relaxations": [
        "INTEROP_ALLOW_TEST_HOSTS=1: a Reactor URL-safety contribution (adapter, not a patch) "
        "lets discovery and metadata fetches reach *.interop.test hosts on private addresses; "
        "other hosts keep the SDK's public-address policy",
        "Trusts the per-run CA at /interop/ca.pem (the adapter builds the httpx client the SDK "
        "is given)",
    ],
    "notes": [
        "Host policy in the adapter, not the SDK (which has none): on 401 invalid_token or "
        "invalid_session it renews the Session (Account Token refresh when signed in, else the "
        "assertion), starting a new Session if the old one is gone, and retries once; signin "
        "with a held Account Token refreshes it into the Session instead of a new sign-in",
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
    #: The runner's retry keys (`send` `message_id`) and the Message each one sent.
    messages: dict[str, Message] = field(default_factory=dict)


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
    """An adapter failure (bad params, nothing to continue): not the Company's doing."""

    def __init__(self, status: int, error: str, detail: str = "") -> None:
        super().__init__(detail)
        self.status, self.error, self.detail = status, error, detail


class PoppyRefusal(Exception):
    """A Poppy error: the Company's (with its HTTP status) or the agent's own (status 0)."""

    def __init__(self, code: str, status: int, detail: str = "") -> None:
        super().__init__(detail)
        self.code, self.status, self.detail = code, status, detail


# Ops ----------------------------------------------------------------------------------


async def company_state(host: str) -> CompanyState:
    state = agent.companies.get(host)
    if state is None:
        try:
            company = await DiscoveryClient(reactor=agent.reactor, http_client=agent.http).discover(
                host
            )
        except PersonalAgentProtocolError as error:
            # The agent won't use what the Company published (spec 5.2: discovery_failed).
            raise PoppyRefusal(
                "discovery_failed", 0, f"{error.code}: {error.message}"
            ) from error
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


def metadata_of(state: CompanyState):  # type: ignore[no-untyped-def]
    metadata = state.company.oauth_metadata
    if metadata is None:
        raise PoppyRefusal("no_auth", 0, "the Company publishes no auth")
    return metadata


async def start_session(state: CompanyState, session: SessionState) -> SessionToken:
    metadata = metadata_of(state)
    session.token = await SessionClient(reactor=agent.reactor, http_client=agent.http).start(
        client_id=agent.client_id,
        pairwise_user_id=session.pairwise,
        issuer=metadata.issuer,
        token_endpoint=metadata.token_endpoint,
        tenant_id=TENANT,
    )
    return session.token


async def renew_signed_out(state: CompanyState, session: SessionState) -> SessionToken:
    """Renew with the assertion, keeping the Session ID; a new Session if it is gone."""

    metadata = metadata_of(state)
    assert session.token is not None
    try:
        session.token = await SessionClient(reactor=agent.reactor, http_client=agent.http).renew(
            client_id=agent.client_id,
            pairwise_user_id=session.pairwise,
            issuer=metadata.issuer,
            token_endpoint=metadata.token_endpoint,
            tenant_id=TENANT,
            session_id=session.token.session_id,
        )
    except PersonalAgentProtocolError as error:
        if error.code != "invalid_session":
            raise
        await start_session(state, session)
    assert session.token is not None
    return session.token


async def refresh_into(state: CompanyState, session: SessionState) -> bool:
    """Sign the Session in with the Account Token held for it; a new Session if it is gone."""

    assert session.account_reference is not None and session.token is not None
    accounts = AccountTokenClient(reactor=agent.reactor, http_client=agent.http)
    for _ in range(2):
        try:
            result = await accounts.refresh(
                session.account_reference,
                context=account_context(state, session),
                session_id=session.token.session_id,
            )
        except PersonalAgentProtocolError as error:
            if error.code != "invalid_session":
                raise
            await start_session(state, session)
            continue
        if result.status == "signed_in" and result.token is not None:
            session.token = result.token
            return True
        session.account_reference = None
        return False
    return False


async def recover(state: CompanyState, session: SessionState) -> None:
    """Host policy after 401 invalid_token or invalid_session: renew, or start again."""

    if session.token is None:
        await start_session(state, session)
    elif session.account_reference is not None:
        if not await refresh_into(state, session):
            await renew_signed_out(state, session)
    else:
        await renew_signed_out(state, session)


RECOVERABLE = {"invalid_token", "invalid_session"}


async def with_session(state: CompanyState, label: str | None, call):  # type: ignore[no-untyped-def]
    """Run `call(session, token)`, recovering once from an ended or expired Session."""

    session = session_of(state, label, create=True)
    if session.token is None:
        await start_session(state, session)
    try:
        return await call(session, session.token)
    except PersonalAgentProtocolError as error:
        if error.code not in RECOVERABLE:
            raise
    await recover(state, session)
    return await call(session, session.token)


def account_context(state: CompanyState, session: SessionState) -> AccountTokenContext:
    metadata = metadata_of(state)
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
    return {
        "signed_in": token.signed_in,
        "account": None,
        "scope": token.scope,
        "session_id": token.session_id,
    }


def message_view(state: CompanyState, label: str, event: Any) -> dict[str, Any]:
    message = event.message
    view: dict[str, Any] = {"role": message.role, "text": message.text, "id": message.id}
    if message.data is not None:
        view["data"] = message.data
    if message.operation is not None:
        state.operations[message.operation.operation_id] = (message.operation, label)
        view["operation"] = message.operation.operation_id
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
        "apis": [api.type for api in document.apis],
        "api_urls": [api.url for api in document.apis],
    }


async def op_session(host: str, params: dict[str, Any]) -> dict[str, Any]:
    """The Session for `label`: started once, then renewed (same ID) while signed out."""

    state = await company_state(host)
    session = session_of(state, params.get("label"), create=True)
    if session.token is None:
        token = await start_session(state, session)
    elif session.token.signed_in:
        token = session.token
    else:
        token = await renew_signed_out(state, session)
    return {"session_id": token.session_id, "signed_in": token.signed_in, "scope": token.scope}


async def op_signin(host: str, params: dict[str, Any]) -> dict[str, Any]:  # noqa: C901
    state = await company_state(host)
    session = session_of(state, params.get("label"), create=True)
    if session.token is None:
        await start_session(state, session)
    if session.account_reference is not None and await refresh_into(state, session):
        # Already signed in to this Company: the Account Token signs the Session in.
        return signed_in(session)
    token = session.token
    assert token is not None
    document, metadata = state.company.document, metadata_of(state)
    method = params.get("method", "direct")
    auth = document.auth
    if auth is None:
        raise PoppyRefusal("no_auth", 0, "the Company publishes no auth")
    declared = getattr(auth, method, None)
    if declared is None:
        raise PoppyRefusal("method_not_offered", 0, f"the Company offers no {method} sign-in")
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
        return {"pending": {"type": "direct", "url": agent.browser.opened}}
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
                "type": "device",
                "url": started.verification_uri,
                "user_code": started.user_code,
                **(
                    {"url_complete": started.verification_uri_complete}
                    if started.verification_uri_complete
                    else {}
                ),
            }
        }
    if method == "mediated":
        session.pending = {"method": "mediated", "scopes": scopes, "reference": None}
        return {
            "pending": {
                "type": "mediated",
                "fields": [f.name for f in auth.mediated.fields],  # type: ignore[union-attr]
            }
        }
    raise StepError(400, "unknown_method", str(method))


async def op_signin_continue(host: str, params: dict[str, Any]) -> dict[str, Any]:  # noqa: C901
    state = await company_state(host)
    session = session_of(state, params.get("label"))
    pending = session.pending or {}
    method = pending.get("method")
    if method == "direct":
        session.pending = None
        callback = str(params.get("callback_url", ""))
        try:
            result = await DirectSignInClient(
                reactor=agent.reactor, http_client=agent.http
            ).complete(callback)
        except PersonalAgentProtocolError as error:
            if error.code == "authorization_denied":
                # The Company's error came on the redirect, not in an HTTP response.
                raise PoppyRefusal("access_denied", 0, error.message) from error
            raise
        session.token, session.account_reference = result.token, result.account_token_reference
        return signed_in(session)
    if method == "device":
        device = DeviceSignInClient(reactor=agent.reactor, http_client=agent.http)
        deadline = time.monotonic() + float(params.get("timeout", 90))
        while True:
            try:
                poll = await device.poll(pending["reference"])
            except PersonalAgentProtocolError:
                session.pending = None
                raise
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
        if pending.get("reference") is None:
            agent.input.answers = [dict(params.get("fields") or {})]
            result = await mediated.sign_in(
                mediated=auth.mediated,
                organization=state.company.document.organization,
                issuer=auth.issuer,
                scopes=tuple(pending.get("scopes") or ()),
                token=session.token,
                **{k: v for k, v in who(state, session).items() if k != "issuer"},
            )
        else:
            code = params.get("code") or (params.get("fields") or {}).get("code")
            if not code:
                raise StepError(400, "code_missing", "the Company asked for a one-time code")
            agent.input.answers = [{"code": str(code)}]
            result = await mediated.submit_code(
                pending["reference"], token=session.token, **who(state, session)
            )
        if result.status == "code_required":
            pending["reference"] = result.reference
            return {"pending": {"type": "mediated", "code_required": True, "sent_to": result.sent_to}}
        session.pending = None
        if result.status != "complete":
            # The Company answered 200 with status failed or expired (§4.7).
            raise PoppyRefusal(f"sign_in_{result.status}", 0, "Mediated Sign-In did not complete")
        session.token, session.account_reference = result.token, result.account_token_reference
        return signed_in(session)
    raise StepError(409, "nothing_pending", "no sign-in is pending for this Session")


def conversations_url(state: CompanyState) -> str:
    endpoint = conversation_endpoint(state.company.document)
    if endpoint is None:
        raise PoppyRefusal("no_company_agent", 0, "the Company offers no conversation endpoint")
    return endpoint


async def op_send(host: str, params: dict[str, Any]) -> dict[str, Any]:
    state = await company_state(host)
    endpoint = conversations_url(state)
    conversation = params.get("conversation")
    label = params.get("label") or (
        state.conversation_labels.get(conversation, "default") if conversation else "default"
    )
    key = params.get("message_id")
    message = state.messages.get(key) if key else None
    if message is None:
        message = Message(
            id=generate_message_id(agent.reactor),
            sender=params.get("sender", "agent"),
            text=params.get("text"),
            data=params.get("data"),
            context=params.get("context"),
        )
        if key:
            state.messages[key] = message
    wait = int(params.get("wait", 5))
    client = ConversationClient(transport=agent.transport)

    async def call(session: SessionState, token: SessionToken):  # type: ignore[no-untyped-def]
        if conversation is None:
            return await client.start(endpoint, message, token=token, wait=wait, **who(state, session))
        return await client.send(
            endpoint,
            conversation,
            message,
            token=token,
            cursor=state.cursors.get(conversation),
            wait=wait,
            **who(state, session),
        )

    response = await with_session(state, label, call)
    session = session_of(state, label)
    conversation_id = response.conversation_id
    state.conversation_labels[conversation_id] = label
    events = getattr(response, "events", None)
    if events is None:
        assert session.token is not None
        page = await client.read_events(
            endpoint,
            conversation_id,
            token=session.token,
            cursor=state.cursors.get(conversation_id),
            wait=wait,
            **who(state, session),
        )
        events, status, cursor = page.events, page.status, page.cursor
    else:
        status, cursor = response.status, response.cursor  # type: ignore[union-attr]
    state.cursors[conversation_id] = cursor
    return {
        "conversation": conversation_id,
        "message_id": message.id,
        "status": status,
        **page_view(state, label, events),
    }


async def op_read(host: str, params: dict[str, Any]) -> dict[str, Any]:
    state = await company_state(host)
    conversation = str(params.get("conversation", ""))
    label = params.get("label") or state.conversation_labels.get(conversation, "default")

    async def call(session: SessionState, token: SessionToken):  # type: ignore[no-untyped-def]
        return await ConversationClient(transport=agent.transport).read_events(
            conversations_url(state),
            conversation,
            token=token,
            cursor=params.get("cursor"),
            wait=int(params["wait"]) if "wait" in params else None,
            **who(state, session),
        )

    page = await with_session(state, label, call)
    state.cursors[conversation] = page.cursor
    return {
        "cursor": page.cursor,
        "has_more": page.has_more,
        "status": page.status,
        **page_view(state, label, page.events),
    }


async def op_sse(host: str, params: dict[str, Any]) -> dict[str, Any]:
    """One stream: events until the Company ends it, `max_events`, or `wait` seconds.

    `cursor` goes as `Last-Event-ID` (the SDK has no `?cursor`). The SDK's reconnect is
    not used: a stream the Company ends is where this read stops. A stream that ends
    with no event at all is `stream_unavailable` in the SDK; here it is zero events.
    """

    state = await company_state(host)
    conversation = str(params.get("conversation", ""))
    label = params.get("label") or state.conversation_labels.get(conversation, "default")
    limit = int(params.get("max_events", 20))
    budget = float(params.get("wait", params.get("timeout", 5)))
    collected: list[dict[str, Any]] = []
    ended = {"by": "wait"}

    async def call(session: SessionState, token: SessionToken) -> None:
        stream = ConversationClient(transport=agent.transport).stream(
            conversations_url(state),
            conversation,
            token=token,
            last_event_id=params.get("cursor"),
            max_reconnects=0,
            **who(state, session),
        )
        try:
            async for item in stream:
                if isinstance(item, StreamReconnected):
                    ended["by"] = "company"
                    return
                if isinstance(item, TextDelta):
                    collected.append(
                        {"id": None, "type": "text-delta", "data": item.model_dump(mode="json")}
                    )
                else:
                    data = item.model_dump(mode="json", exclude_none=True)
                    collected.append({"id": item.id, "type": item.type, "data": data})
                if sum(1 for c in collected if c["id"]) >= limit:
                    ended["by"] = "max_events"
                    return
        except PersonalAgentProtocolError as error:
            if error.code != "stream_unavailable":
                raise
            ended["by"] = "company"
        finally:
            await stream.aclose()

    try:
        await asyncio.wait_for(with_session(state, label, call), budget + 5)
    except asyncio.TimeoutError:
        pass
    ids = [c["id"] for c in collected if c["id"]]
    return {
        "events": collected,
        "last_id": ids[-1] if ids else params.get("cursor"),
        "ended_by": ended["by"],
    }


def find_api(state: CompanyState, api: str, kind: str) -> str:
    for descriptor in state.company.document.apis:
        if api in (descriptor.url, descriptor.type) and descriptor.type == kind:
            return descriptor.url
    raise PoppyRefusal("no_api", 0, f"the Company declares no {kind} API {api}")


HTTP_METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE")


async def resolve_operation(
    description: str, operation: str, args: dict[str, Any]
) -> tuple[str, str, Any]:
    """`operation` is "METHOD /path" or an OpenAPI operationId. `args.params` fill the
    path template; the other params go in the query; `args.body` is the body. Paths are
    relative to the description's first `servers` URL (OpenAPI 3), resolved against the
    description's own URL, or to its origin when it lists none (the SDK has no OpenAPI
    loader)."""

    parts = urlsplit(description)
    base = f"{parts.scheme}://{parts.netloc}"
    values = dict((args or {}).get("params") or {})
    verb, _, path = operation.partition(" ")
    literal = verb.upper() in HTTP_METHODS and path.startswith("/")
    response = await agent.http.get(description, headers={"Accept": "application/json"})
    try:
        document = response.json() if response.status_code == 200 else None
    except ValueError:
        document = None
    if not isinstance(document, dict):
        if not literal:
            raise PoppyRefusal("openapi_unavailable", response.status_code, description)
        document = {}
    servers = document.get("servers") or []
    if servers and isinstance(servers[0], dict) and isinstance(servers[0].get("url"), str):
        base = urljoin(description, servers[0]["url"]).rstrip("/")
    if not literal:
        found = None
        for candidate, item in (document.get("paths") or {}).items():
            for name, spec in item.items():
                if isinstance(spec, dict) and spec.get("operationId") == operation:
                    found = (name, candidate)
        if found is None:
            raise PoppyRefusal("no_operation", 0, f"the API has no operation {operation}")
        verb, path = found
    verb = verb.upper()
    for name in list(values):
        if "{" + name + "}" in path:
            path = path.replace("{" + name + "}", quote(str(values.pop(name)), safe=""))
    url = path if path.startswith("https://") else f"{base}{path}"
    if values:
        url += ("&" if "?" in url else "?") + urlencode({k: str(v) for k, v in values.items()})
    body = (args or {}).get("body")
    return verb, url, body


async def op_api(host: str, params: dict[str, Any]) -> dict[str, Any]:  # noqa: C901
    state = await company_state(host)
    label = params.get("label") or "default"
    api = str(params.get("api") or ("mcp" if "tool" in params else "openapi"))
    args = params.get("args") or {}
    if "tool" in params:
        url = find_api(state, api, "mcp")
        metadata = metadata_of(state)

        async def mcp_call(session: SessionState, token: SessionToken):  # type: ignore[no-untyped-def]
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
                    raise PoppyRefusal(refreshed.status, 0, "no Bearer token for the MCP server")
                bearer = refreshed.token
            else:
                bearer = await SessionClient(
                    reactor=agent.reactor, http_client=agent.http
                ).bearer_for_mcp(
                    client_id=agent.client_id,
                    pairwise_user_id=session.pairwise,
                    issuer=metadata.issuer,
                    token_endpoint=metadata.token_endpoint,
                    tenant_id=TENANT,
                    session_id=token.session_id,
                    resource=url,
                )
            return await McpClient(http_client=agent.http, token=bearer, url=url).call_tool(
                str(params["tool"]), args
            )

        result = await with_session(state, label, mcp_call)
        body = result.model_dump(mode="json", exclude_none=True)
        if result.operation is not None:
            state.operations[result.operation.operation_id] = (result.operation, label)
        return {"status": 200, "body": body}
    description = find_api(state, api, "openapi")
    method, url, body = await resolve_operation(description, str(params.get("operation", "")), args)

    async def call(session: SessionState, token: SessionToken):  # type: ignore[no-untyped-def]
        return await ApiClient(transport=agent.transport).call(
            method, url, token=token, body=body, **who(state, session)
        )

    response = await with_session(state, label, call)
    if response.operation is not None:
        state.operations[response.operation.operation_id] = (response.operation, label)
        return {
            "status": response.status,
            "body": {"operation": response.operation.model_dump(mode="json", exclude_none=True)},
        }
    return {"status": response.status, "body": response.body}


async def op_approve_op(host: str, params: dict[str, Any]) -> dict[str, Any]:
    """`status` is the operation's state afterwards (`succeeded`, `cancelled`, ...)."""

    state = await company_state(host)
    operation_id = str(params.get("operation", ""))
    known = state.operations.get(operation_id)
    label = known[1] if known else (params.get("label") or "default")
    endpoint = operations_endpoint(
        state.company.document, ClientMetadata.model_validate(agent.metadata)
    )
    if endpoint is None:
        raise PoppyRefusal("extension_required", 0, "the Operations extension was not negotiated")
    client = OperationsClient(transport=agent.transport)

    async def call(session: SessionState, token: SessionToken) -> dict[str, Any]:
        operation = await client.read(endpoint, operation_id, token=token, **who(state, session))
        if params.get("decision", "approve") == "decline":
            cancelled = await client.cancel(
                endpoint, operation_id, token=token, **who(state, session)
            )
            return {"status": cancelled.state, "revision": cancelled.revision}
        outcome = await client.confirm(
            endpoint, operation, approval=approve(operation), token=token, **who(state, session)
        )
        after = outcome.operation or operation
        result: dict[str, Any] = {
            "status": after.state,
            "revision": after.revision,
            "outcome": outcome.status,
        }
        if after.result is not None:
            result["result"] = after.result.summary
        return result

    return await with_session(state, label, call)


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
    web = state.company.document.web
    endpoint = getattr(web, "browser_session_endpoint", None) if web is not None else None
    if not endpoint:
        raise PoppyRefusal("no_browser_sessions", 0, "the Company declares no browser_session_endpoint")

    async def call(session: SessionState, token: SessionToken) -> None:
        await BrowserSessionClient(reactor=agent.reactor).join(
            client_id=agent.client_id,
            pairwise_user_id=session.pairwise,
            browser_session_endpoint=endpoint,
            session_id=token.session_id,
            return_to=str(
                params.get("url") or f"https://{state.company.document.organization.domain}/"
            ),
            company_domain=state.company.document.organization.domain,
        )

    await with_session(state, params.get("label"), call)
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
        # A Company refusal keeps its HTTP status; the SDK's own refusal of what the
        # Company did (a malformed answer, a denied device grant, ...) has status 0.
        status = error.status_code if error.status_code and error.status_code >= 400 else 0
        await respond(
            send, 200,
            {"ok": False, "poppy_error": error.code, "status": status, "detail": error.message,
             **({"details": error.details} if error.details else {})},
        )
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
