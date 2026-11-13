"""
A minimal Personal Agent Protocol (Poppy) client for 0.4 and the 1.0
draft, written from the 11 November 0.4 text
(spec/draft-0.4-retrieved-2026-11-11/pages/: the spec, and the Operations
and Mediated Sign-In extensions), the 13 November 1.0 text
(spec/draft-1.0-retrieved-2026-11-13/pages/) and the `v04-*` and `v10-*`
rows of docs/readings.md, not ported from src/poppy. Ported from the 0.3
client on 12 November 2026; nothing of 0.3 is left. 1.0 added on 13
November: protocol descriptions (8.1), `prompt=consent` (4.2), pushed
authorization requests whenever the issuer lists the endpoint (4.2, RFC
9126), and stream events with SSE names it doesn't know skipped (8.6).

It is deliberately small: discovery (3), including redirects of the
well-known URL, the choice among `protocol_version` and
`supported_versions` (3.4), the issuer from the domain's protected resource
metadata (3.2), and a Company with no issuer (a 404 or no authorization
servers: signed out only, identified by https://{domain}); `Poppy-Version`
and `Poppy-Extensions` on every request with the Session header, the same
for the whole Session (3.4); Web Bot Auth operator signatures on resource
requests (5.3); client assertions naming the issuer (4.1); delegated keys
and a Session JWT on every resource request (5.2), and a signed-out one on
website pages fetched without a browser; plain OAuth refresh and access
tokens with DPoP only when the issuer lists it (4.4, 4.5); Direct, Device
and Mediated Sign-In; conversations with request IDs, handoff and its
cancel, and Direct Conversations, including accepting a `user_requested`
event (8); sign-out; Operations 3; MCP; the browser join with
`poppy:browser-sign-in` (6); the tasks endpoint, skills and feedback (9);
and rate limits (5.6). It returns what the Company said (`Reply`) and
leaves judging it to the caller, so the state machines in test_*.py can
hold the Company to a model.

The reject-direction rules need to break things on purpose (replay a JWT,
use a wrong `aud`, sign with another key). Those knobs are explicit
arguments, never defaults, so the honest path is the one you get by not
passing them.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import time
import urllib.parse
from dataclasses import dataclass, field
from typing import Any, Callable

import httpx
import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from jwt.algorithms import ECAlgorithm

DEVICE_CODE = "urn:ietf:params:oauth:grant-type:device_code"
MEDIATED_GRANT = "https://personalagentprotocol.org/grant/mediated-sign-in"
CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
APPROVAL_META = "personalagentprotocol.org/approval"
PROTOCOL_VERSIONS = ("0.4", "1.0")  # the versions this client implements (3.4)
VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
BROWSER_SIGN_IN = "poppy:browser-sign-in"  # the scope that signs the browser in (4.7, 6)
ASSERTION_LIFETIME = 60  # seconds; strict Companies allow 60 (readings S2)
DELEGATION_HOURS = 4  # the guides' "a few hours", from an iat rounded down to the hour
MAX_LIMITED_RETRIES = 6  # 429s waited out before a request gives up
DEFAULT: Any = object()  # "the honest value", where None is itself a value a test may send


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def random_id(prefix: str = "", nbytes: int = 16) -> str:
    """`prefix` + `nbytes` random bytes as base64url (16 bytes: the 128 bits Poppy asks of a `jti` or `sid`)."""
    return prefix + b64url(os.urandom(nbytes))


def ath(token: str) -> str:
    """`ath`: base64url SHA-256 of the access token (RFC 9449 4.2; 0.3 5.2 uses it in the Session JWT too)."""
    return b64url(hashlib.sha256(token.encode("ascii")).digest())


class Es256Key:
    """An ES256 key pair. The private half never leaves this object."""

    def __init__(self, kid: str | None = None) -> None:
        self._private = ec.generate_private_key(ec.SECP256R1())
        self.kid = kid

    def public_jwk(self) -> dict[str, Any]:
        jwk = json.loads(ECAlgorithm.to_jwk(self._private.public_key()))
        public = {name: jwk[name] for name in ("kty", "crv", "x", "y")}
        if self.kid:
            public.update(kid=self.kid, use="sig", alg="ES256")
        return public

    def thumbprint(self) -> str:
        """RFC 7638: SHA-256 of the required members, in lexical order, with no spaces."""
        jwk = self.public_jwk()
        members = json.dumps({name: jwk[name] for name in ("crv", "kty", "x", "y")}, separators=(",", ":"), sort_keys=True)
        return b64url(hashlib.sha256(members.encode("ascii")).digest())

    def sign(self, claims: dict[str, Any], header: dict[str, Any]) -> str:
        return jwt.encode(claims, self._private, algorithm="ES256", headers=header)


# ---------------------------------------------------------------- transport


class Clock:
    """
    The agent's clock for timing requests: when to poll a device, when a
    `Retry-After` has passed. It starts at the real time and moves only when
    the agent waits, so a wait costs nothing and every timing is exact. The
    transport stamps it on each request in `x-test-clock`, the mock's test
    clock header (test/mock-company/core.ts, CLOCK_HEADER), which the mock
    reads for rate limits, device polling and token age. JWT times (`iat`,
    `exp`) stay on the real clock, which is the one the mock checks them on.
    """

    def __init__(self) -> None:
        self._ms = int(time.time() * 1000)

    def now_ms(self) -> int:
        return self._ms

    def sleep(self, seconds: float) -> None:
        assert seconds >= 0
        self._ms += int(seconds * 1000)


@dataclass
class Sent429:
    """A 429 the client met: where, and the `Retry-After` it gave (None when absent or unreadable)."""

    method: str
    url: str
    retry_after: float | None
    at_ms: int


@dataclass
class Exchange:
    """One request on the wire and its status, for invariants about where the client sent what."""

    method: str
    url: str
    scheme: str | None  # of the Authorization header: "DPoP", "Bearer" or None
    session_header: bool  # whether it carried Poppy-Session (5.2)
    status: int
    at_ms: int  # the clock stamp it carried
    retry_after: float | None  # a 429's Retry-After
    version: str | None = None  # Poppy-Version (3.4)
    extensions: str | None = None  # Poppy-Extensions, as sent (3.4)
    sid: str | None = None  # the Session JWT's `sid`, read without verifying it


def retry_after_seconds(value: str | None, now_ms: int) -> float | None:
    """RFC 9110 10.2.3: delay-seconds, or an HTTP-date (as seconds from `now_ms`). Anything else is None."""
    if value is None:
        return None
    value = value.strip()
    if value.isdigit():
        return float(int(value))
    try:
        from email.utils import parsedate_to_datetime

        return max(0.0, parsedate_to_datetime(value).timestamp() - now_ms / 1000)
    except (TypeError, ValueError):
        return None


class LocalTransport(httpx.BaseTransport):
    """
    Sends `https://<host>/...` for the mock's hosts to the launcher on
    127.0.0.1, the way the interop recording proxy does: plain HTTP with the
    original `Host` and `X-Forwarded-Proto: https`, which
    interop/impls/shared/serve.ts turns back into the URL the client meant.
    Anything else is refused, so nothing leaves localhost.

    It is also the client's one rate limiter for the Company (4.3, Guides
    "Rate limits": keep track of limits for each company and share them
    across your tasks and users): after a 429 it holds every request until
    the `Retry-After` has passed, by waiting on the clock. `ignoring_limits`
    turns that off, for the rule that breaks it on purpose.
    """

    def __init__(self, port: int, suffix: str, clock: Clock) -> None:
        self._inner = httpx.HTTPTransport()
        self._port = port
        self._suffix = suffix
        self.clock = clock
        self.blocked_until_ms = 0
        self.ignore_limits = False
        self.limited: list[Sent429] = []
        self.log: list[Exchange] = []

    def reset(self, clock: Clock) -> None:
        self.clock = clock
        self.blocked_until_ms = 0
        self.ignore_limits = False
        self.limited.clear()
        self.log.clear()

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        url = request.url
        if url.scheme != "https" or not (url.host == self._suffix or url.host.endswith("." + self._suffix)):
            raise RuntimeError(f"refusing to send to {url}: only https://*.{self._suffix} goes to the local mock")
        if not self.ignore_limits and self.clock.now_ms() < self.blocked_until_ms:
            self.clock.sleep((self.blocked_until_ms - self.clock.now_ms()) / 1000)
        headers = httpx.Headers([(k, v) for k, v in request.headers.raw if k.lower() != b"host"])
        headers["Host"] = url.host
        headers["X-Forwarded-Proto"] = "https"
        headers["x-test-clock"] = str(self.clock.now_ms())  # the stamp below
        local = url.copy_with(scheme="http", host="127.0.0.1", port=self._port)
        forwarded = httpx.Request(request.method, local, headers=headers, stream=request.stream, extensions=request.extensions)
        stamp = self.clock.now_ms()
        response = self._inner.handle_request(forwarded)
        authorization = request.headers.get("authorization")
        seconds = retry_after_seconds(response.headers.get("retry-after"), stamp) if response.status_code == 429 else None
        scheme = authorization.split(" ", 1)[0] if authorization else None
        self.log.append(
            Exchange(
                request.method, str(url), scheme, "poppy-session" in request.headers, response.status_code, stamp, seconds,
                request.headers.get("poppy-version"), request.headers.get("poppy-extensions"), jwt_sid(request.headers.get("poppy-session")),
            )
        )
        if response.status_code == 429:
            self.limited.append(Sent429(request.method, str(url), seconds, self.clock.now_ms()))
            # Without a readable Retry-After, wait a second: the request isn't sent again at once.
            until = self.clock.now_ms() + int((seconds if seconds is not None else 1) * 1000)
            self.blocked_until_ms = max(self.blocked_until_ms, until)
        return response

    def close(self) -> None:
        self._inner.close()


@dataclass
class Reply:
    """What a Company answered. `error` is from `WWW-Authenticate` or the JSON body."""

    status: int
    body: Any
    headers: httpx.Headers
    error: str | None
    text: str = ""

    @staticmethod
    def of(response: httpx.Response) -> "Reply":
        text = response.text
        body: Any = None
        if "json" in response.headers.get("content-type", ""):
            try:
                body = json.loads(text)
            except ValueError:
                body = None
        challenge = re.search(r'error="([^"]+)"', response.headers.get("www-authenticate", ""))
        error = challenge.group(1) if challenge else (body.get("error") if isinstance(body, dict) and isinstance(body.get("error"), str) else None)
        return Reply(response.status_code, body, response.headers, error, text)

    @property
    def challenge_scope(self) -> str | None:
        """A challenge's `scope` (RFC 6750 3): what a 401 with no error code, or an `insufficient_scope`, asks for (7)."""
        found = re.search(r'scope="([^"]*)"', self.headers.get("www-authenticate", ""))
        return found.group(1) if found else None


