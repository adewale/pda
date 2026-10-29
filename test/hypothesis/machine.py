"""
The model and the rules the state machines share: a model-based, stateful
test of our mock Company (test/mock-company) over HTTP, driven by a second
Poppy client written in Python from the 0.3 text.

The model says what should be true: which Sessions the Company has seen, and
for each the account its last request carried (5.4); which sign-ins have
live refresh tokens, rotated or revoked; which access token each Session
sends; which message ids each User has used, and for what; what each
conversation's event log holds, in order, its status and responder, and its
Direct Conversations. Every response is held to it, and so is the mock's own
record of violations:

- after honest rules, `GET /violations` holds nothing new;
- each reject rule is refused with the error the text names, and the mock
  records exactly the violation id that rule expects, and nothing else.

Each test_*.py builds one machine from `Base` and the rule sets it needs,
so each surface gets the steps to reach deep states. Spec references (4.2,
8.3, ...) are to Poppy 0.3, the 28 October text; `Ops n` is Operations,
version 2; `MSI n` Mediated Sign-In.
"""

from __future__ import annotations

import json
import re
import sys
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

import httpx
from hypothesis import assume
from hypothesis import strategies as st
from hypothesis.stateful import RuleBasedStateMachine, initialize, invariant, precondition, rule

from mock_server import DOMAIN, SUFFIX, MockServer
from poppy_client import Browser, Clock, Company, Es256Key, LocalTransport, PersonalAgent, Poppy, Reply, Session, User, set_cookie_attributes
from strategies import CONFIGS, MESSAGE_IDS, canonical, messages, serialisations

READ, WRITE = "orders:read", "orders:write"
MAX_USERS = 3
MAX_SESSIONS = 8
STATUSES = frozenset({"working", "idle", "queued", "closed"})
RESPONDERS = frozenset({"agent", "human"})
# What the mock's Device Sign-In can grant (DEFAULT_CONFIG.signIn in test/mock-company/types.ts). The metadata
# can't say it: `scopes_supported` is the issuer's, for every sign-in type (4.7). A listed scope the type can't
# grant is left out (RFC 6749 3.3), and the token response names what was granted (RFC 6749 5.1).
DEVICE_GRANTS = frozenset({READ, WRITE})


# ---------------------------------------------------------------- the model


@dataclass(eq=False)
class MGrant:
    """One sign-in's refresh token (4.4): its newest value, the values rotation replaced, and whether it was revoked."""

    user: "MUser"
    account: str
    scope: frozenset[str]
    current: str
    superseded: list[str] = field(default_factory=list)
    revoked: bool = False


@dataclass(eq=False)
class MToken:
    """An access token (4.5), as it was issued: from which sign-in, with which scopes, its scheme, and for which `resource`."""

    value: str
    grant: MGrant
    scope: frozenset[str]
    token_type: str  # "DPoP" or "Bearer", as the token response named it
    key: Es256Key | None  # the DPoP key it is bound to
    resource: str | None = None  # an MCP server's `url` (RFC 8707), or None for the Company's default token
    mcp_session: str | None = None  # the MCP session this token opened, for an MCP token

    @property
    def account(self) -> str:
        return self.grant.account


@dataclass(eq=False)
class MSession:
    """
    One Session of one User: the agent's side (the `sid`, the access token it
    sends, the account it ever used, 5.4) and the Company's (whether it has
    seen the `sid`, and the account and sign-in of its last request).
    """

    session: Session
    user: "MUser"
    token: MToken | None = None  # what the honest agent sends with the Session header, signed in
    used: str | None = None  # the account the agent ever sent a token for in it: never another (5.4 SHOULD)
    seen: bool = False  # the Company started it, on the first request with its sid (5.3)
    remote_account: str | None = None  # the account the Company has it signed in to: its last request's token's
    remote_grant: MGrant | None = None  # the sign-in of the last token it carried
    bound: str | None = None  # the account the Company has ever seen it with: another is refused (5.4)
    ended: bool = False
    mcp: MToken | None = None  # its token for the MCP server, when signed in
    browser: Browser | None = None  # the Personal Agent's browser for this Session (6)
    joined: bool = False  # the browser holds the Company's cookie for this Session
    joined_as: str | None = None  # the account the join authorized, if any (6: the cookie acts for it)
    joined_grant: MGrant | None = None
    joined_scope: frozenset[str] = frozenset()  # the scopes the join authorized
    mcp_signed_out: str | None = None  # the Mcp-Session-Id it initialized while signed out

    @property
    def account(self) -> str | None:
        """The account the next honest request acts for: the token's, while it holds one."""
        return self.token.account if self.token else None

    @property
    def token_scope(self) -> frozenset[str]:
        return self.token.scope if self.token else frozenset()


