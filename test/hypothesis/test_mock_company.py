"""
A model-based, stateful test of our mock Company (test/mock-company) over
HTTP, driven by a second Poppy client written in Python from the draft.

The model says what should be true: which Sessions exist and are signed in,
to which account and with which scopes; which Account Tokens are live,
rotated or revoked; which message ids each User has used, and for what;
what each conversation's event log holds, in order. Every response is held
to it, and so is the mock's own record of violations:

- after honest rules, `GET /violations` holds nothing new;
- each reject rule is refused with the error the draft names, and the mock
  records exactly the violation id that rule expects, and nothing else.

Spec references (4.2, 7.3, ...) are to Poppy Draft 0.1.
"""

from __future__ import annotations

import json
import re
import sys
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

import httpx
from hypothesis import assume, note
from hypothesis import strategies as st
from hypothesis.stateful import RuleBasedStateMachine, initialize, invariant, precondition, rule, run_state_machine_as_test

from mock_server import DOMAIN, SUFFIX, MockServer
from poppy_client import Company, Es256Key, LocalTransport, PersonalAgent, Poppy, Reply, Session, User
from strategies import CONFIGS, MESSAGE_IDS, canonical, messages, serialisations

READ, WRITE = "poppy:read", "poppy:write"
MAX_USERS = 3
MAX_SESSIONS = 8


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
class MSession:
    session: Session
    user: "MUser"
    account: str | None = None  # signed in to, now
    bound: str | None = None  # ever signed in to: a Session can't switch accounts (4.4)
    grant: MGrant | None = None  # the Account Token it is signed in with
    token_scope: frozenset[str] = frozenset()  # what its newest Session Token grants
    ended: bool = False


@dataclass(eq=False)
class MSent:
    message: dict[str, Any]
    conversation: str
    started: bool  # sent with the POST that started the conversation


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
    log: list[dict[str, Any]] = field(default_factory=list)  # every event read so far, from the start
    closed: bool = False
    queued: bool = False


class Refused(AssertionError):
    pass


COVERAGE: Counter[str] = Counter()
"""Each outcome a rule expected and got, `rule: status error`; conftest prints them, to show what the run reached."""


def expect(reply: Reply, status: int, error: str | None = None) -> Reply:
    COVERAGE[f"{sys._getframe(1).f_code.co_name}: {status} {error or ''}".rstrip()] += 1
    if reply.status != status or (error is not None and reply.error != error):
        raise Refused(f"expected {status} {error or ''}, got {reply.status} {reply.error}: {reply.text[:400]}")
    return reply


# ---------------------------------------------------------------- the machine


