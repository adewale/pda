"""
The core machine: discovery, Users and Sessions, the three sign-in types,
Account Tokens, the OpenAPI reads, conversations, and the reject rules for
tokens, proofs and assertions. The model and shared rules are in machine.py.
"""

from __future__ import annotations

from hypothesis import assume
from hypothesis import strategies as st
from hypothesis.stateful import precondition, rule, run_state_machine_as_test

from machine import COVERAGE, MAX_SESSIONS, ApiRules, Base, ConversationRules, SessionRules, expect
from mock_server import DOMAIN, MockServer
from poppy_client import Es256Key, Poppy


class CoreRules:
    # ---- discovery (3) ----

    @rule(data=st.data())
    def rediscover(self, data: st.DataObject) -> None:
        """Every domain the Company names discovers the same Company, keyed by its issuer (3.2)."""
        domain = data.draw(st.sampled_from([DOMAIN, f"www.{DOMAIN}", *self.co.metadata["poppy_domains"]]))
        again = self.poppy.discover(domain)
        assert again.issuer == self.co.issuer
        assert again.metadata == self.co.metadata
        assert again.conversations == self.co.conversations

    # ---- reject direction: tokens and proofs ----

    @precondition(lambda self: self.company is not None)
    @rule(data=st.data())
    def replayed_jti(self, data: st.DataObject) -> None:
        """Reject: a client assertion, Session assertion or DPoP proof the Company has seen (4.2, 4.3)."""
        mu = data.draw(st.sampled_from(self.users))
        kind = data.draw(st.sampled_from(["client-assertion", "session-assertion", "dpop-token", "dpop-resource"]))
        if kind == "dpop-resource":
            live = self.live()
            assume(live)
            ms = data.draw(st.sampled_from(live))
            url = self.api_base + next(path for path, needed in self.api_ops if not needed)
            expect(self.poppy.resource(ms.session, "GET", url, self.co), 200)
            replay = self.poppy.last.proof
            expect(self.poppy.resource(ms.session, "GET", url, self.co, proof=replay), 401, "invalid_dpop_proof")
            self.violation("dpop.jti-reused")
            return
        assume(len(mu.sessions) < MAX_SESSIONS)
        body = self.token_body(self.poppy.start_session(self.co, mu.user), signed_in=False, scope=frozenset())
        self.new_session(mu, body, mu.user.dpop_key)
        last = self.poppy.last
        if kind == "client-assertion":
            expect(self.poppy.start_session(self.co, mu.user, client_assertion=last.client_assertion), 401, "invalid_client")
        elif kind == "session-assertion":
            expect(self.poppy.start_session(self.co, mu.user, assertion=last.session_assertion), 400, "invalid_grant")
        else:
            expect(self.poppy.start_session(self.co, mu.user, proof=last.proof), 400, "invalid_dpop_proof")
            kind = "dpop"
        self.violation(f"{kind}.jti-reused")

    @precondition(lambda self: self.company is not None)
    @rule(data=st.data())
    def assertion_aud(self, data: st.DataObject) -> None:
        """
        Both directions of `aud` (4.1, 4.2). A Session assertion's is the
        token endpoint as a single string. A client assertion's is the
        endpoint called; a lenient Company (S1) also takes the token
        endpoint or the issuer. Anything else is refused.
        """
        mu = data.draw(st.sampled_from(self.users))
        assume(len(mu.sessions) < MAX_SESSIONS)
        co = self.co
        near = [
            co.token_endpoint, co.issuer, co.revocation_endpoint, co.token_endpoint + "/", co.issuer.rstrip("/"),
            co.issuer.rstrip("/") + "/", co.token_endpoint.upper(), f"https://{DOMAIN}", DOMAIN, self.agent.client_id,
            co.metadata.get("authorization_endpoint", ""), co.metadata.get("device_authorization_endpoint", ""),
        ]
        aud = data.draw(
            st.one_of(
                st.sampled_from(near),
                st.text(),
                st.lists(st.sampled_from(near), min_size=1, max_size=3),
                st.integers(),
                st.none(),
            )
        )
        which = data.draw(st.sampled_from(["client", "session"]))
        if which == "session":
            reply = self.poppy.start_session(co, mu.user, assertion=self.poppy.session_assertion(co, mu.user, aud=aud))
            if aud == co.token_endpoint and isinstance(aud, str):
                self.new_session(mu, self.token_body(reply, signed_in=False, scope=frozenset()), mu.user.dpop_key)
            else:
                expect(reply, 400, "invalid_grant")
                self.violation("session-assertion.aud")
            return
        accepted = [co.token_endpoint] + ([] if self.config["clientAssertionAud"] == "exact" else [co.issuer])
        reply = self.poppy.start_session(co, mu.user, client_assertion=lambda: self.agent.assertion(self.agent.client_id, aud))
        if isinstance(aud, str) and aud in accepted:
            self.new_session(mu, self.token_body(reply, signed_in=False, scope=frozenset()), mu.user.dpop_key)
        else:
            expect(reply, 401, "invalid_client")
            self.violation("client-assertion.aud-array" if isinstance(aud, list) else "client-assertion.aud")

    @precondition(lambda self: self.live())
    @rule(data=st.data())
    def stolen_session_token(self, data: st.DataObject) -> None:
        """Reject: a Session Token with a proof from another key is useless (4.3)."""
        ms = data.draw(st.sampled_from(self.live()))
        path, _ = data.draw(st.sampled_from(self.api_ops))
        reply = self.poppy.resource(ms.session, "GET", self.api_base + path, self.co, key=Es256Key())
        expect(reply, 401, "invalid_dpop_proof")
        self.violation("dpop.key-mismatch")

    @precondition(lambda self: any(g.superseded for u in self.users for g in u.grants))
    @rule(data=st.data())
    def reused_rotated_account_token(self, data: st.DataObject) -> None:
        """Reject: an Account Token after the Company rotated it (4.8); with reuse detection, the family is revoked."""
        grant = data.draw(st.sampled_from([g for u in self.users for g in u.grants if g.superseded]))
        old = data.draw(st.sampled_from(grant.superseded))
        live = self.live(grant.user)
        ms = data.draw(st.none() | st.sampled_from(live)) if live else None
        reply = self.poppy.refresh(self.co, grant.user.user.dpop_key, old, ms.session.session_id if ms else None)
        expect(reply, 400, "invalid_grant")
        self.violation("account-token.rotated-reused")
        if self.config["reuseDetection"] and not grant.revoked:
            # RFC 9700 4.14.2: the reuse revokes the active token of that sign-in, not the account's others.
            grant.revoked = True
            self.sign_out_sessions([grant])

    @precondition(lambda self: any(g.revoked for u in self.users for g in u.grants))
    @rule(data=st.data())
    def revoked_account_token(self, data: st.DataObject) -> None:
        """Reject: a revoked Account Token is `invalid_grant` (4.8)."""
        grant = data.draw(st.sampled_from([g for u in self.users for g in u.grants if g.revoked]))
        expect(self.poppy.refresh(self.co, grant.user.user.dpop_key, grant.current, None), 400, "invalid_grant")

    @precondition(lambda self: any(not g.revoked for u in self.users for g in u.grants))
    @rule(data=st.data())
    def account_token_other_agent(self, data: st.DataObject) -> None:
        """Reject: an Account Token belongs to the client_id it was issued to (4.8)."""
        grant = data.draw(st.sampled_from([g for u in self.users for g in u.grants if not g.revoked]))
        other = Poppy(self.other_agent, self.http)
        expect(other.refresh(self.co, Es256Key(), grant.current, None), 400, "invalid_grant")
        self.violation("account-token.other-client")

    @precondition(lambda self: any(s.ended for u in self.users for s in u.sessions))
    @rule(data=st.data())
    def ended_session(self, data: st.DataObject) -> None:
        """
        An ended Session's token is refused at a resource, as `invalid_token`
        (6) or `invalid_session` as the Company chooses (N39), and renewing
        it is `invalid_session` (4.2).
        """
        ms = data.draw(st.sampled_from([s for u in self.users for s in u.sessions if s.ended]))
        path, _ = data.draw(st.sampled_from(self.api_ops))
        reply = self.poppy.resource(ms.session, "GET", self.api_base + path, self.co)
        if self.config["endedSessionError"] == "invalid_session":
            expect(reply, 400, "invalid_session")
        else:
            expect(reply, 401, "invalid_token")
        expect(self.poppy.start_session(self.co, ms.user.user, session_id=ms.session.session_id), 400, "invalid_session")

    @precondition(lambda self: self.live())
    @rule(data=st.data())
    def sign_in_without_an_offered_scope(self, data: st.DataObject) -> None:
        """
        Reject: a sign-in MUST include `scope` (4.4), and one asking for a
        scope its type doesn't offer is `invalid_scope`.
        """
        ms = data.draw(st.sampled_from(self.live()))
        kind = data.draw(st.sampled_from([k for k in ("direct", "device", "mediated") if self.co.offered(k)]))
        offered = self.co.offered(kind)
        unoffered = st.sampled_from(["poppy:admin", "addresses", "orders:read", "openid"]) | st.from_regex(r"[!#-\[\]-~]+", fullmatch=True)
        extra = data.draw(st.lists(unoffered, min_size=1, max_size=2, unique=True))
        assume(not set(extra) <= set(offered))
        requested = data.draw(st.just([]) | st.lists(st.sampled_from(offered), unique=True).map(lambda s: s + extra))
        account = self.fixture["accounts"][0]
        if kind == "direct":
            url, state, _ = self.poppy.authorization_url(self.co, requested)
            redirect = self.server.hook("approve_authorization", url=url, account=account)["redirect"]
            assert self.poppy.callback(self.co, redirect, state).get("error") == "invalid_scope", redirect
            COVERAGE["sign_in_without_an_offered_scope: direct invalid_scope"] += 1
        elif kind == "device":
            expect(self.poppy.device_start(self.co, requested), 400, "invalid_scope")
        else:
            fields = self.server.hook("mediated_answers", account=account)["fields"]
            expect(self.poppy.mediated_start(self.co, ms.session, requested, fields), 400, "invalid_scope")
        if not requested:
            self.violation("signin.no-scope")


class MockCompanyMachine(Base, SessionRules, ApiRules, ConversationRules, CoreRules):
    pass


def test_mock_company(mock_server: MockServer) -> None:
    run_state_machine_as_test(lambda: MockCompanyMachine(mock_server))
