"""
MCP with Bearer Session Tokens (4.3, 6) and web browsing in a Session (5).

MCP: a Bearer token comes from the request that renews the Session's token
without DPoP and with `resource` set to the MCP server's `url`; it works
only there, enforces the Session's scopes, and follows its sign-in; the
server's protected resource metadata names the issuer (RFC 9728, 6). The
reject rules send DPoP where Bearer belongs and Bearer where DPoP does.
machine.py's invariant holds the client to "Bearer only to the listed MCP
server" over every request it sent.

Browsing: the browser joins a Session with a signed browser assertion,
posted as a form; the Company answers 303 to `return_to` with a cookie that
is Secure, HttpOnly and SameSite Lax or None; the website then follows the
Session as it signs in, changes scope, signs out or ends. Every flaw in an
assertion is refused with 400 and no cookie, and recorded.
"""

from __future__ import annotations

from typing import Any

from hypothesis import strategies as st
from hypothesis.stateful import precondition, rule, run_state_machine_as_test

from machine import READ, WRITE, Base, MSession, SessionRules, WarmUp, expect, reached
from mock_server import DOMAIN, MockServer
from poppy_client import Browser, Session, protected_resource_metadata_url, random_id

# ---- return_to values, built in their class (5: an HTTPS URL on organization.domain or a subdomain) ----

PATHS = st.sampled_from(["/", "/orders", "/account/address", "/orders?tab=open", "/x#top"])
ON_DOMAIN = st.builds(
    lambda host, port, path: f"https://{host}{port}{path}",
    st.sampled_from([DOMAIN, f"www.{DOMAIN}", f"uk.{DOMAIN}", f"shop.eu.{DOMAIN}", DOMAIN.upper()]),
    st.sampled_from(["", ":443", ":8443"]),
    PATHS,
)
OFF_DOMAIN = st.one_of(
    st.builds(lambda host, path: f"http://{host}{path}", st.sampled_from([DOMAIN, f"www.{DOMAIN}"]), PATHS),
    st.builds(
        lambda host, path: f"https://{host}{path}",
        st.sampled_from(
            ["evil.test", f"{DOMAIN}.evil.test", f"x{DOMAIN}", "company.interop.test", f"{DOMAIN}@evil.test", "other.company.interop.test"]
        ),
        PATHS,
    ),
    st.sampled_from([f"ftp://{DOMAIN}/", "javascript:alert(1)", f"data:text/html,{DOMAIN}", f"wss://{DOMAIN}/"]),
)
NOT_A_URL = st.sampled_from(["", "/orders", "orders", f"//{DOMAIN}/orders", "https://", "http://[::1"])


def flaws() -> st.SearchStrategy[str]:
    return st.sampled_from(["typ", "lifetime", "aud", "other-user", "unknown-session", "in-url", "replay"])


