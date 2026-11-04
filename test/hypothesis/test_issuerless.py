"""
A Company without an OAuth issuer (3.2, the 3 November text).

The mock runs with `issuerless`: poppy.json has no `auth` and no Mediated
Sign-In, the domain's and the MCP server's protected resource metadata are
404, and the auth host serves nothing. The client discovers it as
signed-out only, identified by https://{organization.domain}, and every
Session JWT names that identifier in `aud` (5.2), with the host lowercased
and no trailing slash. The honest rules use the OpenAPI reads, MCP and
conversations signed out, each request with the Session header and an
operator signature (5.3). The reject rules address a Session JWT to anything
but the identifier: the issuer the Company would have, the domain with a
trailing slash or another case, or an API's own origin.
"""

from __future__ import annotations

from hypothesis import assume
from hypothesis import strategies as st
from hypothesis.stateful import precondition, rule, run_state_machine_as_test

from machine import MAX_SESSIONS, MAX_USERS, ApiRules, Base, ConversationRules, MUser, OperatorRules, expect, reached
from mock_server import DOMAIN, MockServer
from poppy_client import User, protected_resource_metadata_url
from strategies import CONFIGS

IDENTIFIER = f"https://{DOMAIN.lower()}"


class IssuerlessRules:
    @precondition(lambda self: self.company is not None and len(self.users) < MAX_USERS)
    @rule()
    def add_user(self) -> None:
        self.users.append(MUser(User()))

    @precondition(lambda self: self.company is not None)
    @rule(data=st.data())
    def start_session(self, data: st.DataObject) -> None:
        mu = data.draw(st.sampled_from(self.users))
        assume(len(mu.sessions) < MAX_SESSIONS)
        self.new_session(mu)

    @precondition(lambda self: self.company is not None)
    @rule()
    def discover_again(self) -> None:
        """3.2: a 404 for the domain's metadata means no issuer: signed out only, identified by the domain."""
        company = self.poppy.discover(DOMAIN)
        assert company.issuerless and company.issuer == IDENTIFIER, company
        assert company.metadata == {} and company.token_endpoint is None, company.metadata
        assert "auth" not in company.document, company.document
        reached("no issuer")

    @precondition(lambda self: self.company is not None)
    @rule()
    def no_issuer_documents(self) -> None:
        """
        3.2, 7: nothing names an issuer. The domain's and the MCP server's
        protected resource metadata are 404 (an MCP server needs issuer
        discovery only when it offers account access), and so is the
        metadata of the issuer the Company would have.
        """
        for url in (protected_resource_metadata_url(IDENTIFIER), protected_resource_metadata_url(self.co.mcp), f"https://auth.{DOMAIN}/.well-known/oauth-authorization-server"):
            assert self.http.get(url).status_code == 404, url
        reached("404s")

    @precondition(lambda self: self.co.mcp and self.live())
    @rule(data=st.data())
    def mcp_signed_out(self, data: st.DataObject) -> None:
        """7: the MCP server takes signed-out calls with the Session header alone, with no metadata of its own."""
        ms = data.draw(st.sampled_from(self.live()))
        listed = expect(self.mcp_call(ms, "tools/list"), 200).body
        assert "search_products" in {tool["name"] for tool in listed["result"]["tools"]}, listed
        found = expect(self.mcp_call(ms, "tools/call", {"name": "search_products", "arguments": {"query": data.draw(st.text(max_size=12))}}), 200).body
        assert isinstance(found["result"]["content"], list), found

    @precondition(lambda self: self.live() and self.public_paths())
    @rule(data=st.data())
    def session_jwt_for_another_audience(self, data: st.DataObject) -> None:
        """
        Reject (5.2, 5.3): `aud` is the Company's identifier, compared
        character for character: not the issuer it would have, not the
        domain with a trailing slash or its host in capitals, not an API's
        origin. 400 `invalid_session`, and the request starts no Session.
        """
        ms = data.draw(st.sampled_from(self.live()))
        aud = data.draw(st.sampled_from([f"https://auth.{DOMAIN}", IDENTIFIER + "/", f"https://{DOMAIN.upper()}", self.api_base.rstrip("/"), [IDENTIFIER]]))

        def addressed(method: str, at: str, sent: str | None) -> str:
            return self.poppy.session_jwt(self.co, ms.session, method, at, sent, claims={"aud": aud})

        reply = self.poppy.resource(ms.session, "GET", self.api_base + data.draw(st.sampled_from(self.public_paths())), self.co, session_jwt=addressed)
        expect(reply, 400, "invalid_session")
        self.violation("session-jwt.aud")


class IssuerlessMachine(Base, IssuerlessRules, ApiRules, ConversationRules, OperatorRules):
    CONFIG = CONFIGS.map(lambda config: {**config, "issuerless": True})


def test_issuerless(mock_server: MockServer) -> None:
    run_state_machine_as_test(lambda: IssuerlessMachine(mock_server))
