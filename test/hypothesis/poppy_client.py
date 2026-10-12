"""
A minimal Personal Agent Protocol (Poppy) Draft 0.1 client, written from the
draft (https://personalagentprotocol.org/docs/spec) and our spec's readings
(durable-personal-agent-spec.md, "Poppy client"), not ported from src/poppy.

It is deliberately small: discovery, client and Session assertions, DPoP
proofs with nonces and `ath`, the token grants, Account Token renewal and
rotation, conversations with handoff and Direct Conversations, sign-out,
the Operations extension, MCP with Bearer Session Tokens, joining a
browser to a Session (5), and rate limits (4.3). It returns what the
Company said (`Reply`) and leaves judging it to the caller, so the state
machines in test_*.py can hold the Company to a model.

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

JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer"
DEVICE_CODE = "urn:ietf:params:oauth:grant-type:device_code"
CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
ASSERTION_LIFETIME = 60  # seconds; strict Companies allow 60 (spec-issues S2)
MAX_LIMITED_RETRIES = 6  # 429s waited out before a request gives up
DEFAULT: Any = object()  # "the honest value", where None is itself a value a test may send


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def random_id(prefix: str = "", nbytes: int = 16) -> str:
    """`prefix` + `nbytes` random bytes as base64url (16 bytes: the 128 bits Poppy asks of a `jti`)."""
    return prefix + b64url(os.urandom(nbytes))


def ath(token: str) -> str:
    """The DPoP `ath`: base64url SHA-256 of the access token (RFC 9449 4.2)."""
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
        self.log.append(Exchange(request.method, str(url), scheme, response.status_code, stamp, seconds))
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


# ---------------------------------------------------------------- the agent


@dataclass
class PersonalAgent:
    """Our identity (4.1): a client metadata document at `client_id`, and its keys."""

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

    def browser_assertion(
        self,
        user_id: str,
        session_id: Any,
        aud: Any,
        return_to: Any,
        *,
        typ: str = "poppy-browser+jwt",
        lifetime: int = ASSERTION_LIFETIME,
        jti: str | None = None,
    ) -> str:
        """A browser assertion (5): signed like the Session assertion, with `typ` poppy-browser+jwt."""
        now = int(time.time())
        claims = {
            "iss": self.client_id,
            "sub": user_id,
            "aud": aud,
            "session_id": session_id,
            "return_to": return_to,
            "iat": now,
            "exp": now + lifetime,
            "jti": jti or random_id(),
        }
        return self.signing_key.sign(claims, {"typ": typ, "kid": self.signing_key.kid})

    def documents(self) -> dict[str, Any]:
        metadata: dict[str, Any] = {
            "client_id": self.client_id,
            "client_name": "Hypothesis Agent",
            "jwks_uri": self.jwks_uri,
            "redirect_uris": [self.redirect_uri],
            "token_endpoint_auth_method": "private_key_jwt",
        }
        if self.lists_operations:
            metadata["extensions"] = {"operations": {"version": "1"}}
        return {self.client_id: metadata, self.jwks_uri: {"keys": [self.signing_key.public_jwk()]}}

    def assertion(self, sub: str, aud: Any, *, lifetime: int = ASSERTION_LIFETIME, jti: str | None = None) -> str:
        """A client assertion (sub = client_id) or Session assertion (sub = User ID), 4.1 and 4.2."""
        now = int(time.time())
        claims = {"iss": self.client_id, "sub": sub, "aud": aud, "iat": now, "exp": now + lifetime, "jti": jti or random_id()}
        return self.signing_key.sign(claims, {"typ": "JWT", "kid": self.signing_key.kid})


@dataclass
class Company:
    """What discovery (3, 3.2) established about one Company."""

    domain: str
    document: dict[str, Any]
    issuer: str
    metadata: dict[str, Any]
    conversations: str | None
    openapi: str | None
    mediated: dict[str, Any] | None
    mcp: str | None = None  # the MCP server's `url` (6), the only place a Bearer Session Token goes
    operations: str | None = None  # the Operations extension's endpoint, version 1 (Ops 2)
    browser_session: str | None = None  # `web.browser_session_endpoint` (5)

    @property
    def organization_domain(self) -> str:
        return self.document["organization"]["domain"].lower()

    def on_own_domain(self, url: str) -> bool:
        """5: `return_to` is an HTTPS URL on `organization.domain` or one of its subdomains."""
        try:
            parts = urllib.parse.urlsplit(url)
            host = (parts.hostname or "").lower()
        except ValueError:
            return False
        domain = self.organization_domain
        return parts.scheme == "https" and (host == domain or host.endswith("." + domain))

    @property
    def token_endpoint(self) -> str:
        return self.metadata["token_endpoint"]

    @property
    def revocation_endpoint(self) -> str:
        return self.metadata["revocation_endpoint"]

    def offered(self, kind: str) -> list[str]:
        """The scopes a sign-in type (`direct`, `device`, `mediated`) offers, or [] when it isn't offered."""
        entry = self.document.get("auth", {}).get(kind)
        return list(entry.get("scopes", [])) if isinstance(entry, dict) else []

    def hosts(self) -> list[str]:
        domains = [self.document["organization"]["domain"], *self.metadata.get("poppy_domains", [])]
        return [d.lower() for d in domains]

    def may_receive_tokens(self, url: str) -> bool:
        """A host equal to or under `organization.domain` or a `poppy_domains` entry (our reading of N10)."""
        host = (urllib.parse.urlsplit(url).hostname or "").lower()
        return urllib.parse.urlsplit(url).scheme == "https" and any(host == d or host.endswith("." + d) for d in self.hosts())


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
    """A User of our agent at this Company: a random User ID (never derived from them, 4.2) and a DPoP key (4.3)."""

    user_id: str = field(default_factory=lambda: random_id("usr_"))
    dpop_key: Es256Key = field(default_factory=Es256Key)