# ---------------------------------------------------------------- MCP's wire format

MCP_LEGACY = "2025-06-18"
MCP_MODERN = "2026-07-28"
# MCP 2026-07-28's own errors (Base Protocol, "Error Codes"): HeaderMismatch,
# MissingRequiredClientCapability, UnsupportedProtocolVersion.
MODERN_ERRORS = (-32020, -32021, -32022)


def modern_meta() -> dict[str, Any]:
    """The protocol fields every 2026-07-28 request carries in `_meta` (Base Protocol, "_meta")."""
    return {
        "io.modelcontextprotocol/protocolVersion": MCP_MODERN,
        "io.modelcontextprotocol/clientInfo": {"name": "hypothesis", "version": "0"},
        "io.modelcontextprotocol/clientCapabilities": {},
    }


def mirrored(value: str) -> str:
    """
    A value as a mirrored header carries it (Streamable HTTP, "Value
    Encoding"): unchanged when it is printable ASCII with no surrounding
    whitespace; else, and when it already looks encoded, `=?base64?…?=`
    around the Base64 of its UTF-8.
    """
    plain = value != "" and all(" " <= c <= "~" for c in value) and value == value.strip(" ")
    if plain and not (value.startswith("=?base64?") and value.endswith("?=")):
        return value
    return "=?base64?" + base64.b64encode(value.encode("utf-8")).decode("ascii") + "?="


def header_arguments(schema: Any, args: Any) -> dict[str, str]:
    """
    The `Mcp-Param-{name}` headers for a call: each property reached through
    `properties` alone whose schema has `x-mcp-header`, when the arguments
    hold a value there (Streamable HTTP, "Custom Headers from Tool
    Parameters"). Integers in decimal, booleans as `true` or `false`.
    """
    found: dict[str, str] = {}

    def walk(node: Any, value: Any) -> None:
        properties = node.get("properties") if isinstance(node, dict) else None
        for name, child in (properties or {}).items():
            here = value.get(name) if isinstance(value, dict) else None
            header = child.get("x-mcp-header") if isinstance(child, dict) else None
            if isinstance(header, str) and here is not None:
                if isinstance(here, bool):
                    text = "true" if here else "false"
                elif isinstance(here, (int, str)):
                    text = str(here)
                else:
                    raise AssertionError(f"{header} can't carry {here!r}")
                found[f"Mcp-Param-{header}"] = mirrored(text)
            walk(child, here)

    walk(schema, args)
    return found


def rpc_reply(reply: Reply, rpc_id: Any) -> Reply:
    """A Streamable HTTP answer: JSON, or a stream whose matching `message` event is the JSON-RPC response."""
    if reply.body is None and "text/event-stream" in reply.headers.get("content-type", ""):
        for block in re.split(r"\r\n\r\n|\n\n|\r\r", reply.text):
            data = [line[5:].lstrip(" ") for line in re.split(r"\r\n|\n|\r", block) if line.startswith("data:")]
            if data:
                candidate = json.loads("\n".join(data))
                if isinstance(candidate, dict) and candidate.get("id") == rpc_id:
                    reply.body = candidate
    return reply


# ---------------------------------------------------------------- the agent


class OperatorKey:
    """
    An Ed25519 operator key for Web Bot Auth (5.3;
    draft-ietf-webbotauth-httpsig-protocol-00), separate from the
    `jwks_uri` key and the delegated keys: its `kid` is its RFC 7638
    thumbprint (RFC 8037 A.3), as the draft's `keyid` must be.
    """

    def __init__(self) -> None:
        self.private = Ed25519PrivateKey.generate()
        raw = self.private.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        self.x = b64url(raw)
        members = json.dumps({"crv": "Ed25519", "kty": "OKP", "x": self.x}, separators=(",", ":"), sort_keys=True)
        self.kid = b64url(hashlib.sha256(members.encode("ascii")).digest())

    def public_jwk(self) -> dict[str, Any]:
        return {"kty": "OKP", "crv": "Ed25519", "x": self.x, "kid": self.kid, "use": "sig"}


DIRECTORY_PATH = "/.well-known/http-message-signatures-directory"


def sf_string(value: str) -> str:
    """An RFC 8941 String."""
    if not re.fullmatch(r"[\x20-\x7e]*", value):
        raise ValueError("not an RFC 8941 String")
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def operator_headers(
    key: OperatorKey,
    agent_origin: str,
    method: str,
    url: str,
    headers: dict[str, str],
    *,
    omit: tuple[str, ...] = (),
    corrupt: bool = False,
) -> dict[str, str]:
    """
    5.3: an RFC 9421 signature in the Web Bot Auth profile over `@method`,
    `@authority`, `@path`, the `Signature-Agent` member for its label, and
    `poppy-session` and `authorization` when the request carries them, as
    5.3 requires; `created`, `expires`, `keyid` and `tag="web-bot-auth"`.
    The signature base is RFC 9421 2.5's: one `"<id>": <value>` line per
    component, then `"@signature-params"`, joined by LF. `omit` (component
    names) and `corrupt` are only for the reject rules.
    """
    parts = urllib.parse.urlsplit(url)
    agent = sf_string(agent_origin)
    lower = {name.lower(): value for name, value in headers.items()}
    components: list[tuple[str, str]] = [
        ('"@method"', method.upper()),
        ('"@authority"', (parts.netloc or "").lower()),
        ('"@path"', parts.path or "/"),
        ('"signature-agent";key="sig1"', agent),
    ]
    for name in ("poppy-session", "authorization"):
        if name in lower:
            components.append((f'"{name}"', lower[name]))
    components = [(cid, value) for cid, value in components if cid.split(";")[0].strip('"') not in omit]
    created = int(time.time())
    inner = "(" + " ".join(cid for cid, _ in components) + ")"
    params = f';created={created};expires={created + 300};keyid={sf_string(key.kid)};tag="web-bot-auth"'
    base = "\n".join([f"{cid}: {value}" for cid, value in components] + [f'"@signature-params": {inner}{params}'])
    signature = bytearray(key.private.sign(base.encode("utf-8")))
    if corrupt:
        signature[0] ^= 0xFF
    return {
        "Signature-Agent": f"sig1={agent}",
        "Signature-Input": f"sig1={inner}{params}",
        "Signature": f"sig1=:{base64.b64encode(bytes(signature)).decode('ascii')}:",
    }


