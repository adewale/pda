"""Counterexamples for the model's oracles, without a Company process."""
from types import SimpleNamespace as NS

import pytest
from hypothesis import given, settings, strategies as st

from machine import READ, ApiRules, Base
from test_mcp_browsing import BrowsingRules
from test_operations import MOperation, OperationsRules


OPEN = ("none", "agent", False)


@pytest.mark.parametrize("context", [{}, {"user_available": False}, {"locale": "en-GB", "time_zone": "Europe/London"}])
def test_message_oracle_preserves_context_and_rejects_loss_or_change(context):
    """8.3, 8.5: the event contains the message as sent, including context-only messages, with its request's id as its id."""
    sent = {"author": {"type": "agent"}, "context": context}
    echoed = sent | {"role": "user", "id": "req_context"}
    conversation = NS(sent=["req_context"], messages=[sent], log=[{"type": "message", "message": echoed}], state=OPEN)
    model = NS(log_checks=lambda conversation: OPEN)
    Base.full_read_checks(model, conversation, None)
    for wrong in [
        {k: v for k, v in echoed.items() if k != "context"},
        echoed | {"context": {"user_available": "changed"}},
        echoed | {"id": "msg_other"},
        {k: v for k, v in echoed.items() if k != "id"},
    ]:
        conversation.log = [{"type": "message", "message": wrong}]
        with pytest.raises(AssertionError):
            Base.full_read_checks(model, conversation, None)


@pytest.mark.parametrize("read", [
    {"handoff": "pending", "responder": "human", "closed": False, "working": False},
    {"handoff": "pending", "responder": "agent", "closed": True, "working": False},
    {"handoff": "none", "responder": "agent", "closed": True, "working": True},
    {"handoff": "none", "responder": "agent", "closed": False},
    {"handoff": "queued", "responder": "agent", "closed": False, "working": False},
    {"status": "idle", "handoff": "none", "responder": "agent", "closed": False, "working": False},
    {"handoff": "none", "responder": "agent", "closed": False, "working": False, "_model": ("pending", "agent", False)},
])
def test_state_oracle_rejects_what_8_7_rules_out(read):
    """8.5, 8.7: four state fields, values the text gives, pending only with the agent, closed with nothing pending or working; and the model's."""
    model_state = read.pop("_model", (read.get("handoff"), read.get("responder"), read.get("closed")))
    with pytest.raises(AssertionError):
        Base.check_state(NS(), NS(state=model_state), read, "test")
    Base.check_state(NS(), NS(state=OPEN), {"handoff": "none", "responder": "agent", "closed": False, "working": False}, "test")


def message_event(message, event_id="evt_m"):
    return {"id": event_id, "type": "message", "created_at": "2026-11-12T00:00:00Z", "message": message}


@pytest.mark.parametrize("log", [
    # A state event that changes nothing.
    [{"id": "evt_1", "type": "state", "created_at": "t", "handoff": "none", "responder": "agent", "closed": False}],
    # A person's message with as_of_request (8.4: MUST NOT), and one before a person joined.
    [{"id": "evt_1", "type": "state", "created_at": "t", "handoff": "none", "responder": "human", "closed": False},
     message_event({"role": "company", "author": {"type": "human"}, "as_of_request": "req_1", "text": "Hi"})],
    [message_event({"role": "company", "author": {"type": "human"}, "text": "Hi"})],
    # as_of_request naming a request this conversation never accepted, and as_of_cursor from the Company.
    [message_event({"role": "company", "author": {"type": "agent"}, "as_of_request": "req_other", "text": "Hi"})],
    [message_event({"role": "company", "author": {"type": "agent"}, "as_of_cursor": "evt_0", "text": "Hi"})],
    # 0.3's state, and a message after the conversation closed.
    [{"id": "evt_1", "type": "state", "created_at": "t", "status": "queued", "responder": "agent"}],
    [{"id": "evt_1", "type": "state", "created_at": "t", "handoff": "none", "responder": "agent", "closed": True},
     message_event({"role": "company", "author": {"type": "agent"}, "text": "Bye"})],
])
def test_log_oracle_rejects_what_8_4_and_8_7_rule_out(log):
    conversation = NS(log=log, requests=["req_1"], requested=[], children=[])
    with pytest.raises(AssertionError):
        Base.log_checks(NS(declares_operations=True), conversation)
    conversation.log = [message_event({"role": "company", "author": {"type": "agent"}, "as_of_request": "req_1", "text": "Hi"})]
    assert Base.log_checks(NS(declares_operations=True), conversation) == OPEN