@dataclass
class Session:
    """A Session (4.2): its id, its newest Session Token, and the key that token is bound to."""

    user: User
    session_id: str
    token: str
    key: Es256Key
    signed_in: bool
    account_token: str | None = None


@dataclass
class Sent:
    """The JWTs and proof a request carried, so a reject rule can replay one."""

    client_assertion: str | None = None
    session_assertion: str | None = None
    proof: str | None = None


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
        if not isinstance(document, dict) or not str(document.get("protocol_version", "")).startswith("0."):
            raise DiscoveryError("protocol_version major isn't 0")
        org = document.get("organization", {}).get("domain", "")
        if org.lower() != domain.lower().removeprefix("www."):
            raise DiscoveryError(f"organization.domain {org!r} isn't {domain!r}")
        auth = document.get("auth")
        if not isinstance(auth, dict) or not isinstance(auth.get("issuer"), str):
            raise DiscoveryError("no auth.issuer")
        issuer = auth["issuer"]
        if not issuer.startswith("https://"):
            raise DiscoveryError("issuer isn't https")
        meta_response = self.http.get(metadata_url(issuer), follow_redirects=False)
        if meta_response.status_code != 200:
            raise DiscoveryError(f"issuer metadata: HTTP {meta_response.status_code}")
        metadata = strict_json(meta_response.text)
        if metadata.get("issuer") != issuer:
            raise DiscoveryError("issuer metadata names another issuer")
        if org.lower() not in [str(d).lower() for d in metadata.get("poppy_domains", [])]:
            raise DiscoveryError("poppy_domains doesn't list organization.domain")
        for name in ("token_endpoint", "revocation_endpoint"):
            if not isinstance(metadata.get(name), str):
                raise DiscoveryError(f"no {name}")
        if "direct" in auth and "authorization_endpoint" not in metadata:
            raise DiscoveryError("Direct Sign-In without authorization_endpoint")
        if "device" in auth and "device_authorization_endpoint" not in metadata:
            raise DiscoveryError("Device Sign-In without device_authorization_endpoint")
        protocols = document.get("agent", {}).get("protocols", [])
        conversations = next((p["endpoint"] for p in protocols if p.get("type") == "poppy"), None)
        openapi = next((a["url"] for a in document.get("apis", []) if a.get("type") == "openapi"), None)
        mediated = auth.get("mediated") if isinstance(auth.get("mediated"), dict) else None
        mcp = next((a["url"] for a in document.get("apis", []) if a.get("type") == "mcp"), None)
        # Ops 2: version 1, with its endpoint; an extension we don't know is ignored (3.3).
        operations_entry = document.get("extensions", {}).get("operations")
        operations = (
            operations_entry.get("endpoint")
            if isinstance(operations_entry, dict) and operations_entry.get("version") == "1"
            else None
        )
        web = document.get("web") if isinstance(document.get("web"), dict) else {}
        return Company(
            domain, document, issuer, metadata, conversations, openapi, mediated, mcp, operations, web.get("browser_session_endpoint")
        )

    # ---- DPoP (4.3, RFC 9449) ----

    def proof(self, key: Es256Key, method: str, url: str, token: str | None = None, *, jti: str | None = None) -> str:
        parts = urllib.parse.urlsplit(url)
        htu = urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))
        claims: dict[str, Any] = {"htm": method, "htu": htu, "iat": int(time.time()), "jti": jti or random_id()}
        if token is not None:
            claims["ath"] = ath(token)
        nonce = self.nonces.get(origin_of(url))
        if nonce is not None:
            claims["nonce"] = nonce
        return key.sign(claims, {"typ": "dpop+jwt", "jwk": key.public_jwk()})

    def _keep_nonce(self, url: str, response: httpx.Response) -> None:
        nonce = response.headers.get("dpop-nonce")
        if nonce:
            self.nonces[origin_of(url)] = nonce

    # ---- the token endpoint (4.2, 4.5, 4.6, 4.8) ----

    def token_request(
        self,
        company: Company,
        key: Es256Key,
        form: dict[str, str | Callable[[], str]],
        *,
        endpoint: str | None = None,
        client_assertion: str | Callable[[], str] | None = None,
        proof: str | None = None,
        dpop: bool = True,
        retry_limited: bool = True,
    ) -> Reply:
        """
        A form POST with a client assertion and, by default, a DPoP proof
        without `ath`. Callables in `form` make a fresh value per attempt (a
        retry gets new assertions). Retries once on `use_dpop_nonce`, and
        after a 429 once its `Retry-After` has passed (the transport waits).
        """
        url = endpoint or company.token_endpoint
        nonce_retried, limited = False, 0
        while True:
            made = client_assertion() if callable(client_assertion) else client_assertion
            if made is None:
                made = self.agent.assertion(self.agent.client_id, url)
            body = {name: value() if callable(value) else value for name, value in form.items()}
            body.update(client_id=self.agent.client_id, client_assertion_type=CLIENT_ASSERTION_TYPE, client_assertion=made)
            headers = {"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"}
            sent_proof = None
            if dpop:
                sent_proof = proof or self.proof(key, "POST", url)
                headers["DPoP"] = sent_proof
            response = self.http.post(url, content=urllib.parse.urlencode(body), headers=headers)
            self._keep_nonce(url, response)
            self.last = Sent(made, body.get("assertion"), sent_proof)
            reply = Reply.of(response)
            if reply.status == 429 and retry_limited and limited < MAX_LIMITED_RETRIES:
                limited += 1
                continue
            if reply.status == 400 and reply.error == "use_dpop_nonce" and not nonce_retried and proof is None:
                nonce_retried = True
                continue
            return reply

    def session_assertion(self, company: Company, user: User, aud: Any = DEFAULT) -> str:
        return self.agent.assertion(user.user_id, company.token_endpoint if aud is DEFAULT else aud)

    def start_session(self, company: Company, user: User, session_id: str | None = None, **knobs: Any) -> Reply:
        """The JWT bearer grant (4.2): a new Session, or a signed-out one renewed with `session_id`."""
        form: dict[str, str | Callable[[], str]] = {
            "grant_type": JWT_BEARER,
            "assertion": knobs.pop("assertion", None) or (lambda: self.session_assertion(company, user)),
        }
        if session_id is not None:
            form["session_id"] = session_id
        return self.token_request(company, knobs.pop("key", user.dpop_key), form, **knobs)

    def refresh(self, company: Company, key: Es256Key, account_token: str, session_id: str | None, scope: list[str] | None = None) -> Reply:
        """`refresh_token` with the Account Token (4.8): renews a signed-in Session, or signs one in."""
        form: dict[str, str | Callable[[], str]] = {"grant_type": "refresh_token", "refresh_token": account_token}
        if session_id is not None:
            form["session_id"] = session_id
        if scope is not None:
            form["scope"] = " ".join(scope)
        return self.token_request(company, key, form)

    def bearer_token(
        self, company: Company, session: Session, account_token: str | None, *, resource: Any = DEFAULT, dpop: bool = False
    ) -> Reply:
        """
        A Bearer Session Token for the MCP server (4.3): the request that
        renews the Session's token, without the `DPoP` header, with
        `resource` set to the MCP server's `url`. A signed-in Session renews
        with its Account Token (4.8), a signed-out one with the assertion (4.2).
        """
        assert company.mcp is not None
        form: dict[str, str | Callable[[], str]]
        if account_token is not None:
            form = {"grant_type": "refresh_token", "refresh_token": account_token}
        else:
            form = {"grant_type": JWT_BEARER, "assertion": lambda: self.session_assertion(company, session.user)}
        form["session_id"] = session.session_id
        if resource is not None:
            form["resource"] = company.mcp if resource is DEFAULT else resource
        return self.token_request(company, session.key, form, dpop=dpop)

    def revoke(self, company: Company, account_token: str) -> Reply:
        """Sign-out (4.9): revoke the Account Token, RFC 7009, with the client assertion."""
        return self.token_request(
            company,
            Es256Key(),
            {"token": account_token, "token_type_hint": "refresh_token"},
            endpoint=company.revocation_endpoint,
            dpop=False,
        )

    # ---- sign-in (4.4 to 4.7) ----

    def authorization_url(self, company: Company, scopes: list[str]) -> tuple[str, str, str]:
        """Direct Sign-In (4.5): the URL for the User's browser, its `state` and the PKCE verifier."""
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
        """Check the redirect (4.5): our redirect URI, our `state`, the Company's `iss`."""
        if not redirect.startswith(self.agent.redirect_uri + "?"):
            raise AssertionError(f"redirect went to {redirect}")
        params = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(redirect).query))
        if params.get("state") != state:
            raise AssertionError("callback state isn't ours")
        if params.get("iss") != company.issuer:
            raise AssertionError(f"callback iss {params.get('iss')!r} isn't {company.issuer!r}")
        return params

    def exchange_code(self, company: Company, session: Session, code: str, verifier: str) -> Reply:
        return self.token_request(
            company,
            session.key,
            {
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": self.agent.redirect_uri,
                "code_verifier": verifier,
                "session_id": session.session_id,
            },
        )

    def device_start(self, company: Company, scopes: list[str]) -> Reply:
        endpoint = company.metadata["device_authorization_endpoint"]
        return self.token_request(company, Es256Key(), {"scope": " ".join(scopes)}, endpoint=endpoint, dpop=False)

    def device_poll(self, company: Company, session: Session, device_code: str) -> Reply:
        return self.token_request(
            company, session.key, {"grant_type": DEVICE_CODE, "device_code": device_code, "session_id": session.session_id}
        )

    def mediated_start(self, company: Company, session: Session, scopes: list[str], credentials: dict[str, str]) -> Reply:
        assert company.mediated is not None
        return self.resource(session, "POST", company.mediated["endpoint"], company, body={"scope": " ".join(scopes), "credentials": credentials})

    def mediated_code(self, company: Company, session: Session, sign_in_id: str, code: str) -> Reply:
        assert company.mediated is not None
        return self.resource(session, "POST", f"{company.mediated['endpoint']}/{sign_in_id}", company, body={"code": code})

    # ---- resources (4.3, 6, 7) ----

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
        key: Es256Key | None = None,
        proof: str | None = None,
        scheme: str = "DPoP",
        retry_limited: bool = True,
    ) -> Reply:
        """
        A request with the Session Token in `Authorization: DPoP` and a proof
        with `ath` (4.3). Only to the Company's hosts, never with a token in
        the URL. Retries once on `use_dpop_nonce`, and after a 429 once its
        `Retry-After` has passed. `scheme` other than DPoP is only for the
        reject rules: a Bearer header and no proof.
        """
        if not company.may_receive_tokens(url):
            raise AssertionError(f"refusing to send a Session Token to {url}")
        full = httpx.URL(url, params=params or {})
        if session.token in str(full):
            raise AssertionError("refusing to put a token in a URL")
        if content is None:
            text = raw_body if raw_body is not None else (json.dumps(body, allow_nan=False) if body is not None else None)
            content = text.encode("utf-8") if text is not None else None
        nonce_retried, limited = False, 0
        while True:
            request_headers = {"Authorization": f"{scheme} {session.token}", "Accept": "application/json"}
            sent_proof = None
            if scheme == "DPoP":
                sent_proof = proof or self.proof(key or session.key, method, url, session.token)
                request_headers["DPoP"] = sent_proof
            if content is not None:
                request_headers["Content-Type"] = content_type
            request_headers.update(headers or {})
            response = self.http.request(method, full, content=content, headers=request_headers)
            self._keep_nonce(url, response)
            self.last = Sent(proof=sent_proof)
            reply = Reply.of(response)
            if reply.status == 429 and retry_limited and limited < MAX_LIMITED_RETRIES:
                limited += 1
                continue
            if reply.status == 401 and reply.error == "use_dpop_nonce" and not nonce_retried and proof is None and scheme == "DPoP":
                nonce_retried = True
                continue
            return reply

    # ---- APIs (6): the OpenAPI writes the state machines use ----

    def exchange(self, session: Session, company: Company, api_base: str, idempotency_key: str | None) -> Reply:
        """`POST /orders/ord_7Hk2/exchanges` (the fixture's `openapi_write`), with an `Idempotency-Key` (Guides: Retries)."""
        headers = {"Idempotency-Key": idempotency_key} if idempotency_key else None
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

    def order_prints(self, session: Session, company: Company, api_base: str, order: dict[str, Any], idempotency_key: str) -> Reply:
        return self.resource(session, "POST", f"{api_base}/prints", company, body=order, headers={"Idempotency-Key": idempotency_key})

    # ---- the Operations extension (Ops 5 to 7) ----

    def operation_url(self, company: Company, operation_id: str, action: str | None = None) -> str:
        """The operation's URL: its id is the Company's own text (Ops 3), so it is percent-encoded as one path segment."""
        assert company.operations is not None
        url = f"{company.operations}/{urllib.parse.quote(operation_id, safe='')}"
        return f"{url}/{action}" if action else url

    def read_operation(self, session: Session, company: Company, operation_id: str) -> Reply:
        return self.resource(session, "GET", self.operation_url(company, operation_id), company)

    def confirm_operation(self, session: Session, company: Company, operation_id: str, revision: Any, approved_by: Any) -> Reply:
        body = {"revision": revision, "approved_by": approved_by}
        return self.resource(session, "POST", self.operation_url(company, operation_id, "confirm"), company, body=body)

    def cancel_operation(self, session: Session, company: Company, operation_id: str) -> Reply:
        return self.resource(session, "POST", self.operation_url(company, operation_id, "cancel"), company)

    # ---- MCP (6), with Bearer Session Tokens (4.3) ----

    def mcp(
        self,
        session_token: str | None,
        company: Company,
        rpc: dict[str, Any],
        *,
        mcp_session: str | None = None,
        url: str | None = None,
        scheme: str = "Bearer",
        dpop_key: Es256Key | None = None,
    ) -> Reply:
        """
        One JSON-RPC message to the MCP server over Streamable HTTP
        (MCP 2025-06-18): Accept both JSON and SSE, `Mcp-Session-Id` and
        `MCP-Protocol-Version` after `initialize`. A Bearer token goes only
        to the MCP server's own `url` from poppy.json (4.3: each one works at
        only one MCP server); `url` and `scheme` other than that are only for
        the reject rules.
        """
        target = url or company.mcp
        assert target is not None
        if scheme == "Bearer" and target != company.mcp:
            raise AssertionError(f"refusing to send a Bearer Session Token to {target}, not the MCP server {company.mcp}")
        headers = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
        if session_token is not None:  # None only for the reject rule: an MCP client with no token yet
            headers["Authorization"] = f"{scheme} {session_token}"
        if scheme == "DPoP" and dpop_key is not None and session_token is not None:
            headers["DPoP"] = self.proof(dpop_key, "POST", target, session_token)
        if mcp_session is not None:
            headers["Mcp-Session-Id"] = mcp_session
            headers["MCP-Protocol-Version"] = "2025-06-18"
        limited = 0
        while True:
            reply = Reply.of(self.http.post(target, content=json.dumps(rpc), headers=headers))
            if reply.status == 429 and limited < MAX_LIMITED_RETRIES:
                limited += 1
                continue
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

    # ---- conversations (7) ----

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
        Start a conversation (`conversation` None) or send to one (7.3).
        `raw_message` is the message's JSON text. `parent` starts a Direct
        Conversation linked to that one (7.10).
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
        """Ask for a person at the Company (7.9): an empty JSON object."""
        assert company.conversations is not None
        return self.resource(session, "POST", f"{company.conversations}/{conversation}/handoff", company, body={})

    def read_events(self, session: Session, company: Company, conversation: str, cursor: str | None, *, stream: bool) -> tuple[Reply, list[dict[str, Any]] | None]:
        """
        One read (7.5, 7.6). JSON: `cursor` as a query parameter. A stream:
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


class Browser:
    """
    The Personal Agent's own browser for one Session (5; Guides "Web
    browsing": a separate storage context for each Session, never shared
    across Users). It holds the Company's cookie and nothing else; it never
    carries a Session Token.
    """

    def __init__(self, transport: httpx.BaseTransport) -> None:
        self.http = httpx.Client(transport=transport, timeout=30, follow_redirects=False)

    def close(self) -> None:
        self.http.close()

    def join(self, endpoint: str, assertion: str, *, in_url: bool = False) -> httpx.Response:
        """
        Step 2 of 5: the assertion as a form POST, as a top-level navigation,
        in the body (never the URL; `in_url` is only for the reject rule).
        The cookie the Company sets lands in this browser's jar.
        """
        url = f"{endpoint}?{urllib.parse.urlencode({'assertion': assertion})}" if in_url else endpoint
        limited = 0
        while True:
            response = self.http.post(
                url,
                content=urllib.parse.urlencode({"assertion": assertion}),
                headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "text/html"},
            )
            if response.status_code == 429 and limited < MAX_LIMITED_RETRIES:
                limited += 1
                continue
            return response

    def get(self, url: str) -> httpx.Response:
        """Load a page, waiting out a 429's Retry-After (4.3: the website too)."""
        limited = 0
        while True:
            response = self.http.get(url, headers={"Accept": "text/html"})
            if response.status_code == 429 and limited < MAX_LIMITED_RETRIES:
                limited += 1
                continue
            return response


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
