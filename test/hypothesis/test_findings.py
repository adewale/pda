"""
Where the mock Company departed from the 0.4 text (11 November), found by the
0.4 port and fixed on 12 November: each a short script that asserts what the
text says, kept as a regression test beside the machines, which now model
each case too. The README lists them; `test/mock-company.test.ts` has the
same cases for CI.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

import httpx
import pytest

from machine import OPERATIONS, READ
from mock_server import DOMAIN, SUFFIX, MockServer
from poppy_client import BROWSER_SIGN_IN, Browser, Clock, Company, LocalTransport, PersonalAgent, Poppy, Session, User, approval, random_id
from test_operations import PHOTO, SHIP_TO


class Harness:
    """One Personal Agent, one User and one Session at a freshly reset mock."""

    def __init__(self, server: MockServer, knobs: dict[str, Any], *, extensions: dict[str, str] | None = None) -> None:
        self.server = server
        self.transport = LocalTransport(server.company_port, SUFFIX, Clock())
        self.http = httpx.Client(transport=self.transport, timeout=30)
        self.agent = PersonalAgent()
        self.poppy = Poppy(self.agent, self.http)
        server.reset(knobs)
        server.serve_client_documents(self.agent.documents())
        self.co: Company = self.poppy.discover(DOMAIN)
        self.user = User()
        self.session = Session(self.user, extensions=dict(extensions or {}))
        self.fixture = server.hook("fixture")

    def close(self) -> None:
        self.http.close()

    def violations(self) -> list[str]:
        return [v["id"] for v in self.server.violations()]

    def sign_in(self, scopes: list[str]) -> None:
        """Device Sign-In (4.3), the User granting exactly `scopes`."""
        start = self.poppy.device_start(self.co, self.co.offered("device"))
        assert start.status == 200, start.text
        self.server.hook("approve_device", user_code=start.body["user_code"], account=self.fixture["accounts"][0], scopes=scopes)
        reply = self.poppy.device_poll(self.co, self.user.dpop_key, start.body["device_code"])
        assert reply.status == 200, reply.text
        self.session.sign_in(reply.body, self.user.dpop_key)

    def start(self, text: str = "Hello") -> tuple[str, str]:
        """A new conversation (8.3): its id and the request id that started it."""
        request_id = random_id("req_")
        reply = self.poppy.post_message(self.session, self.co, request_id, json.dumps({"author": {"type": "agent"}, "text": text}), None)
        assert reply.status == 201, reply.text
        return reply.body["conversation_id"], request_id

    def direct(self, parent: str) -> str:
        """A Direct Conversation linked to `parent` (8.10), the User's words in it."""
        reply = self.poppy.post_message(self.session, self.co, random_id("req_"), json.dumps({"author": {"type": "human"}, "text": "Hi"}), None, parent=parent)
        assert reply.status == 201, reply.text
        return reply.body["conversation_id"]

    def events(self, conversation: str) -> list[dict[str, Any]]:
        reply, events, _ = self.poppy.read_events(self.session, self.co, conversation, None, stream=False)
        assert reply.status == 200 and events is not None, reply.text
        return events


@pytest.fixture
def harness(mock_server: MockServer) -> Iterator[Any]:
    made: list[Harness] = []

    def make(knobs: dict[str, Any] | None = None, **options: Any) -> Harness:
        h = Harness(mock_server, knobs or {}, **options)
        made.append(h)
        return h

    yield make
    for h in made:
        h.close()


# ---- 8.3, 8.4: a refused request isn't accepted (MOCK-1) ----


def test_a_refused_handoff_retried_is_refused_again(harness: Any) -> None:
    """
    8.3: "If the Company has already accepted a request with that ID, path,
    and body, it returns the original response." A handoff refused with
    `conversation_closed` wasn't accepted, so the same request again is
    refused again.
    """
    h = harness()
    cid, _ = h.start()
    assert h.poppy.close_conversation(h.session, h.co, cid, random_id("req_")).status == 202
    request_id = random_id("req_")
    first = h.poppy.handoff(h.session, h.co, cid, request_id)
    assert (first.status, first.error) == (409, "conversation_closed"), first.text
    again = h.poppy.handoff(h.session, h.co, cid, request_id)
    assert (again.status, again.error) == (409, "conversation_closed"), f"a refused handoff retried: {again.status} {again.text}"