def test_who_may_approve_an_operation():
    """Ops 3: signed in, any of the User's Sessions signed in to its account; signed out, any of their Sessions signed out."""
    model = OperationsRules()
    model.init_operations()
    ada, grace = NS(), NS()
    own = NS(user=ada, account=None, ended=False)
    other_session = NS(user=ada, account=None, ended=False)
    signed_in = NS(user=ada, account="acct_ada", ended=False)
    other_user = NS(user=grace, account="acct_ada", ended=False)
    signed_out_op = MOperation("prt_1", "prints", "prints", "{}", ada, None, own)
    account_op = MOperation("exc_1", "exchange", "api", "{}", ada, "acct_ada", own)
    assert model.can_approve(signed_out_op, own) and model.can_approve(signed_out_op, other_session)
    assert not model.can_approve(signed_out_op, signed_in), "signed in since: it isn't the account's"
    assert model.can_approve(account_op, signed_in) and not model.can_approve(account_op, own)
    assert not model.can_approve(account_op, other_user), "another User signed in to the same account"
    signed_in.ended = True
    assert not model.can_approve(account_op, signed_in)


def test_an_approval_again_must_get_the_first_response():
    """Ops 7: the second approval's response is compared with the first, and a different one fails."""
    model = OperationsRules()
    model.init_operations()
    model.violation = lambda violation_id: None
    op = MOperation("exc_1", "exchange", "api", "{}", NS(), "acct_ada", NS())
    model.perform(op, {"exchange": {"exchange_id": "exc_1"}})
    model.perform(op, {"exchange": {"exchange_id": "exc_1"}})
    assert model.performs == 1
    with pytest.raises(AssertionError):
        model.perform(op, {"exchange": {"exchange_id": "exc_2"}})


@pytest.mark.parametrize("members,with_error", [
    ({"error": "approval_declined", "operation_id": "exc_1", "revision": "rev_2", "reason": "No."}, True),
    ({"error": "approval_declined", "operation_id": "exc_2", "revision": "rev_1", "reason": "No."}, True),
    ({"operation_id": "exc_1", "revision": "rev_1", "reason": "No."}, True),
    ({"error": "approval_declined", "operation_id": "exc_1", "revision": "rev_1", "reason": "No."}, False),
    ({"error": "approval_declined", "operation_id": "exc_1", "revision": "rev_1"}, True),
    ({"error": "approval_declined", "operation_id": "exc_1", "revision": "rev_1", "reason": "No.", "operation": {}}, True),
    ({"error": "approval_declined", "operation_id": "exc_1", "revision": "rev_1", "reason": "No.", "alternative": {}}, True),
])
def test_decline_oracle(members, with_error):
    """Ops 6: a decline names the operation and the revision approved, has a reason, `error` only outside conversations, and no new operation."""
    op = MOperation("exc_1", "exchange", "api", "{}", NS(), "acct_ada", NS())
    with pytest.raises(AssertionError):
        OperationsRules().check_declined(members, op, "rev_1", with_error=with_error)
    OperationsRules().check_declined({"error": "approval_declined", "operation_id": "exc_1", "revision": "rev_1", "reason": "No."}, op, "rev_1", with_error=True)
    OperationsRules().check_declined({"operation_id": "exc_1", "revision": "rev_1", "reason": "No."}, op, "rev_1", with_error=False)


