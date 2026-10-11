"""
A minimal Personal Agent Protocol (Poppy) Draft 0.1 client, written from the
draft (https://personalagentprotocol.org/docs/spec) and our spec's readings
(durable-personal-agent-spec.md, "Poppy client"), not ported from src/poppy.

It is deliberately small: discovery, client and Session assertions, DPoP
proofs with nonces and `ath`, the token grants, Account Token renewal and
rotation, conversations, and sign-out. It returns what the Company said
(`Reply`) and leaves judging it to the caller, so the state machine in
test_mock_company.py can hold the Company to a model.

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


class LocalTransport(httpx.BaseTransport):
    """
    Sends `https://<host>/...` for the mock's hosts to the launcher on
    127.0.0.1, the way the interop recording proxy does: plain HTTP with the
    original `Host` and `X-Forwarded-Proto: https`, which
    interop/impls/shared/serve.ts turns back into the URL the client meant.
    Anything else is refused, so nothing leaves localhost.
    """

    def __init__(self, port: int, suffix: str) -> None:
        self._inner = httpx.HTTPTransport()
        self._port = port
        self._suffix = suffix

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        url = request.url
        if url.scheme != "https" or not (url.host == self._suffix or url.host.endswith("." + self._suffix)):
            raise RuntimeError(f"refusing to send to {url}: only https://*.{self._suffix} goes to the local mock")
        headers = httpx.Headers([(k, v) for k, v in request.headers.raw if k.lower() != b"host"])
        headers["Host"] = url.host
        headers["X-Forwarded-Proto"] = "https"
        local = url.copy_with(scheme="http", host="127.0.0.1", port=self._port)
        forwarded = httpx.Request(request.method, local, headers=headers, stream=request.stream, extensions=request.extensions)
        return self._inner.handle_request(forwarded)

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
        return Company(domain, document, issuer, metadata, conversations, openapi, mediated)

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
    ) -> Reply:
        """
        A form POST with a client assertion and, by default, a DPoP proof
        without `ath`. Callables in `form` make a fresh value per attempt (a
        retry gets new assertions). Retries once on `use_dpop_nonce`.
        """
        url = endpoint or company.token_endpoint
        for attempt in range(2):
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
            if reply.status == 400 and reply.error == "use_dpop_nonce" and attempt == 0 and proof is None:
                continue
            return reply
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
        params: dict[str, str] | None = None,
        headers: dict[str, str] | None = None,
        key: Es256Key | None = None,
        proof: str | None = None,
    ) -> Reply:
        """
        A request with the Session Token in `Authorization: DPoP` and a proof
        with `ath` (4.3). Only to the Company's hosts, never with a token in
        the URL. Retries once on `use_dpop_nonce`.
        """
        if not company.may_receive_tokens(url):
            raise AssertionError(f"refusing to send a Session Token to {url}")
        full = httpx.URL(url, params=params or {})
        if session.token in str(full):
            raise AssertionError("refusing to put a token in a URL")
        content = raw_body if raw_body is not None else (json.dumps(body, allow_nan=False) if body is not None else None)
        for attempt in range(2):
            sent_proof = proof or self.proof(key or session.key, method, url, session.token)
            request_headers = {"Authorization": f"DPoP {session.token}", "DPoP": sent_proof, "Accept": "application/json"}
            if content is not None:
                request_headers["Content-Type"] = "application/json"
            request_headers.update(headers or {})
            response = self.http.request(method, full, content=content, headers=request_headers)
            self._keep_nonce(url, response)
            self.last = Sent(proof=sent_proof)
            reply = Reply.of(response)
            if reply.status == 401 and reply.error == "use_dpop_nonce" and attempt == 0 and proof is None:
                continue
            return reply
        return reply

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
    ) -> Reply:
        """Start a conversation (`conversation` None) or send to one (7.3). `raw_message` is the message's JSON text."""
        assert company.conversations is not None
        url = company.conversations if conversation is None else f"{company.conversations}/{conversation}/messages"
        params: dict[str, str] = {}
        if wait is not None:
            params["wait"] = str(wait)
        if cursor is not None:
            params["cursor"] = cursor
        return self.resource(session, "POST", url, company, raw_body='{"message":' + raw_message + "}", params=params)

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
