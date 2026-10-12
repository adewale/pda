"""Interop adapter for Datalayer's Python reference Company (Manzanita).

One process, two ports:

- 8080: the Company itself, `company_app(service)` from the upstream SDK, at
  INTEROP_ORIGIN (default https://datalayer-py.company.interop.test).
- 8081: the interop control API (docs/interop-spec.md sections 4, 5.1, 5.3).
  Hooks call the same in-process `CompanyService` the Company runs on, the way
  the upstream tests play the user at the Company (`approve_authorization`,
  `approve_device`, ...). A hook answers its result object itself.

Interop-only setting, off unless set (the image sets it):

- INTEROP_ALLOW_TEST_HOSTS=1: a URL-safety policy contributed through Reactor
  that lets the Company fetch client metadata and JWKS from *.interop.test
  hosts on private addresses. Every other host keeps the SDK's default policy.

Scenarios sign in with Manzanita's own `orders:read`/`orders:write`, which the
`fixture` hook names (interop spec 5.3).
"""

from __future__ import annotations

import asyncio
import json
import os
import ssl
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlsplit

import httpx
import uvicorn
from reactor import PluginManifest  # type: ignore[import-untyped]

from personal_agent_protocol.company import (
    CompanyRequest,
    MemoryCompanyStore,
    build_company,
    company_app,
)
from personal_agent_protocol.company.store import (
    CONVERSATION,
    SESSION,
    SESSION_TOKEN,
    StoredConversation,
    StoredSession,
)
from personal_agent_protocol.demo import manzanita as mz
from personal_agent_protocol.demo.kit import StorePlugin
from personal_agent_protocol.models import OperationResult
from personal_agent_protocol.reactor import (
    URL_SAFETY_POLICIES,
    PublicUrlSafetyPolicy,
    resolve_addresses,
)

NAME = os.environ.get("INTEROP_NAME", "datalayer-py")
_DOMAIN = os.environ.get("INTEROP_DOMAIN") or f"{NAME}.company.interop.test"
ORIGIN = os.environ.get("INTEROP_ORIGIN", f"https://{_DOMAIN}").rstrip("/")
DOMAIN = urlsplit(ORIGIN).hostname or ""
SECRET = os.environ.get("INTEROP_SECRET", "")
COMMIT = os.environ.get("INTEROP_COMMIT") or os.environ.get("UPSTREAM_COMMIT", "unknown")
ALLOW_TEST_HOSTS = os.environ.get("INTEROP_ALLOW_TEST_HOSTS") == "1"
CA_FILE = os.environ.get("SSL_CERT_FILE") or "/interop/ca.pem"

HOOKS = [
    "approve_authorization",
    "deny_authorization",
    "approve_device",
    "deny_device",
    "mediated_answers",
    "last_one_time_code",
    "end_sessions",
    "propose_operation",
    "settle_operation",
    "expire_tokens",
    "fixture",
]

RELAXATIONS = [
    "INTEROP_ALLOW_TEST_HOSTS=1: a Reactor URL-safety contribution (adapter, not a patch) "
    "lets the Company fetch client metadata and JWKS from *.interop.test hosts on private "
    "addresses; other hosts keep the SDK's public-address policy",
    "Trusts the per-run CA at /interop/ca.pem for those fetches (the adapter builds the "
    "httpx client the SDK is given)",
    "Organization domain and issuer come from INTEROP_ORIGIN instead of manzanita.example",
]

MANIFEST = {
    "interop": 1,
    "name": NAME,
    "role": "company",
    "commit": COMMIT,
    "poppy": ["0.1"],
    "extensions": ["operations"],
    # Not SM: Manzanita's one account always asks for a one-time code (SMC). Not AM: its
    # MCP tools all need a signed-in user. Not N, RL, H: the Company has no DPoP nonces,
    # no rate limits and no staff.
    "scenarios": [
        "D", "S0", "SD", "SV", "SMC", "SX", "SXV", "R", "SE", "SO",
        "C", "CI", "CS", "CA", "DC", "AO", "AS", "W", "O", "O2", "OX",
    ],
    # S1: a client assertion's aud may be the issuer, the token endpoint or the endpoint
    # called, at the token, device and revocation endpoints alike (service.py `_client`).
    # S2: typ absent or "JWT", at most 120 s (company/verify.py). No section 7 value says
    # 120 s; lenient-300s is the nearest (any typ, a stated cap) and, unlike `any`, says
    # the Company refuses long-lived assertions.
    "readings": {"S1": "either", "S2": "lenient-300s", "S4": "either"},
    "relaxations": RELAXATIONS,
}


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


class InteropPolicyPlugin:
    def provide_contributions(self, contributions: object) -> None:
        contributions.contribute(  # type: ignore[attr-defined]
            URL_SAFETY_POLICIES, InteropUrlPolicy(), contribution_id="interop-test-hosts", order=0
        )


def config():  # type: ignore[no-untyped-def]
    return replace(mz.CONFIG, domain=DOMAIN)