@dataclass
class PersonalAgent:
    """Our identity (4.1): a client metadata document at `client_id`, and the keys `jwks_uri` publishes."""

    origin: str = "https://agent.hypothesis.test"
    signing_key: Es256Key = field(default_factory=lambda: Es256Key(kid=random_id("k_", 8)))
    # 5.3 (a SHOULD): an operator key whose directory is at `origin` + DIRECTORY_PATH; None sends no operator signature.
    operator_key: OperatorKey | None = field(default_factory=OperatorKey)

    @property
    def client_id(self) -> str:
        return f"{self.origin}/poppy/client.json"

    @property
    def jwks_uri(self) -> str:
        return f"{self.origin}/poppy/jwks.json"

    @property
    def redirect_uri(self) -> str:
        return f"{self.origin}/poppy/callback"

    def documents(self) -> dict[str, Any]:
        metadata: dict[str, Any] = {
            "client_id": self.client_id,
            "client_name": "Hypothesis Agent",
            "jwks_uri": self.jwks_uri,
            "redirect_uris": [self.redirect_uri],
            "token_endpoint_auth_method": "private_key_jwt",
        }
        # 0.4 declares extensions per Session, in Poppy-Extensions (3.3, 3.4), not in client metadata.
        documents: dict[str, Any] = {self.client_id: metadata, self.jwks_uri: {"keys": [self.signing_key.public_jwk()]}}
        if self.operator_key is not None:
            documents[self.origin + DIRECTORY_PATH] = {"keys": [self.operator_key.public_jwk()]}
        return documents

    def client_assertion(self, aud: Any, *, lifetime: int = ASSERTION_LIFETIME, jti: str | None = None, typ: str = "JWT") -> str:
        """4.1: `iss` and `sub` the `client_id`, `aud` the Company's issuer as a single string, short-lived, a fresh `jti`."""
        now = int(time.time())
        claims = {"iss": self.client_id, "sub": self.client_id, "aud": aud, "iat": now, "exp": now + lifetime, "jti": jti or random_id()}
        return self.signing_key.sign(claims, {"typ": typ, "kid": self.signing_key.kid})

    def delegation(self, key: Es256Key, *, hours: float = DELEGATION_HOURS, extra: dict[str, Any] | None = None, typ: str = "poppy-delegation+jwt") -> str:
        """
        5.2: a delegation for `key`, signed by our `jwks_uri` key: `iss`, the
        key in `cnf.jwk`, `iat` rounded down to the hour, at most 24 hours,
        and a `jti`. Nothing about a User or a Company (`extra` is only for
        the reject rule that breaks that).
        """
        issued = int(time.time()) // 3600 * 3600
        claims: dict[str, Any] = {"iss": self.client_id, "cnf": {"jwk": key.public_jwk()}, "iat": issued, "exp": issued + int(hours * 3600), "jti": random_id()}
        claims.update(extra or {})
        return self.signing_key.sign(claims, {"typ": typ, "kid": self.signing_key.kid})


@dataclass
class Company:
    """What discovery (3, 3.2) established about one Company."""

    domain: str
    document: dict[str, Any]  # the chosen version's document (3.4)
    issuer: str
    metadata: dict[str, Any]
    conversations: str | None
    openapi: str | None
    mcp: str | None = None  # the MCP server's `url` (7)
    browser_session: str | None = None  # `web.browser_session_endpoint` (6)
    tasks: str | None = None  # `tasks.endpoint` (9): excluded tasks, skills and the feedback endpoint, per Session
    operations: dict[str, Any] | None = None  # the Operations extension's version 3 entry (Ops 2)
    mediated: dict[str, Any] | None = None  # the Mediated Sign-In extension's entry, when its grant is listed too
    # 3.2: no OAuth issuer (a 404, or no authorization servers): `issuer` is then the Company's identifier,
    # https://{organization.domain}, the Session JWT's `aud`; `metadata` is empty and nothing signs in.
    issuerless: bool = False
    resource_scopes: list[str] = field(default_factory=list)  # `scopes_supported` of the domain's protected resource metadata (3.2, 4.7)
    version: str = PROTOCOL_VERSIONS[0]  # the version we implement, compatible with the chosen one, sent in Poppy-Version (3.4)
    listed: list[str] = field(default_factory=list)  # protocol_version and the versions in supported_versions (3.4)

    @property
    def web_disabled(self) -> bool:
        """6: `web.disabled`: no browser on the website; pages may still be fetched with the Session header (5.2)."""
        web = self.document.get("web")
        return isinstance(web, dict) and web.get("disabled") is True

    @property
    def sign_in_disabled(self) -> bool:
        """3.2: `auth.disabled`: no Direct, Device or Mediated Sign-In."""
        auth = self.document.get("auth")
        return isinstance(auth, dict) and auth.get("disabled") is True

    @property
    def organization_domain(self) -> str:
        return self.document["organization"]["domain"].lower()

    @property
    def token_endpoint(self) -> str | None:
        return self.metadata.get("token_endpoint")

    @property
    def revocation_endpoint(self) -> str | None:
        return self.metadata.get("revocation_endpoint")

    @property
    def dpop(self) -> bool:
        """4.5: a proof with token requests only when the issuer lists `dpop_signing_alg_values_supported` (with ES256, which we sign)."""
        return "ES256" in self.metadata.get("dpop_signing_alg_values_supported", [])

    def grants(self) -> list[str]:
        return [str(g) for g in self.metadata.get("grant_types_supported", [])]

    def offered(self, kind: str) -> list[str]:
        """
        The scopes a sign-in type (`direct`, `device`, `mediated`) can ask
        for, or [] when it isn't offered: sign-in types come from
        `grant_types_supported` (3.2), none with `auth.disabled`, each able
        to ask for any scope in the issuer's `scopes_supported` or the
        domain's protected resource metadata's (4.7); Mediated Sign-In for
        its extension's scopes. `poppy:browser-sign-in` only from a Company
        that lists `browser_session_endpoint` (6).
        """
        if self.sign_in_disabled:
            return []
        supported = list(dict.fromkeys([str(s) for s in self.metadata.get("scopes_supported", [])] + self.resource_scopes))
        if self.browser_session is None:
            supported = [s for s in supported if s != BROWSER_SIGN_IN]
        if kind == "direct":
            return supported if "authorization_code" in self.grants() else []
        if kind == "device":
            return supported if DEVICE_CODE in self.grants() else []
        if kind == "mediated":
            return [s for s in self.mediated.get("scopes", []) if s in supported] if self.mediated else []
        raise ValueError(kind)

    def hosts(self) -> list[str]:
        """The Company's own hosts: its domain, and the hosts of its issuer's `protected_resources` (3.2)."""
        resources = [urllib.parse.urlsplit(str(r)).hostname or "" for r in self.metadata.get("protected_resources", [])]
        return [d.lower() for d in [self.organization_domain, *resources] if d]

    def may_receive_tokens(self, url: str) -> bool:
        """A Session JWT or token goes only to an https host equal to or under one of the Company's hosts (our reading of N10)."""
        parts = urllib.parse.urlsplit(url)
        host = (parts.hostname or "").lower()
        return parts.scheme == "https" and any(host == d or host.endswith("." + d) for d in self.hosts())

    def on_own_domain(self, url: str) -> bool:
        """An https URL on `organization.domain` or one of its subdomains."""
        try:
            parts = urllib.parse.urlsplit(url)
            host = (parts.hostname or "").lower()
        except ValueError:
            return False
        domain = self.organization_domain
        return parts.scheme == "https" and (host == domain or host.endswith("." + domain))


class PushRefused(Exception):
    """A pushed authorization request (RFC 9126) the Company refused; `reply` is its answer."""

    def __init__(self, reply: "Reply") -> None:
        super().__init__(f"pushed authorization request: HTTP {reply.status} {reply.error}")
        self.reply = reply


class DiscoveryError(Exception):
    pass


def protected_resource_metadata_url(resource: str) -> str:
    """RFC 9728 3.1: `/.well-known/oauth-protected-resource` between the host and the resource's path."""
    parts = urllib.parse.urlsplit(resource)
    path = parts.path.rstrip("/")
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, "/.well-known/oauth-protected-resource" + path, "", ""))


def metadata_url(issuer: str) -> str:
    """RFC 8414 3.1: the well-known segment goes between the host and any path, without its trailing slash."""
    parts = urllib.parse.urlsplit(issuer)
    path = parts.path.rstrip("/")
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, "/.well-known/oauth-authorization-server" + path, "", ""))