@pytest.mark.parametrize("change,expected", [
    ({}, []),
    ({"approver": None}, ["approval.approver"]),
    ({"approver": "User"}, ["approval.approver"]),
    ({"approved_at": "1700000000"}, ["approval.approved-at"]),
    ({"approver": "agent"}, ["approval.input-type-with-agent"]),
    ({"input_type": 3}, ["approval.input-type"]),
    ({"reference": "a b"}, ["approval.reference"]),
])
def test_approval_member_oracle(change, expected):
    """Ops 6: what the Company records about an approval's own members, before it looks at the operation."""
    model = OperationsRules()
    model.init_operations()
    ms = NS(user=NS(user=NS(user_id="usr_ada")))
    given = {"operation_id": "exc_1", "revision": "rev_1", "approver": "user", "approved_at": 1700000000, "input_type": "tap", "reference": "apr_1"}
    given = {k: v for k, v in (given | change).items() if v is not None}
    assert model.member_violations(ms, given) == expected


def test_a_reference_names_one_approval():
    """Ops 6: the same approval sent again keeps its reference; another approval with it is recorded."""
    model = OperationsRules()
    model.init_operations()
    ms = NS(user=NS(user=NS(user_id="usr_ada")))
    first = {"operation_id": "exc_1", "revision": "rev_1", "approver": "user", "reference": "apr_1"}
    assert model.member_violations(ms, first) == []
    assert model.member_violations(ms, first) == []
    assert model.member_violations(ms, first | {"revision": "rev_2"}) == ["approval.reference-reused"]
    assert model.member_violations(NS(user=NS(user=NS(user_id="usr_grace"))), first | {"revision": "rev_3"}) == []


@pytest.mark.parametrize("body", [
    {}, {"orders": []},
    {"orders": [{"order_id": "ord_7Hk2", "account": "acct_grace"}]},
])
@settings(max_examples=1, database=None)
@given(data=st.data())
def test_orders_oracle_rejects_missing_fixture_or_wrong_owner(body, data):
    ms = NS(session=NS(), account="acct_ada", token_scope={READ})
    reply = NS(status=200, error=None, body=body, text=str(body))
    model = NS(live=lambda: [ms], api_ops=[("/orders", [READ])], touch=lambda *args: None,
               api_base="https://api.company.test", co=NS(), poppy=NS(resource=lambda *args: reply))
    with pytest.raises(AssertionError):
        ApiRules.call_api(model, data)
    reply.body = {"orders": [{"order_id": "ord_7Hk2", "account": "acct_ada"}]}
    ApiRules.call_api(model, data)


@pytest.mark.parametrize("field,value", [("account", "acct_grace"), ("signedIn", False), ("userId", "usr_other"), ("ended", True), ("sid", "sid_other")])
def test_session_oracle_compares_each_identity_and_state_field(field, value):
    ms = NS(session=NS(sid="sid_1"), user=NS(user=NS(user_id="usr_ada")), seen=True, ended=False, remote_account="acct_ada")
    state = {"sid": "sid_1", "ended": False, "account": "acct_ada", "signedIn": True, "userId": "usr_ada"}
    model = NS(company=True, server=NS(state=lambda: {"sessions": [state]}), other_sids=set(), all_sessions=lambda: [ms])
    Base.sessions_match_the_model(model)
    state[field] = value
    with pytest.raises(AssertionError):
        Base.sessions_match_the_model(model)


@pytest.mark.parametrize("body", [
    '<p>Signed in as acct_ada</p><li>Order ord_7Hk2</li><form id="address">private address</form>',
    '<p>Signed out</p><li>Order ord_7Hk2</li>',
    '<p>Signed out</p><form id="address">private address</form>',
])
@settings(max_examples=1, database=None)
@given(data=st.data())
def test_signed_out_browser_oracle_rejects_private_content(body, data):
    browser = NS(get=lambda url: NS(status_code=200, text=body))
    ms = NS(browser=browser, joined=True, ended=False, joined_as=None, joined_grant=None, joined_scope=frozenset())
    model = NS(all_sessions=lambda: [ms], unscoped=lambda: False)
    with pytest.raises(AssertionError):
        BrowsingRules.browse(model, data)
    browser.get = lambda url: NS(status_code=200, text="<p>Signed out</p><p>Sign in to continue.</p>")
    BrowsingRules.browse(model, data)