def http_client() -> httpx.AsyncClient:
    verify: Any = True
    if os.path.exists(CA_FILE):
        verify = ssl.create_default_context(cafile=CA_FILE)
    return httpx.AsyncClient(verify=verify, timeout=10.0, follow_redirects=False)


class World:
    """The Company and everything a reset forgets."""

    def __init__(self) -> None:
        self.store = MemoryCompanyStore()
        # Manzanita's own plugin, as `manzanita()` builds it (accounts, agent, executors,
        # API and MCP server); only the store and the URL policy are the adapter's.
        self.plugin = mz.ManzanitaPlugin()
        plugins: list[tuple[PluginManifest, object]] = [
            (PluginManifest(name="manzanita", version="1"), self.plugin),
            (PluginManifest(name="interop-store", version="1"), StorePlugin(self.store)),
        ]
        if ALLOW_TEST_HOSTS:
            plugins.append(
                (PluginManifest(name="interop-test-hosts", version="1"), InteropPolicyPlugin())
            )
        self.http = http_client()
        self.service = build_company(config(), http_client=self.http, plugins=plugins)
        self.app = company_app(self.service)


world = World()


async def company(scope: dict[str, Any], receive: Any, send: Any) -> None:
    if scope["type"] == "lifespan":
        await lifespan(receive, send)
        return
    await world.app(scope, receive, send)


async def lifespan(receive: Any, send: Any) -> None:
    while (message := await receive())["type"] != "lifespan.shutdown":
        if message["type"] == "lifespan.startup":
            await send({"type": "lifespan.startup.complete"})
    await send({"type": "lifespan.shutdown.complete"})


async def respond(send: Any, status: int, body: object) -> None:
    payload = json.dumps(body).encode()
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [(b"content-type", b"application/json")],
        }
    )
    await send({"type": "http.response.body", "body": payload})


class HookError(Exception):
    def __init__(self, status: int, error: str, detail: str = "") -> None:
        super().__init__(detail)
        self.status, self.error, self.detail = status, error, detail


class RedirectInstead(Exception):
    def __init__(self, location: str) -> None:
        super().__init__(location)
        self.location = location


async def authorization_request(url: str) -> str:
    """Open the agent's authorization URL at the Company, as the user's browser would."""

    parts = urlsplit(url)
    if parts.scheme != "https" or (parts.hostname or "").lower() != DOMAIN:
        raise HookError(400, "foreign_url", f"not an authorization URL at {ORIGIN}")
    response = await world.service.handle(
        CompanyRequest(method="GET", url=url, headers={"accept": "text/html"}, body=b"")
    )
    if response.status == 303:
        # The Company refused the request with a redirect (invalid_scope, ...).
        raise RedirectInstead(response.headers.get("Location", ""))
    page = response.body if isinstance(response.body, str) else ""
    marker = 'name="request_id" value="'
    if response.status != 200 or marker not in page:
        raise HookError(400, "authorization_refused", page[-200:] or str(response.status))
    return page.split(marker, 1)[1].split('"', 1)[0]


def account_of(params: dict[str, Any]) -> str:
    account = params.get("account") or "acct_ada"
    if account not in ("acct_ada", mz.ADA["email"]):
        raise HookError(400, "unknown_account", str(account))
    return "acct_ada"


def scopes_of(params: dict[str, Any]) -> list[str] | None:
    scopes = params.get("scopes")
    return [str(s) for s in scopes] if isinstance(scopes, list) and scopes else None


