"""Interop adapter for Datalayer's Python reference Company (Manzanita).

One process, two ports:

- 8080: the Company itself, `company_app(service)` from the upstream SDK, at
  INTEROP_ORIGIN (default https://datalayer-py.company.interop.test).
- 8081: the interop control API (docs/interop-spec.md sections 4, 5.1, 5.3).
  Hooks call the same in-process `CompanyService` the Company runs on, the way
  the upstream tests play the user at the Company (`approve_authorization`,
  `approve_device`, ...).

Interop-only setting (off unless INTEROP_ALLOW_TEST_HOSTS=1, which the image
sets): a URL-safety policy contributed through Reactor that lets the Company
fetch client metadata and JWKS from *.interop.test hosts on private addresses.
Every other host keeps the SDK's default public-address policy.
"""

from __future__ import annotations

import asyncio
import json
import os
import ssl
from dataclasses import replace
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
from personal_agent_protocol.company.store import SESSION, SESSION_TOKEN
from personal_agent_protocol.demo import manzanita as mz
from personal_agent_protocol.demo.kit import StorePlugin
from personal_agent_protocol.models import OperationResult
from personal_agent_protocol.reactor import (
    URL_SAFETY_POLICIES,
    PublicUrlSafetyPolicy,
    resolve_addresses,
)

NAME = os.environ.get("INTEROP_NAME", "datalayer-py")
ORIGIN = os.environ.get("INTEROP_ORIGIN", f"https://{NAME}.company.interop.test").rstrip("/")
DOMAIN = urlsplit(ORIGIN).hostname or ""
SECRET = os.environ.get("INTEROP_SECRET", "")
COMMIT = os.environ.get("UPSTREAM_COMMIT", "unknown")
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
    "settle_operation",
    "fixture",
]

MANIFEST = {
    "interop": 1,
    "name": NAME,
    "role": "company",
    "commit": COMMIT,
    "poppy": ["0.1"],
    "extensions": ["operations"],
    "scenarios": [
        "D", "S0", "SD", "SV", "SM", "SX", "R", "SE", "SO",
        "C", "CI", "CS", "CA", "DC", "AO", "AM", "AS", "W", "O", "O2", "OX",
    ],
    "readings": {"S1": "token-endpoint", "S2": "any", "S4": "either"},
    "relaxations": [
        "INTEROP_ALLOW_TEST_HOSTS=1: a Reactor URL-safety contribution (adapter, not a patch) "
        "lets the Company fetch client metadata and JWKS from *.interop.test hosts on private "
        "addresses; other hosts keep the SDK's public-address policy",
        "Trusts the per-run CA at /interop/ca.pem for those fetches (the adapter builds the "
        "httpx client the SDK is given)",
        "Organization domain and issuer come from INTEROP_ORIGIN instead of manzanita.example",
    ],
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


def http_client() -> httpx.AsyncClient:
    verify: Any = True
    if os.path.exists(CA_FILE):
        verify = ssl.create_default_context(cafile=CA_FILE)
    return httpx.AsyncClient(verify=verify, timeout=10.0, follow_redirects=False)


class World:
    """The Company and everything a reset forgets."""

    def __init__(self) -> None:
        self.store = MemoryCompanyStore()
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
        self.service = build_company(
            replace(mz.CONFIG, domain=DOMAIN), http_client=self.http, plugins=plugins
        )
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


class RedirectInstead(Exception):
    def __init__(self, location: str) -> None:
        super().__init__(location)
        self.location = location


async def hook(name: str, params: dict[str, Any]) -> dict[str, Any]:  # noqa: C901
    service = world.service
    if name == "fixture":
        return {
            "accounts": ["acct_ada"],
            "scopes": list(mz.CONFIG.scopes),
            "openapi": {"api": service.config.api_description, "operation": "GET /api/orders"},
            "mcp": {"api": service.config.mcp_url, "tool": "list_orders"},
            "write": {"openapi": "POST /api/orders/ord_7Hk2/exchanges", "mcp": "exchange_jacket"},
            "conversation": {
                "signed_out_text": "Hello",
                "sign_in_text": "Where is my jacket order?",
                "operation_text": "Exchange it for something warmer",
            },
        }
    if name in ("approve_authorization", "deny_authorization"):
        try:
            request_id = await authorization_request(str(params.get("url", "")))
        except RedirectInstead as redirect:
            return {"redirect": redirect.location}
        try:
            if name == "deny_authorization":
                return {"redirect": await service.deny_authorization(request_id)}
            scopes = params.get("scopes")
            return {
                "redirect": await service.approve_authorization(
                    request_id,
                    account_id=str(params.get("account") or "acct_ada"),
                    scopes=list(scopes) if scopes else None,
                )
            }
        except KeyError as exc:
            raise HookError(404, "unknown_request", str(exc)) from exc
    if name == "approve_device":
        scopes = params.get("scopes")
        try:
            granted = await service.approve_device(
                str(params.get("user_code", "")),
                account_id=str(params.get("account") or "acct_ada"),
                scopes=list(scopes) if scopes else None,
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
        account = params.get("account") or "acct_ada"
        if account not in ("acct_ada", mz.ADA["email"]):
            raise HookError(404, "unknown_account", str(account))
        return {"fields": dict(mz.ADA)}
    if name == "last_one_time_code":
        # Manzanita's one account has a fixed one-time code (demo/manzanita.py).
        return {"code": mz.ADA_CODE}
    if name == "end_sessions":
        # The Company ends every Session: their records and tokens go; Account Tokens stay.
        entries = world.store._entries  # the store this adapter gave the Company
        keys = [key for key in entries if key[0] in (SESSION, SESSION_TOKEN)]
        ended = sum(1 for key in keys if key[0] == SESSION)
        for key in keys:
            del entries[key]
        return {"ended": ended}
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
        return {"operation": operation.model_dump(mode="json")}
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
        await respond(send, 200, {"ok": True, "result": {}})
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
        await respond(send, 200, {"ok": True, "result": result})
        return
    await respond(send, 404, {"error": "not_found", "detail": path})


async def main() -> None:
    servers = [
        uvicorn.Server(
            uvicorn.Config(company, host="0.0.0.0", port=8080, log_level="warning", proxy_headers=False)  # noqa: S104
        ),
        uvicorn.Server(
            uvicorn.Config(control, host="0.0.0.0", port=8081, log_level="warning")  # noqa: S104
        ),
    ]
    await asyncio.gather(*(server.serve() for server in servers))


if __name__ == "__main__":
    asyncio.run(main())
