"""
The model and the rules the state machines share: a model-based, stateful
test of our mock Company (test/mock-company) over HTTP, driven by a second
Poppy client written in Python from the draft.

The model says what should be true: which Sessions exist and are signed in,
to which account and with which scopes; which Account Tokens are live,
rotated or revoked; which message ids each User has used, and for what;
what each conversation's event log holds, in order, its status and
responder, and its Direct Conversations. Every response is held to it, and
so is the mock's own record of violations:

- after honest rules, `GET /violations` holds nothing new;
- each reject rule is refused with the error the draft names, and the mock
  records exactly the violation id that rule expects, and nothing else.

Each test_*.py builds one machine from `Base` and the rule sets it needs,
so each surface gets the steps to reach deep states. Spec references (4.2,
7.3, ...) are to Poppy Draft 0.1; `Ops n` is the Operations extension.
"""

from __future__ import annotations

import json
import re
import sys
import urllib.parse
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

import httpx
from hypothesis import assume, note
from hypothesis import strategies as st
from hypothesis.stateful import RuleBasedStateMachine, initialize, invariant, precondition, rule

from mock_server import DOMAIN, SUFFIX, MockServer
from poppy_client import Browser, Clock, Company, Es256Key, LocalTransport, PersonalAgent, Poppy, Reply, Session, User
from strategies import CONFIGS, MESSAGE_IDS, canonical, messages, serialisations

READ, WRITE = "poppy:read", "poppy:write"
MAX_USERS = 3
MAX_SESSIONS = 8
STATUSES = frozenset({"working", "idle", "queued", "closed"})
RESPONDERS = frozenset({"agent", "human"})


# ---------------------------------------------------------------- the model


@dataclass(eq=False)
class MGrant:
    """One sign-in's Account Token: its newest value, the values rotation replaced, and whether it was revoked."""

    user: "MUser"
    account: str
    scope: frozenset[str]
    current: str
    superseded: list[str] = field(default_factory=list)
    revoked: bool = False


@dataclass(eq=False)
class MBearer:
    """A Bearer Session Token for the MCP server (4.3), as it was issued: signed in to which account, with which scopes."""

    token: str
    account: str | None
    scope: frozenset[str]
    mcp_session: str | None = None


@dataclass(eq=False)
class MSession:
    session: Session
    user: "MUser"
    account: str | None = None  # signed in to, now
    bound: str | None = None  # ever signed in to: a Session can't switch accounts (4.4)
    grant: MGrant | None = None  # the Account Token it is signed in with
    token_scope: frozenset[str] = frozenset()  # what its newest Session Token grants
    ended: bool = False
    mismatched: bool = False  # refused with account_mismatch: never asked again for another account (4.4)
    bearer: MBearer | None = None  # its newest Bearer token for the MCP server
    browser: Browser | None = None  # the Personal Agent's browser for this Session (5)
    joined: bool = False  # the browser holds the Company's cookie for this Session

    def bearer_account(self) -> str | None:
        """Who the Bearer token acts for now: its account while the Session is still signed in to it (4.9: sign-out takes effect)."""
        if self.bearer is None or self.bearer.account is None or self.account != self.bearer.account:
            return None
        return self.bearer.account


@dataclass(eq=False)
class MSent:
    message: dict[str, Any]
    conversation: str
    started: bool  # sent with the POST that started the conversation
    parent: str | None = None  # the parent of the Direct Conversation it started (7.10)


@dataclass(eq=False)
class MUser:
    user: User
    sessions: list[MSession] = field(default_factory=list)
    grants: list[MGrant] = field(default_factory=list)
    sent: dict[str, MSent] = field(default_factory=dict)


@dataclass(eq=False)
class MConversation:
    id: str
    user: MUser
    account: str | None = None  # 7.2: once it uses the User's account, it belongs to that account
    sent: list[str] = field(default_factory=list)  # our message ids, in the order the Company accepted them
    messages: list[dict[str, Any]] = field(default_factory=list)  # those messages, as sent, by whichever User sent them
    log: list[dict[str, Any]] = field(default_factory=list)  # every event read so far, from the start
    status: str = "idle"
    responder: str = "agent"
    parent: "MConversation | None" = None  # set on a Direct Conversation (7.10)
    children: list["MConversation"] = field(default_factory=list)  # every Direct Conversation opened from this one
    direct_child: "MConversation | None" = None  # the open one, if any
    requested: list[str] = field(default_factory=list)  # `user_requested` reasons the Company added (7.10)

    @property
    def closed(self) -> bool:
        return self.status == "closed"

    @property
    def direct(self) -> bool:
        return self.parent is not None


def same_url(a: str, b: str) -> bool:
    """Two URLs alike once scheme and host are lower-cased, a default port dropped and an empty path made `/` (RFC 3986 6.2.3)."""

    def norm(url: str) -> tuple[str, str, int | None, str, str]:
        parts = urllib.parse.urlsplit(url)
        scheme = parts.scheme.lower()
        port = parts.port if parts.port not in ({"https": 443, "http": 80}.get(scheme),) else None
        return scheme, (parts.hostname or "").lower(), port, parts.path or "/", parts.query

    return norm(a) == norm(b)


class Refused(AssertionError):
    pass


COVERAGE: Counter[str] = Counter()
"""Each outcome a rule expected and got, `rule: status error`; conftest prints them, to show what the runs reached."""


def expect(reply: Reply, status: int, error: str | None = None) -> Reply:
    COVERAGE[f"{sys._getframe(1).f_code.co_name}: {status} {error or ''}".rstrip()] += 1
    if reply.status != status or (error is not None and reply.error != error):
        raise Refused(f"expected {status} {error or ''}, got {reply.status} {reply.error}: {reply.text[:400]}")
    return reply