@dataclass
class User:
    """
    A User of our agent at this Company (5.1): a random User ID, never
    derived from them; a delegated key used for this User ID alone (5.2),
    with its delegation; and a DPoP key (4.5).
    """

    user_id: str = field(default_factory=lambda: random_id("usr_"))
    session_key: Es256Key = field(default_factory=Es256Key)
    dpop_key: Es256Key = field(default_factory=Es256Key)
    delegation: str | None = None  # signed once, by the agent this User belongs to


@dataclass
class Session:
    """
    A Session (5): a `sid` the agent chose, its User, the protocol version
    and extensions it declares on every request (3.4: the same for the whole
    Session; another choice is another Session), and, while signed in, the
    access token it sends, its scheme and the key a DPoP-bound one is bound
    to. Nothing is requested to start one (5.2, 5.3).
    """

    user: User
    sid: str = field(default_factory=lambda: random_id("sid_"))
    token: str | None = None
    token_type: str | None = None  # "DPoP" or "Bearer", as the token response named it (4.5)
    key: Es256Key | None = None  # the DPoP key the token is bound to
    version: str | None = None  # None: the one its Company's discovery chose
    extensions: dict[str, str] = field(default_factory=dict)  # name: version, each listed by the Company (3.3)

    def extensions_header(self) -> str | None:
        """`Poppy-Extensions`: an RFC 9651 List of Strings, each with its version as a String `v` parameter; none when it uses none."""
        if not self.extensions:
            return None
        return ", ".join(f"{sf_string(name)};v={sf_string(version)}" for name, version in self.extensions.items())

    def sign_in(self, body: dict[str, Any], key: Es256Key) -> None:
        self.token = body["access_token"]
        self.token_type = body["token_type"]
        self.key = key if self.token_type == "DPoP" else None

    def sign_out(self) -> None:
        self.token, self.token_type, self.key = None, None, None


@dataclass
class Sent:
    """The JWTs and proof a request carried, so a reject rule can replay one."""

    client_assertion: str | None = None
    session_jwt: str | None = None
    proof: str | None = None


def approval(operation_id: str, revision: str, approver: str, *, input_type: str | None = "tap", reference: str | None = None, approved_at: int | None = None) -> dict[str, Any]:
    """
    An Operations 3 approval (Ops 6): `operation_id`, `revision`, and
    `approver` (`user` or `agent`), which MUST be there; `approved_at` in Unix
    seconds; `input_type` only with `user` (`tap`, as readings v04-input-type
    has it); and a `reference` of our own, new for each approval, so it is
    unique among the User's approvals and never reaches two Companies
    (readings v04-reference).
    """
    given: dict[str, Any] = {"operation_id": operation_id, "revision": revision, "approver": approver, "approved_at": approved_at or int(time.time())}
    if approver == "user" and input_type is not None:
        given["input_type"] = input_type
    given["reference"] = reference or random_id("apr_", 12)
    return given


def approval_header(given: dict[str, Any]) -> str:
    """
    `Poppy-Approval` (Ops 6): an RFC 9651 Dictionary, its members in the
    order given: Strings, and Integers for whole numbers (`approved_at`).
    Booleans and other values are only for the reject rules, as Tokens.
    """
    parts = []
    for name, value in given.items():
        if isinstance(value, bool):
            parts.append(name if value else f"{name}=?0")
        elif isinstance(value, int):
            parts.append(f"{name}={value}")
        elif isinstance(value, str):
            parts.append(f"{name}={sf_string(value)}")
        else:
            raise ValueError(f"{name}: {value!r} has no RFC 9651 form here")
    return ", ".join(parts)


