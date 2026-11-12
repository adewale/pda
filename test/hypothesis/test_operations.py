"""
The Operations extension, version 3 (Ops 1 to 7), under Poppy 0.4: a write
that needs the User's approval is refused with an operation, through every
channel the mock has (an OpenAPI write, an MCP tool, a Company message, the
print shop's order); the same request sent again with an approval of a
revision it returned is performed once, or declined, or answered with a new
revision. The model holds each operation: the request and channel that
returned it, who may approve it, every revision and its terms, whether it
was performed and with what response, how many approvals reached it, which
revisions were declined, and which only the User may approve.

Invariants, from the extension's text and the mock's record of it:

- a revision is fixed once returned (Ops 3): seen again, it has the same
  summary and terms, and it always has terms;
- the Company has the operations the model has, each with as many
  revisions and approvals, performed or not;
- at most once (Ops 7): the Company performs exactly the actions the model
  expects (the mock's `performs`), however many times an approved request
  is sent again, whichever key it carries;
- who can approve it (Ops 3): the same agent and User, signed in to its
  account, or, returned signed out, only its own Session; an approval from
  anyone else is no approval;
- an approval names a revision the Company returned for exactly that
  request; anything else gets a new revision, never the one it named (Ops 6);
- a decline names the revision approved, performs nothing, and is never
  sent again; after one, and after any approval of its own, the agent leaves
  the operation to the User (Ops 5, 6; readings v04-agent-approval-again);
- no operation reaches a Session that doesn't declare `"operations";v="3"`
  (Ops 2, 3.4).
"""

from __future__ import annotations

import datetime as dt
import json
import re
from dataclasses import dataclass, field
from typing import Any

from hypothesis import assume
from hypothesis import strategies as st
from hypothesis.stateful import invariant, precondition, rule, run_state_machine_as_test

from machine import WRITE, Base, ConversationRules, MConversation, MSession, MUser, SessionRules, WarmUp, expect, expect_challenge, reached
from mock_server import MockServer
from poppy_client import approval, approval_header, random_id
from strategies import CONFIGS


def ops_content(message: dict[str, Any]) -> dict[str, Any]:
    """Operations content in a message's `extensions` (8.4; Ops 4, 6), or an empty dict."""
    extensions = message.get("extensions")
    content = extensions.get("operations") if isinstance(extensions, dict) else None
    return content if isinstance(content, dict) else {}


APPROVAL_META = "personalagentprotocol.org/approval"
REFERENCE = re.compile(r"[A-Za-z0-9_-]{1,256}")  # Ops 6: the characters of the IDs in spec 8.2
EXCHANGE = {"item_id": "itm_4Qa", "replacement_sku": "stormline-insulated-m"}
EXCHANGE_ARGS = {"order_id": "ord_7Hk2"} | EXCHANGE
PHOTO = b"\xff\xd8\xff\xe0" + b"\x00" * 64 + b"\xff\xd9"  # enough of a JPEG for the mock's sniffing
SHIP_TO = {"name": "Ada Lovelace", "line1": "12 St James's Square", "city": "London", "postal_code": "SW1Y 4JH", "country": "GB"}

OPS_CONFIGS = st.tuples(
    CONFIGS,
    st.fixed_dictionaries(
        {
            "requireOperationsExtension": st.booleans(),
            # Ops 3: an operation_id is the Company's own text; the mock keeps it URL-safe.
            "operationIdPrefix": st.sampled_from([None, "exc_", "booking:", "ord#", "a/b ", "réservation-", "%41"]),
            # Ops 6: terms that moved since the first revision, and declines for the Company's own reasons.
            "reviseOnFirstApproval": st.booleans(),
            "declineApprovals": st.sampled_from([None, "agent", "all"]),
        }
    ),
).map(lambda pair: pair[0] | pair[1])


@dataclass(eq=False)
class MOperation:
    id: str
    kind: str  # "exchange" or "prints"
    channel: str  # "api", "mcp", "conversation" or "prints"
    request: str  # what the Company compares an approved request with: the body, the tool's arguments, or the conversation
    user: MUser
    account: str | None  # signed in when returned: any of the User's Sessions signed in to it may approve it (Ops 3)
    session: MSession  # the Session it was returned in: the only one that may approve it when signed out
    revisions: dict[str, tuple[str | None, Any]] = field(default_factory=dict)  # summary and terms, fixed once returned (Ops 3)
    latest: str = ""
    performed: Any = None  # the first response of the approved request (Ops 7)
    approvals: int = 0  # approvals that reached it: from someone who may approve it, of this kind
    conversation: MConversation | None = None
    order: dict[str, Any] | None = None  # a print order, as sent
    keys: list[tuple[MSession, str]] = field(default_factory=list)  # Idempotency-Keys of requests without an approval that returned it
    performed_keys: list[tuple[str, str | None]] = field(default_factory=list)  # a print order's keys that got the performed response, each with the account it was sent under
    declined: dict[tuple[str, str], dict[str, Any]] = field(default_factory=dict)  # (revision, approver) declined, each with the approval declined (Ops 6)
    user_only: set[str] = field(default_factory=set)  # revisions that answered an agent approval: only the User approves them (Ops 5)
    agent_used: bool = False  # the agent approved a revision of it itself (readings v04-agent-approval-again)
    last_approval: dict[str, Any] | None = None  # the approval it was performed with, which a retry sends again (Ops 7)