def reached(outcome: str) -> None:
    """Count an outcome that isn't one response, such as a Direct Sign-In error in a redirect."""
    COVERAGE[f"{sys._getframe(1).f_code.co_name}: {outcome}"] += 1


# ---------------------------------------------------------------- the base machine


class Base(RuleBasedStateMachine):
    """Setup, the model's helpers, and the invariants every machine holds."""

    CONFIG: st.SearchStrategy[dict[str, Any]] = CONFIGS
    LISTS_OPERATIONS: st.SearchStrategy[bool] = st.just(False)

    def __init__(self, server: MockServer) -> None:
        super().__init__()
        self.server = server
        self.clock = Clock()
        self.transport = LocalTransport(server.company_port, SUFFIX, self.clock)
        self.http = httpx.Client(transport=self.transport, timeout=30)
        self.agent = PersonalAgent()
        self.poppy = Poppy(self.agent, self.http)
        self.other_agent = PersonalAgent(origin="https://other-agent.hypothesis.test")
        self.company: Company | None = None
        self.config: dict[str, Any] = {}
        self.expected: list[str] = []
        self.users: list[MUser] = []
        self.conversations: list[MConversation] = []
        self.sessions_started: set[str] = set()
        # Requests a reject rule sent with the wrong scheme on purpose: a Bearer token outside MCP, a DPoP one to it.
        self.bearer_elsewhere = 0
        self.dpop_to_mcp = 0

    def teardown(self) -> None:
        for u in self.users:
            for ms in u.sessions:
                if ms.browser:
                    ms.browser.close()
        self.http.close()

    # ---- helpers ----

    @property
    def co(self) -> Company:
        assert self.company is not None
        return self.company

    def violation(self, violation_id: str) -> None:
        self.expected.append(violation_id)

    def live(self, user: MUser | None = None) -> list[MSession]:
        users = [user] if user else self.users
        return [s for u in users for s in u.sessions if not s.ended]

    def all_sessions(self) -> list[MSession]:
        return [s for u in self.users for s in u.sessions]

    def conversation(self, cid: str) -> MConversation:
        return next(c for c in self.conversations if c.id == cid)

    def can_read(self, ms: MSession, conversation: MConversation) -> bool:
        """
        7.2: a conversation belongs to the agent and the User that started
        it; once it uses the User's account, it belongs to that account
        instead, so any Session of this agent signed in to it may continue
        it, whichever User (our reading of S17, docs/readings.md).
        """
        if conversation.account is not None:
            return ms.account == conversation.account
        return ms.user is conversation.user

    def refusal(self, ms: MSession, conversation: MConversation) -> tuple[int, str] | None:
        """
        What a Session that may not use the conversation gets: the same
        User signed out of its account, `sign_in_required` (7.11); anyone
        else `conversation_not_found` (7.13), which the mock records as a
        cross-User reach (S17).
        """
        if self.can_read(ms, conversation):
            return None
        if ms.user is conversation.user:
            return 403, "sign_in_required"
        self.violation("conversation.cross-user")
        return 404, "conversation_not_found"

    def accepted(self, conversation: MConversation, ms: MSession, message: dict[str, Any], *, started: bool = False, parent: str | None = None) -> None:
        """The Company took one of our messages into the conversation (7.3)."""
        if not started:
            conversation.sent.append(message["id"])
        conversation.messages.append(message)
        ms.user.sent[message["id"]] = MSent(message, conversation.id, started=started, parent=parent)

    def token_body(self, reply: Reply, *, session_id: str | None = None, signed_in: bool, scope: frozenset[str], token_type: str = "DPoP") -> dict[str, Any]:
        """A successful token response (4.2)."""
        expect(reply, 200)
        body = reply.body
        assert isinstance(body, dict), reply.text
        assert isinstance(body.get("access_token"), str) and body["access_token"]
        assert body.get("token_type") == token_type, body
        assert isinstance(body.get("expires_in"), int) and body["expires_in"] > 0, "expires_in MUST be greater than 0 (4.2)"
        assert isinstance(body.get("session_id"), str)
        if session_id is not None:
            assert body["session_id"] == session_id, "a renewal keeps its Session"
        assert body.get("signed_in") is signed_in, body
        if "scope" in body:
            granted = body["scope"].split()
            assert len(granted) == len(set(granted)) and set(granted) == scope, (body["scope"], scope)
        else:
            assert self.config["omitTokenScope"], "scope missing from a token response"
        assert "no-store" in reply.headers.get("cache-control", ""), "token responses aren't cached"
        return body

    def new_session(self, mu: MUser, body: dict[str, Any], key: Es256Key) -> MSession:
        assert body["session_id"] not in self.sessions_started, "a new Session got an old id"
        self.sessions_started.add(body["session_id"])
        ms = MSession(Session(mu.user, body["session_id"], body["access_token"], key, body["signed_in"]), mu)
        mu.sessions.append(ms)
        return ms

    def sign_out_sessions(self, grants: list[MGrant]) -> None:
        """4.9: revoking an Account Token signs out every Session signed in with it, or ends them."""
        for grant in grants:
            for ms in grant.user.sessions:
                if ms.grant is grant:
                    ms.account, ms.grant, ms.token_scope = None, None, frozenset()
                    ms.session.signed_in = False
                    if self.config["endSessionsOnSignOut"]:
                        ms.ended = True

    def rotate(self, grant: MGrant, body: dict[str, Any]) -> None:
        """4.8: a new Account Token in `refresh_token` replaces the old one from then on."""
        new = body.get("refresh_token")
        if self.config["rotateRefreshTokens"]:
            assert isinstance(new, str) and new != grant.current, "a rotating Company returns a new Account Token"
        if isinstance(new, str) and new != grant.current:
            grant.superseded.append(grant.current)
            grant.current = new

    def signed_in(self, ms: MSession, grant: MGrant, body: dict[str, Any], key: Es256Key, scope: frozenset[str]) -> None:
        """The Session is signed in with `grant` now, with a new DPoP Session Token."""
        ms.account, ms.bound, ms.grant, ms.token_scope = grant.account, grant.account, grant, scope
        ms.session.token, ms.session.key, ms.session.signed_in = body["access_token"], key, True

    def scripted_agent(self, conversation: MConversation, ms: MSession, message: dict[str, Any]) -> None:
        """
        The mock's Company Agent, as its fixture documents it (test/mock-company
        conversations.ts): it doesn't answer while a person is wanted or
        handling it; `person` hands off (7.9: the status becomes queued); an
        order, exchange or return, asked signed in with read and write, uses
        the account (7.2).
        """
        if ("text" not in message and "data" not in message) or not self.config["agentReplies"]:
            return
        if conversation.status == "queued" or conversation.responder == "human":
            return
        text = message.get("text", "").lower()
        if "person" in text:
            conversation.status = "queued"
        elif re.search("order|exchange|return", text) and ms.account and {READ, WRITE} <= ms.token_scope:
            conversation.account = ms.account

    def check_status(self, conversation: MConversation, body: Any, where: str) -> None:
        """7.7: every successful POST and read says `status` and `responder`, and they are the model's."""
        assert isinstance(body, dict), body
        got = (body.get("status"), body.get("responder"))
        assert got[0] in STATUSES and got[1] in RESPONDERS, f"{where}: status and responder are required (7.7): {body}"
        assert got == (conversation.status, conversation.responder), f"{where}: {got}, model {(conversation.status, conversation.responder)}"

    def absorb(self, conversation: MConversation, cursor: str | None, events: list[dict[str, Any]], page: dict[str, Any] | None) -> None:
        """
        Hold one read (7.5) to the log: from `cursor` it returns the events
        after it that we already know, in order, then only new ones; no event
        twice; and `cursor` is the last event, or the request's.
        """
        ids = [event["id"] for event in events]
        assert len(ids) == len(set(ids)), f"an event twice in one read: {ids}"
        start = 0 if cursor is None else [e["id"] for e in conversation.log].index(cursor) + 1
        known = conversation.log[start:]
        assert events[: len(known)] == known[: len(events)], "a read changed or reordered events already read"
        new = events[len(known):]
        seen = {e["id"] for e in conversation.log}
        assert not [e for e in new if e["id"] in seen], "an event read again after its cursor"
        conversation.log.extend(new)
        mine = [e["message"]["id"] for e in conversation.log if e.get("type") == "message" and e["message"].get("role") == "user"]
        assert mine == conversation.sent[: len(mine)], f"our messages, out of order or twice: {mine} vs {conversation.sent}"
        if page is not None:
            for name in ("cursor", "has_more", "status", "responder"):
                assert name in page, f"a read without {name} (7.5)"
            assert page["cursor"] == (ids[-1] if ids else cursor), "cursor isn't the last event, or the request's"

    def log_checks(self, conversation: MConversation) -> tuple[str, str] | None:
        """
        What the whole log, read from the start, must hold, whatever was
        done to the conversation; returns the last `state` event's status
        and responder.

        - 7.5, 7.7: every event has an id, type and time; a `state` event
          carries a valid status and responder and marks a change ("after
          either one changes"), and while `queued`, `responder` stays `agent`.
        - 7.7: a Company message says who wrote it, and `human` means a
          person has joined, so a person's message comes after a `state`
          event with `responder: human`.
        - 7.12: a closed conversation takes no more messages, and its
          status doesn't change again.
        - 7.10: each Direct Conversation opened from it has a
          `direct_opened` event, and once it closed, a `direct_closed` event
          after that, however it was closed.
        - 7.10: each `user_requested` the Company added, with its `reason`.
        - Ops 2: no operation to an agent that doesn't list the extension.
        """
        last: tuple[str, str] | None = None
        closed = False
        opened: dict[str, int] = {}
        closed_children: dict[str, int] = {}
        for index, event in enumerate(conversation.log):
            kind = event.get("type")
            assert isinstance(event.get("id"), str) and isinstance(kind, str) and isinstance(event.get("created_at"), str), event
            if closed:
                assert kind not in ("message", "state"), f"a closed conversation changed: {event}"
            if kind == "state":
                pair = (event.get("status"), event.get("responder"))
                assert pair[0] in STATUSES and pair[1] in RESPONDERS, event
                assert pair != last, f"a state event that changes nothing (7.5, 7.7): {pair}"
                assert pair[0] != "queued" or pair[1] == "agent", "queued with responder human: while queued, responder stays agent (7.7)"
                last = pair  # type: ignore[assignment]
                closed = pair[0] == "closed"
            elif kind == "message":
                message = event["message"]
                if message.get("role") == "company":
                    assert message.get("sender") in RESPONDERS, f"a Company message without sender (7.7): {message}"
                    if message["sender"] == "human":
                        assert last is not None and last[1] == "human", "a person wrote before responder became human (7.7)"
                else:
                    assert message.get("role") == "user", message
                if not self.agent.lists_operations:
                    assert "operation" not in message, "an operation for an agent that doesn't list the extension (Ops 2)"
            elif kind == "direct_opened":
                opened[event["conversation_id"]] = index
            elif kind == "direct_closed":
                assert event["conversation_id"] in opened, f"direct_closed before direct_opened: {event}"
                closed_children[event["conversation_id"]] = index
        reasons = [event.get("reason") for event in conversation.log if event.get("type") == "user_requested"]
        assert reasons == conversation.requested, f"user_requested reasons {reasons}, model {conversation.requested} (7.10)"
        for child in conversation.children:
            assert child.id in opened, f"{conversation.id}: no direct_opened for its Direct Conversation {child.id} (7.10)"
            if child.closed:
                assert child.id in closed_children, f"{conversation.id}: its Direct Conversation {child.id} closed, but no direct_closed (7.10)"
            else:
                assert child.id not in closed_children, f"{conversation.id}: direct_closed for {child.id}, which is open"
        return last

    def full_read_checks(self, conversation: MConversation, page: dict[str, Any] | None) -> None:
        mine = [e for e in conversation.log if e.get("type") == "message" and e["message"].get("role") == "user"]
        assert [e["message"]["id"] for e in mine] == conversation.sent, "every message we sent, once, in order"
        for event, original in zip(mine, conversation.messages):
            sent = event["message"]["id"]
            shown = {k: v for k, v in original.items() if k != "context"} | {"role": "user", "id": sent}
            assert canonical(event["message"]) == canonical(shown), (event["message"], shown)
        last = self.log_checks(conversation)
        if page is not None:
            self.check_status(conversation, page, "a read to the end")
            if last is not None:
                assert last == (page["status"], page["responder"]), f"the last state event {last} isn't the read's {page['status']}, {page['responder']}"
        elif last is not None:
            assert last == (conversation.status, conversation.responder), f"the last state event {last}, model {(conversation.status, conversation.responder)}"

    # ---- MCP (6) with Bearer Session Tokens (4.3) ----

    def bearer_scope(self, ms: MSession) -> frozenset[str]:
        return ms.grant.scope if ms.grant is not None else frozenset()

    def ensure_bearer(self, ms: MSession) -> MBearer:
        """
        4.3: a Bearer Session Token for the MCP server, from the request
        that renews the Session's token without `DPoP` and with `resource`
        set to the MCP server's `url`: the Account Token for a signed-in
        Session (4.8, which may rotate it), the assertion for a signed-out
        one (4.2). Asked for again whenever the Session's sign-in changed.
        """
        scope = self.bearer_scope(ms)
        if ms.bearer is not None and ms.bearer.account == ms.account and ms.bearer.scope == scope:
            return ms.bearer
        grant = ms.grant
        reply = self.poppy.bearer_token(self.co, ms.session, grant.current if grant else None)
        body = self.token_body(reply, session_id=ms.session.session_id, signed_in=grant is not None, scope=scope, token_type="Bearer")
        if grant is not None:
            self.rotate(grant, body)
        ms.bearer = MBearer(body["access_token"], ms.account, scope)
        return ms.bearer

    def mcp_call(self, ms: MSession, method: str, params: dict[str, Any] | None = None) -> Reply:
        """One MCP request with the Session's Bearer token, after `initialize` (MCP 2025-06-18 lifecycle)."""
        bearer = self.ensure_bearer(ms)
        if bearer.mcp_session is None:
            init = expect(
                self.poppy.mcp(
                    bearer.token,
                    self.co,
                    {
                        "jsonrpc": "2.0",
                        "id": 0,
                        "method": "initialize",
                        "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "hypothesis", "version": "0"}},
                    },
                ),
                200,
            )
            assert init.body["result"]["protocolVersion"] == "2025-06-18", init.body
            bearer.mcp_session = init.headers.get("mcp-session-id")
            assert bearer.mcp_session, "initialize without an Mcp-Session-Id"
            self.poppy.mcp(bearer.token, self.co, {"jsonrpc": "2.0", "method": "notifications/initialized"}, mcp_session=bearer.mcp_session)
        rpc: dict[str, Any] = {"jsonrpc": "2.0", "id": len(self.transport.log), "method": method}
        if params is not None:
            rpc["params"] = params
        return self.poppy.mcp(bearer.token, self.co, rpc, mcp_session=bearer.mcp_session)

    # ---- the browser (5) ----

    def join_browser(self, ms: MSession, return_to: str | None = None) -> httpx.Response:
        """
        5: join this Session's own browser with a signed browser assertion,
        posted as a form, and hold the Company's answer to the section's
        MUSTs: 303 to `return_to`, and a cookie that is `Secure`,
        `HttpOnly` and `SameSite` Lax or None.
        """
        from poppy_client import set_cookie_attributes

        assert self.co.browser_session is not None
        if ms.browser is None:
            ms.browser = Browser(self.transport)
        target = return_to or f"https://{self.co.organization_domain}/orders"
        assertion = self.agent.browser_assertion(ms.user.user.user_id, ms.session.session_id, self.co.browser_session, target)
        response = ms.browser.join(self.co.browser_session, assertion)
        assert response.status_code == 303, (response.status_code, response.text[:200])
        assert same_url(response.headers.get("location", ""), target), f"303 to {response.headers.get('location')}, not return_to {target} (5)"
        cookies = response.headers.get_list("set-cookie")
        assert cookies, "a join without a cookie"
        for cookie in cookies:
            _, attributes = set_cookie_attributes(cookie)
            assert "secure" in attributes and "httponly" in attributes, f"the cookie MUST be Secure and HttpOnly (5): {cookie}"
            assert (attributes.get("samesite") or "").lower() in ("lax", "none"), f"the cookie MUST be SameSite Lax or None (5): {cookie}"
        ms.joined = True
        return response

    def close_in_model(self, conversation: MConversation) -> None:
        """7.10, 7.12: closing closes its open Direct Conversation, and frees the parent of a closed one."""
        if conversation.closed:
            return
        conversation.status = "closed"
        if conversation.direct_child is not None:
            child, conversation.direct_child = conversation.direct_child, None
            self.close_in_model(child)
        if conversation.parent is not None and conversation.parent.direct_child is conversation:
            conversation.parent.direct_child = None

    # ---- setup ----

    @initialize(data=st.data())
    def setup(self, data: st.DataObject) -> None:
        config = data.draw(self.CONFIG, label="config")
        self.agent.lists_operations = data.draw(self.LISTS_OPERATIONS, label="agent lists operations")
        self.config = config
        self.server.reset(config)
        self.server.serve_client_documents(self.agent.documents() | self.other_agent.documents())
        self.company = self.poppy.discover(DOMAIN)
        self.fixture = self.server.hook("fixture")
        openapi = self.http.get(self.co.openapi).json()
        server = openapi["servers"][0]["url"]
        self.api_ops = [
            (path, [scope for requirement in op.get("security", []) for scope in requirement.get("session", [])])
            for path, item in openapi["paths"].items()
            for method, op in item.items()
            if method == "get" and "{" not in path
        ]
        self.api_base = server
        first = MUser(User())
        self.users.append(first)
        # One Session to start with, so runs reach sign-in and conversations sooner.
        body = self.token_body(self.poppy.start_session(self.co, first.user), signed_in=False, scope=frozenset())
        self.new_session(first, body, first.user.dpop_key)
        self.warm_up(data)

    def warm_up(self, data: st.DataObject) -> None:
        """A machine whose surface needs signed-in Sessions starts with a drawn number of them (`WarmUp`)."""

    # ---- invariants ----

    @invariant()
    def violations_are_exactly_the_expected_ones(self) -> None:
        if self.company is None:
            return
        got = self.server.violations()
        assert [v["id"] for v in got] == self.expected, json.dumps(got, indent=1)

    @invariant()
    def sessions_match_the_model(self) -> None:
        if self.company is None:
            return
        state = self.server.state()
        mock = {s["id"]: s for s in state["sessions"]}
        assert set(mock) == self.sessions_started, "the Company's Sessions aren't the ones we started"
        for u in self.users:
            for ms in u.sessions:
                assert mock[ms.session.session_id]["ended"] == ms.ended, f"{ms.session.session_id} ended?"
                actual = mock[ms.session.session_id]
                assert actual["userId"] == ms.user.user.user_id, actual
                assert actual["account"] == ms.account, actual
                assert actual["signedIn"] == (ms.account is not None), actual

    @invariant()
    def bearer_tokens_only_to_the_mcp_server(self) -> None:
        """
        4.3: a Bearer Session Token goes only to the MCP server it was
        issued for, and everything else carries DPoP. Held over every request
        this client sent, as the transport saw it; the reject rules that
        break it on purpose are counted.
        """
        if self.company is None:
            return
        bearer_elsewhere = [x for x in self.transport.log if x.scheme == "Bearer" and x.url != self.co.mcp]
        dpop_to_mcp = [x for x in self.transport.log if x.scheme == "DPoP" and x.url == self.co.mcp]
        assert len(bearer_elsewhere) == self.bearer_elsewhere, [x.url for x in bearer_elsewhere]
        assert len(dpop_to_mcp) == self.dpop_to_mcp, len(dpop_to_mcp)


