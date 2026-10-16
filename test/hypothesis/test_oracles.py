"""Counterexamples for the model's oracles, without a Company process."""
from types import SimpleNamespace as NS

import pytest
from hypothesis import given, settings, strategies as st

from machine import ApiRules, Base
from test_mcp_browsing import BrowsingRules
from test_operations import OperationsRules


def test_pending_exchange_reserves_only_its_item_and_releases_it_on_cancellation():
    model = OperationsRules()
    model.init_operations()
    pending = NS(kind="exchange", account="acct_ada", state="in_progress", pending=True)
    other_user = NS(kind="exchange", account="acct_ada", state="proposed", pending=False)
    other_account = NS(kind="exchange", account="acct_grace", state="proposed", pending=False)
    prints = NS(kind="prints", account="acct_ada", state="proposed", pending=False)
    model.operations = [pending, other_user, other_account, prints]
    model.usable_pairs = lambda operations: [(op, None) for op in operations]
    # Retrying the pending confirm remains valid, as do independent business actions.
    assert model.confirmable() == [(pending, None), (other_account, None), (prints, None)]
    assert not model.item_available(other_user)  # also used by website confirmation
    pending.state, pending.pending = "cancelled", False
    assert model.item_available(other_user)
    assert (other_user, None) in model.confirmable()
    model.exchanged.add("acct_ada")
    assert not model.item_available(other_user)


@pytest.mark.parametrize("body", [
    {}, {"orders": []},
    {"orders": [{"order_id": "ord_7Hk2", "account": "acct_grace"}]},
])
@settings(max_examples=1, database=None)
@given(data=st.data())
def test_orders_oracle_rejects_missing_fixture_or_wrong_owner(body, data):
    ms = NS(session=NS(), account="acct_ada", token_scope={"poppy:read"})
    reply = NS(status=200, error=None, body=body, text=str(body))
    model = NS(live=lambda: [ms], api_ops=[("/orders", ["poppy:read"])],
               api_base="https://api.company.test", co=NS(), poppy=NS(resource=lambda *args: reply))
    with pytest.raises(AssertionError):
        ApiRules.call_api(model, data)
    reply.body = {"orders": [{"order_id": "ord_7Hk2", "account": "acct_ada"}]}
    ApiRules.call_api(model, data)


@pytest.mark.parametrize("field,value", [("account", "acct_grace"), ("signedIn", False), ("userId", "usr_other"), ("ended", True)])
def test_session_oracle_compares_each_identity_and_state_field(field, value):
    ms = NS(session=NS(session_id="ses_1"), user=NS(user=NS(user_id="usr_ada")), ended=False, account="acct_ada")
    state = {"id": "ses_1", "ended": False, "account": "acct_ada", "signedIn": True, "userId": "usr_ada"}
    model = NS(company=True, server=NS(state=lambda: {"sessions": [state]}), sessions_started={"ses_1"}, users=[NS(sessions=[ms])])
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
    ms = NS(browser=browser, joined=True, ended=False, account=None, grant=None)
    model = NS(users=[NS(sessions=[ms])])
    with pytest.raises(AssertionError):
        BrowsingRules.browse(model, data)
    browser.get = lambda url: NS(status_code=200, text="<p>Signed out</p><p>Sign in to continue.</p>")
    BrowsingRules.browse(model, data)