class Poppy:
    """The HTTP side: one client for every Poppy request, as our spec's "One HTTP client for Poppy"."""

    def __init__(self, agent: PersonalAgent, http: httpx.Client) -> None:
        self.agent = agent
        self.http = http
        self.nonces: dict[str, str] = {}  # per server origin (our reading of S23)
        self.last = Sent()

    # ---- discovery (3) ----

    def fetch_document(self, url: str) -> tuple[httpx.Response, str]:
        """
        3: the well-known URL, following redirects, each to an HTTPS URL. The
        document is used only when the last URL's path is exactly
        `/.well-known/poppy.json` with no query. Returns the response and the
        host that served it.
        """
        for _ in range(6):
            response = self.http.get(url, follow_redirects=False)
            if response.status_code not in (301, 302, 303, 307, 308):
                parts = urllib.parse.urlsplit(url)
                if parts.path != "/.well-known/poppy.json" or parts.query:
                    raise DiscoveryError(f"poppy.json came from {url}, not a well-known path")
                return response, (parts.hostname or "").lower()
            target = urllib.parse.urljoin(url, response.headers.get("location", ""))
            if not target.startswith("https://"):
                raise DiscoveryError(f"poppy.json redirected to {target}, not HTTPS")
            url = target
        raise DiscoveryError("poppy.json redirected too often")

    def discover(self, domain: str) -> Company:
        response, host = self.fetch_document(f"https://{domain}/.well-known/poppy.json")
        if response.status_code != 200:
            raise DiscoveryError(f"poppy.json: HTTP {response.status_code}")
        document = strict_json(response.text)
        if not isinstance(document, dict):
            raise DiscoveryError("poppy.json isn't an object")
        org = str(document.get("organization", {}).get("domain", ""))
        if org.lower() != host:
            raise DiscoveryError(f"organization.domain {org!r} isn't the host that served it, {host!r}")
        # 3.4: the newest version, among protocol_version and supported_versions, compatible with one we implement;
        # compatible is the same major version and, before 1.0, the same minor version.
        linked = document.get("supported_versions") if isinstance(document.get("supported_versions"), dict) else {}
        listed = [str(document.get("protocol_version"))] + [str(v) for v in linked]
        usable = [v for v in listed if implemented(v)]
        if not usable:
            raise DiscoveryError(f"no version we implement: {document.get('protocol_version')!r} and {sorted(linked)} (3.4: MUST NOT use any)")
        chosen = max(usable, key=version_order)
        if chosen != document.get("protocol_version"):
            url = linked.get(chosen)
            if not isinstance(url, str):
                raise DiscoveryError(f"supported_versions links {chosen} with no URL")
            parts = urllib.parse.urlsplit(url)
            # 3.4: HTTPS on the host that served poppy.json, never by redirect; readings v04-linked-document: else as if unlisted.
            if parts.scheme != "https" or (parts.hostname or "").lower() != host:
                raise DiscoveryError(f"the {chosen} document {url} isn't HTTPS on {host}")
            linked_response = self.http.get(url, follow_redirects=False)
            if linked_response.status_code != 200:
                raise DiscoveryError(f"the {chosen} document: HTTP {linked_response.status_code}")
            document = strict_json(linked_response.text)
            if not isinstance(document, dict) or document.get("protocol_version") != chosen or "supported_versions" in document:
                raise DiscoveryError(f"the document linked for {chosen} names another version, or links others (3.4)")
            if str(document.get("organization", {}).get("domain", "")).lower() != org.lower():
                raise DiscoveryError("the linked document names another organization.domain (3.4)")
        version = implemented(chosen)
        assert version is not None
        auth = document.get("auth") if isinstance(document.get("auth"), dict) else {}
        extensions = document.get("extensions", {}) if isinstance(document.get("extensions"), dict) else {}
        protocols = document.get("agent", {}).get("protocols", [])
        if not version.startswith("0."):
            # 1.0 8.1: each conversation protocol has a description of what the agent there can help with.
            for protocol in protocols:
                if not isinstance(protocol, dict) or not isinstance(protocol.get("description"), str) or not protocol["description"].strip():
                    raise DiscoveryError("a conversation protocol without a description (1.0: 8.1)")
        web = document.get("web") if isinstance(document.get("web"), dict) else {}
        if web.get("disabled") is True and "browser_session_endpoint" in web:
            raise DiscoveryError("web.disabled with a browser_session_endpoint (6: MUST NOT list it)")
        # 3.2: the issuer from the domain's protected resource metadata (RFC 9728). A 404, or metadata
        # without authorization servers, means none; any other status settles nothing.
        prm_response = self.http.get(protected_resource_metadata_url(f"https://{org.lower()}"), follow_redirects=False)
        resource_scopes: list[str] = []
        if prm_response.status_code == 404:
            servers: list[str] = []
        elif prm_response.status_code != 200:
            raise DiscoveryError(f"protected resource metadata: HTTP {prm_response.status_code}")
        else:
            prm = strict_json(prm_response.text)
            if prm.get("resource") != f"https://{org.lower()}":
                raise DiscoveryError("the protected resource metadata names another resource")
            servers = [str(s) for s in prm.get("authorization_servers", [])]
            resource_scopes = [str(s) for s in prm.get("scopes_supported", [])]
        signs_in = "mediated-sign-in" in extensions or any(p.get("access") == "signed_in" for p in protocols if isinstance(p, dict))
        if auth.get("disabled") is True and signs_in:
            raise DiscoveryError("auth.disabled with Mediated Sign-In or signed_in access (3.2)")
        if not servers:
            # 3.2: valid only when nothing offers sign-in: no auth.issuer, no Mediated Sign-In, no signed_in access.
            if "issuer" in auth or signs_in:
                raise DiscoveryError("poppy.json offers sign-in, but the Company has no issuer")
            return self._company(domain, document, f"https://{org.lower()}", {}, protocols, extensions, issuerless=True, version=version, listed=listed)
        if isinstance(auth.get("issuer"), str):
            if auth["issuer"] not in servers:
                raise DiscoveryError("auth.issuer isn't in authorization_servers")
            issuer = auth["issuer"]
        elif len(servers) == 1:
            issuer = servers[0]
        else:
            raise DiscoveryError("no one issuer: authorization_servers lists none, or several and auth.issuer picks none")
        if not issuer.startswith("https://"):
            raise DiscoveryError("issuer isn't https")
        meta_response = self.http.get(metadata_url(issuer), follow_redirects=False)
        if meta_response.status_code != 200:
            raise DiscoveryError(f"issuer metadata: HTTP {meta_response.status_code}")
        metadata = strict_json(meta_response.text)
        if metadata.get("issuer") != issuer:
            raise DiscoveryError("issuer metadata names another issuer")
        if f"https://{org.lower()}" not in [str(r).lower() for r in metadata.get("protected_resources", [])]:
            raise DiscoveryError("the issuer's protected_resources doesn't list the domain")
        for name in ("token_endpoint", "revocation_endpoint"):
            if not isinstance(metadata.get(name), str):
                raise DiscoveryError(f"no {name}")
        grants = metadata.get("grant_types_supported", [])
        if "refresh_token" not in grants:
            raise DiscoveryError("grant_types_supported without refresh_token (3.2)")
        if "authorization_code" in grants and "authorization_endpoint" not in metadata:
            raise DiscoveryError("Direct Sign-In without authorization_endpoint")
        if DEVICE_CODE in grants and "device_authorization_endpoint" not in metadata:
            raise DiscoveryError("Device Sign-In without device_authorization_endpoint")
        return self._company(domain, document, issuer, metadata, protocols, extensions, resource_scopes=resource_scopes, version=version, listed=listed)

    def _company(
        self, domain: str, document: dict[str, Any], identifier: str, metadata: dict[str, Any], protocols: list[Any], extensions: dict[str, Any],
        *, issuerless: bool = False, resource_scopes: list[str] | None = None, version: str, listed: list[str],
    ) -> Company:
        grants = metadata.get("grant_types_supported", [])
        conversations = next((p["endpoint"] for p in protocols if p.get("type") == "poppy"), None)
        openapi = next((a["url"] for a in document.get("apis", []) if a.get("type") == "openapi"), None)
        mcp = next((a["url"] for a in document.get("apis", []) if a.get("type") == "mcp"), None)

        def entry(name: str, version: str) -> dict[str, Any] | None:
            """3.3: an extension is a list with an entry per major version; one we don't support, or another shape, is ignored."""
            entries = extensions.get(name)
            found = [e for e in entries if isinstance(e, dict) and e.get("version") == version] if isinstance(entries, list) else []
            return found[0] if found else None

        mediated = entry("mediated-sign-in", "1")
        web = document.get("web") if isinstance(document.get("web"), dict) else {}
        tasks = document.get("tasks", {}).get("endpoint") if isinstance(document.get("tasks"), dict) else None
        return Company(
            domain, document, identifier, metadata, conversations, openapi, mcp,
            None if web.get("disabled") is True else web.get("browser_session_endpoint"), tasks,
            entry("operations", "3"), mediated if MEDIATED_GRANT in grants else None, issuerless, resource_scopes or [], version, listed,
        )

    # ---- JWTs (4.1, 4.5, 5.2) ----

    def proof(self, key: Es256Key, method: str, url: str, token: str | None = None, *, jti: str | None = None) -> str:
        """A DPoP proof (RFC 9449): `htu` without query or fragment, `ath` with a token, the server's nonce."""
        claims: dict[str, Any] = {"htm": method, "htu": htu(url), "iat": int(time.time()), "jti": jti or random_id()}
        if token is not None:
            claims["ath"] = ath(token)
        nonce = self.nonces.get(origin_of(url))
        if nonce is not None:
            claims["nonce"] = nonce
        return key.sign(claims, {"typ": "dpop+jwt", "jwk": key.public_jwk()})

    def delegation_for(self, user: User) -> str:
        """The User's delegation, signed once by this agent (5.2: one delegated key for one User ID)."""
        if user.delegation is None:
            user.delegation = self.agent.delegation(user.session_key)
        return user.delegation

    def session_jwt(
        self,
        company: Company,
        session: Session,
        method: str,
        url: str,
        token: str | None,
        *,
        claims: dict[str, Any] | None = None,
        header: dict[str, Any] | None = None,
        key: Es256Key | None = None,
        drop: tuple[str, ...] = (),
    ) -> str:
        """
        5.2: the Session JWT for one request: `typ` poppy-session+jwt, ES256,
        `kid` the delegated key's thumbprint, the delegation in `poppy_dlg`;
        `iss`, `aud` (the issuer), `sid`, `sub`, `htm`, `htu`, `iat`, `jti`,
        and `ath` only with an access token. `claims`, `header`, `key` and
        `drop` are only for the reject rules.
        """
        signing = key or session.user.session_key
        body: dict[str, Any] = {
            "iss": self.agent.client_id,
            "aud": company.issuer,
            "sid": session.sid,
            "sub": session.user.user_id,
            "htm": method,
            "htu": htu(url),
            "iat": int(time.time()),
            "jti": random_id(),
        }
        if token is not None:
            body["ath"] = ath(token)
        body.update(claims or {})
        for name in drop:
            body.pop(name, None)
        head: dict[str, Any] = {"typ": "poppy-session+jwt", "kid": session.user.session_key.thumbprint(), "poppy_dlg": self.delegation_for(session.user)}
        head.update(header or {})
        return signing.sign(body, head)

    def _keep_nonce(self, url: str, response: httpx.Response) -> None:
        nonce = response.headers.get("dpop-nonce")
        if nonce:
            self.nonces[origin_of(url)] = nonce

    # ---- the token endpoint (4.1 to 4.6) ----

    def token_request(
        self,
        company: Company,
        key: Es256Key | None,
        form: dict[str, str | Callable[[], str]],
        *,
        endpoint: str | None = None,
        client_assertion: str | Callable[[], str] | None = None,
        proof: str | None = None,
        dpop: bool | None = None,
        retry_limited: bool = True,
        headers: dict[str, str] | None = None,
    ) -> Reply:
        """
        A form POST with a client assertion naming the issuer (4.1) and, when
        the issuer asks for DPoP (4.5), a proof without `ath`. Never the
        Session header (5.2). Callables in `form` make a fresh value per
        attempt; `headers` is only for the reject rule that adds the
        Session header. Retries once on `use_dpop_nonce`, and after a 429
        once its `Retry-After` has passed (the transport waits).
        """
        url = endpoint or company.token_endpoint
        send_proof = company.dpop if dpop is None else dpop
        nonce_retried, limited = False, 0
        while True:
            made = client_assertion() if callable(client_assertion) else client_assertion
            if made is None:
                made = self.agent.client_assertion(company.issuer)
            body = {name: value() if callable(value) else value for name, value in form.items()}
            body.update(client_id=self.agent.client_id, client_assertion_type=CLIENT_ASSERTION_TYPE, client_assertion=made)
            request_headers = {"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"}
            sent_proof = None
            if send_proof:
                sent_proof = proof or self.proof(key or Es256Key(), "POST", url)
                request_headers["DPoP"] = sent_proof
            request_headers.update(headers or {})
            response = self.http.post(url, content=urllib.parse.urlencode(body), headers=request_headers)
            self._keep_nonce(url, response)
            self.last = Sent(made, None, sent_proof)
            reply = Reply.of(response)
            if reply.status == 429 and retry_limited and limited < MAX_LIMITED_RETRIES:
                limited += 1
                continue
            if reply.status == 400 and reply.error == "use_dpop_nonce" and not nonce_retried and proof is None and send_proof:
                nonce_retried = True
                continue
            return reply

    def refresh(self, company: Company, key: Es256Key, refresh_token: str, *, scope: list[str] | None = None, resource: str | None = None) -> Reply:
        """4.4: an access token from the refresh token, narrower with `scope`, for one service with `resource` (RFC 8707)."""
        form: dict[str, str | Callable[[], str]] = {"grant_type": "refresh_token", "refresh_token": refresh_token}
        if scope is not None:
            form["scope"] = " ".join(scope)
        if resource is not None:
            form["resource"] = resource
        return self.token_request(company, key, form)

    def revoke(self, company: Company, refresh_token: str) -> Reply:
        """Sign-out (4.6): revoke the refresh token, RFC 7009, with the client assertion and no proof."""
        return self.token_request(
            company, None, {"token": refresh_token, "token_type_hint": "refresh_token"}, endpoint=company.revocation_endpoint, dpop=False
        )

    # ---- sign-in (4.2, 4.3, Mediated Sign-In) ----

    def authorization_url(self, company: Company, scopes: list[str], key: Es256Key | None = None) -> tuple[str, str, str]:
        """
        Direct Sign-In (4.2): the URL for the User's browser, its `state` and
        the PKCE verifier. From 1.0 the request carries `prompt=consent`: our
        redirect isn't received only on the device that opened the URL. When
        the issuer lists `pushed_authorization_request_endpoint`, the request
        is pushed (RFC 9126), with the client assertion and, when the issuer
        uses DPoP, a proof by `key`, the key the code is then exchanged with
        (RFC 9449 10.1); the URL carries only `client_id` and `request_uri`.
        A push the Company refuses raises `PushRefused`.
        """
        state = random_id()
        verifier = random_id(nbytes=32)
        challenge = b64url(hashlib.sha256(verifier.encode("ascii")).digest())
        request = {
            "response_type": "code",
            "client_id": self.agent.client_id,
            "redirect_uri": self.agent.redirect_uri,
            "scope": " ".join(scopes),
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            **({} if company.version.startswith("0.") else {"prompt": "consent"}),
        }
        endpoint = company.metadata.get("pushed_authorization_request_endpoint")
        if isinstance(endpoint, str):
            pushed = self.token_request(company, key, {name: value for name, value in request.items() if name != "client_id"}, endpoint=endpoint)
            if pushed.status != 201 or not isinstance(pushed.body, dict) or not isinstance(pushed.body.get("request_uri"), str):
                raise PushRefused(pushed)
            request = {"client_id": self.agent.client_id, "request_uri": pushed.body["request_uri"]}
        return f"{company.metadata['authorization_endpoint']}?{urllib.parse.urlencode(request)}", state, verifier

    def callback(self, company: Company, redirect: str, state: str) -> dict[str, str]:
        """Check the redirect (4.2): our redirect URI, our `state`, the Company's `iss` (RFC 9207)."""
        if not redirect.startswith(self.agent.redirect_uri + "?"):
            raise AssertionError(f"redirect went to {redirect}")
        params = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(redirect).query))
        if params.get("state") != state:
            raise AssertionError("callback state isn't ours")
        if params.get("iss") != company.issuer:
            raise AssertionError(f"callback iss {params.get('iss')!r} isn't {company.issuer!r}")
        return params

    def exchange_code(self, company: Company, key: Es256Key, code: str, verifier: str) -> Reply:
        """The code at the token endpoint; a sign-in names no Session (5.4)."""
        return self.token_request(
            company, key, {"grant_type": "authorization_code", "code": code, "redirect_uri": self.agent.redirect_uri, "code_verifier": verifier}
        )

    def device_start(self, company: Company, scopes: list[str]) -> Reply:
        endpoint = company.metadata["device_authorization_endpoint"]
        return self.token_request(company, None, {"scope": " ".join(scopes)}, endpoint=endpoint, dpop=False)

    def device_poll(self, company: Company, key: Es256Key, device_code: str) -> Reply:
        return self.token_request(company, key, {"grant_type": DEVICE_CODE, "device_code": device_code})

    def mediated_start(self, company: Company, key: Es256Key, scopes: list[str], fields: dict[str, str]) -> Reply:
        """Mediated Sign-In (3): the credentials the extension's `fields` name, and `scope`, at the token endpoint, never elsewhere."""
        assert company.mediated is not None
        return self.token_request(company, key, {"grant_type": MEDIATED_GRANT, "scope": " ".join(scopes), **fields})

    def mediated_code(self, company: Company, key: Es256Key, sign_in_id: str, code: str) -> Reply:
        """Mediated Sign-In (4): after `code_required`, `sign_in_id` and `one_time_code` alone, not the credentials or scope."""
        return self.token_request(company, key, {"grant_type": MEDIATED_GRANT, "sign_in_id": sign_in_id, "one_time_code": code})

    # ---- resources (5.2, 7, 8) ----

    def resource(
        self,
        session: Session,
        method: str,
        url: str,
        company: Company,
        *,
        body: Any = None,
        raw_body: str | None = None,
        content: bytes | None = None,
        content_type: str = "application/json",
        params: dict[str, str] | None = None,
        headers: dict[str, str] | None = None,
        token: Any = DEFAULT,
        scheme: str | None = None,
        key: Es256Key | None = None,
        proof: str | None = None,
        session_jwt: str | Callable[[str, str, str | None], str] | None = None,
        retry_limited: bool = True,
        operator: bool = True,
        operator_omit: tuple[str, ...] = (),
        operator_corrupt: bool = False,
        version: Any = DEFAULT,
        extensions: Any = DEFAULT,
        accept: str = "application/json",
    ) -> Reply:
        """
        A request with the Session header (5.2), `Poppy-Version` and, when
        the Session uses extensions, `Poppy-Extensions`, as the Session
        declares them (3.4), the agent's operator signature when it has an
        operator key (5.3), and, signed in, the access token with the scheme
        its `token_type` named (4.5), and a DPoP proof with `ath` when it is
        DPoP-bound. Only to the Company's hosts, never with a token or
        Session JWT in the URL. Retries once on `use_dpop_nonce`, and after a
        429 once its `Retry-After` has passed, each time with a new Session
        JWT and proof. `token`, `scheme`, `key`, `proof`, `session_jwt`,
        `version` and `extensions` (None: left out) are only for the reject
        rules.
        """
        if not company.may_receive_tokens(url):
            raise AssertionError(f"refusing to send a Session JWT or token to {url}")
        sent_token = session.token if token is DEFAULT else token
        sent_scheme = scheme or session.token_type or "Bearer"
        full = httpx.URL(url, params=params or {})
        if sent_token is not None and sent_token in str(full):
            raise AssertionError("refusing to put a token in a URL")
        if content is None:
            text = raw_body if raw_body is not None else (json.dumps(body, allow_nan=False) if body is not None else None)
            content = text.encode("utf-8") if text is not None else None
        nonce_retried, limited = False, 0
        while True:
            if callable(session_jwt):
                header_value = session_jwt(method, url, sent_token)
            elif session_jwt is not None:
                header_value = session_jwt
            else:
                header_value = self.session_jwt(company, session, method, url, sent_token)
            request_headers = {"Poppy-Session": header_value, "Accept": accept}
            sent_version = (session.version or company.version) if version is DEFAULT else version
            sent_extensions = session.extensions_header() if extensions is DEFAULT else extensions
            if sent_version is not None:
                request_headers["Poppy-Version"] = sent_version
            if sent_extensions is not None:
                request_headers["Poppy-Extensions"] = sent_extensions
            sent_proof = None
            if sent_token is not None:
                request_headers["Authorization"] = f"{sent_scheme} {sent_token}"
                if sent_scheme == "DPoP":
                    proof_key = key or session.key or session.user.dpop_key
                    sent_proof = proof or self.proof(proof_key, method, url, sent_token)
                    request_headers["DPoP"] = sent_proof
            if content is not None:
                request_headers["Content-Type"] = content_type
            request_headers.update(headers or {})
            # 5.3: the operator signature last, over the Session header and token it covers.
            # `operator`, `operator_omit` and `operator_corrupt` are only for the reject rules.
            if operator and self.agent.operator_key is not None:
                request_headers.update(operator_headers(self.agent.operator_key, self.agent.origin, method, url, request_headers, omit=operator_omit, corrupt=operator_corrupt))
            response = self.http.request(method, full, content=content, headers=request_headers)
            self._keep_nonce(url, response)
            self.last = Sent(None, header_value, sent_proof)
            reply = Reply.of(response)
            if reply.status == 429 and retry_limited and limited < MAX_LIMITED_RETRIES:
                limited += 1
                continue
            if reply.status == 401 and reply.error == "use_dpop_nonce" and not nonce_retried and proof is None and sent_scheme == "DPoP":
                nonce_retried = True
                continue
            return reply

    # ---- APIs (7): the OpenAPI writes the state machines use ----

    def exchange(self, session: Session, company: Company, api_base: str, idempotency_key: str | None, *, approval: dict[str, Any] | None = None) -> Reply:
        """
        `POST /orders/ord_7Hk2/exchanges` (the fixture's `openapi_write`),
        with an `Idempotency-Key`, and with `Poppy-Approval` when it is the
        same request again with the User's approval (Ops 6).
        """
        headers: dict[str, str] = {}
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        if approval is not None:
            headers["Poppy-Approval"] = approval_header(approval)
        body = {"item_id": "itm_4Qa", "replacement_sku": "stormline-insulated-m"}
        return self.resource(session, "POST", f"{api_base}/orders/ord_7Hk2/exchanges", company, body=body, headers=headers)

    def upload_photo(self, session: Session, company: Company, api_base: str, name: str, data: bytes) -> Reply:
        """`POST /photos`: one photo as `multipart/form-data` (RFC 7578), in the field `photo`."""
        boundary = random_id("b", 12)
        head = (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"photo\"; filename=\"{name}\"\r\n"
            "Content-Type: image/jpeg\r\n\r\n"
        ).encode()
        content = head + data + f"\r\n--{boundary}--\r\n".encode()
        return self.resource(
            session, "POST", f"{api_base}/photos", company, content=content, content_type=f"multipart/form-data; boundary={boundary}"
        )

    def order_prints(self, session: Session, company: Company, api_base: str, order: dict[str, Any], idempotency_key: str, *, approval: dict[str, Any] | None = None) -> Reply:
        headers = {"Idempotency-Key": idempotency_key}
        if approval is not None:
            headers["Poppy-Approval"] = approval_header(approval)
        return self.resource(session, "POST", f"{api_base}/prints", company, body=order, headers=headers)

    # ---- MCP (7) ----

    def mcp(
        self,
        session: Session,
        company: Company,
        rpc: dict[str, Any],
        *,
        mcp_session: str | None = None,
        token: Any = DEFAULT,
        scheme: str | None = None,
        url: str | None = None,
    ) -> Reply:
        """
        One JSON-RPC message to the MCP server over Streamable HTTP
        (MCP 2025-06-18): the Session header, and, signed in, the token
        issued for this server's `url` (4.5, RFC 8707), in its scheme. Accept
        both JSON and SSE, `Mcp-Session-Id` and `MCP-Protocol-Version` after
        `initialize`. `token`, `scheme` and `url` are only for the reject rules.
        """
        target = url or company.mcp
        assert target is not None
        headers = {"Accept": "application/json, text/event-stream"}
        if mcp_session is not None:
            headers["Mcp-Session-Id"] = mcp_session
            headers["MCP-Protocol-Version"] = "2025-06-18"
        reply = self.resource(session, "POST", target, company, raw_body=json.dumps(rpc), headers=headers, token=token, scheme=scheme)
        return rpc_reply(reply, rpc.get("id"))

    def mcp_modern(
        self,
        session: Session,
        company: Company,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        tool: dict[str, Any] | None = None,
        meta: dict[str, Any] | None = None,
        headers: dict[str, str | None] | None = None,
    ) -> Reply:
        """
        One request in MCP 2026-07-28's stateless lifecycle: no handshake and
        no MCP session. The version, the client and its (empty) capabilities
        go in `_meta` beside any other members (the Poppy approval), and are
        mirrored into `MCP-Protocol-Version` and `Mcp-Method`; a `tools/call`
        adds `Mcp-Name` and a `Mcp-Param-{name}` header for each argument the
        tool's schema marks with `x-mcp-header` (Streamable HTTP, "Request
        Metadata"). `headers` replaces or (with None) removes headers, for the
        reject rules only.
        """
        target = company.mcp
        assert target is not None
        sent = dict(params or {})
        sent["_meta"] = {**(meta or {}), **modern_meta()}
        rpc = {"jsonrpc": "2.0", "id": int.from_bytes(os.urandom(4), "big"), "method": method, "params": sent}
        request_headers: dict[str, str] = {"Accept": "application/json, text/event-stream", "MCP-Protocol-Version": MCP_MODERN, "Mcp-Method": method}
        if method == "tools/call":
            request_headers["Mcp-Name"] = mirrored(str(sent["name"]))
            if tool is not None:
                request_headers |= header_arguments(tool.get("inputSchema"), sent.get("arguments"))
        for name, value in (headers or {}).items():
            request_headers = {k: v for k, v in request_headers.items() if k.lower() != name.lower()}
            if value is not None:
                request_headers[name] = value
        reply = self.resource(session, "POST", target, company, raw_body=json.dumps(rpc), headers=request_headers)
        return rpc_reply(reply, rpc["id"])

    def mcp_era(self, session: Session, company: Company) -> tuple[str, Reply]:
        """
        Which lifecycle the server speaks (MCP 2026-07-28 Streamable HTTP,
        "Backward Compatibility"): a 2026-07-28 `server/discover` first. Its
        result names the versions; a 400 whose body isn't one of 2026-07-28's
        own errors (-32020 to -32022) is a legacy server, and so is an
        `UnsupportedProtocolVersionError` that offers 2025-06-18.
        """
        reply = self.mcp_modern(session, company, "server/discover")
        error = reply.body.get("error") if isinstance(reply.body, dict) else None
        code = error.get("code") if isinstance(error, dict) else None
        if reply.status == 200 and isinstance(reply.body, dict) and isinstance(reply.body.get("result"), dict):
            versions = reply.body["result"].get("supportedVersions", [])
            if MCP_MODERN in versions:
                return "modern", reply
            if MCP_LEGACY in versions:
                return "legacy", reply
        elif reply.status == 400 and code not in MODERN_ERRORS:
            return "legacy", reply
        elif reply.status == 400 and code == -32022 and MCP_LEGACY in (error.get("data") or {}).get("supported", []):
            return "legacy", reply
        raise AssertionError(f"no MCP version in common: {reply.status} {reply.text[:300]}")

    def protected_resource_metadata(self, resource: str) -> Reply:
        return Reply.of(self.http.get(protected_resource_metadata_url(resource)))

    # ---- conversations (8) ----

    def conversation_post(
        self,
        session: Session,
        company: Company,
        path: str,
        request_id: str | None,
        members: str = "",
        *,
        wait: int | None = None,
        cursor: str | None = None,
        raw_body: str | None = None,
    ) -> Reply:
        """
        One conversation `POST` (8.2, 8.3): a JSON body with the request `id`
        first, then `members` (JSON text of further members, each followed by
        a comma), and `wait` and `cursor` as query parameters, which aren't
        part of what a retry repeats. `raw_body` replaces the body, and a
        `request_id` of None leaves the id out, for the reject rules.
        """
        assert company.conversations is not None
        params: dict[str, str] = {}
        if wait is not None:
            params["wait"] = str(wait)
        if cursor is not None:
            params["cursor"] = cursor
        if raw_body is None:
            inner = (f'"id":{json.dumps(request_id)},' if request_id is not None else "") + members
            raw_body = "{" + inner.rstrip(",") + "}"
        return self.resource(session, "POST", company.conversations + path, company, raw_body=raw_body, params=params)

    def post_message(
        self,
        session: Session,
        company: Company,
        request_id: str | None,
        raw_message: str | None,
        conversation: str | None,
        *,
        wait: int | None = None,
        cursor: str | None = None,
        parent: str | None = None,
        invitation: str | None = None,
    ) -> Reply:
        """
        Start a conversation (`conversation` None) or send to one (8.3). The
        request `id` is the message's id, so the message has none.
        `raw_message` is the message's JSON text. `parent` starts a Direct
        Conversation linked to that one, and `invitation` accepts that
        parent's `user_requested` event, with or without a message (8.10).
        """
        assert parent is None or conversation is None
        members = ""
        if parent is not None:
            members += f'"parent_conversation_id":{json.dumps(parent)},'
        if invitation is not None:
            members += f'"user_requested_event_id":{json.dumps(invitation)},'
        if raw_message is not None:
            members += f'"message":{raw_message},'
        path = "" if conversation is None else f"/{conversation}/messages"
        return self.conversation_post(session, company, path, request_id, members, wait=wait, cursor=cursor)

    def handoff(self, session: Session, company: Company, conversation: str, request_id: str) -> Reply:
        """Ask for a person at the Company (8.9): the request `id` alone."""
        return self.conversation_post(session, company, f"/{conversation}/handoff", request_id)

    def cancel_handoff(self, session: Session, company: Company, conversation: str, request_id: str) -> Reply:
        """Withdraw a request for a person (8.9): the request `id` alone, to `handoff/cancel`."""
        return self.conversation_post(session, company, f"/{conversation}/handoff/cancel", request_id)

    def close_conversation(self, session: Session, company: Company, conversation: str, request_id: str) -> Reply:
        """Close it (8.12): the request `id` alone."""
        return self.conversation_post(session, company, f"/{conversation}/close", request_id)

    def read_events(self, session: Session, company: Company, conversation: str, cursor: str | None, *, stream: bool) -> tuple[Reply, list[dict[str, Any]] | None, list[Any]]:
        """
        One read (8.5, 8.6). JSON: `cursor` as a query parameter. A stream:
        `Last-Event-ID` in place of `cursor`; `text-delta` pieces and
        comments are dropped, and each event's SSE `id` must be its own.
        Returns the reply, the events, and a stream's `working` events, in
        order, with whether each came before every conversation event.
        """
        assert company.conversations is not None
        url = f"{company.conversations}/{conversation}/events"
        if not stream:
            reply = self.resource(session, "GET", url, company, params={"cursor": cursor} if cursor is not None else None)
            return reply, (reply.body.get("events") if reply.status == 200 and isinstance(reply.body, dict) else None), []
        headers = {"Accept": "text/event-stream, application/json"}
        if cursor is not None:
            headers["Last-Event-ID"] = cursor
        reply = self.resource(session, "GET", url, company, headers=headers)
        if reply.status != 200:
            return reply, None, []
        if reply.body is not None:  # the Company answered JSON after all
            return reply, reply.body.get("events"), []
        events, working = parse_sse(reply.text)
        return reply, events, working

    # ---- task coverage (9) ----

    def tasks(self, session: Session, company: Company, *, token: Any = None) -> Reply:
        """9: `GET {tasks.endpoint}`, with the Session header and no access token, even signed in (`token` only for the reject rule)."""
        assert company.tasks is not None
        return self.resource(session, "GET", company.tasks, company, token=token)

    def report(self, session: Session, company: Company, endpoint: str, body: Any) -> Reply:
        """
        9.3: a feedback report to the endpoint the tasks response named, with
        the Session header. No scope is needed, so no access token
        (readings v04-tasks).
        """
        if not company.may_receive_tokens(endpoint):
            raise AssertionError(f"a feedback endpoint off the Company's hosts: {endpoint}")
        return self.resource(session, "POST", endpoint, company, body=body, token=None)

    # ---- website pages without a browser (5.2) ----

    def fetch_page(self, session: Session, company: Company, url: str, **options: Any) -> Reply:
        """
        5.2: a page of the website fetched with our own HTTP client, not a
        browser: the Session header, signed out (no access token, so no
        `ath`), only for HTTPS URLs on exactly `organization.domain`. Where
        the Company lists `browser_session_endpoint`, the fetch browser joins
        instead and sends no header (readings v04-fetch-browser).
        """
        parts = urllib.parse.urlsplit(url)
        if parts.scheme != "https" or (parts.hostname or "").lower() != company.organization_domain:
            raise AssertionError(f"the Session header goes only to pages on {company.organization_domain}, not {url}")
        return self.resource(session, "GET", url, company, token=options.pop("token", None), accept="text/html", **options)