# ---------------------------------------------------------------- Users, Sessions and sign-in (4.2 to 4.9)


class SessionRules:
    """Honest rules that make Users, Sessions and sign-ins, for every machine."""

    @precondition(lambda self: self.company is not None and len(self.users) < MAX_USERS)
    @rule()
    def add_user(self) -> None:
        self.users.append(MUser(User()))

    @precondition(lambda self: self.company is not None)
    @rule(data=st.data())
    def start_session(self, data: st.DataObject) -> None:
        mu = data.draw(st.sampled_from(self.users))
        assume(len(mu.sessions) < MAX_SESSIONS)
        reply = self.poppy.start_session(self.co, mu.user)
        body = self.token_body(reply, signed_in=False, scope=frozenset())
        self.new_session(mu, body, mu.user.dpop_key)

    @precondition(lambda self: self.company is not None)
    @rule(data=st.data())
    def new_dpop_key(self, data: st.DataObject) -> None:
        """Guides: to switch keys, request new Session Tokens with proofs signed by the new key."""
        mu = data.draw(st.sampled_from(self.users))
        mu.user.dpop_key = Es256Key()

    @precondition(lambda self: self.live())
    @rule(data=st.data())
    def renew(self, data: st.DataObject) -> None:
        """Renew: signed out with the assertion and `session_id` (4.2), signed in with the Account Token (4.8)."""
        ms = data.draw(st.sampled_from(self.live()))
        mu = ms.user
        if ms.grant is None:
            reply = self.poppy.start_session(self.co, mu.user, session_id=ms.session.session_id)
            body = self.token_body(reply, session_id=ms.session.session_id, signed_in=False, scope=frozenset())
            ms.token_scope = frozenset()
        else:
            grant = ms.grant
            assert not grant.revoked
            narrower = data.draw(st.none() | st.lists(st.sampled_from(sorted(grant.scope)), unique=True) if grant.scope else st.none())
            reply = self.poppy.refresh(self.co, mu.user.dpop_key, grant.current, ms.session.session_id, narrower)
            scope = frozenset(narrower) if narrower is not None else grant.scope
            body = self.token_body(reply, session_id=ms.session.session_id, signed_in=True, scope=scope)
            self.rotate(grant, body)
            ms.token_scope = scope
        ms.session.token, ms.session.key = body["access_token"], mu.user.dpop_key

    @precondition(lambda self: self.live())
    @rule(data=st.data())
    def sign_in(self, data: st.DataObject) -> None:
        """Direct, Device or Mediated Sign-In into a Session, as the User approves (4.5 to 4.7)."""
        ms = data.draw(st.sampled_from(self.live()))
        mu = ms.user
        kinds = [kind for kind in ("direct", "device", "mediated") if self.co.offered(kind)]
        kind = data.draw(st.sampled_from(kinds))
        offered = self.co.offered(kind)
        # Every subset can be drawn; "all of them" and "what was asked" are also drawn directly, as the common case.
        requested = data.draw(st.just(offered) | st.lists(st.sampled_from(offered), min_size=1, unique=True))
        account = data.draw(st.sampled_from(self.fixture["accounts"]))
        # 4.4: after account_mismatch an agent starts a new Session; it never asks that one again for another account.
        assume(not (ms.mismatched and ms.bound != account))
        granted = requested
        if kind == "direct":
            granted = data.draw(st.just(requested) | st.lists(st.sampled_from(requested), unique=True))
            url, state, verifier = self.poppy.authorization_url(self.co, requested)
            redirect = self.server.hook("approve_authorization", url=url, account=account, scopes=granted)["redirect"]
            params = self.poppy.callback(self.co, redirect, state)
            assert "code" in params and "error" not in params, params
            reply = self.poppy.exchange_code(self.co, Session(mu.user, ms.session.session_id, ms.session.token, mu.user.dpop_key, False), params["code"], verifier)
            key = mu.user.dpop_key
        elif kind == "device":
            granted = data.draw(st.just(requested) | st.lists(st.sampled_from(requested), unique=True))
            start = expect(self.poppy.device_start(self.co, requested), 200).body
            for name in ("device_code", "user_code", "verification_uri", "expires_in"):
                assert name in start, f"device authorization response without {name}"
            self.server.hook("approve_device", user_code=start["user_code"], account=account, scopes=granted)
            reply = self.poppy.device_poll(self.co, Session(mu.user, ms.session.session_id, ms.session.token, mu.user.dpop_key, False), start["device_code"])
            key = mu.user.dpop_key
        else:
            fields = self.server.hook("mediated_answers", account=account)["fields"]
            reply = self.poppy.mediated_start(self.co, ms.session, requested, fields)
            if reply.status == 200 and isinstance(reply.body, dict) and reply.body.get("status") == "code_required":
                assert isinstance(reply.body.get("sign_in_id"), str)
                code = self.server.hook("last_one_time_code")["code"]
                reply = self.poppy.mediated_code(self.co, ms.session, reply.body["sign_in_id"], code)
            key = ms.session.key
        if ms.bound is not None and ms.bound != account:
            expect(reply, 400, "account_mismatch")  # 4.4: a Session can't switch accounts
            ms.mismatched = True
            return
        body = self.token_body(reply, session_id=ms.session.session_id, signed_in=True, scope=frozenset(granted))
        if kind == "mediated":
            assert body.get("status") == "complete", body
        assert isinstance(body.get("refresh_token"), str), "a sign-in returns an Account Token"
        grant = MGrant(mu, account, frozenset(granted), body["refresh_token"])
        mu.grants.append(grant)
        self.signed_in(ms, grant, body, key, frozenset(granted))

    @precondition(lambda self: any(not g.revoked for u in self.users for g in u.grants))
    @rule(data=st.data())
    def use_account_token(self, data: st.DataObject) -> None:
        """4.4 step 1 and 4.8: a stored Account Token signs a Session in, or a new one, without asking the User."""
        grant = data.draw(st.sampled_from([g for u in self.users for g in u.grants if not g.revoked]))
        mu = grant.user
        targets = self.live(mu)
        ms = data.draw(st.none() | st.sampled_from(targets)) if targets else None
        # 4.4: after account_mismatch an agent starts a new Session; it never asks that one again for another account.
        assume(ms is None or not (ms.mismatched and ms.bound != grant.account))
        reply = self.poppy.refresh(self.co, mu.user.dpop_key, grant.current, ms.session.session_id if ms else None)
        if ms is not None and ms.bound is not None and ms.bound != grant.account:
            expect(reply, 400, "account_mismatch")
            ms.mismatched = True
            return
        body = self.token_body(reply, session_id=ms.session.session_id if ms else None, signed_in=True, scope=grant.scope)
        self.rotate(grant, body)
        if ms is None:
            ms = self.new_session(mu, body, mu.user.dpop_key)
        self.signed_in(ms, grant, body, mu.user.dpop_key, grant.scope)

    @precondition(lambda self: any(not g.revoked for u in self.users for g in u.grants))
    @rule(data=st.data())
    def sign_out(self, data: st.DataObject) -> None:
        """4.9: revoke the Account Token; its Sessions carry on signed out (or end)."""
        grant = data.draw(st.sampled_from([g for u in self.users for g in u.grants if not g.revoked]))
        expect(self.poppy.revoke(self.co, grant.current), 200)
        grant.revoked = True
        self.sign_out_sessions([grant])


