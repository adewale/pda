"""
MCP (7) and the browser join (6).

MCP: every request carries the Session header; signed in, also the token
the issuer gave for the MCP server's `url` (4.5, RFC 8707), from the
refresh token with `resource`, which the mock issues as Bearer. It works
only there, enforces its scopes, and follows the Session's sign-in; the
server's protected resource metadata names the issuer (RFC 9728, 7). The
reject rules send the Company's default token to the MCP server and the MCP
server's token to the OpenAPI API.

The browser join: the Personal Agent's own browser loads the join page,
software reads its one-time code, the agent's own request authorizes the
code with the Session header and token, and the browser submits the code
alone; the Company answers 303 with the Session's cookie. The website then
acts for the account and scopes the join authorized until that sign-in is
revoked, and never for an ended Session. The reject rules break each step:
the code submitted unauthorized, twice, from another browser, or authorized
twice or without a JSON body.
"""

from __future__ import annotations

from typing import Any

from hypothesis import strategies as st
from hypothesis.stateful import precondition, rule, run_state_machine_as_test

from machine import READ, WRITE, Base, SessionRules, WarmUp, expect, expect_challenge, reached
from mock_server import DOMAIN, MockServer
from poppy_client import Browser, protected_resource_metadata_url


class McpRules:
    # ---- MCP (7) ----

    @precondition(lambda self: self.co.mcp and self.live())
    @rule(data=st.data())
    def mcp_tools(self, data: st.DataObject) -> None:
        """MCP 2025-06-18: list the tools, then call the one that works signed out."""
        ms = data.draw(st.sampled_from(self.live()))
        listed = expect(self.mcp_call(ms, "tools/list"), 200).body
        assert listed.get("jsonrpc") == "2.0" and isinstance(listed["result"]["tools"], list), listed
        names = {tool["name"] for tool in listed["result"]["tools"]}
        assert {"search_products", "exchange_item"} <= names, names
        query = data.draw(st.text(max_size=12))
        found = expect(self.mcp_call(ms, "tools/call", {"name": "search_products", "arguments": {"query": query}}), 200).body
        assert isinstance(found["result"]["content"], list), found

    @precondition(lambda self: self.co.mcp and self.live())
    @rule(data=st.data())
    def mcp_write(self, data: st.DataObject) -> None:
        """
        7: the MCP server enforces its token's scopes. The exchange needs
        `orders:write`: signed out, a Bearer challenge naming the scope and
        the server's metadata (401, no error code); without the scope
        `insufficient_scope` (403); with it, an operation to approve (Ops 2),
        since the agent lists Operations.
        """
        ms = data.draw(st.sampled_from(self.live()))
        args = {"order_id": "ord_7Hk2", "item_id": "itm_4Qa", "replacement_sku": "stormline-insulated-m"}
        reply = self.mcp_call(ms, "tools/call", {"name": "exchange_item", "arguments": args})
        challenge = reply.headers.get("www-authenticate", "")
        if ms.mcp is None:
            expect_challenge(reply, [WRITE])
            assert challenge.startswith("Bearer ") and f'resource_metadata="{protected_resource_metadata_url(self.co.mcp)}"' in challenge, challenge
        elif WRITE not in ms.mcp.scope:
            expect(reply, 403, "insufficient_scope")
            assert challenge.startswith("Bearer "), challenge
        else:
            expect(reply, 200)
            result = reply.body["result"]
            operation = result["structuredContent"]["operation"]
            assert result.get("isError") is True, "not done until approved (Ops 2)"
            for name in ("operation_id", "revision", "summary"):
                assert isinstance(operation.get(name), str), operation

    @precondition(lambda self: self.co.mcp)
    @rule()
    def mcp_metadata(self) -> None:
        """RFC 9728 and 7: the MCP server's protected resource metadata names it as `resource` and includes the issuer."""
        found = expect(self.poppy.protected_resource_metadata(self.co.mcp), 200)
        assert found.body["resource"] == self.co.mcp, found.body
        assert self.co.issuer in found.body["authorization_servers"], "authorization_servers MUST include the issuer (7)"

    # ---- reject direction: a token where it doesn't belong ----

    @precondition(lambda self: self.co.mcp and any(s.token for s in self.live()))
    @rule(data=st.data())
    def default_token_at_the_mcp_server(self, data: st.DataObject) -> None:
        """
        Reject: an MCP server takes only a token issued for its `url` (4.5,
        RFC 8707); the Company's default token is `invalid_token`, with a
        challenge naming the server's metadata.
        """
        ms = data.draw(st.sampled_from([s for s in self.live() if s.token]))
        rpc = {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
        reply = self.poppy.mcp(ms.session, self.co, rpc)
        expect(reply, 401, "invalid_token")
        assert "resource_metadata=" in reply.headers.get("www-authenticate", ""), reply.headers
        self.violation("mcp.wrong-token")

    @precondition(lambda self: self.co.mcp and any(s.token for s in self.live()))
    @rule(data=st.data())
    def mcp_token_at_the_api(self, data: st.DataObject) -> None:
        """Reject: the MCP server's token at the OpenAPI API is `invalid_token` (4.5: a token for one service only there)."""
        ms = data.draw(st.sampled_from([s for s in self.live() if s.token]))
        token = self.ensure_mcp_token(ms)
        assert token is not None
        reply = self.poppy.resource(ms.session, "GET", self.api_base + "/orders", self.co, token=token.value, scheme=token.token_type)
        expect(reply, 401, "invalid_token")


class BrowsingRules:
    # ---- the browser join (6) ----

    @precondition(lambda self: self.co.browser_session and self.live())
    @rule(data=st.data())
    def join(self, data: st.DataObject) -> None:
        """6: join the Session's own browser (machine.join_browser checks each step)."""
        ms = data.draw(st.sampled_from(self.live()))
        self.join_browser(ms)
        reached("303 signed in" if ms.joined_as else "303 signed out")

    def refused(self, response: Any) -> None:
        assert response.status_code == 400, (response.status_code, response.text[:200])
        assert not [c for c in response.headers.get_list("set-cookie") if c.startswith("mock_sid=")], "a refused join set the Session's cookie (6)"
        reached("400")

    @precondition(lambda self: self.co.browser_session and self.live())
    @rule(data=st.data())
    def flawed_join(self, data: st.DataObject) -> None:
        """
        Reject (6): each code works once and only in the browser it was
        given to, after the agent authorized it; the agent authorizes it
        once, in a JSON body. Each flaw alone is refused, with no cookie,
        and recorded.
        """
        ms = data.draw(st.sampled_from(self.live()))
        flaw = data.draw(st.sampled_from(["unauthorized", "submitted twice", "other browser", "authorized twice", "authorize as a form"]), label="flaw")
        if ms.browser is None:
            ms.browser = Browser(self.transport)
        endpoint = self.co.browser_session
        assert endpoint is not None
        _, code, action = ms.browser.open_join(endpoint)
        assert code and action

        def authorize(**options: Any) -> Any:
            reply = self.poppy.resource(ms.session, "POST", f"{endpoint.rstrip('/')}/authorize", self.co, **options)
            self.touch(ms, reply)
            return reply

        if flaw == "unauthorized":
            self.refused(ms.browser.submit_join(action, code))
            self.violation("browser-join.not-authorized")
        elif flaw == "submitted twice":
            expect(authorize(body={"code": code}), 204)
            response = ms.browser.submit_join(action, code)
            assert response.status_code == 303, response.status_code
            ms.joined, ms.joined_as, ms.joined_grant, ms.joined_scope = True, ms.account, ms.token.grant if ms.token else None, ms.token_scope
            self.refused(ms.browser.submit_join(action, code))
            self.violation("browser-join.code-reused")
        elif flaw == "other browser":
            expect(authorize(body={"code": code}), 204)
            other = Browser(self.transport)
            try:
                self.refused(other.submit_join(action, code))
            finally:
                other.close()
            self.violation("browser-join.cookie")
        elif flaw == "authorized twice":
            expect(authorize(body={"code": code}), 204)
            expect(authorize(body={"code": code}), 400, "invalid_request")
            self.violation("browser-join.code-reused")
        else:
            reply = authorize(raw_body=f"code={code}", content_type="application/x-www-form-urlencoded")
            expect(reply, 400, "invalid_request")
            self.violation("browser-join.authorize-body")

    @precondition(lambda self: [s for s in self.all_sessions() if s.browser is not None])
    @rule(data=st.data())
    def browse(self, data: st.DataObject) -> None:
        """
        6: the website handles the browser's requests as its Session, acting
        for the account and scopes the join authorized until that sign-in's
        refresh token is revoked: orders need `orders:read`; the address
        form needs the account. An ended Session's cookie is no Session at
        all, and a browser never joined is a signed-out visitor.
        """
        ms = data.draw(st.sampled_from([s for s in self.all_sessions() if s.browser is not None]))
        assert ms.browser is not None
        orders = ms.browser.get(f"https://{DOMAIN}/orders")
        address = ms.browser.get(f"https://{DOMAIN}/account/address")
        assert orders.status_code == 200 and address.status_code == 200, (orders.status_code, address.status_code)
        active = ms.joined and not ms.ended and ms.joined_as is not None and ms.joined_grant is not None and not ms.joined_grant.revoked
        sees_orders = active and READ in ms.joined_scope
        for page, signed_in in [(orders, sees_orders), (address, active)]:
            if signed_in:
                assert f"Signed in as {ms.joined_as}" in page.text, page.text[:200]
                assert "Signed out" not in page.text, page.text[:200]
            else:
                assert "Signed out" in page.text, page.text[:200]
                for private_marker in ["Signed in as ", "ord_7Hk2", '<form id="address"', 'name="csrf"']:
                    assert private_marker not in page.text, page.text[:200]
        if sees_orders:
            assert "ord_7Hk2" in orders.text, orders.text[:200]
        reached("orders seen" if sees_orders else "signed in" if active else "signed out")


class McpBrowsingMachine(WarmUp, Base, SessionRules, McpRules, BrowsingRules):
    LISTS_OPERATIONS = st.just(True)


def test_mcp_and_browsing(mock_server: MockServer) -> None:
    run_state_machine_as_test(lambda: McpBrowsingMachine(mock_server))