@dataclass(eq=False)
class MSent:
    message: dict[str, Any]
    conversation: str
    started: bool  # sent with the POST that started the conversation
    parent: str | None = None  # the parent of the Direct Conversation it started (8.10)


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
    account: str | None = None  # 8.2: once it uses the User's account, it belongs to that account
    sent: list[str] = field(default_factory=list)  # our message ids, in the order the Company accepted them
    messages: list[dict[str, Any]] = field(default_factory=list)  # those messages, as sent, by whichever User sent them
    log: list[dict[str, Any]] = field(default_factory=list)  # every event read so far, from the start
    status: str = "idle"
    responder: str = "agent"
    parent: "MConversation | None" = None  # set on a Direct Conversation (8.10)
    children: list["MConversation"] = field(default_factory=list)  # every Direct Conversation opened from this one
    direct_child: "MConversation | None" = None  # the open one, if any
    requested: list[str] = field(default_factory=list)  # `user_requested` reasons the Company added (8.10)

    @property
    def closed(self) -> bool:
        return self.status == "closed"

    @property
    def direct(self) -> bool:
        return self.parent is not None


class Refused(AssertionError):
    pass


COVERAGE: Counter[str] = Counter()
"""Each outcome a rule expected and got, `rule: status error`; conftest prints them, to show what the runs reached."""


def expect(reply: Reply, status: int, error: str | None = None) -> Reply:
    COVERAGE[f"{sys._getframe(1).f_code.co_name}: {status} {error or ''}".rstrip()] += 1
    if reply.status != status or (error is not None and reply.error != error):
        raise Refused(f"expected {status} {error or ''}, got {reply.status} {reply.error}: {reply.text[:400]}")
    return reply