async def hook(name: str, params: dict[str, Any]) -> dict[str, Any]:  # noqa: C901
    service = world.service
    if name == "fixture":
        # Manzanita's own scopes: scenarios sign in with these (interop spec 5.3).
        return {
            "accounts": ["acct_ada"],
            "scopes": {"read": ["orders:read"], "write": ["orders:read", "orders:write"]},
            "openapi": {"api": "openapi", "operation": "GET /api/orders", "args": {}},
            # Manzanita's API has no signed-out operation; its description, served at the
            # API's own path, is the one GET that works signed out.
            "openapi_public": {"api": "openapi", "operation": "GET /api/openapi.json", "args": {}},
            "openapi_write": {
                "api": "openapi",
                "operation": "POST /api/orders/{order_id}/exchanges",
                "args": {"params": {"order_id": "ord_7Hk2"}, "body": {}},
            },
            "mcp": {"api": "mcp", "tool": "list_orders", "args": {}},
            "prompts": {
                "hello": "Hello",
                "sign_in": "Where is my jacket order?",
                "operation": "Exchange it for something warmer",
            },
            "otp_account": "acct_ada",
        }
    if name in ("approve_authorization", "deny_authorization"):
        try:
            request_id = await authorization_request(str(params.get("url", "")))
        except RedirectInstead as redirect:
            return {"redirect": redirect.location}
        try:
            if name == "deny_authorization":
                return {"redirect": await service.deny_authorization(request_id)}
            return {
                "redirect": await service.approve_authorization(
                    request_id, account_id=account_of(params), scopes=scopes_of(params)
                )
            }
        except KeyError as exc:
            raise HookError(404, "unknown_request", str(exc)) from exc
    if name == "approve_device":
        try:
            granted = await service.approve_device(
                str(params.get("user_code", "")),
                account_id=account_of(params),
                scopes=scopes_of(params),
            )
        except KeyError as exc:
            raise HookError(404, "unknown_user_code", str(exc)) from exc
        return {"granted": list(granted)}
    if name == "deny_device":
        try:
            await service.deny_device(str(params.get("user_code", "")))
        except KeyError as exc:
            raise HookError(404, "unknown_user_code", str(exc)) from exc
        return {}
    if name == "mediated_answers":
        account_of(params)
        return {"fields": dict(mz.ADA)}
    if name == "last_one_time_code":
        # Manzanita's one account has a fixed one-time code (demo/manzanita.py).
        return {"code": mz.ADA_CODE}
    if name == "end_sessions":
        # The Company ends every Session: their records and tokens go; Account Tokens stay.
        # (Manzanita has no such feature; this deletes the records from the store the
        # adapter gave it.)
        entries = world.store._entries
        keys = [key for key in entries if key[0] in (SESSION, SESSION_TOKEN)]
        ended = sum(1 for key in keys if key[0] == SESSION)
        for key in keys:
            del entries[key]
        return {"ended": ended}
    if name == "expire_tokens":
        # Every Session Token issued so far now carries an expiry in the past; the
        # service's own expiry check then refuses it (401 invalid_token).
        past = datetime.now(timezone.utc) - timedelta(seconds=1)
        sessions = [key[1] for key in list(world.store._entries) if key[0] == SESSION]
        expired = 0
        for session_id in sessions:
            changed = await service._change(
                SESSION,
                session_id,
                StoredSession.from_json,
                lambda stored: replace(
                    stored,
                    tokens={d: replace(t, expires_at=past) for d, t in stored.tokens.items()},
                ),
            )
            if changed is not None:
                expired += len(changed[1].tokens)
        return {"expired": expired}
    if name == "propose_operation":
        # Manzanita's agent proposes the exchange when a signed-in user asks for it
        # (fixture prompts.operation): the proposal it made in that conversation.
        conversation = await service._read(
            CONVERSATION, str(params.get("conversation", "")), StoredConversation.from_json
        )
        if conversation is None:
            raise HookError(404, "unknown_conversation", "no such conversation")
        ids = [
            ((event.payload.get("message") or {}).get("operation") or {}).get("operation_id")
            for event in conversation.events
        ]
        for operation_id in reversed([i for i in ids if i]):
            stored = await service.operation_record(operation_id)
            if stored.operation.state == "proposed":
                return {"operation": operation_id}
        raise HookError(
            409, "no_operation",
            "Nothing proposed: send fixture.prompts.operation in a signed-in conversation first",
        )
    if name == "settle_operation":
        outcome = str(params.get("outcome", "succeeded"))
        try:
            operation = await service.settle(
                str(params.get("operation", "")),
                OperationResult(summary=f"Settled by the interop runner: {outcome}."),
                succeeded=outcome == "succeeded",
            )
        except (KeyError, ValueError) as exc:
            raise HookError(409, "not_settleable", str(exc)) from exc
        return {"state": operation.state}
    # require_nonce, rate_limit, staff_join, staff_reply: Manzanita has no DPoP nonces,
    # no rate limits and no staff, and the adapter doesn't fake them.
    raise HookError(501, "unsupported", name)


async def control(scope: dict[str, Any], receive: Any, send: Any) -> None:  # noqa: C901
    global world
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
    try:
        params = json.loads(body) if body else {}
    except ValueError:
        await respond(send, 400, {"error": "invalid_json", "detail": "body is not JSON"})
        return
    if isinstance(params, dict) and isinstance(params.get("params"), dict):
        params = params["params"]
    if method == "POST" and path == "/reset":
        await world.http.aclose()
        world = World()
        await respond(send, 200, {"ok": True})
        return
    if method == "GET" and path == "/hooks":
        await respond(send, 200, {"interop": 1, "hooks": HOOKS})
        return
    if method == "POST" and path.startswith("/hooks/"):
        name = path.removeprefix("/hooks/")
        try:
            result = await hook(name, params if isinstance(params, dict) else {})
        except HookError as error:
            await respond(send, error.status, {"error": error.error, "detail": error.detail})
            return
        except Exception as error:  # noqa: BLE001 - the adapter reports, never crashes
            await respond(send, 500, {"error": "adapter_error", "detail": repr(error)})
            return
        # The hook's result is the body itself (spec 5.3).
        await respond(send, 200, result)
        return
    await respond(send, 404, {"error": "not_found", "detail": path})


async def main() -> None:
    servers = [
        uvicorn.Server(
            uvicorn.Config(company, host="0.0.0.0", port=8080, log_level="warning")  # noqa: S104
        ),
        uvicorn.Server(
            uvicorn.Config(control, host="0.0.0.0", port=8081, log_level="warning")  # noqa: S104
        ),
    ]
    await asyncio.gather(*(server.serve() for server in servers))


if __name__ == "__main__":
    asyncio.run(main())
