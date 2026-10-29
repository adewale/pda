"""Counterexamples for the model's oracles, without a Company process."""
from types import SimpleNamespace as NS

import pytest
from hypothesis import given, settings, strategies as st

from machine import READ, ApiRules, Base
from test_mcp_browsing import BrowsingRules
from test_operations import MOperation, OperationsRules


@pytest.mark.parametrize("context", [{}, {"user_available": False}, {"locale": "en-GB", "time_zone": "Europe/London"}])
def test_message_oracle_preserves_context_and_rejects_loss_or_change(context):
    """8.5: the event contains the message as sent, including context-only messages."""
    sent = {"id": "msg_context", "author": {"type": "agent"}, "context": context}
    echoed = sent | {"role": "user"}
    conversation = NS(sent=[sent["id"]], messages=[sent], log=[{"type": "message", "message": echoed}])
    model = NS(log_checks=lambda conversation: None)
    Base.full_read_checks(model, conversation, None)
    for wrong in [{k: v for k, v in echoed.items() if k != "context"}, echoed | {"context": {"user_available": "changed"}}]:
        conversation.log = [{"type": "message", "message": wrong}]
        with pytest.raises(AssertionError):
            Base.full_read_checks(model, conversation, None)


def test_who_may_approve_an_operation():
    """Ops 3: signed in, any of the User's Sessions signed in to its account; signed out, only its own Session."""
    model = OperationsRules()
    model.init_operations()
    ada, grace = NS(), NS()
    own = NS(user=ada, account=None, ended=False)
    other_session = NS(user=ada, account=None, ended=False)
    signed_in = NS(user=ada, account="acct_ada", ended=False)
    other_user = NS(user=grace, account="acct_ada", ended=False)
    signed_out_op = MOperation("prt_1", "prints", "prints", "{}", ada, None, own)
    account_op = MOperation("exc_1", "exchange", "api", "{}", ada, "acct_ada", own)
    assert model.can_approve(signed_out_op, own) and not model.can_approve(signed_out_op, other_session)
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
    model = NS(all_sessions=lambda: [ms])
    with pytest.raises(AssertionError):
        BrowsingRules.browse(model, data)
    browser.get = lambda url: NS(status_code=200, text="<p>Signed out</p><p>Sign in to continue.</p>")
    BrowsingRules.browse(model, data)