class MockCompanyMachine(RuleBasedStateMachine):
    def __init__(self, server: MockServer) -> None:
        super().__init__()
        self.server = server
        self.http = httpx.Client(transport=LocalTransport(server.company_port, SUFFIX), timeout=30)
        self.agent = PersonalAgent()
        self.poppy = Poppy(self.agent, self.http)
        self.other_agent = PersonalAgent(origin="https://other-agent.hypothesis.test")
        self.company: Company | None = None
        self.config: dict[str, Any] = {}
        self.expected: list[str] = []
        self.users: list[MUser] = []
        self.conversations: list[MConversation] = []
        self.sessions_started: set[str] = set()

    def teardown(self) -> None:
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

    def can_read(self, ms: MSession, conversation: MConversation) -> bool:
        return ms.user is conversation.user and (conversation.account is None or ms.account == conversation.account)

    def token_body(self, reply: Reply, *, session_id: str | None = None, signed_in: bool, scope: frozenset[str]) -> dict[str, Any]:
        """A successful token response (4.2)."""
        expect(reply, 200)
        body = reply.body
        assert isinstance(body, dict), reply.text
        assert isinstance(body.get("access_token"), str) and body["access_token"]
        assert body.get("token_type") == "DPoP", body
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

    def scripted_agent(self, conversation: MConversation, ms: MSession, message: dict[str, Any]) -> None:
        """
        The mock's Company Agent, as its fixture documents it (test/mock-company
        conversations.ts): `person` hands off, and an order, exchange or
        return, asked signed in with read and write, uses the account (7.2).
        """
        if ("text" not in message and "data" not in message) or not self.config["agentReplies"] or conversation.queued:
            return
        text = message.get("text", "").lower()
        if "person" in text:
            conversation.queued = True
        elif re.search("order|exchange|return", text) and ms.account and {READ, WRITE} <= ms.token_scope:
            conversation.account = ms.account

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

    def full_read_checks(self, conversation: MConversation, status: str | None) -> None:
        mine = [e for e in conversation.log if e.get("type") == "message" and e["message"].get("role") == "user"]
        assert [e["message"]["id"] for e in mine] == conversation.sent, "every message we sent, once, in order"
        for event in mine:
            sent = event["message"]["id"]
            original = conversation.user.sent[sent].message
            shown = {k: v for k, v in original.items() if k != "context"} | {"role": "user", "id": sent}
            assert canonical(event["message"]) == canonical(shown), (event["message"], shown)
        if status is not None:
            assert (status == "closed") == conversation.closed, f"status {status}, closed {conversation.closed}"

    # ---- setup ----

    @initialize(config=CONFIGS)
    def setup(self, config: dict[str, Any]) -> None:
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

    # ---- discovery (3) ----

    @rule(data=st.data())
    def rediscover(self, data: st.DataObject) -> None:
        """Every domain the Company names discovers the same Company, keyed by its issuer (3.2)."""
        domain = data.draw(st.sampled_from([DOMAIN, f"www.{DOMAIN}", *self.co.metadata["poppy_domains"]]))
        again = self.poppy.discover(domain)
        assert again.issuer == self.co.issuer
        assert again.metadata == self.co.metadata
        assert again.conversations == self.co.conversations

    # ---- Users and Sessions (4.2) ----

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

    # ---- signing in (4.4 to 4.8) ----

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
            return
        body = self.token_body(reply, session_id=ms.session.session_id, signed_in=True, scope=frozenset(granted))
        if kind == "mediated":
            assert body.get("status") == "complete", body
        assert isinstance(body.get("refresh_token"), str), "a sign-in returns an Account Token"
        grant = MGrant(mu, account, frozenset(granted), body["refresh_token"])
        mu.grants.append(grant)
        ms.account, ms.bound, ms.grant, ms.token_scope = account, account, grant, frozenset(granted)
        ms.session.token, ms.session.key, ms.session.signed_in = body["access_token"], key, True

    @precondition(lambda self: any(not g.revoked for u in self.users for g in u.grants))
    @rule(data=st.data())
    def use_account_token(self, data: st.DataObject) -> None:
        """4.4 step 1 and 4.8: a stored Account Token signs a Session in, or a new one, without asking the User."""
        grant = data.draw(st.sampled_from([g for u in self.users for g in u.grants if not g.revoked]))
        mu = grant.user
        targets = self.live(mu)
        ms = data.draw(st.none() | st.sampled_from(targets)) if targets else None
        reply = self.poppy.refresh(self.co, mu.user.dpop_key, grant.current, ms.session.session_id if ms else None)
        if ms is not None and ms.bound is not None and ms.bound != grant.account:
            expect(reply, 400, "account_mismatch")
            return
        body = self.token_body(reply, session_id=ms.session.session_id if ms else None, signed_in=True, scope=grant.scope)
        self.rotate(grant, body)
        if ms is None:
            ms = self.new_session(mu, body, mu.user.dpop_key)
        ms.account, ms.bound, ms.grant, ms.token_scope = grant.account, grant.account, grant, grant.scope
        ms.session.token, ms.session.key, ms.session.signed_in = body["access_token"], mu.user.dpop_key, True

    @precondition(lambda self: any(not g.revoked for u in self.users for g in u.grants))
    @rule(data=st.data())
    def sign_out(self, data: st.DataObject) -> None:
        """4.9: revoke the Account Token; its Sessions carry on signed out (or end)."""
        grant = data.draw(st.sampled_from([g for u in self.users for g in u.grants if not g.revoked]))
        expect(self.poppy.revoke(self.co, grant.current), 200)
        grant.revoked = True
        self.sign_out_sessions([grant])

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
            for order in reply.body.get("orders", []):
                assert order["account"] == ms.account, "a Session sees its own account's orders"

    # ---- conversations (7) ----

    def new_message_id(self, data: st.DataObject, mu: MUser) -> str:
        """Unique for the User (7.3); another User's ids are fair game."""
        others = [mid for u in self.users if u is not mu for mid in u.sent]
        mid = data.draw(st.sampled_from(others) | MESSAGE_IDS if others else MESSAGE_IDS)
        assume(mid not in mu.sent)
        return mid

    @precondition(lambda self: self.live() and self.co.conversations)
    @rule(data=st.data())
    def start_conversation(self, data: st.DataObject) -> None:
        ms = data.draw(st.sampled_from(self.live()))
        mu = ms.user
        message = {"id": self.new_message_id(data, mu)} | data.draw(messages(list(self.fixture["prompts"].values())))
        raw = data.draw(serialisations(message))
        wait = data.draw(st.sampled_from([None, 0, 1]))
        reply = expect(self.poppy.post_message(ms.session, self.co, raw, None, wait=wait), 201)
        cid = reply.body["conversation_id"]
        assert cid not in [c.id for c in self.conversations], "a new conversation got an old id"
        conversation = MConversation(cid, mu, sent=[message["id"]])
        self.conversations.append(conversation)
        mu.sent[message["id"]] = MSent(message, cid, started=True)
        self.scripted_agent(conversation, ms, message)
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
        conversation = MConversation(reply.body["conversation_id"], ms.user, sent=[message["id"]])
        self.conversations.append(conversation)
        ms.user.sent[message["id"]] = MSent(message, conversation.id, started=True)
        self.scripted_agent(conversation, ms, message)

    def readable(self) -> list[tuple[MConversation, MSession]]:
        return [(c, s) for c in self.conversations for s in self.live(c.user) if self.can_read(s, c)]

    @precondition(lambda self: any(not c.closed for c, _ in self.readable()))
    @rule(data=st.data())
    def send_message(self, data: st.DataObject) -> None:
        conversation, ms = data.draw(st.sampled_from([(c, s) for c, s in self.readable() if not c.closed]))
        mu = ms.user
        message = {"id": self.new_message_id(data, mu)} | data.draw(messages(list(self.fixture["prompts"].values())))
        raw = data.draw(serialisations(message))
        wait = data.draw(st.sampled_from([None, 0, 1]))
        cursor = conversation.log[-1]["id"] if conversation.log else None
        reply = expect(self.poppy.post_message(ms.session, self.co, raw, conversation.id, wait=wait, cursor=cursor), 202)
        assert reply.body["conversation_id"] == conversation.id
        conversation.sent.append(message["id"])
        mu.sent[message["id"]] = MSent(message, conversation.id, started=False)
        self.scripted_agent(conversation, ms, message)
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
        """
        mu = data.draw(st.sampled_from([u for u in self.users if u.sent and self.live(u)]))
        mid = data.draw(st.sampled_from(sorted(mu.sent)))
        original = mu.sent[mid]
        conversation = next(c for c in self.conversations if c.id == original.conversation)
        ms = data.draw(st.sampled_from(self.live(mu)))
        raw = data.draw(serialisations(original.message))
        reply = self.poppy.post_message(ms.session, self.co, raw, None if original.started else conversation.id)
        if not self.can_read(ms, conversation):
            expect(reply, 403, "sign_in_required")
            return
        expect(reply, 201 if original.started else 202)
        assert reply.body["conversation_id"] == conversation.id, "a retry answers for the original conversation"

    @precondition(lambda self: any(c.user.sent for c, _ in self.readable()))
    @rule(data=st.data())
    def conflicting_message_id(self, data: st.DataObject) -> None:
        """Reject: an id the Company accepted, with different content, is `message_id_conflict` (7.3)."""
        conversation, ms = data.draw(st.sampled_from([(c, s) for c, s in self.readable() if any(m.conversation == c.id for m in c.user.sent.values())]))
        mid = data.draw(st.sampled_from(sorted(m for m, sent in ms.user.sent.items() if sent.conversation == conversation.id)))
        original = ms.user.sent[mid]
        message = {"id": mid} | data.draw(messages(list(self.fixture["prompts"].values())))
        assume(canonical(message) != canonical(original.message))
        raw = data.draw(serialisations(message))
        reply = self.poppy.post_message(ms.session, self.co, raw, None if original.started else conversation.id)
        expect(reply, 409, "message_id_conflict")
        self.violation("message.id-reused")

    @precondition(lambda self: any(c.closed for c, _ in self.readable()))
    @rule(data=st.data())
    def send_to_closed(self, data: st.DataObject) -> None:
        """Reject: a new message to a closed conversation is `conversation_closed` (7.13)."""
        conversation, ms = data.draw(st.sampled_from([(c, s) for c, s in self.readable() if c.closed]))
        message = {"id": self.new_message_id(data, ms.user)} | data.draw(messages(list(self.fixture["prompts"].values())))
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
        status = None
        for _ in range(100):
            reply, events = self.poppy.read_events(ms.session, self.co, conversation.id, cursor, stream=stream)
            if ms.user is not conversation.user:
                expect(reply, 404, "conversation_not_found")
                # Another User of the same agent reaching for it: the mock records the breach (7.13, S17).
                self.violation("conversation.cross-user")
                return
            if not self.can_read(ms, conversation):
                expect(reply, 403, "sign_in_required")
                return
            expect(reply, 200)
            assert events is not None
            page = reply.body if isinstance(reply.body, dict) else None
            self.absorb(conversation, cursor, events, page)
            if page is not None:
                status = page["status"]
            if events:
                cursor = events[-1]["id"]
            if (page is not None and not page["has_more"]) or (page is None and not events):
                break
        else:
            raise AssertionError("a read that never ends")
        self.full_read_checks(conversation, status)

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
        conversation, ms = data.draw(st.sampled_from([(c, s) for c, s in self.readable() if not c.closed]))
        reply = expect(self.poppy.close_conversation(ms.session, self.co, conversation.id), 200)
        assert reply.body["status"] == "closed"
        conversation.closed = True

    # ---- reject direction: tokens and proofs ----

    @precondition(lambda self: self.company is not None)
    @rule(data=st.data())
    def replayed_jti(self, data: st.DataObject) -> None:
        """Reject: a client assertion, Session assertion or DPoP proof the Company has seen (4.2, 4.3)."""
        mu = data.draw(st.sampled_from(self.users))
        kind = data.draw(st.sampled_from(["client-assertion", "session-assertion", "dpop-token", "dpop-resource"]))
        if kind == "dpop-resource":
            live = self.live()
            assume(live)
            ms = data.draw(st.sampled_from(live))
            url = self.api_base + next(path for path, needed in self.api_ops if not needed)
            expect(self.poppy.resource(ms.session, "GET", url, self.co), 200)
            replay = self.poppy.last.proof
            expect(self.poppy.resource(ms.session, "GET", url, self.co, proof=replay), 401, "invalid_dpop_proof")
            self.violation("dpop.jti-reused")
            return
        assume(len(mu.sessions) < MAX_SESSIONS)
        body = self.token_body(self.poppy.start_session(self.co, mu.user), signed_in=False, scope=frozenset())
        self.new_session(mu, body, mu.user.dpop_key)
        last = self.poppy.last
        if kind == "client-assertion":
            expect(self.poppy.start_session(self.co, mu.user, client_assertion=last.client_assertion), 401, "invalid_client")
        elif kind == "session-assertion":
            expect(self.poppy.start_session(self.co, mu.user, assertion=last.session_assertion), 400, "invalid_grant")
        else:
            expect(self.poppy.start_session(self.co, mu.user, proof=last.proof), 400, "invalid_dpop_proof")
            kind = "dpop"
        self.violation(f"{kind}.jti-reused")

    @precondition(lambda self: self.company is not None)
    @rule(data=st.data())
    def assertion_aud(self, data: st.DataObject) -> None:
        """
        Both directions of `aud` (4.1, 4.2). A Session assertion's is the
        token endpoint as a single string. A client assertion's is the
        endpoint called; a lenient Company (S1) also takes the token
        endpoint or the issuer. Anything else is refused.
        """
        mu = data.draw(st.sampled_from(self.users))
        assume(len(mu.sessions) < MAX_SESSIONS)
        co = self.co
        near = [
            co.token_endpoint, co.issuer, co.revocation_endpoint, co.token_endpoint + "/", co.issuer.rstrip("/"),
            co.issuer.rstrip("/") + "/", co.token_endpoint.upper(), f"https://{DOMAIN}", DOMAIN, self.agent.client_id,
            co.metadata.get("authorization_endpoint", ""), co.metadata.get("device_authorization_endpoint", ""),
        ]
        aud = data.draw(
            st.one_of(
                st.sampled_from(near),
                st.text(),
                st.lists(st.sampled_from(near), min_size=1, max_size=3),
                st.integers(),
                st.none(),
            )
        )
        which = data.draw(st.sampled_from(["client", "session"]))
        if which == "session":
            reply = self.poppy.start_session(co, mu.user, assertion=self.poppy.session_assertion(co, mu.user, aud=aud))
            if aud == co.token_endpoint and isinstance(aud, str):
                self.new_session(mu, self.token_body(reply, signed_in=False, scope=frozenset()), mu.user.dpop_key)
            else:
                expect(reply, 400, "invalid_grant")
                self.violation("session-assertion.aud")
            return
        accepted = [co.token_endpoint] + ([] if self.config["clientAssertionAud"] == "exact" else [co.issuer])
        reply = self.poppy.start_session(co, mu.user, client_assertion=lambda: self.agent.assertion(self.agent.client_id, aud))
        if isinstance(aud, str) and aud in accepted:
            self.new_session(mu, self.token_body(reply, signed_in=False, scope=frozenset()), mu.user.dpop_key)
        else:
            expect(reply, 401, "invalid_client")
            self.violation("client-assertion.aud-array" if isinstance(aud, list) else "client-assertion.aud")

    @precondition(lambda self: self.live())
    @rule(data=st.data())
    def stolen_session_token(self, data: st.DataObject) -> None:
        """Reject: a Session Token with a proof from another key is useless (4.3)."""
        ms = data.draw(st.sampled_from(self.live()))
        path, _ = data.draw(st.sampled_from(self.api_ops))
        reply = self.poppy.resource(ms.session, "GET", self.api_base + path, self.co, key=Es256Key())
        expect(reply, 401, "invalid_dpop_proof")
        self.violation("dpop.key-mismatch")

    @precondition(lambda self: any(g.superseded for u in self.users for g in u.grants))
    @rule(data=st.data())
    def reused_rotated_account_token(self, data: st.DataObject) -> None:
        """Reject: an Account Token after the Company rotated it (4.8); with reuse detection, the family is revoked."""
        grant = data.draw(st.sampled_from([g for u in self.users for g in u.grants if g.superseded]))
        old = data.draw(st.sampled_from(grant.superseded))
        live = self.live(grant.user)
        ms = data.draw(st.none() | st.sampled_from(live)) if live else None
        reply = self.poppy.refresh(self.co, grant.user.user.dpop_key, old, ms.session.session_id if ms else None)
        expect(reply, 400, "invalid_grant")
        self.violation("account-token.rotated-reused")
        if self.config["reuseDetection"] and not grant.revoked:
            # RFC 9700 4.14.2: the reuse revokes the active token of that sign-in, not the account's others.
            grant.revoked = True
            self.sign_out_sessions([grant])

    @precondition(lambda self: any(g.revoked for u in self.users for g in u.grants))
    @rule(data=st.data())
    def revoked_account_token(self, data: st.DataObject) -> None:
        """Reject: a revoked Account Token is `invalid_grant` (4.8)."""
        grant = data.draw(st.sampled_from([g for u in self.users for g in u.grants if g.revoked]))
        expect(self.poppy.refresh(self.co, grant.user.user.dpop_key, grant.current, None), 400, "invalid_grant")

    @precondition(lambda self: any(not g.revoked for u in self.users for g in u.grants))
    @rule(data=st.data())
    def account_token_other_agent(self, data: st.DataObject) -> None:
        """Reject: an Account Token belongs to the client_id it was issued to (4.8)."""
        grant = data.draw(st.sampled_from([g for u in self.users for g in u.grants if not g.revoked]))
        other = Poppy(self.other_agent, self.http)
        expect(other.refresh(self.co, Es256Key(), grant.current, None), 400, "invalid_grant")
        self.violation("account-token.other-client")

    @precondition(lambda self: any(s.ended for u in self.users for s in u.sessions))
    @rule(data=st.data())
    def ended_session(self, data: st.DataObject) -> None:
        """
        An ended Session's token is refused at a resource, as `invalid_token`
        (6) or `invalid_session` as the Company chooses (N39), and renewing
        it is `invalid_session` (4.2).
        """
        ms = data.draw(st.sampled_from([s for u in self.users for s in u.sessions if s.ended]))
        path, _ = data.draw(st.sampled_from(self.api_ops))
        reply = self.poppy.resource(ms.session, "GET", self.api_base + path, self.co)
        if self.config["endedSessionError"] == "invalid_session":
            expect(reply, 400, "invalid_session")
        else:
            expect(reply, 401, "invalid_token")
        expect(self.poppy.start_session(self.co, ms.user.user, session_id=ms.session.session_id), 400, "invalid_session")

    @precondition(lambda self: self.live())
    @rule(data=st.data())
    def sign_in_without_an_offered_scope(self, data: st.DataObject) -> None:
        """
        Reject: a sign-in MUST include `scope` (4.4), and one asking for a
        scope its type doesn't offer is `invalid_scope`.
        """
        ms = data.draw(st.sampled_from(self.live()))
        kind = data.draw(st.sampled_from([k for k in ("direct", "device", "mediated") if self.co.offered(k)]))
        offered = self.co.offered(kind)
        unoffered = st.sampled_from(["poppy:admin", "addresses", "orders:read", "openid"]) | st.from_regex(r"[!#-\[\]-~]+", fullmatch=True)
        extra = data.draw(st.lists(unoffered, min_size=1, max_size=2, unique=True))
        assume(not set(extra) <= set(offered))
        requested = data.draw(st.just([]) | st.lists(st.sampled_from(offered), unique=True).map(lambda s: s + extra))
        account = self.fixture["accounts"][0]
        if kind == "direct":
            url, state, _ = self.poppy.authorization_url(self.co, requested)
            redirect = self.server.hook("approve_authorization", url=url, account=account)["redirect"]
            assert self.poppy.callback(self.co, redirect, state).get("error") == "invalid_scope", redirect
            COVERAGE["sign_in_without_an_offered_scope: direct invalid_scope"] += 1
        elif kind == "device":
            expect(self.poppy.device_start(self.co, requested), 400, "invalid_scope")
        else:
            fields = self.server.hook("mediated_answers", account=account)["fields"]
            expect(self.poppy.mediated_start(self.co, ms.session, requested, fields), 400, "invalid_scope")
        if not requested:
            self.violation("signin.no-scope")

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
                note(f"{ms.session.session_id}: model {ms.account}, mock {mock[ms.session.session_id]['account']}")


def test_mock_company(mock_server: MockServer) -> None:
    run_state_machine_as_test(lambda: MockCompanyMachine(mock_server))