class Browser:
    """
    The Personal Agent's own browser for one Session (6; guides "Web
    browsing": a separate storage context for each Session, never shared
    across Users). It holds the Company's cookies and nothing else; it never
    carries a token or Session JWT.
    """

    def __init__(self, transport: httpx.BaseTransport) -> None:
        self.http = httpx.Client(transport=transport, timeout=30, follow_redirects=False)

    def close(self) -> None:
        self.http.close()

    def open_join(self, endpoint: str) -> tuple[httpx.Response, str | None, str | None]:
        """
        Step 1 of 6: load the browser-session page as a top-level
        navigation. Returns the response, the form's one-time code and its
        action, read by software from this browser's own page (6, 10.6).
        """
        response = self.get(endpoint)
        code = re.search(r'<input[^>]*name="code"[^>]*value="([^"]+)"', response.text)
        action = re.search(r'<form[^>]*action="([^"]+)"', response.text)
        return response, code.group(1) if code else None, urllib.parse.urljoin(endpoint, action.group(1)) if action else None

    def submit_join(self, action: str, code: str) -> httpx.Response:
        """Step 3 of 6: the browser submits the form, the code alone, with the cookie step 1 set."""
        limited = 0
        while True:
            response = self.http.post(
                action,
                content=urllib.parse.urlencode({"code": code}),
                headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "text/html"},
            )
            if response.status_code == 429 and limited < MAX_LIMITED_RETRIES:
                limited += 1
                continue
            return response

    def get(self, url: str) -> httpx.Response:
        """Load a page, waiting out a 429's Retry-After (5.6: the website too)."""
        limited = 0
        while True:
            response = self.http.get(url, headers={"Accept": "text/html"})
            if response.status_code == 429 and limited < MAX_LIMITED_RETRIES:
                limited += 1
                continue
            return response