def test_as_of_request_names_only_what_was_taken_into_account(harness: Any) -> None:
    """
    8.4: `as_of_request` is "the ID of the latest message, handoff request,
    or handoff cancel from the Personal Agent that it took into account". A
    handoff refused with `direct_conversation_open` (8.10) wasn't, so the
    message the Company Agent sends when no one is available doesn't name it.
    """
    h = harness()
    cid, _ = h.start()
    accepted = random_id("req_")
    assert h.poppy.handoff(h.session, h.co, cid, accepted).status == 202
    h.direct(cid)
    refused = random_id("req_")
    reply = h.poppy.handoff(h.session, h.co, cid, refused)
    assert (reply.status, reply.error) == (409, "direct_conversation_open"), reply.text
    h.server.hook("staff_unavailable", conversation=cid, text="No one is free.")
    said = [e["message"] for e in h.events(cid) if e["type"] == "message" and e["message"].get("role") == "company"]
    assert said and said[-1].get("text") == "No one is free.", said
    assert said[-1].get("as_of_request") != refused, f"as_of_request names the refused handoff {refused}: {said[-1]}"


# ---- 8.10: a cancel to a parent with an open Direct Conversation (MOCK-2) ----


def test_cancel_to_a_parent_with_an_open_direct_conversation(harness: Any) -> None:
    """8.10: "messages, handoff requests, and handoff cancels to the parent return `direct_conversation_open`"."""
    h = harness()
    cid, _ = h.start()
    assert h.poppy.handoff(h.session, h.co, cid, random_id("req_")).status == 202
    child = h.direct(cid)
    reply = h.poppy.cancel_handoff(h.session, h.co, cid, random_id("req_"))
    assert (reply.status, reply.error) == (409, "direct_conversation_open"), f"cancel to a parent: {reply.status} {reply.text}"
    assert reply.body.get("conversation_id") == child, reply.text


# ---- 8.3: `wait` on any POST (MOCK-3) ----


@pytest.mark.parametrize("path", ["handoff", "handoff/cancel", "close"])
def test_wait_on_a_handoff_cancel_or_close(harness: Any, path: str) -> None:
    """
    8.3: the agent "adds the `wait` query parameter to any POST", and the
    Company then "responds as a read", not with `{conversation_id}` alone.
    """
    h = harness()
    cid, _ = h.start()
    reply = h.poppy.conversation_post(h.session, h.co, f"/{cid}/{path}", random_id("req_"), wait=0)
    assert reply.status in (200, 202), reply.text
    assert isinstance(reply.body, dict) and isinstance(reply.body.get("events"), list), f"{path} with wait=0: {reply.text}"


# ---- Ops 6: the User approves after an agent's approval was declined (MOCK-5) ----


def test_the_user_approves_after_the_agents_approval_was_declined(harness: Any) -> None:
    """
    Ops 6: after a decline the agent "MUST NOT send that approval again" and
    "MUST NOT approve a new revision for the same action without asking the
    User" (readings v04-agent-approval-again). Asking the User is what's
    left: the User's approval is a new approval, not the declined one sent
    again, so it is performed and nothing is recorded.
    """
    h = harness({"declineApprovals": "agent", "requireOperationsExtension": True}, extensions=OPERATIONS)
    api_base = h.http.get(h.co.openapi).json()["servers"][0]["url"]
    photo = h.poppy.upload_photo(h.session, h.co, api_base, "lake.jpg", PHOTO)
    assert photo.status == 201, photo.text
    order = {"email": "ada@example.com", "ship_to": SHIP_TO, "items": [{"photo_id": photo.body["id"], "copies": 1}]}
    proposed = h.poppy.order_prints(h.session, h.co, api_base, order, random_id("idk_"))
    assert (proposed.status, proposed.error) == (403, "approval_required"), proposed.text
    op = proposed.body["operation"]
    declined = h.poppy.order_prints(h.session, h.co, api_base, order, random_id("idk_"), approval=approval(op["operation_id"], op["revision"], "agent"))
    assert (declined.status, declined.error) == (403, "approval_declined"), declined.text
    assert h.violations() == [], h.violations()
    approved = h.poppy.order_prints(h.session, h.co, api_base, order, random_id("idk_"), approval=approval(op["operation_id"], op["revision"], "user"))
    assert h.violations() == [], f"the User's approval was recorded: {h.violations()} ({approved.status} {approved.text[:200]})"
    assert approved.status == 201, approved.text


# ---- 8.3: request ids of invitations (MOCK-6) ----


def invitation(h: Harness) -> tuple[str, str]:
    """A conversation whose Company asked for the User (8.10): its id and the `user_requested` event's."""
    cid, _ = h.start()
    event = h.server.hook("request_user", conversation=cid, reason="To confirm the address.")["event"]
    return cid, event["id"] if isinstance(event, dict) else event