def expect_challenge(reply: Reply, scope: list[str]) -> Reply:
    """
    7: a request that needs the account, signed out, is a 401 with no error
    code and the scopes it needs in the challenge, which the Personal Agent
    handles as `insufficient_scope`.
    """
    COVERAGE[f"{sys._getframe(1).f_code.co_name}: 401 challenge"] += 1
    if reply.status != 401 or reply.error is not None or sorted((reply.challenge_scope or "").split()) != sorted(scope):
        raise Refused(f"expected a 401 challenge for {scope}, got {reply.status} {reply.error} {reply.headers.get('www-authenticate')}: {reply.text[:300]}")
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
        # Requests a reject rule sent on purpose with the Session header to an OAuth endpoint, or without it to a resource.
        self.session_header_misplaced = 0
        # Sessions another Personal Agent started in a reject rule: the Company has them, the model doesn't.
        self.other_sids: set[str] = set()

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

    def live_grants(self) -> list[MGrant]:
        return [g for u in self.users for g in u.grants if not g.revoked]

    def conversation(self, cid: str) -> MConversation:
        return next(c for c in self.conversations if c.id == cid)

    def new_session(self, mu: MUser) -> MSession:
        """A new Session: a `sid` the agent makes; nothing is requested (5.2). The Company starts it on its first request."""
        ms = MSession(Session(mu.user), mu)
        mu.sessions.append(ms)
        return ms

    def touch(self, ms: MSession, reply: Reply, sent: MToken | None | object = ...) -> None:
        """
        What one request with this Session's honest Session header did at the
        Company (5.3, 5.4): it started the Session if its `sid` was new, and
        the Session is signed in to the account of the token it carried, or
        signed out when it carried none (the sign-in stays recorded). A 429
        refused it before the Session was looked at.
        """
        if reply.status == 429:
            return
        token = ms.token if sent is ... else sent
        ms.seen = True
        if ms.ended:
            return
        if token is None:
            ms.remote_account = None
        elif isinstance(token, MToken) and not token.grant.revoked and (ms.bound is None or ms.bound == token.account):
            ms.remote_account, ms.remote_grant, ms.bound = token.account, token.grant, token.account

    def set_token(self, ms: MSession, token: MToken | None) -> None:
        ms.token = token
        if token is None:
            ms.session.sign_out()
        else:
            ms.session.token, ms.session.token_type, ms.session.key = token.value, token.token_type, token.key
            ms.used = token.account

    def can_read(self, ms: MSession, conversation: MConversation) -> bool:
        """
        8.2: a conversation belongs to the agent and the User that started
        it; once it uses the User's account, it belongs to that account
        instead, so any Session of this agent signed in to it may continue
        it, whichever User (our reading of S17, docs/readings.md).
        """
        if conversation.account is not None:
            return ms.account == conversation.account
        return ms.user is conversation.user

    def refusal(self, ms: MSession, conversation: MConversation) -> tuple[int, str | None] | None:
        """
        What a Session that may not use the conversation gets: the same
        User not signed in to its account, a challenge for the account
        (8.11, 7: 401 with no error code); anyone else
        `conversation_not_found` (8.13), which the mock records as a
        cross-User reach (S17).
        """
        if self.can_read(ms, conversation):
            return None
        if ms.user is conversation.user:
            return 401, None
        self.violation("conversation.cross-user")
        return 404, "conversation_not_found"

    def expect_refusal(self, reply: Reply, refused: tuple[int, str | None]) -> None:
        if refused == (401, None):
            expect_challenge(reply, [READ])
        else:
            expect(reply, *refused)

    def accepted(self, conversation: MConversation, ms: MSession, message: dict[str, Any], *, started: bool = False, parent: str | None = None) -> None:
        """The Company took one of our messages into the conversation (8.3)."""
        if not started:
            conversation.sent.append(message["id"])
        conversation.messages.append(message)
        ms.user.sent[message["id"]] = MSent(message, conversation.id, started=started, parent=parent)

    def expected_token_type(self, resource: str | None) -> str:
        """4.5: DPoP-bound when the issuer lists algorithms, except an MCP server's token, which the mock issues as Bearer."""
        return "DPoP" if self.config["dpopTokens"] and resource is None else "Bearer"

    def token_body(
        self, reply: Reply, *, scope: frozenset[str], resource: str | None = None, sign_in: bool = False, requested: list[str] | None = None
    ) -> dict[str, Any]:
        """
        A successful token response (4.4, 4.5): plain OAuth, with nothing
        naming a Session (5.4: a sign-in names no Session), and a refresh
        token from a sign-in. `scope` is what was granted; it may be left
        out only when it is what was `requested` (RFC 6749 5.1), which is
        `scope` itself unless a sign-in says otherwise.
        """
        expect(reply, 200)
        body = reply.body
        assert isinstance(body, dict), reply.text
        assert isinstance(body.get("access_token"), str) and body["access_token"]
        assert body.get("token_type") == self.expected_token_type(resource), body
        assert isinstance(body.get("expires_in"), int) and body["expires_in"] > 0, "expires_in MUST be greater than 0"
        assert "session_id" not in body and "signed_in" not in body, f"0.3 token responses name no Session: {body}"
        if "scope" in body:
            granted = body["scope"].split()
            assert len(granted) == len(set(granted)) and set(granted) == scope, (body["scope"], scope)
        else:
            assert self.config["omitTokenScope"], "scope missing from a token response"
            assert requested is None or set(requested) == scope, f"granted {sorted(scope)} of {requested}, without saying so (RFC 6749 5.1)"
        if sign_in:
            assert isinstance(body.get("refresh_token"), str), "a sign-in returns a refresh token"
        assert "no-store" in reply.headers.get("cache-control", ""), "token responses aren't cached"
        return body

    def token_from(self, body: dict[str, Any], grant: MGrant, scope: frozenset[str], key: Es256Key, resource: str | None = None) -> MToken:
        return MToken(body["access_token"], grant, scope, body["token_type"], key if body["token_type"] == "DPoP" else None, resource)

    def rotate(self, grant: MGrant, body: dict[str, Any]) -> None:
        """4.4: a new refresh token in `refresh_token` replaces the old one from then on."""
        new = body.get("refresh_token")
        if self.config["rotateRefreshTokens"]:
            assert isinstance(new, str) and new != grant.current, "a rotating Company returns a new refresh token"
        if isinstance(new, str) and new != grant.current:
            grant.superseded.append(grant.current)
            grant.current = new

    def revoked(self, grant: MGrant) -> None:
        """
        4.6, 5.5: a revoked sign-in. The Company signs out every Session whose
        last request used it, or ends them; the honest agent stops sending
        its tokens, and those Sessions carry on signed out with the same `sid`.
        """
        grant.revoked = True
        for ms in self.all_sessions():
            if ms.remote_grant is grant and ms.remote_account == grant.account and not ms.ended:
                ms.remote_account, ms.remote_grant = None, None
                if self.config["endSessionsOnSignOut"]:
                    ms.ended = True
            if ms.token is not None and ms.token.grant is grant:
                self.set_token(ms, None)
            if ms.mcp is not None and ms.mcp.grant is grant:
                ms.mcp = None

    def target_session(self, data: st.DataObject, mu: MUser, account: str) -> MSession:
        """
        Where the honest agent puts a new token for `account`: a live Session
        of the User that was never used with another account, or a new one
        (5.4: SHOULD start a new Session rather than use a second account).
        """
        fits = [s for s in self.live(mu) if s.used in (None, account)]
        if fits and len(mu.sessions) >= MAX_SESSIONS:
            return data.draw(st.sampled_from(fits))
        choice = data.draw(st.none() | st.sampled_from(fits)) if fits else None
        return choice if choice is not None else self.new_session(mu)

    def scripted_agent(self, conversation: MConversation, ms: MSession, message: dict[str, Any]) -> bool:
        """
        The mock's Company Agent, as its fixture documents it (test/mock-company
        conversations.ts): it doesn't answer while a person is wanted or
        handling it; `person` hands off (8.9: the status becomes queued); an
        order, exchange or return, asked signed in with read and write, uses
        the account (8.2). Returns whether it handed off.
        """
        if ("text" not in message and "data" not in message) or "approval" in message or not self.config["agentReplies"]:
            return False
        if conversation.status == "queued" or conversation.responder == "human":
            return False
        text = message.get("text", "").lower()
        if "person" in text:
            conversation.status = "queued"
            return True
        if re.search("order|exchange|return", text) and ms.account and {READ, WRITE} <= ms.token_scope:
            conversation.account = ms.account
            self.agent_used_account(conversation, ms)
        return False

    def agent_used_account(self, conversation: MConversation, ms: MSession) -> None:
        """The Company Agent answered with the account; the operations machine also expects an operation then (Ops 4)."""

    def check_status(self, conversation: MConversation, body: Any, where: str) -> None:
        """8.7: every successful POST and read says `status` and `responder`, and they are the model's."""
        assert isinstance(body, dict), body
        got = (body.get("status"), body.get("responder"))
        assert got[0] in STATUSES and got[1] in RESPONDERS, f"{where}: status and responder are required (8.7): {body}"
        assert got == (conversation.status, conversation.responder), f"{where}: {got}, model {(conversation.status, conversation.responder)}"

    def absorb(self, conversation: MConversation, cursor: str | None, events: list[dict[str, Any]], page: dict[str, Any] | None) -> None:
        """
        Hold one read (8.5) to the log: from `cursor` it returns the events
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
                assert name in page, f"a read without {name} (8.5)"
            assert page["cursor"] == (ids[-1] if ids else cursor), "cursor isn't the last event, or the request's"

    def log_checks(self, conversation: MConversation) -> tuple[str, str] | None:
        """
        What the whole log, read from the start, must hold, whatever was
        done to the conversation; returns the last `state` event's status
        and responder.

        - 8.5, 8.7: every event has an id, type and time; a `state` event
          carries a valid status and responder and marks a change, and while
          `queued`, `responder` stays `agent`.
        - 8.4, 8.7: a Company message says who wrote it in `author.type`,
          and `human` means a person has joined, so a person's message comes
          after a `state` event with `responder: human`.
        - 8.12: a closed conversation takes no more messages, and its
          status doesn't change again.
        - 8.10: each Direct Conversation opened from it has a
          `direct_opened` event, and once it closed, a `direct_closed` event
          after that, however it was closed.
        - 8.10: each `user_requested` the Company added, with its `reason`.
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
                assert pair != last, f"a state event that changes nothing (8.5, 8.7): {pair}"
                assert pair[0] != "queued" or pair[1] == "agent", "queued with responder human: while queued, responder stays agent (8.7)"
                last = pair  # type: ignore[assignment]
                closed = pair[0] == "closed"
            elif kind == "message":
                message = event["message"]
                author = message.get("author")
                assert isinstance(author, dict) and author.get("type") in RESPONDERS, f"a message without author.type (8.4): {message}"
                assert "sender" not in message, f"0.3 messages carry author, not sender (8.4): {message}"
                if message.get("role") == "company":
                    if author["type"] == "human":
                        assert last is not None and last[1] == "human", "a person wrote before responder became human (8.7)"
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
        assert reasons == conversation.requested, f"user_requested reasons {reasons}, model {conversation.requested} (8.10)"
        for child in conversation.children:
            assert child.id in opened, f"{conversation.id}: no direct_opened for its Direct Conversation {child.id} (8.10)"
            if child.closed:
                assert child.id in closed_children, f"{conversation.id}: its Direct Conversation {child.id} closed, but no direct_closed (8.10)"
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

    # ---- MCP (7) ----

    def ensure_mcp_token(self, ms: MSession) -> MToken | None:
        """
        4.5, 7: signed in, a token for the MCP server, from the refresh token
        with `resource` set to the server's `url` (RFC 8707, which may rotate
        the refresh token). Asked for again whenever the Session's sign-in
        changed. Signed out, none: the Session header alone.
        """
        if ms.token is None:
            ms.mcp = None
            return None
        if ms.mcp is not None and ms.mcp.grant is ms.token.grant and ms.mcp.scope == ms.token.scope:
            return ms.mcp
        grant = ms.token.grant
        reply = self.poppy.refresh(self.co, ms.user.user.dpop_key, grant.current, scope=sorted(ms.token.scope) if ms.token.scope != grant.scope else None, resource=self.co.mcp)
        body = self.token_body(reply, scope=ms.token.scope, resource=self.co.mcp)
        self.rotate(grant, body)
        ms.mcp = self.token_from(body, grant, ms.token.scope, ms.user.user.dpop_key, self.co.mcp)
        return ms.mcp

    def mcp_session(self, ms: MSession) -> Session:
        """The client Session as an MCP request sends it: the same `sid`, with the MCP server's own token when signed in."""
        token = self.ensure_mcp_token(ms)
        session = Session(ms.user.user, sid=ms.session.sid)
        if token is not None:
            session.token, session.token_type, session.key = token.value, token.token_type, token.key
        return session

    def mcp_call(self, ms: MSession, method: str, params: dict[str, Any] | None = None, *, meta: dict[str, Any] | None = None) -> Reply:
        """One MCP request with the Session header and its token, after `initialize` (MCP 2025-06-18 lifecycle)."""
        session = self.mcp_session(ms)
        holder = ms.mcp
        mcp_id = holder.mcp_session if holder is not None else ms.mcp_signed_out
        if mcp_id is None:
            init = expect(
                self.poppy.mcp(
                    session,
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
            self.touch_mcp(ms, init)
            assert init.body["result"]["protocolVersion"] == "2025-06-18", init.body
            mcp_id = init.headers.get("mcp-session-id")
            assert mcp_id, "initialize without an Mcp-Session-Id"
            if holder is not None:
                holder.mcp_session = mcp_id
            else:
                ms.mcp_signed_out = mcp_id
            note_reply = self.poppy.mcp(session, self.co, {"jsonrpc": "2.0", "method": "notifications/initialized"}, mcp_session=mcp_id)
            self.touch_mcp(ms, note_reply)
        rpc: dict[str, Any] = {"jsonrpc": "2.0", "id": len(self.transport.log), "method": method}
        if params is not None:
            rpc["params"] = dict(params)
        if meta is not None:
            rpc.setdefault("params", {})["_meta"] = meta
        reply = self.poppy.mcp(session, self.co, rpc, mcp_session=mcp_id)
        self.touch_mcp(ms, reply)
        return reply

    def touch_mcp(self, ms: MSession, reply: Reply) -> None:
        """An MCP request is a request in the Session too (7: an MCP server MAY ignore the Session header; ours reads it)."""
        self.touch(ms, reply, ms.mcp)

    # ---- the browser (6) ----

    def join_browser(self, ms: MSession) -> httpx.Response:
        """
        6: join this Session's own browser: it loads the page, our own
        request authorizes its code with the Session header and token, and
        the browser submits the code. Hold the Company's answers to the
        section's MUSTs: the page isn't cached or framed, its cookie is
        `__Host-`, Secure, HttpOnly and SameSite Strict; authorize is 204;
        the submit redirects with the Session's cookie.
        """
        assert self.co.browser_session is not None
        if ms.browser is None:
            ms.browser = Browser(self.transport)
        page, code, action = ms.browser.open_join(self.co.browser_session)
        assert page.status_code == 200 and code and action, (page.status_code, page.text[:200])
        assert "no-store" in page.headers.get("cache-control", ""), "the join page MUST NOT be stored by caches (6)"
        assert "frame-ancestors 'none'" in page.headers.get("content-security-policy", ""), "the join page MUST NOT be framed (6)"
        join_cookie = next((c for c in page.headers.get_list("set-cookie") if c.startswith("__Host-")), None)
        assert join_cookie, "the join page sets no __Host- cookie (6: other hosts MUST NOT be able to set it)"
        _, attributes = set_cookie_attributes(join_cookie)
        assert "secure" in attributes and (attributes.get("samesite") or "").lower() == "strict", f"the join cookie (6): {join_cookie}"
        authorized = self.poppy.resource(ms.session, "POST", f"{self.co.browser_session.rstrip('/')}/authorize", self.co, body={"code": code})
        self.touch(ms, authorized)
        expect(authorized, 204)
        response = ms.browser.submit_join(action, code)
        assert response.status_code in (302, 303), (response.status_code, response.text[:200])
        cookies = [c for c in response.headers.get_list("set-cookie") if not c.startswith("__Host-poppy_join=;")]
        assert cookies, "a join without the Session's cookie"
        for cookie in cookies:
            _, attributes = set_cookie_attributes(cookie)
            assert "secure" in attributes and "httponly" in attributes, f"the Session's cookie (6): {cookie}"
        ms.joined = True
        ms.joined_as = ms.account
        ms.joined_grant = ms.token.grant if ms.token else None
        ms.joined_scope = ms.token_scope
        return response

    def close_in_model(self, conversation: MConversation) -> None:
        """8.10, 8.12: closing closes its open Direct Conversation, and frees the parent of a closed one."""
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
        self.new_session(first)
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
        """
        5.3, 5.4, 5.5: the Company's Sessions are the ones our requests
        started, by `sid`, each the User's, signed in to the account its last
        request carried, and ended as the model says.
        """
        if self.company is None:
            return
        state = self.server.state()
        mock = {s["sid"]: s for s in state["sessions"] if s["sid"] not in self.other_sids}
        seen = {ms.session.sid: ms for ms in self.all_sessions() if ms.seen}
        assert set(mock) == set(seen), f"the Company's Sessions {sorted(mock)} aren't the ones our requests started {sorted(seen)}"
        for sid, ms in seen.items():
            actual = mock[sid]
            assert actual["ended"] == ms.ended, f"{sid} ended? {actual}"
            assert actual["userId"] == ms.user.user.user_id, actual
            assert actual["account"] == ms.remote_account, (actual, ms.remote_account)
            assert actual["signedIn"] == (ms.remote_account is not None), actual

    @invariant()
    def session_header_only_where_it_belongs(self) -> None:
        """
        5.2: the Session header on every request to the Company's resources,
        and never to its OAuth endpoints, website pages or well-known
        documents. Held over every request this client sent, as the
        transport saw it; the reject rules that break it on purpose are counted.
        """
        if self.company is None:
            return
        oauth = {self.co.token_endpoint, self.co.revocation_endpoint, self.co.metadata.get("device_authorization_endpoint")}
        misplaced = 0
        for x in self.transport.log:
            bare = x.url.split("?", 1)[0]
            resource = x.url.startswith(self.api_base) or bool(self.co.mcp and bare == self.co.mcp) or bool(self.co.conversations and bare.startswith(self.co.conversations)) or bare.endswith("/authorize") and bool(self.co.browser_session) and bare.startswith(self.co.browser_session)
            if "/.well-known/" in bare or bare in oauth or (self.co.browser_session and bare == self.co.browser_session):
                misplaced += x.session_header
            elif resource and bare != self.co.openapi:
                misplaced += not x.session_header
        assert misplaced == self.session_header_misplaced, misplaced


# ---------------------------------------------------------------- Users, Sessions and sign-in (4, 5)


class SessionRules:
    """Honest rules that make Users, Sessions and sign-ins, for every machine."""

    @precondition(lambda self: self.company is not None and len(self.users) < MAX_USERS)
    @rule()
    def add_user(self) -> None:
        self.users.append(MUser(User()))

    @precondition(lambda self: self.company is not None)
    @rule(data=st.data())
    def start_session(self, data: st.DataObject) -> None:
        """5.2: a new `sid`, for a new task; the Company sees it with its first request."""
        mu = data.draw(st.sampled_from(self.users))
        assume(len(mu.sessions) < MAX_SESSIONS)
        self.new_session(mu)

    @precondition(lambda self: self.company is not None)
    @rule(data=st.data())
    def new_dpop_key(self, data: st.DataObject) -> None:
        """Guides: a new DPoP key binds only the tokens asked for with it; tokens bound to the old one keep its proofs."""
        mu = data.draw(st.sampled_from(self.users))
        mu.user.dpop_key = Es256Key()

    @precondition(lambda self: any(s.token for s in self.live()))
    @rule(data=st.data())
    def refresh(self, data: st.DataObject) -> None:
        """4.4: a new access token for a signed-in Session from its refresh token, perhaps narrower."""
        ms = data.draw(st.sampled_from([s for s in self.live() if s.token]))
        assert ms.token is not None
        grant = ms.token.grant
        assert not grant.revoked
        narrower = data.draw(st.none() | st.lists(st.sampled_from(sorted(grant.scope)), unique=True) if grant.scope else st.none())
        reply = self.poppy.refresh(self.co, ms.user.user.dpop_key, grant.current, scope=narrower)
        scope = frozenset(narrower) if narrower is not None else grant.scope
        body = self.token_body(reply, scope=scope)
        self.rotate(grant, body)
        self.set_token(ms, self.token_from(body, grant, scope, ms.user.user.dpop_key))

    @precondition(lambda self: self.company is not None)
    @rule(data=st.data())
    def sign_in(self, data: st.DataObject) -> None:
        """Direct, Device or Mediated Sign-In, as the User approves (4.2, 4.3, MSI); the token goes to a Session it fits (5.4)."""
        mu = data.draw(st.sampled_from(self.users))
        kinds = [kind for kind in ("direct", "device", "mediated") if self.co.offered(kind)]
        kind = data.draw(st.sampled_from(kinds))
        offered = self.co.offered(kind)
        # Every subset can be drawn; "all of them" is also drawn directly, as the common case.
        requested = data.draw(st.just(offered) | st.lists(st.sampled_from(offered), min_size=1, unique=True))
        account = data.draw(st.sampled_from(self.fixture["accounts"]))
        granted = requested
        key = mu.user.dpop_key
        if kind == "direct":
            granted = data.draw(st.just(requested) | st.lists(st.sampled_from(requested), unique=True))
            url, state, verifier = self.poppy.authorization_url(self.co, requested)
            redirect = self.server.hook("approve_authorization", url=url, account=account, scopes=granted)["redirect"]
            params = self.poppy.callback(self.co, redirect, state)
            assert "code" in params and "error" not in params, params
            reply = self.poppy.exchange_code(self.co, key, params["code"], verifier)
        elif kind == "device":
            grantable = [s for s in requested if s in DEVICE_GRANTS]
            if not grantable:
                expect(self.poppy.device_start(self.co, requested), 400, "invalid_scope")
                return
            granted = data.draw(st.just(grantable) | st.lists(st.sampled_from(grantable), unique=True))
            start = expect(self.poppy.device_start(self.co, requested), 200).body
            for name in ("device_code", "user_code", "verification_uri", "expires_in"):
                assert name in start, f"device authorization response without {name}"
            self.server.hook("approve_device", user_code=start["user_code"], account=account, scopes=granted)
            reply = self.poppy.device_poll(self.co, key, start["device_code"])
        else:
            fields = self.server.hook("mediated_answers", account=account)["fields"]
            reply = self.poppy.mediated_start(self.co, key, requested, fields)
            if reply.status == 400 and reply.error == "code_required":
                assert isinstance(reply.body.get("sign_in_id"), str), reply.body
                assert "no-store" in reply.headers.get("cache-control", ""), "code_required is a token response, not cached (MSI 4)"
                code = self.server.hook("last_one_time_code")["code"]
                reply = self.poppy.mediated_code(self.co, key, reply.body["sign_in_id"], code)
        body = self.token_body(reply, scope=frozenset(granted), sign_in=True, requested=requested)
        grant = MGrant(mu, account, frozenset(granted), body["refresh_token"])
        mu.grants.append(grant)
        ms = self.target_session(data, mu, account)
        self.set_token(ms, self.token_from(body, grant, frozenset(granted), key))

    @precondition(lambda self: self.live_grants())
    @rule(data=st.data())
    def use_refresh_token(self, data: st.DataObject) -> None:
        """4.4, 5.4: a stored refresh token signs a Session in, or a new one, without asking the User."""
        grant = data.draw(st.sampled_from(self.live_grants()))
        mu = grant.user
        reply = self.poppy.refresh(self.co, mu.user.dpop_key, grant.current)
        body = self.token_body(reply, scope=grant.scope)
        self.rotate(grant, body)
        ms = self.target_session(data, mu, grant.account)
        self.set_token(ms, self.token_from(body, grant, grant.scope, mu.user.dpop_key))

    @precondition(lambda self: self.live_grants())
    @rule(data=st.data())
    def sign_out(self, data: st.DataObject) -> None:
        """4.6, 5.5: revoke the refresh token; its Sessions carry on signed out, or the Company ends them."""
        grant = data.draw(st.sampled_from(self.live_grants()))
        expect(self.poppy.revoke(self.co, grant.current), 200)
        self.revoked(grant)

    @precondition(lambda self: any(s.ended and s.seen for s in self.all_sessions()))
    @rule(data=st.data())
    def ended_session(self, data: st.DataObject) -> None:
        """5.5, 7: a Session the Company ended gets `invalid_session`; the agent starts a new one (once)."""
        ms = data.draw(st.sampled_from([s for s in self.all_sessions() if s.ended and s.seen]))
        path, _ = data.draw(st.sampled_from(self.api_ops))
        reply = self.poppy.resource(ms.session, "GET", self.api_base + path, self.co)
        expect(reply, 400, "invalid_session")
        assume(len(ms.user.sessions) < MAX_SESSIONS)
        fresh = self.new_session(ms.user)
        if ms.token is not None:
            self.set_token(fresh, ms.token)


class ApiRules:
    # ---- APIs (7): what a Session may do is what the model says it holds ----

    @precondition(lambda self: self.live())
    @rule(data=st.data())
    def call_api(self, data: st.DataObject) -> None:
        ms = data.draw(st.sampled_from(self.live()))
        path, needed = data.draw(st.sampled_from(self.api_ops))
        reply = self.poppy.resource(ms.session, "GET", self.api_base + path, self.co)
        self.touch(ms, reply)
        if not needed:
            expect(reply, 200)
        elif ms.account is None:
            expect_challenge(reply, needed)
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
            self.new_session(self.users[-1])
        for _ in range(data.draw(st.integers(0, 4), label="sign-ins")):
            self.sign_in(data)


# ---------------------------------------------------------------- conversations (8)


class ConversationRules:
    """Honest conversation rules, and the conversation errors of 8.13."""

    def new_message_id(self, data: st.DataObject, mu: MUser) -> str:
        """Unique for the User (8.3); another User's ids are fair game."""
        others = [mid for u in self.users if u is not mu for mid in u.sent]
        mid = data.draw(st.sampled_from(others) | MESSAGE_IDS if others else MESSAGE_IDS)
        assume(mid not in mu.sent)
        return mid

    def a_message(self, data: st.DataObject, mu: MUser, *, direct: bool = False) -> dict[str, Any]:
        """
        A message the Personal Agent may send (8.3, 8.4). Into a Direct
        Conversation it relays the User's words as written, as `human`
        (8.10); it may still send `context` alone as itself (8.4).
        """
        message = {"id": self.new_message_id(data, mu)} | data.draw(messages(list(self.fixture["prompts"].values())))
        if direct and ("text" in message or "data" in message):
            message["author"] = {"type": "human"}
        return message

    def started(self, ms: MSession, message: dict[str, Any], reply: Reply, *, parent: MConversation | None = None) -> MConversation:
        """A 201 for a new conversation (8.3), or a Direct Conversation (8.10): the model gains it."""
        body = reply.body
        cid = body["conversation_id"]
        assert cid not in [c.id for c in self.conversations], "a new conversation got an old id"
        conversation = MConversation(cid, ms.user, sent=[message["id"]], parent=parent)
        if parent is not None:
            # 8.10: it belongs to the parent's owner, and the parent waits for it.
            conversation.account = parent.account
            parent.children.append(conversation)
            parent.direct_child = conversation
        self.conversations.append(conversation)
        self.accepted(conversation, ms, message, started=True, parent=parent.id if parent else None)
        # A new conversation's first status is the Company's to choose; a person hasn't joined, and it isn't closed (8.7).
        assert body.get("responder") == "agent" and body.get("status") in {"idle", "working", "queued"}, body
        conversation.status = body["status"]
        handed_off = self.scripted_agent(conversation, ms, message)
        assert (body["status"] == "queued") == handed_off, f"queued {'without' if not handed_off else 'only after'} a handoff: {body}"
        self.check_status(conversation, body, "a new conversation")
        return conversation

    @precondition(lambda self: self.live() and self.co.conversations)
    @rule(data=st.data())
    def start_conversation(self, data: st.DataObject) -> None:
        ms = data.draw(st.sampled_from(self.live()))
        message = self.a_message(data, ms.user)
        raw = data.draw(serialisations(message))
        wait = data.draw(st.sampled_from([None, 0, 1]))
        reply = self.poppy.post_message(ms.session, self.co, raw, None, wait=wait)
        self.touch(ms, reply)
        expect(reply, 201)
        conversation = self.started(ms, message, reply)
        if wait is not None:
            self.absorb(conversation, None, reply.body["events"], reply.body)

    @precondition(lambda self: any(s.account and {READ, WRITE} <= s.token_scope for s in self.live()))
    @rule(data=st.data())
    def ask_about_an_order(self, data: st.DataObject) -> None:
        """
        Signed in with read and write, start a conversation with the
        fixture's `operation` prompt, which the Company answers using the
        account (8.2, 8.11). The other rules then meet a conversation that
        belongs to an account: retries, reads and sign-out.
        """
        ms = data.draw(st.sampled_from([s for s in self.live() if s.account and {READ, WRITE} <= s.token_scope]))
        message = {"id": self.new_message_id(data, ms.user), "author": {"type": data.draw(st.sampled_from(["agent", "human"]))}, "text": self.fixture["prompts"]["operation"]}
        reply = self.poppy.post_message(ms.session, self.co, data.draw(serialisations(message)), None)
        self.touch(ms, reply)
        expect(reply, 201)
        self.started(ms, message, reply)

    def readable(self) -> list[tuple[MConversation, MSession]]:
        return [(c, s) for c in self.conversations for s in self.live() if self.can_read(s, c)]

    def sendable(self) -> list[tuple[MConversation, MSession]]:
        """Where the honest agent sends: open, and not waiting on a Direct Conversation (8.10)."""
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
        reply = self.poppy.post_message(ms.session, self.co, raw, conversation.id, wait=wait, cursor=cursor)
        self.touch(ms, reply)
        expect(reply, 202)
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
        A retry (8.3): the same id and the same content, in any member order
        or spelling, returns the original response and adds nothing. After
        the conversation used an account, a retry from a token not signed in
        to it gets the challenge for the account (8.11; our reading of S8:
        8.11 wins). A Direct Conversation's first message is retried as it
        was sent, with its parent.
        """
        mu = data.draw(st.sampled_from([u for u in self.users if u.sent and self.live(u)]))
        mid = data.draw(st.sampled_from(sorted(mu.sent)))
        original = mu.sent[mid]
        conversation = self.conversation(original.conversation)
        ms = data.draw(st.sampled_from(self.live(mu)))
        raw = data.draw(serialisations(original.message))
        reply = self.poppy.post_message(ms.session, self.co, raw, None if original.started else conversation.id, parent=original.parent)
        self.touch(ms, reply)
        refused = self.refusal(ms, conversation)
        if refused is not None:
            self.expect_refusal(reply, refused)
            return
        expect(reply, 201 if original.started else 202)
        assert reply.body["conversation_id"] == conversation.id, "a retry answers for the original conversation"

    def own_messages(self) -> list[tuple[MConversation, MSession]]:
        """Conversations a Session may use, where its User has sent a message."""
        return [(c, s) for c, s in self.readable() if any(m.conversation == c.id for m in s.user.sent.values())]

    @precondition(lambda self: self.own_messages())
    @rule(data=st.data())
    def conflicting_message_id(self, data: st.DataObject) -> None:
        """Reject: an id the Company accepted, with different content, is `message_id_conflict` (8.3)."""
        conversation, ms = data.draw(st.sampled_from(self.own_messages()))
        mid = data.draw(st.sampled_from(sorted(m for m, sent in ms.user.sent.items() if sent.conversation == conversation.id)))
        original = ms.user.sent[mid]
        message = {"id": mid} | data.draw(messages(list(self.fixture["prompts"].values())))
        assume(canonical(message) != canonical(original.message))
        raw = data.draw(serialisations(message))
        reply = self.poppy.post_message(ms.session, self.co, raw, None if original.started else conversation.id, parent=original.parent)
        self.touch(ms, reply)
        expect(reply, 409, "message_id_conflict")
        self.violation("message.id-reused")

    @precondition(lambda self: any(c.closed for c, _ in self.readable()))
    @rule(data=st.data())
    def send_to_closed(self, data: st.DataObject) -> None:
        """Reject: a new message to a closed conversation is `conversation_closed` (8.13)."""
        conversation, ms = data.draw(st.sampled_from([(c, s) for c, s in self.readable() if c.closed]))
        message = self.a_message(data, ms.user, direct=conversation.direct)
        reply = self.poppy.post_message(ms.session, self.co, data.draw(serialisations(message)), conversation.id)
        self.touch(ms, reply)
        expect(reply, 409, "conversation_closed")

    @precondition(lambda self: self.conversations and self.live())
    @rule(data=st.data())
    def read(self, data: st.DataObject) -> None:
        """
        Read to the end (8.5, 8.6), as JSON or a stream, from the start or
        the saved cursor. Who may read is 8.2 and 8.11: another User gets
        `conversation_not_found`; the same User not signed in to the account
        the conversation used gets a challenge for it.
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
            self.touch(ms, reply)
            refused = self.refusal(ms, conversation)
            if refused is not None:
                self.expect_refusal(reply, refused)
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
        """Reject: a cursor that isn't one of this conversation's events is `invalid_cursor` (8.13)."""
        conversation, ms = data.draw(st.sampled_from(self.readable()))
        others = [e["id"] for c in self.conversations if c is not conversation for e in c.log]
        cursor = data.draw(st.sampled_from(others) | st.text() if others else st.text())
        assume(cursor not in [e["id"] for e in conversation.log])
        reply, _ = self.poppy.read_events(ms.session, self.co, conversation.id, cursor, stream=False)
        self.touch(ms, reply)
        expect(reply, 400, "invalid_cursor")

    @precondition(lambda self: any(not c.closed for c, _ in self.readable()))
    @rule(data=st.data())
    def close(self, data: st.DataObject) -> None:
        """8.12: closing says `closed`, with whoever handled it last; it closes its open Direct Conversation (8.10)."""
        conversation, ms = data.draw(st.sampled_from([(c, s) for c, s in self.readable() if not c.closed]))
        reply = self.poppy.close_conversation(ms.session, self.co, conversation.id)
        self.touch(ms, reply)
        expect(reply, 200)
        self.close_in_model(conversation)
        self.check_status(conversation, reply.body, "close")