class McpRules:
    # ---- MCP (6) ----

    @precondition(lambda self: self.co.mcp and self.live())
    @rule(data=st.data())
    def new_bearer_token(self, data: st.DataObject) -> None:
        """4.3: a Bearer token for the Session, from its renewal without DPoP; `token_type` Bearer, same Session (ensure_bearer)."""
        ms = data.draw(st.sampled_from(self.live()))
        ms.bearer = None
        self.ensure_bearer(ms)

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
        6: a listed MCP server enforces the token's scopes. The exchange
        needs a signed-in Bearer token with `poppy:write`: signed out it is
        `sign_in_required`, without the scope `insufficient_scope` (Bearer
        challenge, RFC 6750); with it, a proposed operation (Ops 4.2).
        """
        ms = data.draw(st.sampled_from(self.live()))
        args = {"order_id": "ord_7Hk2", "item_id": "itm_4Qa", "replacement_sku": "stormline-insulated-m"}
        reply = self.mcp_call(ms, "tools/call", {"name": "exchange_item", "arguments": args})
        assert ms.bearer is not None
        if ms.bearer_account() is None:
            expect(reply, 403, "sign_in_required")
        elif WRITE not in ms.bearer.scope:
            expect(reply, 403, "insufficient_scope")
        else:
            expect(reply, 200)
            operation = reply.body["result"]["structuredContent"]["operation"]
            assert operation["state"] in ("proposed", "in_progress", "succeeded"), operation
            return
        assert reply.headers.get("www-authenticate", "").startswith("Bearer "), reply.headers

    @precondition(lambda self: self.co.mcp)
    @rule()
    def mcp_without_a_token(self) -> None:
        """
        6 and RFC 9728: an MCP request without a token is 401 with a Bearer
        challenge naming the protected resource metadata, whose
        `authorization_servers` MUST include `auth.issuer` and whose
        `resource` is the server's `url`. A Personal Agent MUST send a
        Session Token on every API request (4.3), so the mock records it.
        """
        reply = expect(self.poppy.mcp(None, self.co, {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}), 401, "invalid_token")
        self.violation("resource.no-token")
        challenge = reply.headers.get("www-authenticate", "")
        assert challenge.startswith("Bearer "), challenge
        assert 'resource_metadata="' in challenge, challenge
        named = challenge.split('resource_metadata="', 1)[1].split('"', 1)[0]
        assert named == protected_resource_metadata_url(self.co.mcp), f"{named}: not where RFC 9728 3.1 puts the MCP server's metadata"
        found = self.poppy.protected_resource_metadata(self.co.mcp)
        expect(found, 200)
        assert found.body["resource"] == self.co.mcp, found.body
        assert self.co.issuer in found.body["authorization_servers"], "authorization_servers MUST include auth.issuer (6)"

    # ---- reject direction: the wrong scheme in the wrong place ----

    @precondition(lambda self: self.co.mcp and self.live())
    @rule(data=st.data())
    def dpop_at_the_mcp_server(self, data: st.DataObject) -> None:
        """Reject: MCP takes Bearer tokens only (4.3, 6): the DPoP token, with DPoP or with Bearer, is 401."""
        ms = data.draw(st.sampled_from(self.live()))
        as_bearer = data.draw(st.booleans(), label="as Bearer")
        rpc = {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
        if as_bearer:
            reply = self.poppy.mcp(ms.session.token, self.co, rpc)
            self.violation("mcp.wrong-token")
        else:
            reply = self.poppy.mcp(ms.session.token, self.co, rpc, scheme="DPoP", dpop_key=ms.session.key)
            self.dpop_to_mcp += 1
            self.violation("mcp.not-bearer")
        expect(reply, 401, "invalid_token")

    @precondition(lambda self: self.co.mcp and self.live())
    @rule(data=st.data())
    def bearer_outside_mcp(self, data: st.DataObject) -> None:
        """
        Reject: Companies MUST accept Bearer Session Tokens only on their
        MCP APIs and require DPoP everywhere else (4.3): the Bearer token at
        the OpenAPI API is 401, with the Bearer scheme or dressed as DPoP.
        """
        ms = data.draw(st.sampled_from(self.live()))
        bearer = self.ensure_bearer(ms)
        stolen = Session(ms.user.user, ms.session.session_id, bearer.token, ms.session.key, ms.session.signed_in)
        if data.draw(st.booleans(), label="Bearer scheme"):
            reply = self.poppy.resource(stolen, "GET", self.api_base + "/products", self.co, scheme="Bearer")
            self.bearer_elsewhere += 1
            self.violation("resource.bearer-scheme")
        else:
            reply = self.poppy.resource(stolen, "GET", self.api_base + "/products", self.co)
            self.violation("resource.bearer-token-as-dpop")
        expect(reply, 401, "invalid_token")

    @precondition(lambda self: self.co.mcp and self.live())
    @rule(data=st.data())
    def token_request_without_dpop_elsewhere(self, data: st.DataObject) -> None:
        """Reject: only a token for the MCP server comes without a proof (4.3); anything else is `invalid_dpop_proof`."""
        ms = data.draw(st.sampled_from(self.live()))
        resource = data.draw(st.sampled_from([None, self.api_base, self.co.mcp + "/", self.co.conversations]))
        reply = self.poppy.bearer_token(self.co, ms.session, ms.grant.current if ms.grant else None, resource=resource)
        expect(reply, 400, "invalid_dpop_proof")
        self.violation("token.no-dpop")

    @precondition(lambda self: self.co.mcp and self.live())
    @rule(data=st.data())
    def dpop_token_for_mcp(self, data: st.DataObject) -> None:
        """Reject, recorded: a DPoP-bound token for the MCP server is one MCP can't use (4.3: MCP uses Bearer)."""
        ms = data.draw(st.sampled_from(self.live()))
        grant = ms.grant
        reply = self.poppy.bearer_token(self.co, ms.session, grant.current if grant else None, dpop=True)
        body = self.token_body(reply, session_id=ms.session.session_id, signed_in=grant is not None, scope=self.bearer_scope(ms))
        if grant is not None:
            self.rotate(grant, body)
        self.violation("token.mcp-dpop")