class ApiRules:
    # ---- APIs (6): what a Session may do is what the model says it holds ----

    @precondition(lambda self: self.live())
    @rule(data=st.data())
    def call_api(self, data: st.DataObject) -> None:
        ms = data.draw(st.sampled_from(self.live()))
        path, needed = data.draw(st.sampled_from(self.api_ops))
        reply = self.poppy.resource(ms.session, "GET", self.api_base + path, self.co)
        if not needed:
            expect(reply, 200)
        elif ms.account is None:
            expect(reply, 403, "sign_in_required")
        elif not set(needed) <= ms.token_scope:
            expect(reply, 403, "insufficient_scope")
        else:
            expect(reply, 200)
            if path == "/orders":
                assert isinstance(reply.body, dict) and isinstance(reply.body.get("orders"), list), reply.body
                assert [order["order_id"] for order in reply.body["orders"]] == ["ord_7Hk2"], reply.body
                for order in reply.body["orders"]:
                    assert order["account"] == ms.account, "a Session sees its own account's orders"
            elif path == "/products":
                assert isinstance(reply.body, dict) and isinstance(reply.body.get("products"), list), reply.body
            elif path == "/addresses":
                assert isinstance(reply.body, dict) and isinstance(reply.body.get("addresses"), list), reply.body