def htu(url: str) -> str:
    """`htu`: the request URL without its query or fragment (RFC 9449 4.2; 0.3 5.2)."""
    parts = urllib.parse.urlsplit(url)
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


def set_cookie_attributes(header: str) -> tuple[str, dict[str, str | None]]:
    """A `Set-Cookie` value's name and its attributes, names lower-cased (RFC 6265 5.2)."""
    name_value, *attributes = [part.strip() for part in header.split(";")]
    parsed: dict[str, str | None] = {}
    for attribute in attributes:
        key, eq, value = attribute.partition("=")
        parsed[key.strip().lower()] = value.strip() if eq else None
    return name_value.split("=", 1)[0].strip(), parsed


def origin_of(url: str) -> str:
    parts = urllib.parse.urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}".lower()


def strict_json(text: str) -> Any:
    """JSON that refuses duplicate member names (Guides)."""

    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        names = [name for name, _ in items]
        if len(names) != len(set(names)):
            raise DiscoveryError("duplicate member names")
        return dict(items)

    return json.loads(text, object_pairs_hook=pairs)


def compatible(a: object, b: object) -> bool:
    """3.4: two versions with the same major version and, before 1.0, the same minor version."""
    x, y = VERSION.fullmatch(str(a)), VERSION.fullmatch(str(b))
    return bool(x and y) and x[1] == y[1] and (x[1] != "0" or x[2] == y[2])


