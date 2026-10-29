"""
A minimal Personal Agent Protocol (Poppy) 0.3 client, written from the
28 October text (spec/draft-0.3-retrieved-2026-10-28/pages/) and our spec's
readings (pda-spec.md, "Poppy client"), not ported from src/poppy.

It is deliberately small: discovery through the domain's protected
resource metadata (3, 3.2), client assertions naming the issuer (4.1),
delegated keys and a Session JWT on every resource request (5.2), plain
OAuth refresh and access tokens with DPoP only when the issuer lists it
(4.4, 4.5), Direct, Device and Mediated Sign-In, conversations with handoff
and Direct Conversations, sign-out, Operations 2, MCP, the browser join
(6), task coverage (9) and rate limits (5.6). It returns what the Company
said (`Reply`) and leaves judging it to the caller, so the state machines
in test_*.py can hold the Company to a model.

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
from cryptography.hazmat.primitives.asymmetric import ec
from jwt.algorithms import ECAlgorithm

DEVICE_CODE = "urn:ietf:params:oauth:grant-type:device_code"
MEDIATED_GRANT = "https://personalagentprotocol.org/grant/mediated-sign-in"
CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
APPROVAL_META = "personalagentprotocol.org/approval"
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
        self.log.append(Exchange(request.method, str(url), scheme, "poppy-session" in request.headers, response.status_code, stamp, seconds))
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


# ---------------------------------------------------------------- the agent


@dataclass
class PersonalAgent:
    """Our identity (4.1): a client metadata document at `client_id`, and the keys `jwks_uri` publishes."""

    origin: str = "https://agent.hypothesis.test"
    signing_key: Es256Key = field(default_factory=lambda: Es256Key(kid=random_id("k_", 8)))
    lists_operations: bool = False

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
        if self.lists_operations:
            # 3.3: one major version per extension; Operations 2 counts only when both sides list "2".
            metadata["extensions"] = {"operations": {"version": "2"}}
        return {self.client_id: metadata, self.jwks_uri: {"keys": [self.signing_key.public_jwk()]}}

    def client_assertion(self, aud: Any, *, lifetime: int = ASSERTION_LIFETIME, jti: str | None = None, typ: str = "JWT") -> str:
        """4.1: `iss` and `sub` the `client_id`, `aud` the Company's issuer as a single string, short-lived, a fresh `jti`."""
        now = int(time.time())
        claims = {"iss": self.client_id, "sub": self.client_id, "aud": aud, "iat": now, "exp": now + lifetime, "jti": jti or random_id()}
        return self.signing_key.sign(claims, {"typ": typ, "kid": self.signing_key.kid})

    def delegation(self, key: Es256Key, *, hours: float = DELEGATION_HOURS, extra: dict[str, Any] | None = None, typ: str = "pap-delegation+jwt") -> str:
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
    document: dict[str, Any]
    issuer: str
    metadata: dict[str, Any]
    conversations: str | None
    openapi: str | None
    mcp: str | None = None  # the MCP server's `url` (7)
    browser_session: str | None = None  # `web.browser_session_endpoint` (6)
    feedback: str | None = None  # `feedback.endpoint` (9.3)
    excluded_tasks: str | None = None  # `excluded_tasks.url` (9.1)
    operations: bool = False  # lists Operations version 2 (Ops 2)
    mediated: dict[str, Any] | None = None  # the Mediated Sign-In extension's entry, when its grant is listed too

    @property
    def organization_domain(self) -> str:
        return self.document["organization"]["domain"].lower()

    @property
    def token_endpoint(self) -> str:
        return self.metadata["token_endpoint"]

    @property
    def revocation_endpoint(self) -> str:
        return self.metadata["revocation_endpoint"]

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
        `grant_types_supported` (3.2), each able to ask for any of
        `scopes_supported` (4.7); Mediated Sign-In for its extension's scopes.
        """
        supported = [str(s) for s in self.metadata.get("scopes_supported", [])]
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
    A Session (5): a `sid` the agent chose, its User, and, while signed in,
    the access token it sends, its scheme and the key a DPoP-bound one is
    bound to. Nothing is requested to start one (5.2, 5.3).
    """

    user: User
    sid: str = field(default_factory=lambda: random_id("sid_"))
    token: str | None = None
    token_type: str | None = None  # "DPoP" or "Bearer", as the token response named it (4.5)
    key: Es256Key | None = None  # the DPoP key the token is bound to

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


