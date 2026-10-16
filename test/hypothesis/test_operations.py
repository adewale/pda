"""
The Operations extension (Ops 1 to 9): proposals through every channel the
mock has (an OpenAPI write, an MCP tool, a Company message, the print
shop's signed-out order), then approval, confirmation, tracking,
cancelling, revisions, a confirm on the website, and who may use an
operation. The model holds each operation's revisions, state, confirmation
and result, and the mock's count of actions performed.

Invariants, from the extension's text:

- each revision is fixed once issued (3.1): a revision seen again has the
  same summary and terms;
- a final operation never changes (3);
- `confirmation` is null until confirmed and then names the revision and
  how it was approved (3, 5.2); `result` is null until final (3);
- at most once (Ops 1, 6): the Company performs exactly the actions the
  model expects, however many times and through whichever channel an
  operation is confirmed (the mock's `performs`);
- who may use one (3.2): any Session of the same agent and User signed in
  to its account, or only its own Session when proposed signed out;
  anyone else gets `operation_not_found`;
- no operation reaches an agent that doesn't list the extension (2).
"""

from __future__ import annotations

import datetime as dt
import os
from dataclasses import dataclass, field
from typing import Any

from hypothesis import strategies as st
from hypothesis.stateful import invariant, precondition, rule, run_state_machine_as_test

from machine import READ, WRITE, Base, MConversation, MSession, MUser, SessionRules, WarmUp, expect, reached
from mock_server import MockServer
from poppy_client import random_id
from strategies import CONFIGS, serialisations

FINAL = frozenset({"succeeded", "failed", "cancelled", "expired"})
OPEN = frozenset({"proposed", "in_progress"})

OPS_CONFIGS = st.tuples(
    CONFIGS,
    st.fixed_dictionaries(
        {
            "slowConfirm": st.booleans(),
            "userApprovalRequired": st.booleans(),
            "requireOperationsExtension": st.booleans(),
            # Ops 3: an operation_id MAY be the Company's own record's id, any text; the agent encodes it in the path.
            "operationIdPrefix": st.sampled_from([None, "exc_", "booking:", "ord#", "a/b ", "réservation-", "%41"]),
        }
    ),
).map(lambda pair: pair[0] | pair[1])


@dataclass(eq=False)
class MOperation:
    id: str
    kind: str  # "exchange" or "prints"
    user: MUser
    account: str | None  # signed in when proposed: it belongs to the account too (3.2)
    session: MSession  # the Session it was proposed in
    user_approval_required: bool
    revision: int = 1
    known: int = 1  # the revision the agent has seen, and shown the User
    revisions: dict[int, tuple[str, Any]] = field(default_factory=dict)  # summary and terms, fixed once issued (3.1)
    state: str = "proposed"
    confirmation: dict[str, Any] | None = None
    confirm_tried: bool = False  # a confirm reached the Company (Ops 6, N34)
    pending: bool = False  # `slowConfirm`: in_progress until the next read
    retry_at_ms: int = 0  # Retry-After from the last in_progress answer
    result: Any = None
    url: str | None = None  # where the website shows it (Ops 3, 4.4)