class WarmUp:
    """
    Start with up to three Users, each with a Session, and up to four
    sign-ins drawn as the `sign_in` rule draws them, so a machine reaches
    states such as two Users signed in to one account within its steps.
    """

    def warm_up(self, data: st.DataObject) -> None:
        for _ in range(data.draw(st.integers(0, MAX_USERS - 1), label="extra Users")):
            self.add_user()
            mu = self.users[-1]
            body = self.token_body(self.poppy.start_session(self.co, mu.user), signed_in=False, scope=frozenset())
            self.new_session(mu, body, mu.user.dpop_key)
        for _ in range(data.draw(st.integers(0, 4), label="sign-ins")):
            self.sign_in(data)


# ---------------------------------------------------------------- conversations (7)


class ConversationRules:
    """Honest conversation rules, and the conversation errors of 7.13."""

    def new_message_id(self, data: st.DataObject, mu: MUser) -> str:
        """Unique for the User (7.3); another User's ids are fair game."""
        others = [mid for u in self.users if u is not mu for mid in u.sent]
        mid = data.draw(st.sampled_from(others) | MESSAGE_IDS if others else MESSAGE_IDS)
        assume(mid not in mu.sent)
        return mid

    def a_message(self, data: st.DataObject, mu: MUser, *, direct: bool = False) -> dict[str, Any]:
        """
        A message the Personal Agent may send (7.3, 7.4). Into a Direct
        Conversation it relays the User's words as written, as `human`
        (7.10); it may still send `context` alone as itself (7.4).
        """
        message = {"id": self.new_message_id(data, mu)} | data.draw(messages(list(self.fixture["prompts"].values())))
        if direct and ("text" in message or "data" in message):
            message["sender"] = "human"
        return message

    def started(self, ms: MSession, message: dict[str, Any], reply: Reply, *, parent: MConversation | None = None) -> MConversation:
        """A 201 for a new conversation (7.3), or a Direct Conversation (7.10): the model gains it."""
        body = reply.body
        cid = body["conversation_id"]
        assert cid not in [c.id for c in self.conversations], "a new conversation got an old id"
        conversation = MConversation(cid, ms.user, sent=[message["id"]], parent=parent)
        if parent is not None:
            # 7.10: it belongs to the parent's owner, and the parent waits for it.
            conversation.account = parent.account
            parent.children.append(conversation)
            parent.direct_child = conversation
        self.conversations.append(conversation)
        self.accepted(conversation, ms, message, started=True, parent=parent.id if parent else None)
        self.scripted_agent(conversation, ms, message)
        # A new conversation's first status is the Company's to choose; a person hasn't joined, and it isn't closed (7.7).
        assert body.get("responder") == "agent" and body.get("status") in {"idle", "working", "queued"}, body
        if conversation.status != "queued":
            assert body["status"] != "queued", f"queued without a handoff: {body}"
            conversation.status = body["status"]
        self.check_status(conversation, body, "a new conversation")
        return conversation

    @precondition(lambda self: self.live() and self.co.conversations)
    @rule(data=st.data())
    def start_conversation(self, data: st.DataObject) -> None:
        ms = data.draw(st.sampled_from(self.live()))
        message = self.a_message(data, ms.user)
        raw = data.draw(serialisations(message))
        wait = data.draw(st.sampled_from([None, 0, 1]))
        reply = expect(self.poppy.post_message(ms.session, self.co, raw, None, wait=wait), 201)
        conversation = self.started(ms, message, reply)
        if wait is not None:
            self.absorb(conversation, None, reply.body["events"], reply.body)

    @precondition(lambda self: any(s.account and {READ, WRITE} <= s.token_scope for s in self.live()))
    @rule(data=st.data())
    def ask_about_an_order(self, data: st.DataObject) -> None:
        """
        Signed in with read and write, start a conversation with the
        fixture's `operation` prompt, which the Company answers using the
        account (7.2, 7.11). The other rules then meet a conversation that
        belongs to an account: retries, reads and sign-out.
        """
        ms = data.draw(st.sampled_from([s for s in self.live() if s.account and {READ, WRITE} <= s.token_scope]))
        message = {"id": self.new_message_id(data, ms.user), "sender": data.draw(st.sampled_from(["agent", "human"])), "text": self.fixture["prompts"]["operation"]}
        reply = expect(self.poppy.post_message(ms.session, self.co, data.draw(serialisations(message)), None), 201)
        self.started(ms, message, reply)

    def readable(self) -> list[tuple[MConversation, MSession]]:
        return [(c, s) for c in self.conversations for s in self.live() if self.can_read(s, c)]

    def sendable(self) -> list[tuple[MConversation, MSession]]:
        """Where the honest agent sends: open, and not waiting on a Direct Conversation (7.10)."""
        return [(c, s) for c, s in self.readable() if not c.closed and c.direct_child is None]

    @precondition(lambda self: self.sendable())
    @rule(data=st.data())
    def send_message(self, data: st.DataObject) -> None:
        conversation, ms = data.draw(st.sampled_from(self.sendable()))
        mu = ms.user
        message = self.a_message(data, mu, direct=conversation.direct)
        raw = data.draw(serialisations(message))
        wait = data.draw(st.sampled_from([None, 0, 1]))
        cursor = conversation.log[-1]["id"] if conversation.log else None
        reply = expect(self.poppy.post_message(ms.session, self.co, raw, conversation.id, wait=wait, cursor=cursor), 202)
        assert reply.body["conversation_id"] == conversation.id
        self.accepted(conversation, ms, message)
        self.scripted_agent(conversation, ms, message)
        self.check_status(conversation, reply.body, "a message")
        if wait is not None:
            self.absorb(conversation, cursor, reply.body["events"], reply.body)

    @precondition(lambda self: any(u.sent and self.live(u) for u in self.users))
    @rule(data=st.data())
    def resend_message(self, data: st.DataObject) -> None:
        """
        A retry (7.3): the same id and the same content, in any member order
        or spelling, returns the original response and adds nothing. After
        the conversation used an account, a retry from a token not signed in
        to it gets `sign_in_required` (7.11; our reading of S8: 7.11 wins).
        A Direct Conversation's first message is retried as it was sent,
        with its parent.
        """
        mu = data.draw(st.sampled_from([u for u in self.users if u.sent and self.live(u)]))
        mid = data.draw(st.sampled_from(sorted(mu.sent)))
        original = mu.sent[mid]
        conversation = self.conversation(original.conversation)
        ms = data.draw(st.sampled_from(self.live(mu)))
        raw = data.draw(serialisations(original.message))
        reply = self.poppy.post_message(ms.session, self.co, raw, None if original.started else conversation.id, parent=original.parent)
        refused = self.refusal(ms, conversation)
        if refused is not None:
            expect(reply, *refused)
            return
        expect(reply, 201 if original.started else 202)
        assert reply.body["conversation_id"] == conversation.id, "a retry answers for the original conversation"

    def own_messages(self) -> list[tuple[MConversation, MSession]]:
        """Conversations a Session may use, where its User has sent a message."""
        return [(c, s) for c, s in self.readable() if any(m.conversation == c.id for m in s.user.sent.values())]

    @precondition(lambda self: self.own_messages())
    @rule(data=st.data())
    def conflicting_message_id(self, data: st.DataObject) -> None:
        """Reject: an id the Company accepted, with different content, is `message_id_conflict` (7.3)."""
        conversation, ms = data.draw(st.sampled_from(self.own_messages()))
        mid = data.draw(st.sampled_from(sorted(m for m, sent in ms.user.sent.items() if sent.conversation == conversation.id)))
        original = ms.user.sent[mid]
        message = {"id": mid} | data.draw(messages(list(self.fixture["prompts"].values())))
        assume(canonical(message) != canonical(original.message))
        raw = data.draw(serialisations(message))
        reply = self.poppy.post_message(ms.session, self.co, raw, None if original.started else conversation.id, parent=original.parent)
        expect(reply, 409, "message_id_conflict")
        self.violation("message.id-reused")

    @precondition(lambda self: any(c.closed for c, _ in self.readable()))
    @rule(data=st.data())
    def send_to_closed(self, data: st.DataObject) -> None:
        """Reject: a new message to a closed conversation is `conversation_closed` (7.13)."""
        conversation, ms = data.draw(st.sampled_from([(c, s) for c, s in self.readable() if c.closed]))
        message = self.a_message(data, ms.user, direct=conversation.direct)
        reply = self.poppy.post_message(ms.session, self.co, data.draw(serialisations(message)), conversation.id)
        expect(reply, 409, "conversation_closed")

    @precondition(lambda self: self.conversations and self.live())
    @rule(data=st.data())
    def read(self, data: st.DataObject) -> None:
        """
        Read to the end (7.5, 7.6), as JSON or a stream, from the start or
        the saved cursor. Who may read is 7.2 and 7.11: another User gets
        `conversation_not_found`; the same User not signed in to the account
        the conversation used gets `sign_in_required`.
        """
        conversation = data.draw(st.sampled_from(self.conversations))
        ms = data.draw(st.sampled_from(self.live()))
        self.read_as(conversation, ms, stream=data.draw(st.booleans()), from_start=data.draw(st.booleans()))

    @precondition(lambda self: any(not self.can_read(s, c) for c in self.conversations if c.account for s in self.live(c.user)))
    @rule(data=st.data())
    def read_after_sign_out(self, data: st.DataObject) -> None:
        conversation, ms = data.draw(
            st.sampled_from([(c, s) for c in self.conversations if c.account for s in self.live(c.user) if not self.can_read(s, c)])
        )
        self.read_as(conversation, ms, stream=data.draw(st.booleans()), from_start=True)

    def read_as(self, conversation: MConversation, ms: MSession, *, stream: bool, from_start: bool) -> None:
        cursor = None if from_start or not conversation.log else conversation.log[-1]["id"]
        page: dict[str, Any] | None = None
        for _ in range(100):
            reply, events = self.poppy.read_events(ms.session, self.co, conversation.id, cursor, stream=stream)
            refused = self.refusal(ms, conversation)
            if refused is not None:
                expect(reply, *refused)
                return
            expect(reply, 200)
            assert events is not None
            page = reply.body if isinstance(reply.body, dict) else None
            self.absorb(conversation, cursor, events, page)
            if events:
                cursor = events[-1]["id"]
            if (page is not None and not page["has_more"]) or (page is None and not events):
                break
        else:
            raise AssertionError("a read that never ends")
        self.full_read_checks(conversation, page)

    @precondition(lambda self: self.readable())
    @rule(data=st.data())
    def invalid_cursor(self, data: st.DataObject) -> None:
        """Reject: a cursor that isn't one of this conversation's events is `invalid_cursor` (7.13)."""
        conversation, ms = data.draw(st.sampled_from(self.readable()))
        others = [e["id"] for c in self.conversations if c is not conversation for e in c.log]
        cursor = data.draw(st.sampled_from(others) | st.text() if others else st.text())
        assume(cursor not in [e["id"] for e in conversation.log])
        reply, _ = self.poppy.read_events(ms.session, self.co, conversation.id, cursor, stream=False)
        expect(reply, 400, "invalid_cursor")

    @precondition(lambda self: any(not c.closed for c, _ in self.readable()))
    @rule(data=st.data())
    def close(self, data: st.DataObject) -> None:
        """7.12: closing says `closed`, with whoever handled it last; it closes its open Direct Conversation (7.10)."""
        conversation, ms = data.draw(st.sampled_from([(c, s) for c, s in self.readable() if not c.closed]))
        reply = expect(self.poppy.close_conversation(ms.session, self.co, conversation.id), 200)
        self.close_in_model(conversation)
        self.check_status(conversation, reply.body, "close")