class BrowsingRules:
    # ---- web browsing (5) ----

    @precondition(lambda self: self.co.browser_session and self.live())
    @rule(data=st.data())
    def join(self, data: st.DataObject) -> None:
        """
        5: join the Session's own browser, `return_to` drawn on the
        Company's domain or a subdomain (accepted), off it (400,
        `return-to-off-domain`), or not a URL at all (400). A refused join
        sets no cookie.
        """
        ms = data.draw(st.sampled_from(self.live()))
        kind = data.draw(st.sampled_from(["on", "off", "not a URL"]), label="return_to")
        return_to = data.draw({"on": ON_DOMAIN, "off": OFF_DOMAIN, "not a URL": NOT_A_URL}[kind])
        if kind == "on":
            self.join_browser(ms, return_to)
            reached("303")
            return
        if ms.browser is None:
            ms.browser = Browser(self.transport)
        assertion = self.agent.browser_assertion(ms.user.user.user_id, ms.session.session_id, self.co.browser_session, return_to)
        self.refused(ms.browser.join(self.co.browser_session, assertion))
        self.violation("browser-assertion.return-to-off-domain" if kind == "off" else "browser-assertion.return-to-not-url")

    def refused(self, response: Any) -> None:
        assert response.status_code == 400, (response.status_code, response.text[:200])
        assert not response.headers.get_list("set-cookie"), "a refused join set a cookie (5)"
        reached("400")

    @precondition(lambda self: self.co.browser_session and self.live())
    @rule(data=st.data())
    def flawed_join(self, data: st.DataObject) -> None:
        """
        Reject (5): the Company MUST check the assertion's `typ`, `aud`,
        lifetime (`exp` no more than 60 s after `iat`), single-use `jti`, and
        that the Session is this agent's and User's and active; and the
        assertion goes in the body, never the URL. Each flaw alone is 400,
        no cookie, and its own record.
        """
        ms = data.draw(st.sampled_from(self.live()))
        flaw = data.draw(flaws(), label="flaw")
        if ms.browser is None:
            ms.browser = Browser(self.transport)
        user_id, session_id = ms.user.user.user_id, ms.session.session_id
        endpoint = self.co.browser_session
        if flaw == "replay":
            self.join_browser(ms)
            assertion = self.agent.browser_assertion(user_id, session_id, endpoint, f"https://{DOMAIN}/")
            ok = ms.browser.join(endpoint, assertion)
            assert ok.status_code == 303, ok.status_code
            self.refused(ms.browser.join(endpoint, assertion))
            self.violation("browser-assertion.jti-reused")
            return
        kwargs: dict[str, Any] = {}
        aud: Any = endpoint
        violation = {
            "typ": "browser-assertion.typ",
            "lifetime": "browser-assertion.lifetime",
            "aud": "browser-assertion.aud",
            "other-user": "browser-assertion.session",
            "unknown-session": "browser-assertion.session",
            "in-url": "browser-assertion.in-url",
        }[flaw]
        if flaw == "typ":
            kwargs["typ"] = data.draw(st.sampled_from(["JWT", "dpop+jwt", "poppy-browser"]))
        elif flaw == "lifetime":
            kwargs["lifetime"] = data.draw(st.integers(61, 3600))
        elif flaw == "aud":
            aud = data.draw(st.sampled_from([self.co.token_endpoint, self.co.issuer, endpoint + "/", f"https://{DOMAIN}", [endpoint]]))
        elif flaw == "other-user":
            others = [u for u in self.users if u is not ms.user]
            user_id = others[0].user.user_id if others else random_id("usr_")
        elif flaw == "unknown-session":
            session_id = data.draw(st.sampled_from([random_id("ses_"), ""]) | st.integers())
        assertion = self.agent.browser_assertion(user_id, session_id, aud, f"https://{DOMAIN}/orders", **kwargs)
        self.refused(ms.browser.join(endpoint, assertion, in_url=flaw == "in-url"))
        self.violation(violation)

    @precondition(lambda self: self.co.browser_session and self.live())
    @rule(data=st.data())
    def browser_assertion_at_the_token_endpoint(self, data: st.DataObject) -> None:
        """Reject (5): a browser assertion isn't accepted at the token endpoint."""
        ms = data.draw(st.sampled_from(self.live()))
        assertion = self.agent.browser_assertion(ms.user.user.user_id, ms.session.session_id, self.co.token_endpoint, f"https://{DOMAIN}/")
        expect(self.poppy.start_session(self.co, ms.user.user, assertion=assertion), 400, "invalid_grant")
        self.violation("session-assertion.browser-typ")

    @precondition(lambda self: [s for u in self.users for s in u.sessions if s.browser is not None])
    @rule(data=st.data())
    def browse(self, data: st.DataObject) -> None:
        """
        5: the website handles the browser's requests as its Session, and
        the cookie follows the Session's current state: orders need the
        Session signed in with `poppy:read` (the Session's scopes, not one
        token's); the address form needs it signed in; an ended Session's
        cookie is no Session at all. A browser never joined is a signed-out
        visitor.
        """
        ms = data.draw(st.sampled_from([s for u in self.users for s in u.sessions if s.browser is not None]))
        assert ms.browser is not None
        orders = ms.browser.get(f"https://{DOMAIN}/orders")
        address = ms.browser.get(f"https://{DOMAIN}/account/address")
        assert orders.status_code == 200 and address.status_code == 200, (orders.status_code, address.status_code)
        active = ms.joined and not ms.ended and ms.account is not None
        sees_orders = active and ms.grant is not None and READ in ms.grant.scope
        for page, signed_in in [(orders, sees_orders), (address, active)]:
            if signed_in:
                assert f"Signed in as {ms.account}" in page.text, page.text[:200]
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