class OperationsRules:
    # ---- the model ----

    def init_operations(self) -> None:
        self.operations: list[MOperation] = []
        self.performs = 0
        self.exchanged: set[str | None] = set()  # accounts whose jacket was exchanged: the item is exchanged once
        self.photos: dict[MSession, list[str]] = {}
        self.references: dict[tuple[str, str], str] = {}  # each (User, reference) sent, and the "operation revision" it approved (Ops 6)

    def can_approve(self, op: MOperation, ms: MSession, account: object = ...) -> bool:
        """Ops 3: the same agent and User, signed in to its account; returned signed out, only its own Session."""
        acting = ms.account if account is ... else account
        if ms.user is not op.user or ms.ended:
            return False
        return acting == op.account if op.account is not None else ms is op.session

    def existing(self, kind: str, request: str, ms: MSession, account: str | None) -> MOperation | None:
        """The first unperformed operation for exactly this request that this Session may approve: the Company returns it again."""
        for op in self.operations:
            if op.kind == kind and op.performed is None and op.request == request and self.can_approve(op, ms, account):
                return op
        return None

    def check_operation(self, body: Any, op: MOperation) -> None:
        """One operation (Ops 3): its id, a revision, its terms, perhaps a summary, and when it expires."""
        assert isinstance(body, dict), body
        assert body.get("operation_id") == op.id, (body, op.id)
        revision, summary, terms = body.get("revision"), body.get("summary"), body.get("terms")
        assert isinstance(revision, str) and revision, body
        assert summary is None or (isinstance(summary, str) and summary), body
        assert isinstance(terms, dict), f"an operation without terms (Ops 3: required in version 3): {body}"
        expires = body.get("expires_at")
        assert isinstance(expires, str) and dt.datetime.fromisoformat(expires.replace("Z", "+00:00")).tzinfo is not None, body
        fixed = op.revisions.setdefault(revision, (summary, terms))
        assert fixed == (summary, terms), f"revision {revision} of {op.id} changed: {fixed} then {(summary, terms)} (Ops 3)"
        if op.kind == "exchange":
            assert terms.get("order_id") == "ord_7Hk2" and terms.get("item_id") == "itm_4Qa", terms
        if op.kind == "prints":
            assert terms.get("items") == [{"photo_id": i["photo_id"], "copies": i["copies"]} for i in op.order["items"]], terms  # type: ignore[index]

    def returned(self, body: Any, *, kind: str, channel: str, request: str, ms: MSession, account: str | None, **extra: Any) -> MOperation:
        """
        An operation the Company returned for a request without an approval:
        the open one for exactly this request and this approver, at its
        latest revision, or a new one (Ops 4).
        """
        assert isinstance(body, dict) and "operation_id" in body, body
        op = self.existing(kind, request, ms, account)
        if op is not None:
            assert body["operation_id"] == op.id, f"returned {body['operation_id']}, but {op.id} is open for the same request and approver"
            assert body["revision"] == op.latest, f"{op.id}: revision {body['revision']}, not the latest {op.latest}"
            self.check_operation(body, op)
            return op
        known = {o.id: o for o in self.operations}
        assert body["operation_id"] not in known, f"a new request got {body['operation_id']}, an operation of {known[body['operation_id']].user.user.user_id} (Ops 3)"
        op = MOperation(body["operation_id"], kind, channel, request, ms.user, account, ms, **extra)
        self.operations.append(op)
        self.check_operation(body, op)
        op.latest = body["revision"]
        reached(f"{channel}: new operation")
        return op

    def revised(self, body: Any, op: MOperation, named: str, *, agent: bool) -> None:
        """Ops 6: an approval that isn't performed gets a new revision of the operation, never the one it named; after an agent's, only the User's (Ops 5)."""
        assert isinstance(body, dict) and body.get("operation_id") == op.id, (body, op.id)
        assert body["revision"] != named and body["revision"] not in op.revisions, f"{op.id}: revision {body['revision']} again"
        self.check_operation(body, op)
        op.latest = body["revision"]
        if agent:
            op.user_only.add(body["revision"])

    def perform(self, op: MOperation, response: Any) -> None:
        """The approved request was performed: its response is the one every later approval gets (Ops 7)."""
        if op.performed is None:
            op.performed = response
            self.performs += 1
            if op.kind == "exchange":
                if op.account in self.exchanged:
                    self.violation("exchange.performed-twice")
                self.exchanged.add(op.account)
        else:
            assert response == op.performed, f"{op.id}: an approval again got {response}, not the first response {op.performed} (Ops 7)"

    def check_declined(self, members: Any, op: MOperation, revision: str, *, with_error: bool) -> None:
        """
        Ops 6: a decline names the operation and the revision approved, says
        why in `reason`, perhaps with an `alternative` (9.2), carries `error`
        at an API or MCP server and not in a conversation, and returns no
        new operation.
        """
        assert isinstance(members, dict), members
        assert members.get("operation_id") == op.id and members.get("revision") == revision, (members, op.id, revision)
        assert isinstance(members.get("reason"), str), members
        assert "operation" not in members, f"a decline with a new operation (Ops 6: \"returns no new operation\"): {members}"
        if with_error:
            assert members.get("error") == "approval_declined", members
        else:
            assert "error" not in members, f"a conversation's decline carries no error (Ops 6): {members}"
        if "alternative" in members:
            alternative = members["alternative"]
            assert isinstance(alternative, dict) and ("instructions" in alternative or "references" in alternative), alternative

    def approvable(self, *, honest: bool = True) -> list[tuple[MOperation, MSession]]:
        """
        Who may send an approval now: a live Session that may approve it, on
        its channel (the print order only from the Session holding its
        photos; a message only where the Session may send to the
        conversation). The honest agent never approves a second exchange of
        the same item, and approves only a revision that wasn't declined.
        """
        pairs = []
        for op in self.operations:
            if honest and op.kind == "exchange" and op.performed is None and op.account in self.exchanged:
                continue
            if honest and op.performed is None and not self.honest_revisions(op):
                continue
            for ms in self.live(op.user):
                if not self.can_approve(op, ms):
                    continue
                if op.channel == "prints" and ms is not op.session:
                    continue
                if op.channel in ("api", "mcp") and WRITE not in ms.token_scope:
                    continue  # the write needs the scope before anything else (7)
                if op.channel == "conversation" and (op.conversation not in [c for c, s in self.sendable() if s is ms]):
                    continue
                pairs.append((op, ms))
        return pairs

    def honest_revisions(self, op: MOperation) -> list[str]:
        """
        What the User may approve: a revision returned, not one whose User
        approval was declined (Ops 6: "MUST NOT send that approval again").
        A revision whose agent approval was declined is the User's to approve:
        that is a new approval (readings v04-agent-approval-again).
        """
        return [r for r in op.revisions if (r, "user") not in op.declined]

    def agent_may_approve(self, op: MOperation, revision: str) -> bool:
        """Ops 5, 6 and readings v04-agent-approval-again: not after a decline, not twice, and not a revision that answered the agent's own approval."""
        return not op.declined and not op.agent_used and revision not in op.user_only

    @invariant()
    def operations_match_the_company(self) -> None:
        """The Company's operations are the model's: each performed or not, with as many revisions and approvals; and its performs."""
        if self.company is None:
            return
        state = self.server.state()
        got = {o["id"]: (o["state"], o["revision"], o["confirms"]) for o in state["operations"]}
        want = {op.id: ("succeeded" if op.performed is not None else "proposed", len(op.revisions), op.approvals) for op in self.operations}
        assert got == want, f"the Company's operations {got}, the model's {want}"
        assert state["performs"] == self.performs, f"the Company performed {state['performs']} actions, the model {self.performs} (Ops 7)"

    # ---- requests, by channel ----

    def api_request(self, ms: MSession, body: dict[str, Any], *, key: str | None = None, approval: str | None = None) -> Any:
        headers = {"Idempotency-Key": key or random_id("idk_")}
        if approval is not None:
            headers["Poppy-Approval"] = approval
        reply = self.poppy.resource(ms.session, "POST", f"{self.api_base}/orders/ord_7Hk2/exchanges", self.co, body=body, headers=headers)
        self.touch(ms, reply)
        return reply, headers["Idempotency-Key"]

    def mcp_exchange(self, ms: MSession, *, meta: Any = None, args: dict[str, Any] | None = None) -> Any:
        return self.mcp_call(ms, "tools/call", {"name": "exchange_item", "arguments": args or EXCHANGE_ARGS}, meta=meta)

    def prints_request(self, ms: MSession, order: dict[str, Any], *, key: str | None = None, approval: str | None = None, raw_key: bool = False) -> Any:
        headers: dict[str, str] = {} if raw_key and key is None else {"Idempotency-Key": key or random_id("idk_", 16)}
        if approval is not None:
            headers["Poppy-Approval"] = approval
        reply = self.poppy.resource(ms.session, "POST", f"{self.api_base}/prints", self.co, body=order, headers=headers)
        self.touch(ms, reply)
        return reply, headers.get("Idempotency-Key")

    def extension_required(self, reply: Any) -> None:
        """3.3, 7: 403 with `extension_required` and the extension's name in a JSON body (0.3 put them in `WWW-Authenticate`)."""
        expect(reply, 403, "extension_required")
        assert isinstance(reply.body, dict) and reply.body.get("extension") == "operations", reply.text
        assert "extension_required" not in reply.headers.get("www-authenticate", ""), reply.headers

    # ---- proposing (Ops 4) ----

    @precondition(lambda self: self.live())
    @rule(data=st.data())
    def propose_by_api(self, data: st.DataObject) -> None:
        """
        Ops 4: the exchange write is refused with `approval_required` and the
        operation. Signed out, a challenge; without the scope,
        `insufficient_scope` (7). A Session that doesn't declare the
        extension gets the exchange done (201), or `extension_required`
        naming it (3.3).
        """
        ms = data.draw(st.sampled_from(self.live()))
        if not self.declares_operations and not self.config["requireOperationsExtension"] and ms.account in self.exchanged:
            return  # the jacket was exchanged already: nothing left to ask for
        reply, key = self.api_request(ms, EXCHANGE)
        if ms.account is None:
            expect_challenge(reply, [WRITE])
        elif WRITE not in ms.token_scope:
            expect(reply, 403, "insufficient_scope")
        elif not self.declares_operations:
            if self.config["requireOperationsExtension"]:
                self.extension_required(reply)
            else:
                expect(reply, 201)
                self.performs += 1
                self.exchanged.add(ms.account)
        else:
            expect(reply, 403, "approval_required")
            op = self.returned(reply.body["operation"], kind="exchange", channel="api", request=json.dumps(EXCHANGE), ms=ms, account=ms.account)
            op.keys.append((ms, key))

    @precondition(lambda self: self.co.mcp and any(WRITE in s.token_scope for s in self.live()))
    @rule(data=st.data())
    def propose_by_mcp(self, data: st.DataObject) -> None:
        """Ops 4 at an MCP server: the tool's result is an error that carries the operation in `structuredContent`; never `extension_required` for one tool (Ops 2)."""
        ms = data.draw(st.sampled_from([s for s in self.live() if WRITE in s.token_scope]))
        if not self.declares_operations and not self.config["requireOperationsExtension"] and ms.account in self.exchanged:
            return
        reply = expect(self.mcp_exchange(ms), 200)
        result = reply.body["result"]
        if not self.declares_operations:
            assert "operation" not in json.dumps(result), "an operation to a Session that doesn't declare the extension (Ops 2)"
            if self.config["requireOperationsExtension"]:
                assert result.get("isError") is True, result
            else:
                self.performs += 1
                self.exchanged.add(ms.account)
            return
        assert result.get("isError") is True, f"done before it was approved (Ops 4): {result}"
        self.returned(result["structuredContent"]["operation"], kind="exchange", channel="mcp", request=json.dumps(EXCHANGE_ARGS), ms=ms, account=ms.account)

    def agent_used_account(self, conversation: MConversation, ms: MSession) -> None:
        """Ops 4 in a conversation: the Company Agent's answer carries the operation; read it to see it."""
        if not self.declares_operations:
            return
        before = len(conversation.log)
        self.read_as(conversation, ms, stream=False, from_start=False)
        carried = [ops_content(e["message"])["operation"] for e in conversation.log[before:] if e.get("type") == "message" and "operation" in ops_content(e["message"])]
        assert len(carried) == 1, f"the Company Agent used the account and returned {len(carried)} operations"
        self.returned(carried[0], kind="exchange", channel="conversation", request=conversation.id, ms=ms, account=ms.account, conversation=conversation)

    @precondition(lambda self: self.live())
    @rule(data=st.data())
    def upload_photo(self, data: st.DataObject) -> None:
        """The print shop: a photo, uploaded signed out or in, belongs to the Session."""
        ms = data.draw(st.sampled_from(self.live()))
        reply = self.poppy.upload_photo(ms.session, self.co, self.api_base, data.draw(st.sampled_from(["lake.jpg", "dog.jpg"])), PHOTO)
        self.touch(ms, reply)
        expect(reply, 201)
        self.photos.setdefault(ms, []).append(reply.body["id"])

    @precondition(lambda self: [s for s in self.live() if self.photos.get(s)])
    @rule(data=st.data())
    def order_prints(self, data: st.DataObject) -> None:
        """Ops 4, signed out or in: the order's terms come back as an operation; nothing is ordered until it is approved."""
        ms = data.draw(st.sampled_from([s for s in self.live() if self.photos.get(s)]))
        photos = data.draw(st.lists(st.sampled_from(self.photos[ms]), min_size=1, max_size=2, unique=True))
        order = {"email": "ada@example.com", "ship_to": SHIP_TO, "items": [{"photo_id": p, "copies": data.draw(st.integers(1, 3))} for p in photos]}
        reply, key = self.prints_request(ms, order)
        if not self.declares_operations:
            self.extension_required(reply)
            return
        expect(reply, 403, "approval_required")
        op = self.returned(reply.body["operation"], kind="prints", channel="prints", request=json.dumps(order), ms=ms, account=ms.account, order=order)
        op.keys.append((ms, key))

    # ---- approving (Ops 5, 6, 7) ----

    def approve_on_channel(self, op: MOperation, ms: MSession, given: Any, *, key: str | None = None, header: str | None = None) -> Any:
        """Send the request that returned `op` again with the approval `given`, on its channel. Returns the reply."""
        if op.channel in ("api", "prints"):
            value = header if header is not None else approval_header(given)
            if op.channel == "api":
                return self.api_request(ms, EXCHANGE, key=key, approval=value)[0]
            assert op.order is not None
            reply, used = self.prints_request(ms, op.order, key=key, approval=value)
            if reply.status == 201:
                op.performed_keys.append((used, ms.account))
            return reply
        if op.channel == "mcp":
            return self.mcp_exchange(ms, meta={APPROVAL_META: given})
        assert op.conversation is not None
        request_id = random_id("req_")
        ms.user.used.add(request_id)
        message = {"author": {"type": "agent"}, "extensions": {"operations": {"approval": given}}}
        reply = self.poppy.post_message(ms.session, self.co, request_id, json.dumps(message), op.conversation.id)
        self.touch(ms, reply)
        expect(reply, 202)
        self.accepted(op.conversation, ms, request_id, message)
        self.check_post(op.conversation, reply, None, None, "an approval")
        return reply

    def outcome(self, op: MOperation, ms: MSession, reply: Any) -> tuple[str, Any]:
        """What an approval led to on `op`'s channel: ("performed", response), ("operation", the operation returned) or ("declined", its members)."""
        if op.channel in ("api", "prints"):
            if reply.status == 201:
                return "performed", reply.body
            expect(reply, 403)
            if reply.error == "approval_declined":
                return "declined", reply.body
            expect(reply, 403, "approval_required")
            return "operation", reply.body["operation"]
        if op.channel == "mcp":
            expect(reply, 200)
            result = reply.body["result"]
            if result.get("isError"):
                content = result["structuredContent"]
                return ("declined", content) if "operation" not in content else ("operation", content["operation"])
            return "performed", result["structuredContent"]
        assert op.conversation is not None
        before = len(op.conversation.log)
        self.read_as(op.conversation, ms, stream=False, from_start=False)
        said = [e["message"] for e in op.conversation.log[before:] if e.get("type") == "message" and e["message"].get("role") == "company"]
        assert said, "the Company Agent said nothing about the approval (Ops 6)"
        content = ops_content(said[-1])
        if "operation" in content:
            return "operation", content["operation"]
        if "declined" in content:
            return "declined", content["declined"]
        assert said[-1]["text"].startswith("Done."), said[-1]
        return "performed", "done"

    def member_violations(self, ms: MSession, given: dict[str, Any]) -> list[str]:
        """
        What the Company records about an approval's own members (Ops 6),
        before it looks at the operation: `approver` that isn't `user` or
        `agent`, `approved_at` that isn't an Integer, `input_type` with
        `agent` or not a String, and a `reference` that is malformed or
        already approved something else for this User.
        """
        found = []
        approver = given.get("approver")
        if approver not in ("user", "agent"):
            found.append("approval.approver")
        if "approved_at" in given and not (isinstance(given["approved_at"], int) and not isinstance(given["approved_at"], bool)):
            found.append("approval.approved-at")
        if "input_type" in given and approver == "agent":
            found.append("approval.input-type-with-agent")
        if "input_type" in given and not isinstance(given["input_type"], str):
            found.append("approval.input-type")
        reference = given.get("reference")
        if reference is None:
            return found
        if not isinstance(reference, str) or not REFERENCE.fullmatch(reference):
            return found + ["approval.reference"]
        approved = f"{given['operation_id']} {given['revision']}"
        earlier = self.references.get((ms.user.user.user_id, reference))
        if earlier is not None and earlier != approved:
            found.append("approval.reference-reused")
        self.references[(ms.user.user.user_id, reference)] = approved
        return found

    def approve_and_check(self, op: MOperation, ms: MSession, given: dict[str, Any], *, key: str | None = None, header: str | None = None) -> str:
        """
        Send an approval of `op` from a Session that may approve it, and hold
        the answer to what the text says follows (Ops 6): performed already,
        the first response again (check 2, Ops 7); a revision returned for
        this request, performed, or declined for the Company's own reasons;
        anything else, a new revision. The mock's settings say which of its
        choices it makes: a new revision for the first approval when its
        terms moved, and declines of every approval or only the agent's.
        Returns what happened.
        """
        revision = given["revision"]
        agent = given.get("approver") == "agent"
        for violation in self.member_violations(ms, given):
            self.violation(violation)
        if op.performed is None:
            if (revision, "agent" if agent else "user") in op.declined:
                self.violation("approval.declined-resent")
            elif agent and op.declined:
                self.violation("approval.agent-after-decline")
            if agent and revision in op.user_only:
                self.violation("approval.agent-after-revision")
        op.approvals += 1
        if agent:
            op.agent_used = True
        kind, got = self.outcome(op, ms, self.approve_on_channel(op, ms, given, key=key, header=header))
        if op.performed is not None:
            assert kind == "performed", f"{op.id} was performed, but an approval of it got {kind}: {got} (Ops 7)"
            self.perform(op, got)
            return "first response again"
        if revision not in op.revisions:
            assert kind == "operation", f"an approval of a revision never returned got {kind}: {got} (Ops 6, check 3)"
            self.revised(got, op, revision, agent=agent)
            return "unknown revision"
        if self.config["reviseOnFirstApproval"] and len(op.revisions) == 1:
            assert kind == "operation", f"{kind}: {got}"
            self.revised(got, op, revision, agent=agent)
            return "terms moved"
        declines = self.config["declineApprovals"]
        if declines == "all" or (declines == "agent" and agent):
            assert kind == "declined", f"{kind}: {got}"
            self.check_declined(got, op, revision, with_error=op.channel != "conversation")
            op.declined[(revision, "agent" if agent else "user")] = given
            return "declined"
        assert kind == "performed", f"an approval of {op.id} revision {revision} wasn't performed: {kind} {got}"
        self.perform(op, got)
        op.last_approval = given
        return "performed"

    @precondition(lambda self: self.approvable())
    @rule(data=st.data())
    def approve(self, data: st.DataObject) -> None:
        """
        Ops 5, 6: the User approved a revision on our card, or the agent did
        on the User's standing instruction, once and only before any
        decline; the same request goes again with the approval, under a new
        Idempotency-Key. Once performed, a retry sends the same approval and
        gets the first response (Ops 7), whichever key it carries.
        """
        op, ms = data.draw(st.sampled_from(self.approvable()))
        if op.performed is not None and op.last_approval is not None:
            given = op.last_approval
        else:
            revision = data.draw(st.sampled_from(self.honest_revisions(op) or list(op.revisions)), label="revision approved")
            approvers = ["user", "agent"] if self.agent_may_approve(op, revision) else ["user"]
            approver = data.draw(st.sampled_from(approvers), label="approver")
            given = approval(op.id, revision, approver, input_type=data.draw(st.sampled_from(["tap", None])) if approver == "user" else None)
            if data.draw(st.booleans(), label="without approved_at"):
                del given["approved_at"]  # SHOULD, not MUST: the Company MUST NOT reject it for that (Ops 6)
        reached(f"{op.channel}: {self.approve_and_check(op, ms, given)}")

    # ---- reject direction ----

    @precondition(lambda self: [op for op in self.operations if op.channel == "api" and op.performed is None])
    @rule(data=st.data())
    def approval_from_someone_else(self, data: st.DataObject) -> None:
        """
        An approval from a Session that may not approve the operation is no
        approval (Ops 6, check 1): the Company answers as for the request
        alone, with that Session's own operation.
        """
        op = data.draw(st.sampled_from([o for o in self.operations if o.channel == "api" and o.performed is None]))
        others = [s for s in self.live() if WRITE in s.token_scope and not self.can_approve(op, s)]
        assume(others)
        ms = data.draw(st.sampled_from(others))
        given = approval(op.id, op.latest, "user")
        assert not self.member_violations(ms, given)
        reply, _ = self.api_request(ms, EXCHANGE, approval=approval_header(given))
        expect(reply, 403, "approval_required")
        assert reply.body["operation"]["operation_id"] != op.id, "an approval from someone who may not approve it was used (Ops 3)"
        self.returned(reply.body["operation"], kind="exchange", channel="api", request=json.dumps(EXCHANGE), ms=ms, account=ms.account)

    @precondition(lambda self: [(o, s) for o, s in self.approvable(honest=False) if o.performed is None and o.channel in ("api", "mcp", "prints")])
    @rule(data=st.data())
    def approval_that_cannot_be_used(self, data: st.DataObject) -> None:
        """
        Ops 6, check 3: an approval naming a revision the Company never
        returned, or sent with a request other than the one that returned the
        operation, gets a new revision, not the action.
        """
        op, ms = data.draw(st.sampled_from([(o, s) for o, s in self.approvable(honest=False) if o.performed is None and o.channel in ("api", "mcp", "prints")]))
        flaw = data.draw(st.sampled_from(["unknown revision", "changed request"] if op.channel != "prints" else ["unknown revision"]))
        named = random_id("rev_") if flaw == "unknown revision" else data.draw(st.sampled_from(self.honest_revisions(op) or list(op.revisions)))
        given = approval(op.id, named, "user")
        for violation in self.member_violations(ms, given):
            self.violation(violation)
        if (named, "user") in op.declined:
            self.violation("approval.declined-resent")
        op.approvals += 1
        if op.channel == "api":
            body = EXCHANGE if flaw == "unknown revision" else EXCHANGE | {"replacement_sku": data.draw(st.sampled_from(["stormline-insulated-l", "stormline-m"]))}
            reply, _ = self.api_request(ms, body, approval=approval_header(given))
            expect(reply, 403, "approval_required")
            got = reply.body["operation"]
        elif op.channel == "mcp":
            args = EXCHANGE_ARGS if flaw == "unknown revision" else EXCHANGE_ARGS | {"replacement_sku": "stormline-insulated-l"}
            reply = expect(self.mcp_exchange(ms, meta={APPROVAL_META: given}, args=args), 200)
            assert reply.body["result"].get("isError") is True, reply.body
            got = reply.body["result"]["structuredContent"]["operation"]
        else:
            assert op.order is not None
            reply, _ = self.prints_request(ms, op.order, approval=approval_header(given))
            expect(reply, 403, "approval_required")
            got = reply.body["operation"]
        self.revised(got, op, named, agent=False)
        reached(f"{op.channel}: {flaw}")

    def first_keys(self) -> list[tuple[MOperation, MSession]]:
        return [(o, s) for o, s in self.approvable() if o.channel in ("api", "prints") and any(k[0] is s for k in o.keys)]

    @precondition(lambda self: self.first_keys())
    @rule(data=st.data())
    def approval_reusing_the_first_key(self, data: st.DataObject) -> None:
        """
        Reject: the approved request is a new request, so it takes a new
        Idempotency-Key (Ops 6); reusing the first request's is recorded. The
        mock still checks the approval. Each first key is reused once here:
        after that the Company may hold the approved response under it.
        """
        op, ms = data.draw(st.sampled_from(self.first_keys()))
        key = data.draw(st.sampled_from([k for s, k in op.keys if s is ms]))
        op.keys.remove((ms, key))
        given = op.last_approval if op.performed is not None and op.last_approval is not None else approval(op.id, self.honest_revisions(op)[-1] if self.honest_revisions(op) else op.latest, "user")
        self.violation("approval.idempotency-key-reused")
        reached(f"{op.channel} with the first key: {self.approve_and_check(op, ms, given, key=key)}")

    @precondition(lambda self: [(o, s) for o, s in self.approvable() if o.channel == "api" and o.performed is None])
    @rule(data=st.data())
    def malformed_approval_header(self, data: st.DataObject) -> None:
        """
        Reject: `Poppy-Approval` is an RFC 9651 Dictionary with
        `operation_id` and `revision` Strings (Ops 6). Anything else is
        recorded and ignored: the request is answered as without one.
        """
        op, ms = data.draw(st.sampled_from([(o, s) for o, s in self.approvable() if o.channel == "api" and o.performed is None]))
        header = data.draw(
            st.sampled_from(
                [
                    f"operation_id={op.id}, revision={op.latest}",
                    f'operation_id="{op.id}"',
                    f'"{op.id}"',
                    f'operation_id="{op.id}", revision=1',
                    f'operation_id="{op.id}" revision="{op.latest}"',
                    f'{{"operation_id": "{op.id}", "revision": "{op.latest}"}}',
                ]
            )
        )
        reply, _ = self.api_request(ms, EXCHANGE, approval=header)
        expect(reply, 403, "approval_required")
        self.returned(reply.body["operation"], kind="exchange", channel="api", request=json.dumps(EXCHANGE), ms=ms, account=ms.account)
        self.violation("approval.header")

    @precondition(lambda self: [(o, s) for o, s in self.approvable() if o.channel == "api" and o.performed is None and self.honest_revisions(o)])
    @rule(data=st.data())
    def malformed_approval_members(self, data: st.DataObject) -> None:
        """
        Reject: an approval whose own members break Ops 6: no `approver`, or
        one that isn't `user` or `agent`; `approved_at` that isn't an
        Integer; `input_type` with `agent`, or not a String; a `reference`
        that isn't 1 to 256 URL-safe base64 characters. Each is recorded, and
        the approval is checked as usual: the Company MUST NOT reject it for
        an optional member.
        """
        op, ms = data.draw(st.sampled_from([(o, s) for o, s in self.approvable() if o.channel == "api" and o.performed is None and self.honest_revisions(o)]))
        revision = data.draw(st.sampled_from(self.honest_revisions(op)))
        flaw = data.draw(st.sampled_from(["no approver", "approver", "approved_at", "input_type with agent", "input_type", "reference"]))
        agent_ok = self.agent_may_approve(op, revision)
        if flaw == "input_type with agent":
            assume(agent_ok)
        given = approval(op.id, revision, "agent" if flaw == "input_type with agent" else "user")
        if flaw == "no approver":
            del given["approver"]
        elif flaw == "approver":
            given["approver"] = data.draw(st.sampled_from(["User", "person", "assistant", "both"]))
        elif flaw == "approved_at":
            given["approved_at"] = data.draw(st.sampled_from(["1700000000", "2026-11-12T10:00:00Z"]))
        elif flaw == "input_type with agent":
            given["input_type"] = "tap"
        elif flaw == "input_type":
            given["input_type"] = data.draw(st.sampled_from([1, 0, 42]))
        else:
            given["reference"] = data.draw(st.sampled_from(["a b", "apr/1", "x" * 257, "ref!"]))
        reached(f"approval member {flaw}: {self.approve_and_check(op, ms, given)}")

    @precondition(lambda self: [(o, s) for o, s in self.approvable(honest=False) if o.channel == "api" and o.performed is None and self.honest_revisions(o) and self.references_of(o)])
    @rule(data=st.data())
    def reference_reused(self, data: st.DataObject) -> None:
        """Reject: a `reference` this User's agent sent with another approval (Ops 6: "unique among the User's approvals"); recorded, and checked as usual."""
        op, ms = data.draw(st.sampled_from([(o, s) for o, s in self.approvable(honest=False) if o.channel == "api" and o.performed is None and self.honest_revisions(o) and self.references_of(o)]))
        reference, _ = data.draw(st.sampled_from(self.references_of(op)))
        revision = data.draw(st.sampled_from(self.honest_revisions(op)))
        assume(self.references[(ms.user.user.user_id, reference)] != f"{op.id} {revision}")
        given = approval(op.id, revision, "user", reference=reference)
        reached(f"reference reused: {self.approve_and_check(op, ms, given)}")

    def references_of(self, op: MOperation) -> list[tuple[str, str]]:
        return [(ref, approved) for (user, ref), approved in self.references.items() if user == op.user.user.user_id]

    def declined_ops(self) -> list[tuple[MOperation, MSession]]:
        return [(o, s) for o, s in self.approvable(honest=False) if o.performed is None and o.declined]

    @precondition(lambda self: self.declined_ops())
    @rule(data=st.data())
    def declined_approval_again(self, data: st.DataObject) -> None:
        """Reject: a declined approval sent again (Ops 6: MUST NOT); recorded, and declined again."""
        op, ms = data.draw(st.sampled_from(self.declined_ops()))
        declined = data.draw(st.sampled_from(list(op.declined)))
        reached(f"{op.channel}: declined {declined[1]} approval again, {self.approve_and_check(op, ms, op.declined[declined])}")

    @precondition(lambda self: self.declined_ops())
    @rule(data=st.data())
    def agent_after_decline(self, data: st.DataObject) -> None:
        """
        Reject: after a decline, the agent approves the action again itself
        (Ops 6: MUST NOT "approve a new revision for the same action without
        asking the User"), a revision it returned or one it never did.
        Recorded, and checked as usual.
        """
        op, ms = data.draw(st.sampled_from(self.declined_ops()))
        revision = data.draw(st.sampled_from(self.honest_revisions(op) + [random_id("rev_")]))
        given = approval(op.id, revision, "agent")
        reached(f"{op.channel}: agent after a decline, {self.approve_and_check(op, ms, given)}")

    def answered_agent(self) -> list[tuple[MOperation, MSession]]:
        return [(o, s) for o, s in self.approvable(honest=False) if o.performed is None and o.user_only - {r for r, _ in o.declined}]

    @precondition(lambda self: self.answered_agent())
    @rule(data=st.data())
    def agent_approves_its_answer(self, data: st.DataObject) -> None:
        """Reject: the agent approves a revision that answered its own approval (Ops 5: MUST NOT "on the same instruction"); recorded, and checked as usual."""
        op, ms = data.draw(st.sampled_from(self.answered_agent()))
        revision = data.draw(st.sampled_from([r for r in op.revisions if r in op.user_only and r not in {d for d, _ in op.declined}]))
        given = approval(op.id, revision, "agent")
        reached(f"{op.channel}: agent approves its answer, {self.approve_and_check(op, ms, given)}")

    @precondition(lambda self: [(o, s) for o, s in self.approvable() if o.channel == "mcp" and o.performed is None])
    @rule(data=st.data())
    def malformed_mcp_approval(self, data: st.DataObject) -> None:
        """Reject: the approval in `_meta` is an object with `operation_id` and `revision` strings (Ops 6); else recorded, and no approval."""
        op, ms = data.draw(st.sampled_from([(o, s) for o, s in self.approvable() if o.channel == "mcp" and o.performed is None]))
        given = data.draw(st.sampled_from([op.id, [op.id, op.latest], {"operation_id": op.id}, {"operation_id": op.id, "revision": 1}, None]))
        reply = expect(self.mcp_exchange(ms, meta={APPROVAL_META: given}), 200)
        assert reply.body["result"].get("isError") is True, reply.body
        self.returned(reply.body["result"]["structuredContent"]["operation"], kind="exchange", channel="mcp", request=json.dumps(EXCHANGE_ARGS), ms=ms, account=ms.account)
        self.violation("approval.mcp-meta")

    @precondition(lambda self: [(o, s) for o, s in self.approvable() if o.channel == "conversation" and o.performed is None])
    @rule(data=st.data())
    def malformed_message_approval(self, data: st.DataObject) -> None:
        """Reject: a message's `approval` is an object with `operation_id` and `revision` strings (Ops 6); else recorded, and nothing done."""
        op, ms = data.draw(st.sampled_from([(o, s) for o, s in self.approvable() if o.channel == "conversation" and o.performed is None]))
        assert op.conversation is not None
        given = data.draw(st.sampled_from([op.id, [op.id, op.latest], {"operation_id": op.id}, {"revision": op.latest}]))
        request_id = random_id("req_")
        ms.user.used.add(request_id)
        message = {"author": {"type": "agent"}, "extensions": {"operations": {"approval": given}}}
        reply = self.poppy.post_message(ms.session, self.co, request_id, json.dumps(message), op.conversation.id)
        self.touch(ms, reply)
        expect(reply, 202)
        self.accepted(op.conversation, ms, request_id, message)
        self.violation("approval.message")

    @precondition(lambda self: [(o, s) for o, s in self.approvable(honest=False) if o.kind == "exchange" and o.performed is None and o.account in self.exchanged and self.honest_revisions(o)])
    @rule(data=st.data())
    def second_exchange_of_the_item(self, data: st.DataObject) -> None:
        """Reject: the User approving a second exchange of an item already exchanged; the mock performs it and records it."""
        op, ms = data.draw(st.sampled_from([(o, s) for o, s in self.approvable(honest=False) if o.kind == "exchange" and o.performed is None and o.account in self.exchanged and self.honest_revisions(o)]))
        given = approval(op.id, self.honest_revisions(op)[-1], "user")
        reached(f"{op.channel}: second exchange, {self.approve_and_check(op, ms, given)}")

    @precondition(lambda self: self.declares_operations and [s for s in self.live() if self.photos.get(s)])
    @rule(data=st.data())
    def prints_without_a_key(self, data: st.DataObject) -> None:
        """Reject: the order's description makes `Idempotency-Key` required (Guides: send one on writes that take one)."""
        ms = data.draw(st.sampled_from([s for s in self.live() if self.photos.get(s)]))
        order = {"email": "ada@example.com", "ship_to": SHIP_TO, "items": [{"photo_id": self.photos[ms][0], "copies": 1}]}
        reply, _ = self.prints_request(ms, order, raw_key=True)
        expect(reply, 400, "idempotency_key_required")
        self.violation("idempotency.key-missing")

    def performed_retries(self) -> list[tuple[MOperation, str]]:
        """
        A performed order's keys that its Session can send again within the
        record's scope: the agent, the User, and the account the key was sent
        under (Guides, "Retries"). Signing in to an account, or out of one,
        leaves that scope.
        """
        return [(o, key) for o in self.operations if o.session in self.live() for key, account in o.performed_keys if o.session.account == account]

    @precondition(lambda self: self.performed_retries())
    @rule(data=st.data())
    def prints_key_reused(self, data: st.DataObject) -> None:
        """
        A performed order's key, sent again in the record's scope: the same
        body gets the same response (Guides: retries); a different body is
        `idempotency_conflict`, and recorded.
        """
        op, key = data.draw(st.sampled_from(self.performed_retries()))
        assert op.order is not None and op.last_approval is not None
        ms = op.session
        changed = data.draw(st.booleans(), label="a different body")
        order = op.order | {"email": "grace@example.com"} if changed else op.order
        reply, _ = self.prints_request(ms, order, key=key, approval=approval_header(op.last_approval))
        if changed:
            expect(reply, 409, "idempotency_conflict")
            self.violation("idempotency.key-reused")
        else:
            expect(reply, 201)
            assert reply.body == op.performed, "a retry with the same key got another response"


class OperationsMachine(WarmUp, OperationsRules, Base, SessionRules, ConversationRules):
    CONFIG = OPS_CONFIGS
    DECLARES_OPERATIONS = st.booleans()

    def __init__(self, server: MockServer) -> None:
        super().__init__(server)
        self.init_operations()


def test_operations(mock_server: MockServer) -> None:
    run_state_machine_as_test(lambda: OperationsMachine(mock_server))
