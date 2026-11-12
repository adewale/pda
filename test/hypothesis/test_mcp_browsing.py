"""
MCP (7), the browser join (6) and website pages (5.2).

MCP: every request carries the Session header with the Session's version
and extensions (3.4); signed in, also the token the issuer gave for the MCP
server's `url` (4.5, RFC 8707), from the refresh token with `resource`,
which the mock issues as Bearer. It works only there, enforces its scopes,
and follows the Session's sign-in; the server's protected resource
metadata names the issuer (RFC 9728, 7). The reject rules send the
Company's default token to the MCP server and the MCP server's token to the
OpenAPI API.

The browser join, where the Company lists `browser_session_endpoint`: the
Personal Agent's own browser loads the join page, software reads its
one-time code, the agent's own request authorizes the code with the
Session header, and with the token only when it has
`poppy:browser-sign-in` (a token without it is `insufficient_scope`, after
which the same code is authorized signed out), and the browser submits the
code alone; the Company answers 303 with the Session's cookie. The website
then acts for the account and scopes the join authorized until that
sign-in is revoked, and never for an ended Session. The reject rules break
each step: the code submitted unauthorized, twice, from another browser,
or authorized twice or without a JSON body.

Where the Company lists no browser join, the agent fetches pages of
`organization.domain` itself, with the Session header and no token (5.2),
`web.disabled` or not. The reject rules send a token with one, leave out
`Poppy-Version`, send the header to another host, send a form to a
website that sets `web.disabled`, and ask for `poppy:browser-sign-in` from
a Company without browser join.
"""

from __future__ import annotations

from typing import Any

from hypothesis import strategies as st
from hypothesis.stateful import precondition, rule, run_state_machine_as_test

from machine import READ, WRITE, Base, MSession, SessionRules, WarmUp, expect, expect_challenge, reached
from mock_server import DOMAIN, MockServer
from poppy_client import BROWSER_SIGN_IN, MCP_LEGACY, MCP_MODERN, Browser, protected_resource_metadata_url, random_id
from strategies import CONFIGS