def test_an_invitations_request_id_reused_for_a_new_conversation(harness: Any) -> None:
    """8.3: `request_id_conflict` for "A request reused an ID that the Company accepted with a different path or body"."""
    h = harness()
    parent, event = invitation(h)
    request_id = random_id("req_")
    accepted = h.poppy.post_message(h.session, h.co, request_id, None, None, parent=parent, invitation=event)
    assert accepted.status == 201, accepted.text
    reused = h.poppy.post_message(h.session, h.co, request_id, json.dumps({"author": {"type": "agent"}, "text": "Hello"}), None)
    assert (reused.status, reused.error) == (409, "request_id_conflict"), f"an invitation's id reused: {reused.status} {reused.text}"


def test_the_same_id_without_the_invitation_is_a_conflict(harness: Any) -> None:
    """8.3: the same id with a different body (the invitation's event left out) is `request_id_conflict`, not a retry."""
    h = harness()
    parent, event = invitation(h)
    request_id = random_id("req_")
    message = json.dumps({"author": {"type": "human"}, "text": "I'm here."})
    accepted = h.poppy.post_message(h.session, h.co, request_id, message, None, parent=parent, invitation=event)
    assert accepted.status == 201, accepted.text
    other = h.poppy.post_message(h.session, h.co, request_id, message, None, parent=parent)
    assert (other.status, other.error) == (409, "request_id_conflict"), f"another body under the same id: {other.status} {other.text}"


# ---- 3.4: the same extensions, written differently (MOCK-7) ----


def test_the_same_extensions_written_differently(harness: Any) -> None:
    """
    3.4: a Session's requests declare the same version and extensions. The
    header is an RFC 9651 List, where `"operations";v="3"` and
    `"operations"; v="3"` are the same value.
    """
    h = harness(extensions=OPERATIONS)
    assert h.poppy.tasks(h.session, h.co).status == 200
    assert h.violations() == [], h.violations()
    reply = h.poppy.resource(h.session, "GET", h.co.tasks, h.co, token=None, extensions='"operations"; v="3"')
    assert reply.status == 200, reply.text
    assert h.violations() == [], f"the same extensions, written with a space: {h.violations()}"


# ---- 6: browser-sign-in with web.disabled (MOCK-8) ----


def test_a_disabled_website_offers_no_browser_sign_in(harness: Any) -> None:
    """
    6: "A Company that sets `web.disabled` MUST NOT list
    `browser_session_endpoint`", and "A Personal Agent requests
    `poppy:browser-sign-in` only from a Company that lists
    `browser_session_endpoint`". With `web.disabled`, the Company lists
    neither the endpoint nor the scope, and records a sign-in asking for it,
    whatever its `browserSession` knob says.
    """
    h = harness({"webDisabled": True, "browserSession": True})
    assert h.co.web_disabled and h.co.browser_session is None, h.co.document.get("web")
    listed = [str(s) for s in h.co.metadata.get("scopes_supported", [])] + list(h.co.resource_scopes)
    started = h.poppy.device_start(h.co, [BROWSER_SIGN_IN])
    assert BROWSER_SIGN_IN not in listed and "browser-sign-in.no-endpoint" in h.violations(), (
        f"web.disabled, yet scopes {listed}; a device start for {BROWSER_SIGN_IN}: {started.status}, recorded {h.violations()}"
    )


# ---- 3.1, 6: web.unscoped (MOCK-9) ----


def test_an_unscoped_website_gives_browser_sign_in_full_access(harness: Any) -> None:
    """
    3.1: `web.unscoped` is "`true` if the website doesn't apply the
    Company's other scopes, so `poppy:browser-sign-in` gives the account's
    full access there"; 6: such a website "treat[s] `poppy:browser-sign-in`
    as access to everything the account can do on the website".
    """
    h = harness({"browserSession": True, "webUnscoped": True})
    assert isinstance(h.co.document.get("web"), dict) and h.co.document["web"].get("unscoped") is True, h.co.document.get("web")
    h.sign_in([BROWSER_SIGN_IN])
    assert h.co.browser_session is not None
    browser = Browser(h.transport)
    try:
        _, code, action = browser.open_join(h.co.browser_session)
        assert code and action
        authorized = h.poppy.resource(h.session, "POST", f"{h.co.browser_session.rstrip('/')}/authorize", h.co, body={"code": code})
        assert authorized.status == 204, authorized.text
        assert browser.submit_join(action, code).status_code in (302, 303)
        address = browser.get(f"https://{DOMAIN}/account/address")
        assert "Signed in as " in address.text, address.text[:200]
        orders = browser.get(f"https://{DOMAIN}/orders")
    finally:
        browser.close()
    assert "ord_7Hk2" in orders.text, f"orders, signed in with {BROWSER_SIGN_IN} alone on an unscoped website (needs {READ} there): {orders.text[:200]}"