class OperationsRules:
    # ---- the model ----

    def init_operations(self) -> None:
        self.operations: list[MOperation] = []
        self.performs = 0
        self.exchanged: set[str] = set()  # accounts whose jacket was exchanged: an item is exchanged once
        self.exchange_terms: Any = None  # the jacket exchange's terms, as the Company first proposed them
        self.idempotency: dict[tuple[str, str], tuple[int, str]] = {}  # (Session, key) → (status, operation or exchange id)
        self.revised = 0

    def can_use(self, op: MOperation, ms: MSession) -> bool:
        """Ops 3.2: the same agent and User, signed in to its account; signed out, only its own Session."""
        if ms.user is not op.user:
            return False
        return ms.account == op.account if op.account is not None else ms is op.session

    def open_exchange_for(self, ms: MSession) -> MOperation | None:
        """
        The open jacket exchange this Session's proposal is the same action
        as (Ops 4: the Company SHOULD return the existing operation): the
        same User and account, and still the terms first proposed.
        """
        for op in self.operations:
            if (
                op.kind == "exchange"
                and op.state in OPEN
                and op.account == ms.account
                and op.user is ms.user
                and op.revisions[op.revision][1] == self.exchange_terms
            ):
                return op
        return None

    def check_operation(self, body: Any, op: MOperation) -> None:
        """One operation object, held to the model (Ops 3, 5.2)."""
        assert isinstance(body, dict), body
        for name in ("operation_id", "revision", "state", "summary", "confirmation", "result"):
            assert name in body, f"an operation without {name} (Ops 3): {body}"
        assert body["operation_id"] == op.id, (body["operation_id"], op.id)
        assert body["revision"] == op.revision, f"revision {body['revision']}, model {op.revision}"
        assert body["state"] == op.state, f"{op.id}: state {body['state']}, model {op.state}"
        assert isinstance(body["summary"], str) and body["summary"], body
        seen = (body["summary"], body.get("terms"))
        fixed = op.revisions.setdefault(op.revision, seen)
        assert seen == fixed, f"revision {op.revision} of {op.id} changed: {fixed} then {seen} (Ops 3.1)"
        assert body.get("user_approval_required", False) is op.user_approval_required, body
        if op.state == "proposed":
            expires = body.get("expires_at")
            assert isinstance(expires, str), f"a proposed operation without expires_at (Ops 3): {body}"
            assert dt.datetime.fromisoformat(expires).tzinfo is not None, f"expires_at {expires} isn't RFC 3339 with an offset"
        if op.confirmation is None:
            assert body["confirmation"] is None, body
        else:
            got = body["confirmation"]
            assert isinstance(got, dict) and isinstance(got.get("confirmed_at"), str), got
            assert (got.get("revision"), got.get("approved_by")) == (op.confirmation["revision"], op.confirmation["approved_by"]), (got, op.confirmation)
        if op.state in OPEN:
            assert body["result"] is None, f"a result before the operation is final (Ops 3): {body}"
        else:
            assert isinstance(body["result"], dict) and isinstance(body["result"].get("summary"), str), body
            if op.result is not None:
                assert body["result"] == op.result, "a final operation changed (Ops 3)"
            op.result = body["result"]
        if "url" in body and body["url"] is not None:
            assert self.co.on_own_domain(body["url"]), f"the operation's url isn't on the Company's website: {body['url']}"
            assert op.url in (None, body["url"]), f"{op.id}'s url changed"
            op.url = body["url"]

    def proposed(self, body: Any, ms: MSession, kind: str) -> MOperation:
        """A proposal: the open one for the same action (Ops 4, 6), or a new operation."""
        assert isinstance(body, dict), body
        existing = self.open_exchange_for(ms) if kind == "exchange" else None
        if existing is not None:
            assert body["operation_id"] == existing.id, (
                f"proposed {body['operation_id']}, but {existing.id} is open for the same action, User and account (Ops 4)"
            )
            if existing.confirm_tried:
                # Ops 6: no new proposal until it's final; the reject rule asked on purpose.
                self.violation("proposal.while-open")
            existing.known = existing.revision
            self.check_operation(body, existing)
            return existing
        known = {op.id: op for op in self.operations}
        assert body["operation_id"] not in known, (
            f"a new proposal for {ms.user.user.user_id} returned {body['operation_id']}, "
            f"an operation of User {known[body['operation_id']].user.user.user_id} in account {known[body['operation_id']].account} (Ops 3.2)"
        )
        assert body["state"] == "proposed" and body["revision"] == 1 and body["confirmation"] is None, body
        op = MOperation(
            body["operation_id"],
            kind,
            ms.user,
            ms.account,
            ms,
            True if kind == "prints" else self.config["userApprovalRequired"],
        )
        if kind == "exchange" and self.exchange_terms is None:
            self.exchange_terms = body.get("terms")
        self.operations.append(op)
        self.check_operation(body, op)
        return op

    def performed(self, op: MOperation | None, account: str | None = None) -> None:
        self.performs += 1
        if op is None or op.kind == "exchange":
            self.exchanged.add(op.account if op else account)  # type: ignore[arg-type]

    def proposals_allowed(self, ms: MSession) -> bool:
        """Ops 6: the honest agent doesn't ask again for an action whose operation it tried to confirm, until it's final."""
        existing = self.open_exchange_for(ms)
        return existing is None or not existing.confirm_tried

    def usable_pairs(self, ops: list[MOperation]) -> list[tuple[MOperation, MSession]]:
        return [(op, ms) for op in ops for ms in self.live() if self.can_use(op, ms)]

    def exchange_outcome(self, ms: MSession, scope: frozenset[str], account: str | None) -> tuple[int, str | None] | None:
        """What an exchange write gets before any proposal: sign-in or scope errors (6), or None to go on."""
        if account is None:
            return 403, "sign_in_required"
        if WRITE not in scope:
            return 403, "insufficient_scope"
        return None

    # ---- proposing (Ops 4) ----

    @precondition(lambda self: self.live())
    @rule(data=st.data())
    def propose_by_api(self, data: st.DataObject) -> None:
        """
        Ops 4.1: the exchange write answers 202 with the operation. An agent
        without the extension gets the action done (201) or
        `extension_required` (Ops 2). A retry with the same
        `Idempotency-Key` answers for the same operation or exchange (Guides).
        """
        ms = data.draw(st.sampled_from(self.live()))
        keys = [key for (sid, key) in self.idempotency if sid == ms.session.session_id]
        key = data.draw(st.sampled_from(keys) | st.just(random_id("idk_")) if keys else st.just(random_id("idk_")))
        retry = self.idempotency.get((ms.session.session_id, key))
        if retry is None and not self.proposals_allowed(ms):
            reached("reads the open operation instead of asking again")
            return self.read_one(self.open_exchange_for(ms), ms)
        if retry is None and not self.agent.lists_operations and ms.account in self.exchanged:
            return  # the jacket was exchanged already: nothing left to ask for
        reply = self.poppy.exchange(ms.session, self.co, self.api_base, key)
        outcome = self.exchange_outcome(ms, ms.token_scope, ms.account)
        if outcome is not None:
            expect(reply, *outcome)
            return
        if retry is not None:
            expect(reply, retry[0])
            got = reply.body["operation"]["operation_id"] if "operation" in reply.body else reply.body["exchange"]["exchange_id"]
            assert got == retry[1], "a retry with the same Idempotency-Key answers for the same request (Guides: Retries)"
            return
        if self.agent.lists_operations:
            expect(reply, 202)
            op = self.proposed(reply.body["operation"], ms, "exchange")
            self.idempotency[(ms.session.session_id, key)] = (202, op.id)
        elif self.config["requireOperationsExtension"]:
            expect(reply, 403, "extension_required")
            assert reply.body.get("extension") == "operations", reply.body
        else:
            expect(reply, 201)
            assert "operation" not in reply.body, "an operation for an agent that doesn't list the extension (Ops 2)"
            self.performed(None, ms.account)
            self.idempotency[(ms.session.session_id, key)] = (201, reply.body["exchange"]["exchange_id"])

    @precondition(lambda self: self.live())
    @rule(data=st.data())
    def propose_by_mcp(self, data: st.DataObject) -> None:
        """Ops 4.2: the MCP tool returns the operation in `structuredContent`, and the summary as text."""
        ms = data.draw(st.sampled_from(self.live()))
        if not self.proposals_allowed(ms):
            reached("reads the open operation instead of asking again")
            return self.read_one(self.open_exchange_for(ms), ms)
        if not self.agent.lists_operations and ms.account in self.exchanged:
            return
        args = {"order_id": "ord_7Hk2", "item_id": "itm_4Qa", "replacement_sku": "stormline-insulated-m"}
        reply = self.mcp_call(ms, "tools/call", {"name": "exchange_item", "arguments": args})
        assert ms.bearer is not None
        outcome = self.exchange_outcome(ms, ms.bearer.scope if ms.bearer_account() else frozenset(), ms.bearer_account())
        if outcome is not None:
            expect(reply, *outcome)
            assert reply.headers.get("www-authenticate", "").startswith("Bearer "), reply.headers
            return
        if self.agent.lists_operations:
            expect(reply, 200)
            result = reply.body["result"]
            assert any(item.get("type") == "text" for item in result["content"]), result
            self.proposed(result["structuredContent"]["operation"], ms, "exchange")
        elif self.config["requireOperationsExtension"]:
            expect(reply, 403, "extension_required")
        else:
            expect(reply, 200)
            assert "operation" not in reply.body["result"].get("structuredContent", {}), "an operation for an agent that doesn't list the extension (Ops 2)"
            self.performed(None, ms.account)

    @precondition(lambda self: self.live() and self.co.conversations)
    @rule(data=st.data())
    def propose_in_conversation(self, data: st.DataObject) -> None:
        """
        Ops 4.3: asked signed in with read and write, the Company Agent's
        message carries the operation. Signed out, or without those scopes,
        the Company asks for them with an `authorization` event (7.11).
        """
        ms = data.draw(st.sampled_from(self.live()))
        if not self.proposals_allowed(ms):
            reached("reads the open operation instead of asking again")
            return self.read_one(self.open_exchange_for(ms), ms)
        message = {"id": random_id("msg_"), "sender": data.draw(st.sampled_from(["agent", "human"])), "text": self.fixture["prompts"]["operation"]}
        reply = expect(self.poppy.post_message(ms.session, self.co, data.draw(serialisations(message)), None), 201)
        cid = reply.body["conversation_id"]
        conversation = MConversation(cid, ms.user, sent=[message["id"]])
        self.conversations.append(conversation)
        self.accepted(conversation, ms, message, started=True)
        self.check_status(conversation, reply.body, "a new conversation")
        if self.config["agentReplies"] and ms.account and {READ, WRITE} <= ms.token_scope:
            conversation.account = ms.account
        read, events = self.poppy.read_events(ms.session, self.co, cid, None, stream=False)
        expect(read, 200)
        self.absorb(conversation, None, events, read.body)
        replies = [e["message"] for e in events if e["type"] == "message" and e["message"]["role"] == "company"]
        if not self.config["agentReplies"]:
            assert not replies and not [e for e in events if e["type"] == "authorization"], events
            return
        if not ms.account or not {READ, WRITE} <= ms.token_scope:
            asks = [e for e in events if e["type"] == "authorization"]
            assert len(asks) == 1, events
            if not ms.account:
                assert asks[0]["error"] == "sign_in_required", asks
            else:
                assert asks[0]["error"] == "insufficient_scope" and set(asks[0]["scope"].split()) == {READ, WRITE}, asks
            reached("authorization " + asks[0]["error"])
            return
        assert len(replies) == 1, events
        if not self.agent.lists_operations:
            assert "operation" not in replies[0], "an operation for an agent that doesn't list the extension (Ops 2)"
            return
        self.proposed(replies[0]["operation"], ms, "exchange")
        reached("operation in a message")

    @precondition(lambda self: self.live())
    @rule(data=st.data())
    def propose_prints(self, data: st.DataObject) -> None:
        """
        The print shop: a photo uploaded, then an order of prints, which
        proposes an operation the User must approve themselves
        (`user_approval_required`). Proposed signed out, it belongs to its
        Session alone (Ops 3.2).
        """
        ms = data.draw(st.sampled_from(self.live()))
        photo = expect(self.poppy.upload_photo(ms.session, self.co, self.api_base, "lake.jpg", b"\xff\xd8\xff\xe0" + os.urandom(64)), 201).body
        order = {
            "email": "ada@example.com",
            "ship_to": {"name": "Ada Lovelace", "line1": "12 St James's Square", "city": "London", "postal_code": "SW1Y 4JH", "country": "GB"},
            "items": [{"photo_id": photo["id"], "copies": data.draw(st.integers(1, 100))}],
        }
        reply = self.poppy.order_prints(ms.session, self.co, self.api_base, order, random_id("idk_"))
        if not self.agent.lists_operations:
            expect(reply, 403, "extension_required")
            return
        expect(reply, 202)
        self.proposed(reply.body["operation"], ms, "prints")

    # ---- approving and confirming (Ops 5) ----

    def item_available(self, op: MOperation) -> bool:
        """The fixture has one jacket per account; a pending exchange reserves it."""
        return op.kind != "exchange" or (
            op.account not in self.exchanged
            and not any(other.kind == "exchange" and other.account == op.account and other.pending for other in self.operations)
        )

    def confirmable(self) -> list[tuple[MOperation, MSession]]:
        """
        What the honest agent confirms: an operation it may use, after the
        User approved it, never an exchange for an account whose jacket was
        already exchanged or committed to another pending operation (a
        repeat confirm of a confirmed one is fine).
        """
        return [
            (op, ms)
            for op, ms in self.usable_pairs(self.operations)
            if op.state != "proposed" or self.item_available(op)
        ]

    @precondition(lambda self: self.agent.lists_operations and self.confirmable())
    @rule(data=st.data())
    def confirm(self, data: st.DataObject) -> None:
        """
        Ops 5.2, with the revision the agent showed the User and an approval
        it may use (5.1: a standing permission only when the operation
        doesn't require the User's own). In the order Ops 5.2 lists:
        scopes, the latest revision (`terms_changed` with the current
        operation), then the state: anything but `proposed` is returned as
        it is. Done at once (`succeeded`) or `in_progress` with `Retry-After`.
        """
        op, ms = data.draw(st.sampled_from(self.confirmable()))
        approved_by = "user" if op.user_approval_required else data.draw(st.sampled_from(["user", "standing_permission"]))
        if op.confirmation is not None:
            approved_by = op.confirmation["approved_by"]  # a retry of the same confirm
        reply = self.poppy.confirm_operation(ms.session, self.co, op.id, op.known, approved_by)
        op.confirm_tried = True
        self.confirm_answer(reply, op, ms, op.known, approved_by)

    def confirm_answer(self, reply: Any, op: MOperation, ms: MSession, revision: Any, approved_by: str) -> None:
        if op.kind == "exchange" and WRITE not in ms.token_scope:
            expect(reply, 403, "insufficient_scope")
            return
        if op.state != "proposed":
            if revision != (op.confirmation or {}).get("revision", op.revision):
                # The draft lists the checks without an order: a stale revision on an operation no longer
                # proposed may be `terms_changed` or the operation as it is (ask-author, see README).
                assert reply.status in (200, 409), reply.text
                reached(f"stale revision, not proposed: {reply.status}")
                if reply.status == 409:
                    assert reply.error == "terms_changed"
                    self.check_operation(reply.body["operation"], op)
                    return
            expect(reply, 200)
            self.check_operation(reply.body, op)
            return
        if revision != op.revision:
            expect(reply, 409, "terms_changed")
            self.check_operation(reply.body["operation"], op)
            op.known = op.revision
            return
        expect(reply, 200)
        op.confirmation = {"revision": op.revision, "approved_by": approved_by}
        if self.config["slowConfirm"]:
            op.state, op.pending = "in_progress", True
            retry_after = reply.headers.get("retry-after")
            assert retry_after is not None and retry_after.isdigit(), "in_progress without Retry-After (Ops 5.2)"
            op.retry_at_ms = self.clock.now_ms() + int(retry_after) * 1000
        else:
            op.state = "succeeded"
            self.performed(op)
        self.check_operation(reply.body, op)

    def read_one(self, op: MOperation | None, ms: MSession) -> None:
        """Ops 6: read the operation, after the `Retry-After` it gave while in progress."""
        assert op is not None
        if self.clock.now_ms() < op.retry_at_ms:
            self.clock.sleep((op.retry_at_ms - self.clock.now_ms()) / 1000)
        reply = self.poppy.read_operation(ms.session, self.co, op.id)
        if not self.can_use(op, ms):
            expect(reply, 404, "operation_not_found")
            return
        expect(reply, 200)
        if op.pending:
            op.pending, op.state = False, "succeeded"
            self.performed(op)
        if op.state == "in_progress":
            assert reply.headers.get("retry-after"), "in_progress without Retry-After (Ops 6 SHOULD)"
        op.known = op.revision
        self.check_operation(reply.body, op)

    @precondition(lambda self: self.agent.lists_operations and self.operations and self.live())
    @rule(data=st.data())
    def read_operation(self, data: st.DataObject) -> None:
        """Ops 6 and 3.2: any Session may ask; only those that may use it get it."""
        op = data.draw(st.sampled_from(self.operations))
        ms = data.draw(st.sampled_from(self.live()))
        self.read_one(op, ms)

    @precondition(lambda self: self.agent.lists_operations and self.operations and self.live())
    @rule(data=st.data())
    def cancel(self, data: st.DataObject) -> None:
        """
        Ops 7: `proposed` becomes `cancelled`; an `in_progress` one is
        stopped if it can be, and says where it is; a final one is returned
        as it is. 3.2 says who may.
        """
        op = data.draw(st.sampled_from(self.operations))
        ms = data.draw(st.sampled_from(self.live()))
        reply = self.poppy.cancel_operation(ms.session, self.co, op.id)
        if not self.can_use(op, ms):
            expect(reply, 404, "operation_not_found")
            return
        expect(reply, 200)
        if op.state == "proposed":
            op.state = "cancelled"
        elif op.state == "in_progress":
            assert reply.body.get("state") in ("in_progress", "cancelled"), reply.body
            if reply.body["state"] == "cancelled":
                op.state, op.pending = "cancelled", False
            reached(f"in_progress, then {reply.body['state']}")
        self.check_operation(reply.body, op)

    # ---- the Company's side ----

    @precondition(lambda self: [op for op in self.operations if op.state == "proposed" and op.kind == "exchange"])
    @rule(data=st.data())
    def company_revises(self, data: st.DataObject) -> None:
        """Ops 3.1: the terms change before confirmation: the next revision, fixed once issued."""
        op = data.draw(st.sampled_from([op for op in self.operations if op.state == "proposed" and op.kind == "exchange"]))
        self.revised += 1
        size = data.draw(st.sampled_from(["S", "L", "XL"]))
        terms = {"order_id": "ord_7Hk2", "item_id": "itm_4Qa", "replacement_sku": f"stormline-insulated-{size.lower()}", "change": self.revised}
        summary = f"Exchange the Stormline Jacket (M) on order ord_7Hk2 for the Stormline Insulated Jacket ({size}), for $70.00 more."
        revision = self.server.hook("revise_operation", operation=op.id, summary=summary, terms=terms)["revision"]
        op.revision += 1
        assert revision == op.revision, (revision, op.revision)
        op.revisions[op.revision] = (summary, terms)
        reached("revised")

    @precondition(
        lambda self: [
            op for op in self.operations if op.state == "proposed" and self.item_available(op)
        ]
    )
    @rule(data=st.data())
    def user_confirms_on_the_website(self, data: st.DataObject) -> None:
        """Ops 4.4: confirmed on the website, it's the same operation, performed once whichever way it's confirmed."""
        op = data.draw(
            st.sampled_from([op for op in self.operations if op.state == "proposed" and self.item_available(op)])
        )
        self.server.hook("confirm_on_website", operation=op.id)
        op.state = "succeeded"
        op.confirmation = {"revision": op.revision, "approved_by": "user"}
        self.performed(op)
        reached("confirmed on the website")

    @precondition(lambda self: [op for op in self.operations if op.url] and self.live() and self.co.browser_session)
    @rule(data=st.data())
    def view_on_the_website(self, data: st.DataObject) -> None:
        """
        Ops 4.4 and 3: an operation's `url` is a page on the Company's
        website that shows it in the same Session, to a Session that may use
        it (3.2), with its current terms and state.
        """
        op = data.draw(st.sampled_from([op for op in self.operations if op.url]))
        ms = data.draw(st.sampled_from(self.live()))
        if not ms.joined:
            self.join_browser(ms)
        assert ms.browser is not None and op.url is not None
        page = ms.browser.get(op.url)
        if not self.can_use(op, ms):
            assert page.status_code == 404, (page.status_code, page.text[:200])
            reached(f"{op.kind} page: 404")
            return
        assert page.status_code == 200, f"{op.url} doesn't show {op.id} to a Session that may use it: {page.status_code} {page.text[:200]}"
        assert op.revisions[op.revision][0] in page.text and f"Status: {op.state}" in page.text, page.text[:400]
        reached(f"{op.kind} page: 200")

    # ---- reject direction ----

    @precondition(
        lambda self: self.agent.lists_operations
        and [
            (op, ms)
            for op, ms in self.usable_pairs(self.operations)
            if op.state == "proposed" and op.user_approval_required and (op.kind != "exchange" or WRITE in ms.token_scope)
        ]
    )
    @rule(data=st.data())
    def standing_permission_when_the_user_must_approve(self, data: st.DataObject) -> None:
        """Reject: `user_approval_required` rules out a standing permission (Ops 3, 5.1): 403 `user_approval_required`."""
        op, ms = data.draw(
            st.sampled_from(
                [
                    (op, ms)
                    for op, ms in self.usable_pairs(self.operations)
                    if op.state == "proposed" and op.user_approval_required and (op.kind != "exchange" or WRITE in ms.token_scope)
                ]
            )
        )
        reply = self.poppy.confirm_operation(ms.session, self.co, op.id, op.revision, "standing_permission")
        op.confirm_tried, op.known = True, op.revision
        expect(reply, 403, "user_approval_required")
        self.violation("confirm.standing-permission-overrides-user")

    @precondition(
        lambda self: self.agent.lists_operations
        and [(op, ms) for op, ms in self.usable_pairs(self.operations) if op.state == "proposed" and (op.kind != "exchange" or WRITE in ms.token_scope)]
    )
    @rule(data=st.data())
    def confirm_another_revision(self, data: st.DataObject) -> None:
        """Reject: only the latest revision can be confirmed (Ops 3.1): `terms_changed` with the current operation (Ops 9)."""
        op, ms = data.draw(
            st.sampled_from(
                [(op, ms) for op, ms in self.usable_pairs(self.operations) if op.state == "proposed" and (op.kind != "exchange" or WRITE in ms.token_scope)]
            )
        )
        # Any other integer within RFC 8259's interoperable range (section 6).
        revision = data.draw(st.integers(min_value=-(2**53 - 1), max_value=2**53 - 1).filter(lambda r: r != op.revision))
        reply = self.poppy.confirm_operation(ms.session, self.co, op.id, revision, "user")
        op.confirm_tried = True
        expect(reply, 409, "terms_changed")
        self.check_operation(reply.body["operation"], op)

    @precondition(
        lambda self: self.agent.lists_operations
        and [(op, ms) for op, ms in self.usable_pairs(self.operations) if op.kind != "exchange" or WRITE in ms.token_scope]
    )
    @rule(data=st.data())
    def malformed_confirm(self, data: st.DataObject) -> None:
        """
        Reject: a confirm names the revision as an integer and how it was
        approved, `user` or `standing_permission` (Ops 5.1, 5.2). The draft
        has no error for it (N20); the mock answers `invalid_request` and
        records it. A JSON number with an integral value is that integer
        (RFC 8259 6), so 1.0 is revision 1.
        """
        op, ms = data.draw(
            st.sampled_from([(op, ms) for op, ms in self.usable_pairs(self.operations) if op.kind != "exchange" or WRITE in ms.token_scope])
        )
        bad_revision = data.draw(st.booleans(), label="bad revision")
        if bad_revision:
            revision = data.draw(
                st.none() | st.booleans() | st.text() | st.floats(allow_nan=False, allow_infinity=False).filter(lambda f: not f.is_integer())
            )
            approved_by: Any = "user"
        else:
            revision = op.revision
            approved_by = data.draw(st.none() | st.text().filter(lambda t: t not in ("user", "standing_permission")) | st.integers())
        reply = self.poppy.confirm_operation(ms.session, self.co, op.id, revision, approved_by)
        op.confirm_tried = True
        if bad_revision:
            expect(reply, 400, "invalid_request")
            self.violation("confirm.revision")
        elif op.state != "proposed":
            expect(reply, 200)
            self.check_operation(reply.body, op)
        else:
            expect(reply, 400, "invalid_request")
            self.violation("confirm.approved-by")

    def asking_again(self) -> list[MSession]:
        return [
            ms
            for ms in self.live()
            if ms.account and WRITE in ms.token_scope and (op := self.open_exchange_for(ms)) is not None and op.confirm_tried
        ]

    @precondition(lambda self: self.agent.lists_operations and self.asking_again())
    @rule(data=st.data())
    def ask_again_while_confirming(self, data: st.DataObject) -> None:
        """
        Reject: after a confirm, no new proposal of the same action until
        the operation is final (Ops 6 MUST NOT; N34). The Company answers
        with the open operation, and records it.
        """
        ms = data.draw(st.sampled_from(self.asking_again()))
        reply = expect(self.poppy.exchange(ms.session, self.co, self.api_base, random_id("idk_")), 202)
        self.proposed(reply.body["operation"], ms, "exchange")

    # ---- invariants ----

    @invariant()
    def performed_at_most_once(self) -> None:
        """Ops 1, 6: the Company performed exactly the actions confirmed, each once, and its operations are the model's."""
        if self.company is None:
            return
        state = self.server.state()
        assert state["performs"] == self.performs, f"performed {state['performs']} actions, model {self.performs}"
        mock = {o["id"]: o for o in state["operations"]}
        assert set(mock) == {op.id for op in self.operations}, (set(mock), [op.id for op in self.operations])
        for op in self.operations:
            assert (mock[op.id]["state"], mock[op.id]["revision"]) == (op.state if not op.pending else "in_progress", op.revision), (mock[op.id], op.state)


class OperationsMachine(WarmUp, Base, SessionRules, OperationsRules):
    CONFIG = OPS_CONFIGS
    # Mostly an agent that lists the extension; sometimes one that doesn't (Ops 2).
    LISTS_OPERATIONS = st.sampled_from([True, True, True, False])

    def __init__(self, server: MockServer) -> None:
        super().__init__(server)
        self.init_operations()


def test_operations_extension(mock_server: MockServer) -> None:
    run_state_machine_as_test(lambda: OperationsMachine(mock_server))