class McpRules:
    # ---- MCP (7) ----

    @precondition(lambda self: self.co.mcp and self.live())
    @rule(data=st.data())
    def mcp_tools(self, data: st.DataObject) -> None:
        """List the tools, then call the one that works signed out, in whichever lifecycle the server speaks (7)."""
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
        since the Session declares Operations 3: terms always, a summary
        perhaps (Ops 3).
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
            for name in ("operation_id", "revision"):
                assert isinstance(operation.get(name), str), operation
            assert isinstance(operation.get("terms"), dict), f"an operation without terms (Ops 3): {operation}"
            assert "summary" not in operation or isinstance(operation["summary"], str), operation

    @precondition(lambda self: self.co.mcp)
    @rule()
    def mcp_metadata(self) -> None:
        """RFC 9728 and 7: the MCP server's protected resource metadata names it as `resource` and includes the issuer."""
        found = expect(self.poppy.protected_resource_metadata(self.co.mcp), 200)
        assert found.body["resource"] == self.co.mcp, found.body
        assert self.co.issuer in found.body["authorization_servers"], "authorization_servers MUST include the issuer (7)"

    # ---- reject direction: each MCP version's own rules, broken on purpose ----

    @precondition(lambda self: self.co.mcp and self.live() and self.mcp_era == "modern")
    @rule(data=st.data())
    def mcp_session_id_in_a_stateless_request(self, data: st.DataObject) -> None:
        """
        Reject (7: 2026-07-28 "uses per-request metadata instead of an
        initialization handshake or Mcp-Session-Id"): the server ignores the
        header and serves the request (Streamable HTTP, "Backward
        Compatibility"); the mock records it.
        """
        ms = data.draw(st.sampled_from(self.live()))
        reply = self.poppy.mcp_modern(self.mcp_session(ms), self.co, "tools/list", headers={"Mcp-Session-Id": random_id("mcp_", 8)})
        self.touch_mcp(ms, reply)
        self.check_modern(expect(reply, 200))
        self.mcp_stray_session_ids += 1
        self.violation("mcp.modern-session-id")

    @precondition(lambda self: self.co.mcp and self.live() and self.mcp_era == "modern")
    @rule(data=st.data())
    def mcp_name_that_differs_from_the_body(self, data: st.DataObject) -> None:
        """
        Reject (MCP 2026-07-28 Streamable HTTP, "Server Validation"): an
        `Mcp-Name` that isn't the body's tool is a 400 with `HeaderMismatch`
        (-32020), and the tool doesn't run.
        """
        ms = data.draw(st.sampled_from(self.live()))
        call = {"name": "search_products", "arguments": {"query": data.draw(st.text(max_size=8))}}
        reply = self.poppy.mcp_modern(self.mcp_session(ms), self.co, "tools/call", call, tool=(self.mcp_tools or {}).get("search_products"), headers={"Mcp-Name": "exchange_item"})
        self.touch_mcp(ms, reply)
        assert expect(reply, 400).body["error"]["code"] == -32020, reply.body
        self.violation("mcp.modern-name-header")

    @precondition(lambda self: self.co.mcp and self.live() and self.mcp_era == "modern" and self.config["mcpVersions"] == [MCP_MODERN])
    @rule(data=st.data())
    def initialize_at_a_stateless_server(self, data: st.DataObject) -> None:
        """
        MCP 2026-07-28 Versioning: a server that speaks only 2026-07-28 answers
        `initialize` with `UnsupportedProtocolVersionError` naming what it
        speaks. Nothing is recorded: a dual-era client may try it.
        """
        ms = data.draw(st.sampled_from(self.live()))
        rpc = {"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {"protocolVersion": MCP_LEGACY, "capabilities": {}, "clientInfo": {"name": "hypothesis", "version": "0"}}}
        reply = self.poppy.mcp(self.mcp_session(ms), self.co, rpc)
        self.touch_mcp(ms, reply)
        error = expect(reply, 400).body["error"]
        assert error["code"] == -32022 and error["data"]["supported"] == [MCP_MODERN], error
        assert "mcp-session-id" not in reply.headers, reply.headers
        self.mcp_initialize_refused += 1

    @precondition(lambda self: self.co.mcp and self.live() and self.mcp_era == "legacy")
    @rule(data=st.data())
    def legacy_request_without_its_session(self, data: st.DataObject) -> None:
        """
        Reject (MCP 2025-06-18 Streamable HTTP: a client "MUST include it in
        the Mcp-Session-Id header on all of their subsequent HTTP requests"):
        a request outside the session `initialize` opened is a 400, recorded.
        """
        ms = data.draw(st.sampled_from(self.live()))
        reply = self.poppy.mcp(self.mcp_session(ms), self.co, {"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        self.touch_mcp(ms, reply)
        expect(reply, 400)
        self.violation("mcp.legacy-session")

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
        """6: join the Session's own browser (machine.join_browser checks each step), signed in only with `poppy:browser-sign-in`."""
        ms = data.draw(st.sampled_from(self.live()))
        self.join_browser(ms)
        reached("303 signed in" if ms.joined_as else "303 signed out")

    def short_tokens(self) -> list[MSession]:
        return [s for s in self.live() if s.token is not None and BROWSER_SIGN_IN not in s.token_scope]

    @precondition(lambda self: self.co.browser_session and self.short_tokens())
    @rule(data=st.data())
    def join_with_a_token_without_the_scope(self, data: st.DataObject) -> None:
        """
        6: a token without `poppy:browser-sign-in` in step 2 is refused with
        `insufficient_scope` naming the scope, as at an API, and the code
        stays unauthorized; the agent then authorizes the same code without
        a token, and the browser joins signed out.
        """
        ms = data.draw(st.sampled_from(self.short_tokens()))
        self.join_browser(ms, short_token=True)
        reached("403 insufficient_scope, then 303 signed out")

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
        # 6: signed in only with a token that has `poppy:browser-sign-in`; otherwise signed out.
        token = ms.token if ms.token is not None and BROWSER_SIGN_IN in ms.token_scope else None

        def authorize(**options: Any) -> Any:
            reply = self.poppy.resource(ms.session, "POST", f"{endpoint.rstrip('/')}/authorize", self.co, token=token.value if token else None, **options)
            self.touch(ms, reply, token)
            return reply

        if flaw == "unauthorized":
            self.refused(ms.browser.submit_join(action, code))
            self.violation("browser-join.not-authorized")
        elif flaw == "submitted twice":
            expect(authorize(body={"code": code}), 204)
            response = ms.browser.submit_join(action, code)
            assert response.status_code == 303, response.status_code
            ms.joined = True
            ms.joined_as = token.account if token else None
            ms.joined_grant = token.grant if token else None
            ms.joined_scope = token.scope if token else frozenset()
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
        all, and a browser never joined is a signed-out visitor. A website
        that sets `web.unscoped` gives a browser signed in with
        `poppy:browser-sign-in` the account's full access; the mock's
        doesn't (MOCK-9, test_findings.py), so that case isn't held here.
        """
        ms = data.draw(st.sampled_from([s for s in self.all_sessions() if s.browser is not None]))
        assert ms.browser is not None
        active = ms.joined and not ms.ended and ms.joined_as is not None and ms.joined_grant is not None and not ms.joined_grant.revoked
        if self.unscoped() and active and READ not in ms.joined_scope:
            reached("unscoped, without orders:read: MOCK-9")
            return
        orders = ms.browser.get(f"https://{DOMAIN}/orders")
        address = ms.browser.get(f"https://{DOMAIN}/account/address")
        assert orders.status_code == 200 and address.status_code == 200, (orders.status_code, address.status_code)
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

    def unscoped(self) -> bool:
        web = self.co.document.get("web")
        return isinstance(web, dict) and web.get("unscoped") is True

    # ---- pages fetched without a browser (5.2) ----

    def page_seen(self, ms: MSession) -> None:
        """A page verifies the Session header as any endpoint does (5.3), signed out, and leaves the Session's sign-in as it was (5.2)."""
        ms.seen = True
        ms.declared = True

    @precondition(lambda self: not self.co.browser_session and self.live())
    @rule(data=st.data())
    def fetch_page(self, data: st.DataObject) -> None:
        """
        5.2: where the Company lists no browser join, the agent fetches a
        page of `organization.domain` with its own HTTP client, with the
        Session header and no access token, so the page is signed out, even
        when `web.disabled` is set (6: it "doesn't cover pages the Personal
        Agent fetches without a browser").
        """
        ms = data.draw(st.sampled_from(self.live()))
        path = data.draw(st.sampled_from(["/", "/orders", "/account/address"]))
        reply = self.poppy.fetch_page(ms.session, self.co, f"https://{self.co.organization_domain}{path}")
        self.page_seen(ms)
        expect(reply, 200)
        if path != "/":
            assert "Signed out" in reply.text and "Signed in as " not in reply.text, reply.text[:200]
        reached("page fetched" + (" (web.disabled)" if self.co.web_disabled else ""))

    @precondition(lambda self: not self.co.browser_session and [s for s in self.live() if s.token])
    @rule(data=st.data())
    def page_with_a_token(self, data: st.DataObject) -> None:
        """
        Reject: an access token with a website page (5.2: MUST NOT). The
        Session JWT then has `ath`, which a page, verifying it signed out,
        refuses with `invalid_session` before it looks at the Session.
        """
        ms = data.draw(st.sampled_from([s for s in self.live() if s.token]))
        assert ms.token is not None
        reply = self.poppy.fetch_page(ms.session, self.co, f"https://{self.co.organization_domain}/orders", token=ms.token.value, scheme=ms.token.token_type)
        expect(reply, 400, "invalid_session")
        self.violation("page.token")
        self.violation("session-jwt.ath-without-token")

    @precondition(lambda self: not self.co.browser_session and self.live())
    @rule(data=st.data())
    def page_without_a_version(self, data: st.DataObject) -> None:
        """Reject: a page's Session header goes with `Poppy-Version` like any other (3.4); without it, `version_unsupported`."""
        ms = data.draw(st.sampled_from(self.live()))
        reply = self.poppy.fetch_page(ms.session, self.co, f"https://{self.co.organization_domain}/", version=None)
        self.seen_only(ms)
        expect(reply, 400, "version_unsupported")
        self.version_misdeclared += 1
        self.violation("version.missing")

    @precondition(lambda self: self.live())
    @rule(data=st.data())
    def page_on_another_host(self, data: st.DataObject) -> None:
        """
        Reject: the Session header on a page of another host of the
        Company's (5.2: only "HTTPS URLs whose host is exactly
        organization.domain"). Recorded; the page is served.
        """
        ms = data.draw(st.sampled_from(self.live()))
        url = f"https://cdn.{self.co.organization_domain}/orders"
        headers = {"Poppy-Session": self.poppy.session_jwt(self.co, ms.session, "GET", url, None), "Poppy-Version": ms.session.version, "Accept": "text/html"}
        extensions = ms.session.extensions_header()
        if extensions is not None:
            headers["Poppy-Extensions"] = extensions
        response = self.http.get(url, headers=headers)
        assert response.status_code == 200, (response.status_code, response.text[:200])
        self.page_seen(ms)
        self.session_header_misplaced += 1
        self.violation("page.session-off-host")
        reached("served, recorded")

    @precondition(lambda self: self.co.web_disabled)
    @rule(data=st.data())
    def form_on_a_disabled_website(self, data: st.DataObject) -> None:
        """Reject: a browser sending a form to a website that sets `web.disabled` (6: SHOULD NOT use a browser there); recorded, and refused as signed out."""
        browser = Browser(self.transport)
        try:
            response = browser.http.post(
                f"https://{self.co.organization_domain}/account/address",
                content="line1=1+Main+St&city=London",
                headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "text/html"},
            )
        finally:
            browser.close()
        assert response.status_code == 403, response.status_code
        self.violation("web.disabled-form")
        reached("403, recorded")

    @precondition(lambda self: not self.co.browser_session and (self.co.offered("device") or self.co.offered("direct")))
    @rule(data=st.data())
    def browser_sign_in_without_browser_join(self, data: st.DataObject) -> None:
        """
        Reject: asking for `poppy:browser-sign-in` from a Company that lists
        no `browser_session_endpoint` (6: only from one that does). Recorded;
        it isn't a scope this Company has, so `invalid_scope` (4.7).
        """
        kind = data.draw(st.sampled_from([k for k in ("device", "direct") if self.co.offered(k)]))
        requested = self.co.offered(kind) + [BROWSER_SIGN_IN]
        if kind == "device":
            expect(self.poppy.device_start(self.co, requested), 400, "invalid_scope")
        else:
            url, state, _ = self.poppy.authorization_url(self.co, requested)
            redirect = self.server.hook("approve_authorization", url=url, account=self.fixture["accounts"][0])["redirect"]
            assert self.poppy.callback(self.co, redirect, state).get("error") == "invalid_scope", redirect
            reached("direct invalid_scope")
        self.violation("browser-sign-in.no-endpoint")


# 6: browser join or not; a website Personal Agents are asked not to browse, which lists no browser join (MOCK-8:
# the mock would still offer `poppy:browser-sign-in` with both set); one that doesn't apply the Company's scopes.
BROWSE_CONFIGS = st.tuples(
    CONFIGS,
    st.fixed_dictionaries({"browserSession": st.sampled_from([True, True, True, False]), "webDisabled": st.sampled_from([False, False, False, True]), "webUnscoped": st.booleans()}),
).map(lambda pair: pair[0] | pair[1] | ({"browserSession": False} if pair[1]["webDisabled"] else {}))


class McpBrowsingMachine(WarmUp, Base, SessionRules, McpRules, BrowsingRules):
    CONFIG = BROWSE_CONFIGS
    DECLARES_OPERATIONS = st.just(True)


def test_mcp_and_browsing(mock_server: MockServer) -> None:
    run_state_machine_as_test(lambda: McpBrowsingMachine(mock_server))