def approval_header(operation_id: str, revision: str) -> str:
    """`Poppy-Approval` (Ops 6): an RFC 9651 Dictionary with `operation_id` and `revision` as Strings."""

    def sf_string(value: str) -> str:
        if not re.fullmatch(r"[\x20-\x7e]*", value):
            raise ValueError("not an RFC 9651 String")
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'

    return f"operation_id={sf_string(operation_id)}, revision={sf_string(revision)}"


class Poppy:
    """The HTTP side: one client for every Poppy request, as our spec's "One HTTP client for Poppy"."""

    def __init__(self, agent: PersonalAgent, http: httpx.Client) -> None:
        self.agent = agent
        self.http = http
        self.nonces: dict[str, str] = {}  # per server origin (our reading of S23)
        self.last = Sent()

    # ---- discovery (3) ----

    def discover(self, domain: str) -> Company:
        response = self.http.get(f"https://{domain}/.well-known/poppy.json", follow_redirects=False)
        if response.status_code != 200:
            raise DiscoveryError(f"poppy.json: HTTP {response.status_code}")
        document = strict_json(response.text)
        if not isinstance(document, dict) or document.get("protocol_version") != "0.3":
            raise DiscoveryError("protocol_version isn't 0.3 (3.1: MUST NOT use a major.minor it doesn't support)")
        org = str(document.get("organization", {}).get("domain", ""))
        if org.lower() != domain.lower():
            raise DiscoveryError(f"organization.domain {org!r} isn't the host that served it, {domain!r}")
        auth = document.get("auth") if isinstance(document.get("auth"), dict) else {}
        # 3.2: the issuer from the domain's protected resource metadata (RFC 9728).
        prm_response = self.http.get(protected_resource_metadata_url(f"https://{org.lower()}"), follow_redirects=False)
        if prm_response.status_code != 200:
            raise DiscoveryError(f"protected resource metadata: HTTP {prm_response.status_code}")
        prm = strict_json(prm_response.text)
        if prm.get("resource") != f"https://{org.lower()}":
            raise DiscoveryError("the protected resource metadata names another resource")
        servers = [str(s) for s in prm.get("authorization_servers", [])]
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
        if "authorization_code" in grants and "authorization_endpoint" not in metadata:
            raise DiscoveryError("Direct Sign-In without authorization_endpoint")
        if DEVICE_CODE in grants and "device_authorization_endpoint" not in metadata:
            raise DiscoveryError("Device Sign-In without device_authorization_endpoint")
        protocols = document.get("agent", {}).get("protocols", [])
        conversations = next((p["endpoint"] for p in protocols if p.get("type") == "poppy"), None)
        openapi = next((a["url"] for a in document.get("apis", []) if a.get("type") == "openapi"), None)
        mcp = next((a["url"] for a in document.get("apis", []) if a.get("type") == "mcp"), None)
        extensions = document.get("extensions", {}) if isinstance(document.get("extensions"), dict) else {}
        # 3.3: an extension counts only at a major version we support; anything else is ignored.
        operations = isinstance(extensions.get("operations"), dict) and extensions["operations"].get("version") == "2"
        mediated_entry = extensions.get("mediated-sign-in")
        mediated = mediated_entry if isinstance(mediated_entry, dict) and mediated_entry.get("version") == "1" and MEDIATED_GRANT in grants else None
        web = document.get("web") if isinstance(document.get("web"), dict) else {}
        feedback = document.get("feedback", {}).get("endpoint") if isinstance(document.get("feedback"), dict) else None
        excluded = document.get("excluded_tasks", {}).get("url") if isinstance(document.get("excluded_tasks"), dict) else None
        return Company(
            domain, document, issuer, metadata, conversations, openapi, mcp,
            web.get("browser_session_endpoint"), feedback, excluded, operations, mediated,
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
        `kid` the delegated key's thumbprint, the delegation in `pap_dlg`;
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
        head: dict[str, Any] = {"typ": "poppy-session+jwt", "kid": session.user.session_key.thumbprint(), "pap_dlg": self.delegation_for(session.user)}
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

    def authorization_url(self, company: Company, scopes: list[str]) -> tuple[str, str, str]:
        """Direct Sign-In (4.2): the URL for the User's browser, its `state` and the PKCE verifier."""
        state = random_id()
        verifier = random_id(nbytes=32)
        challenge = b64url(hashlib.sha256(verifier.encode("ascii")).digest())
        query = urllib.parse.urlencode(
            {
                "response_type": "code",
                "client_id": self.agent.client_id,
                "redirect_uri": self.agent.redirect_uri,
                "scope": " ".join(scopes),
                "state": state,
                "code_challenge": challenge,
                "code_challenge_method": "S256",
            }
        )
        return f"{company.metadata['authorization_endpoint']}?{query}", state, verifier

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
    ) -> Reply:
        """
        A request with the Session header (5.2) and, signed in, the access
        token with the scheme its `token_type` named (4.5), and a DPoP proof
        with `ath` when it is DPoP-bound. Only to the Company's hosts, never
        with a token or Session JWT in the URL. Retries once on
        `use_dpop_nonce`, and after a 429 once its `Retry-After` has passed,
        each time with a new Session JWT and proof. `token`, `scheme`, `key`,
        `proof` and `session_jwt` are only for the reject rules.
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
            request_headers = {"Poppy-Session": header_value, "Accept": "application/json"}
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

    def exchange(self, session: Session, company: Company, api_base: str, idempotency_key: str | None, *, approval: tuple[str, str] | None = None) -> Reply:
        """
        `POST /orders/ord_7Hk2/exchanges` (the fixture's `openapi_write`),
        with an `Idempotency-Key`, and with `Poppy-Approval` when it is the
        same request again with the User's approval (Ops 6).
        """
        headers: dict[str, str] = {}
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        if approval is not None:
            headers["Poppy-Approval"] = approval_header(*approval)
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

    def order_prints(self, session: Session, company: Company, api_base: str, order: dict[str, Any], idempotency_key: str, *, approval: tuple[str, str] | None = None) -> Reply:
        headers = {"Idempotency-Key": idempotency_key}
        if approval is not None:
            headers["Poppy-Approval"] = approval_header(*approval)
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
        if reply.status == 200 and reply.body is None and "text/event-stream" in reply.headers.get("content-type", ""):
            # A Streamable HTTP server may answer with a stream: the JSON-RPC response is a `message` event.
            for block in re.split(r"\r\n\r\n|\n\n|\r\r", reply.text):
                data = [line[5:].lstrip(" ") for line in re.split(r"\r\n|\n|\r", block) if line.startswith("data:")]
                if data:
                    candidate = json.loads("\n".join(data))
                    if isinstance(candidate, dict) and candidate.get("id") == rpc.get("id"):
                        reply.body = candidate
        return reply

    def protected_resource_metadata(self, resource: str) -> Reply:
        return Reply.of(self.http.get(protected_resource_metadata_url(resource)))

    # ---- conversations (8) ----

    def post_message(
        self,
        session: Session,
        company: Company,
        raw_message: str,
        conversation: str | None,
        *,
        wait: int | None = None,
        cursor: str | None = None,
        parent: str | None = None,
    ) -> Reply:
        """
        Start a conversation (`conversation` None) or send to one (8.3).
        `raw_message` is the message's JSON text. `parent` starts a Direct
        Conversation linked to that one (8.10).
        """
        assert company.conversations is not None
        assert parent is None or conversation is None
        url = company.conversations if conversation is None else f"{company.conversations}/{conversation}/messages"
        params: dict[str, str] = {}
        if wait is not None:
            params["wait"] = str(wait)
        if cursor is not None:
            params["cursor"] = cursor
        prefix = "{" + (f'"parent_conversation_id":{json.dumps(parent)},' if parent is not None else "")
        return self.resource(session, "POST", url, company, raw_body=prefix + '"message":' + raw_message + "}", params=params)

    def handoff(self, session: Session, company: Company, conversation: str) -> Reply:
        """Ask for a person at the Company (8.9): an empty JSON object."""
        assert company.conversations is not None
        return self.resource(session, "POST", f"{company.conversations}/{conversation}/handoff", company, body={})

    def read_events(self, session: Session, company: Company, conversation: str, cursor: str | None, *, stream: bool) -> tuple[Reply, list[dict[str, Any]] | None]:
        """
        One read (8.5, 8.6). JSON: `cursor` as a query parameter. A stream:
        `Last-Event-ID` in place of `cursor`; `text-delta` pieces and
        comments are dropped, and each event's SSE `id` must be its own.
        """
        assert company.conversations is not None
        url = f"{company.conversations}/{conversation}/events"
        if not stream:
            reply = self.resource(session, "GET", url, company, params={"cursor": cursor} if cursor is not None else None)
            return reply, (reply.body.get("events") if reply.status == 200 and isinstance(reply.body, dict) else None)
        headers = {"Accept": "text/event-stream, application/json"}
        if cursor is not None:
            headers["Last-Event-ID"] = cursor
        reply = self.resource(session, "GET", url, company, headers=headers)
        if reply.status != 200:
            return reply, None
        if reply.body is not None:  # the Company answered JSON after all
            return reply, reply.body.get("events")
        return reply, parse_sse(reply.text)

    def close_conversation(self, session: Session, company: Company, conversation: str) -> Reply:
        assert company.conversations is not None
        return self.resource(session, "POST", f"{company.conversations}/{conversation}/close", company, body={})

    # ---- task coverage (9) ----

    def excluded(self, company: Company) -> Reply:
        """9.1: the excluded-tasks document, fetched like discovery: a GET with no token or Session header."""
        assert company.excluded_tasks is not None
        return Reply.of(self.http.get(company.excluded_tasks, follow_redirects=False))

    def report(self, session: Session, company: Company, task: str, description: str) -> Reply:
        """9.3: a feedback report, with the Session header and, signed in, the token; no scope needed."""
        assert company.feedback is not None
        return self.resource(session, "POST", company.feedback, company, body={"task": task, "description": description})


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


def join_browser(poppy: Poppy, browser: Browser, session: Session, company: Company) -> tuple[Reply, httpx.Response | None]:
    """
    The browser join (6): the browser loads the page, our own request
    authorizes its code at `{browser_session_endpoint}/authorize` with the
    Session header and, signed in, the access token, and the browser submits
    the code. The token never reaches the browser. Returns the authorize
    reply and, when it was accepted, the browser's submit.
    """
    assert company.browser_session is not None
    _, code, action = browser.open_join(company.browser_session)
    assert code is not None and action is not None, "the browser-session page gave no code to join with"
    authorized = poppy.resource(session, "POST", f"{company.browser_session.rstrip('/')}/authorize", company, body={"code": code})
    if authorized.status != 204:
        return authorized, None
    return authorized, browser.submit_join(action, code)


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


def parse_sse(text: str) -> list[dict[str, Any]]:
    """
    Server-sent events (HTML Living Standard 9.2.6), as Poppy uses them:
    each `message` event's data is one conversation event, whose `id` the
    SSE `id` field repeats. `text-delta` events are only for display (7.6).
    """
    events: list[dict[str, Any]] = []
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
        if not data or kind != "message":
            continue
        event = json.loads("\n".join(data))
        if sse_id != event.get("id"):
            raise AssertionError(f"SSE id {sse_id!r} isn't the event's id {event.get('id')!r}")
        events.append(event)
    return events