def implemented(version: object) -> str | None:
    """The version we implement that is compatible with `version` (3.4), or None: 1.0 for 1.1."""
    return next((ours for ours in PROTOCOL_VERSIONS if compatible(ours, version)), None)


def version_order(version: str) -> tuple[int, int]:
    match = VERSION.fullmatch(version)
    return (int(match[1]), int(match[2])) if match else (-1, -1)


def parse_sse(text: str) -> tuple[list[dict[str, Any]], list[tuple[Any, bool]]]:
    """
    Server-sent events (HTML Living Standard 9.2.6), as Poppy uses them
    (8.6): each `message` event's data is one conversation event, whose `id`
    the SSE `id` field repeats. `working` arrives as a `working` event with
    no SSE `id`; `text-delta` events are only for display. An event with
    another SSE name is skipped, as 1.0 requires of names a Personal Agent
    doesn't know; 0.4 named no others. Returns the conversation events, and
    each `working` value with whether it came before every conversation
    event.
    """
    events: list[dict[str, Any]] = []
    working: list[tuple[Any, bool]] = []
    for block in re.split(r"\r\n\r\n|\n\n|\r\r", text):
        kind, data, sse_id = "message", [], None
        for line in re.split(r"\r\n|\n|\r", block):
            if line == "" or line.startswith(":"):
                continue
            name, _, value = line.partition(":")
            value = value[1:] if value.startswith(" ") else value
            if name == "event":
                kind = value
            elif name == "data":
                data.append(value)
            elif name == "id":
                sse_id = value
        if not data:
            continue
        if kind == "working":
            if sse_id is not None:
                raise AssertionError(f"a working event with an SSE id {sse_id!r} (8.6: it has none)")
            working.append((json.loads("\n".join(data)).get("working"), not events))
            continue
        if kind != "message":
            continue
        event = json.loads("\n".join(data))
        if sse_id != event.get("id"):
            raise AssertionError(f"SSE id {sse_id!r} isn't the event's id {event.get('id')!r}")
        events.append(event)
    return events, working


def jwt_sid(value: str | None) -> str | None:
    """The `sid` in a Session JWT's payload, read without verifying it, for the transport's log."""
    try:
        payload = (value or "").split(".")[1]
        return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))).get("sid")
    except (IndexError, ValueError, AttributeError):
        return None