"""
The core machine: discovery, Users and Sessions, the three sign-in types,
refresh tokens, the OpenAPI reads, conversations, and the reject rules for
tokens, proofs, client assertions and Session JWTs. The model and shared
rules are in machine.py.
"""

from __future__ import annotations

from hypothesis import assume
from hypothesis import strategies as st
from hypothesis.stateful import precondition, rule, run_state_machine_as_test

from machine import COVERAGE, MAX_SESSIONS, ApiRules, Base, ConversationRules, MSession, SessionRules, expect
from mock_server import DOMAIN, MockServer
from poppy_client import Es256Key, Poppy, Session, User, ath, random_id


class CoreRules:
    # ---- discovery (3) ----

    @rule()
    def rediscover(self) -> None:
        """Discovery again finds the same issuer and the same documents (3, 3.2)."""
        again = self.poppy.discover(DOMAIN)
        assert again.issuer == self.co.issuer
        assert again.metadata == self.co.metadata
        assert again.conversations == self.co.conversations

    # ---- helpers for the reject rules ----

    def public_url(self) -> str:
        return self.api_base + next(path for path, needed in self.api_ops if not needed)

    def revoke_nothing(self, **options: object) -> object:
        """A revocation of a token the Company never issued: 200 (RFC 7009 2.2), so only the client assertion is tested."""
        return self.poppy.token_request(
            self.co, None, {"token": random_id("rt_"), "token_type_hint": "refresh_token"}, endpoint=self.co.revocation_endpoint, dpop=False, **options
        )

    def dpop_sessions(self) -> list[MSession]:
        return [s for s in self.live() if s.token and s.token.token_type == "DPoP"]

    # ---- reject direction: assertions, proofs and Session JWTs ----

    @precondition(lambda self: self.company is not None)
    @rule(data=st.data())
    def replayed_jti(self, data: st.DataObject) -> None:
        """Reject: a client assertion, DPoP proof or Session JWT the Company has seen (4.1, RFC 9449 11.1, 5.2)."""
        kinds = ["client-assertion"] + (["dpop-token"] if self.co.dpop else []) + (["session-jwt"] if self.live() else [])
        kinds += ["dpop-resource"] if self.dpop_sessions() else []
        kind = data.draw(st.sampled_from(kinds))
        if kind == "client-assertion":
            expect(self.revoke_nothing(), 200)
            expect(self.revoke_nothing(client_assertion=self.poppy.last.client_assertion), 401, "invalid_client")
        elif kind == "dpop-token":
            key = data.draw(st.sampled_from(self.users)).user.dpop_key
            first = self.poppy.refresh(self.co, key, random_id("rt_"))
            expect(first, 400, "invalid_grant")
            replay = self.poppy.last.proof
            form = {"grant_type": "refresh_token", "refresh_token": random_id("rt_")}
            expect(self.poppy.token_request(self.co, key, form, proof=replay), 400, "invalid_dpop_proof")
            kind = "dpop"
        else:
            ms = data.draw(st.sampled_from(self.dpop_sessions() if kind == "dpop-resource" else self.live()))
            url = self.public_url()
            reply = self.poppy.resource(ms.session, "GET", url, self.co)
            self.touch(ms, reply)
            expect(reply, 200)
            if kind == "session-jwt":
                expect(self.poppy.resource(ms.session, "GET", url, self.co, session_jwt=self.poppy.last.session_jwt), 400, "invalid_session")
            else:
                replayed = self.poppy.resource(ms.session, "GET", url, self.co, proof=self.poppy.last.proof)
                expect(replayed, 401, "invalid_dpop_proof")
                kind = "dpop"
        self.violation(f"{kind}.jti-reused")

    @precondition(lambda self: self.company is not None)
    @rule(data=st.data())
    def client_assertion_aud(self, data: st.DataObject) -> None:
        """
        4.1: a client assertion's `aud` is the issuer, as a single string,
        at every endpoint. An endpoint, an array or a near miss is refused
        with `invalid_client`.
        """
        co = self.co
        near = [
            co.issuer, co.token_endpoint, co.revocation_endpoint, co.issuer.rstrip("/"), co.issuer.rstrip("/") + "/",
            co.issuer.upper(), f"https://{DOMAIN}", DOMAIN, self.agent.client_id,
            co.metadata.get("authorization_endpoint", ""), co.metadata.get("device_authorization_endpoint", ""),
        ]
        aud = data.draw(
            st.one_of(st.sampled_from(near), st.text(), st.lists(st.sampled_from(near), max_size=3), st.integers(), st.none())
        )
        reply = self.revoke_nothing(client_assertion=lambda: self.agent.client_assertion(aud))
        if aud == co.issuer and isinstance(aud, str):
            expect(reply, 200)
        else:
            expect(reply, 401, "invalid_client")
            self.violation("client-assertion.aud-array" if isinstance(aud, list) else "client-assertion.aud")

    @precondition(lambda self: self.company is not None)
    @rule()
    def session_header_at_an_oauth_endpoint(self) -> None:
        """Reject: the Session header never goes to an OAuth endpoint (5.2); the mock records it and answers anyway."""
        mu = self.users[0]
        session = Session(mu.user)
        header = self.poppy.session_jwt(self.co, session, "POST", self.co.revocation_endpoint, None)
        expect(self.revoke_nothing(headers={"Poppy-Session": header}), 200)
        self.session_header_misplaced += 1
        self.violation("session-jwt.oauth-endpoint")

    @precondition(lambda self: self.live())
    @rule(data=st.data())
    def tampered_session_jwt(self, data: st.DataObject) -> None:
        """
        Reject: a Session JWT the Company can't accept (5.2, 5.3) is 400
        `invalid_session`, before the Session is looked at: a wrong `typ`,
        signature, `kid`, `aud`, `htm`, `htu` or `ath`, no `sub` or `sid`,
        or a delegation that lasts more than a day or names the User.
        """
        ms = data.draw(st.sampled_from(self.live()))
        user = ms.user.user
        url = self.public_url()
        token = ms.session.token
        kinds = ["typ", "signature", "kid", "aud", "htm", "htu", "sub", "sid", "delegation-lifetime", "delegation-names-user"]
        kind = data.draw(st.sampled_from(kinds + ["ath"]))
        options: dict[str, object] = {}
        violation = f"session-jwt.{kind}"
        if kind == "typ":
            options["header"] = {"typ": data.draw(st.sampled_from(["JWT", "dpop+jwt", "pap-delegation+jwt", "session+jwt"]))}
        elif kind == "signature":
            options["key"] = Es256Key()
        elif kind == "kid":
            options["header"] = {"kid": Es256Key().thumbprint()}
        elif kind == "aud":
            co = self.co
            options["claims"] = {"aud": data.draw(st.sampled_from([co.token_endpoint, self.api_base, f"https://{DOMAIN}", [co.issuer], co.issuer + "x"]))}
        elif kind == "htm":
            options["claims"] = {"htm": data.draw(st.sampled_from(["POST", "get", "PUT"]))}
        elif kind == "htu":
            options["claims"] = {"htu": data.draw(st.sampled_from([url + "x", url.replace("https://", "http://"), self.co.issuer, url + "?q=1"]))}
        elif kind in ("sub", "sid"):
            options["drop"] = (kind,)
        elif kind == "ath":
            # With a token, `ath` of another; without one, any `ath` at all.
            options["claims"] = {"ath": ath(random_id())}
            violation = "session-jwt.ath" if token else "session-jwt.ath-without-token"
        else:
            hours, extra = (48, None) if kind == "delegation-lifetime" else (4, {data.draw(st.sampled_from(["sub", "aud", "user_id"])): user.user_id})
            options["header"] = {"pap_dlg": self.agent.delegation(user.session_key, hours=hours, extra=extra)}
            violation = "delegation.lifetime" if kind == "delegation-lifetime" else "delegation.names-user"

        def tampered(method: str, at: str, sent: str | None) -> str:
            return self.poppy.session_jwt(self.co, ms.session, method, at, sent, **options)  # type: ignore[arg-type]

        reply = self.poppy.resource(ms.session, "GET", url, self.co, session_jwt=tampered)
        expect(reply, 400, "invalid_session")
        self.violation(violation)

    @precondition(lambda self: len(self.users) > 1 and any(s.seen for s in self.users[0].sessions))
    @rule(data=st.data())
    def delegated_key_for_two_users(self, data: st.DataObject) -> None:
        """
        Reject: a delegated key, and its delegation, for one User ID only
        (5.2). The mock records the second User ID and still answers; the
        request starts that User's Session.
        """
        first = self.users[0].user
        mu = data.draw(st.sampled_from(self.users[1:]))
        assume(len(mu.sessions) < MAX_SESSIONS)
        ms = self.new_session(mu)
        header = {"kid": first.session_key.thumbprint(), "pap_dlg": self.poppy.delegation_for(first)}

        def borrowed(method: str, at: str, sent: str | None) -> str:
            return self.poppy.session_jwt(self.co, ms.session, method, at, sent, header=header, key=first.session_key)

        reply = self.poppy.resource(ms.session, "GET", self.public_url(), self.co, session_jwt=borrowed)
        self.touch(ms, reply)
        expect(reply, 200)
        self.violation("delegation.key-shared")

    # ---- reject direction: tokens ----

    @precondition(lambda self: self.dpop_sessions())
    @rule(data=st.data())
    def stolen_access_token(self, data: st.DataObject) -> None:
        """Reject: a DPoP-bound token with a proof from another key is useless (4.5, RFC 9449 7.1)."""
        ms = data.draw(st.sampled_from(self.dpop_sessions()))
        path, _ = data.draw(st.sampled_from(self.api_ops))
        reply = self.poppy.resource(ms.session, "GET", self.api_base + path, self.co, key=Es256Key())
        ms.seen = True  # the Session header was verified first, so the Company has the Session
        expect(reply, 401, "invalid_dpop_proof")
        self.violation("dpop.key-mismatch")

    @precondition(lambda self: self.dpop_sessions())
    @rule(data=st.data())
    def dpop_token_as_bearer(self, data: st.DataObject) -> None:
        """Reject: a DPoP-bound token sent with the Bearer scheme (4.5, RFC 9449 7.1) is `invalid_token`."""
        ms = data.draw(st.sampled_from(self.dpop_sessions()))
        reply = self.poppy.resource(ms.session, "GET", self.api_base + "/orders", self.co, scheme="Bearer")
        expect(reply, 401, "invalid_token")
        self.violation("resource.bearer-scheme")

    @precondition(lambda self: any(s.token for s in self.live()))
    @rule(data=st.data())
    def token_from_another_agent(self, data: st.DataObject) -> None:
        """
        Reject: an access token with another Personal Agent's Session header
        (5.3: the token was issued to the `client_id` that is the JWT's `iss`)
        is `invalid_session`. The other agent's Session is started first.
        """
        ms = data.draw(st.sampled_from([s for s in self.live() if s.token]))
        other = Poppy(self.other_agent, self.http)
        thief = Session(User(), token=ms.session.token, token_type=ms.session.token_type, key=ms.session.key)
        self.other_sids.add(thief.sid)
        reply = other.resource(thief, "GET", self.api_base + "/orders", self.co)
        expect(reply, 400, "invalid_session")
        self.violation("session-jwt.token-other-client")

    @precondition(lambda self: any(g.superseded for u in self.users for g in u.grants))
    @rule(data=st.data())
    def reused_rotated_refresh_token(self, data: st.DataObject) -> None:
        """Reject: a refresh token after the Company rotated it (4.4); with reuse detection, its sign-in is revoked (RFC 9700 4.14.2)."""
        grant = data.draw(st.sampled_from([g for u in self.users for g in u.grants if g.superseded]))
        old = data.draw(st.sampled_from(grant.superseded))
        expect(self.poppy.refresh(self.co, grant.user.user.dpop_key, old), 400, "invalid_grant")
        self.violation("account-token.rotated-reused")
        if self.config["reuseDetection"] and not grant.revoked:
            self.revoked(grant)

    @precondition(lambda self: any(g.revoked for u in self.users for g in u.grants))
    @rule(data=st.data())
    def revoked_refresh_token(self, data: st.DataObject) -> None:
        """Reject: a revoked refresh token is `invalid_grant` (4.4, 4.6)."""
        grant = data.draw(st.sampled_from([g for u in self.users for g in u.grants if g.revoked]))
        expect(self.poppy.refresh(self.co, grant.user.user.dpop_key, grant.current), 400, "invalid_grant")

    @precondition(lambda self: self.live_grants())
    @rule(data=st.data())
    def refresh_token_other_agent(self, data: st.DataObject) -> None:
        """Reject: a refresh token belongs to the `client_id` it was issued to (4.4, RFC 6749 6)."""
        grant = data.draw(st.sampled_from(self.live_grants()))
        other = Poppy(self.other_agent, self.http)
        expect(other.refresh(self.co, Es256Key(), grant.current), 400, "invalid_grant")
        self.violation("account-token.other-client")

    @precondition(lambda self: any(s.bound and any(g.account != s.bound for g in self.live_grants()) for s in self.live()))
    @rule(data=st.data())
    def second_account(self, data: st.DataObject) -> None:
        """
        Reject: one Session, two accounts (5.4: SHOULD start a new Session;
        the mock refuses with `invalid_session`, as a Company MAY). The token
        is a real one, from a refresh of another sign-in.
        """
        ms = data.draw(st.sampled_from([s for s in self.live() if s.bound and any(g.account != s.bound for g in self.live_grants())]))
        grant = data.draw(st.sampled_from([g for g in self.live_grants() if g.account != ms.bound]))
        key = grant.user.user.dpop_key
        body = self.token_body(self.poppy.refresh(self.co, key, grant.current), scope=grant.scope)
        self.rotate(grant, body)
        token = self.token_from(body, grant, grant.scope, key)
        reply = self.poppy.resource(ms.session, "GET", self.api_base + "/orders", self.co, token=token.value, scheme=token.token_type, key=token.key)
        expect(reply, 400, "invalid_session")
        self.violation("session.second-account")

    @precondition(lambda self: self.company is not None)
    @rule(data=st.data())
    def sign_in_without_an_offered_scope(self, data: st.DataObject) -> None:
        """
        Reject: a sign-in MUST include `scope` (4.7), and one asking for a
        scope the issuer doesn't list in `scopes_supported` is `invalid_scope`.
        (A listed scope the type can't grant is left out instead: `sign_in`.)
        """
        kind = data.draw(st.sampled_from([k for k in ("direct", "device", "mediated") if self.co.offered(k)]))
        offered = self.co.offered(kind)
        unoffered = st.sampled_from(["poppy:admin", "poppy:read", "addresses", "orders:read", "openid"]) | st.from_regex(r"[!#-\[\]-~]+", fullmatch=True)
        extra = data.draw(st.lists(unoffered, min_size=1, max_size=2, unique=True))
        assume(not set(extra) <= set(self.co.metadata["scopes_supported"]))
        requested = data.draw(st.just([]) | st.lists(st.sampled_from(offered), unique=True).map(lambda s: s + extra))
        account = self.fixture["accounts"][0]
        key = self.users[0].user.dpop_key
        if kind == "direct":
            url, state, _ = self.poppy.authorization_url(self.co, requested)
            redirect = self.server.hook("approve_authorization", url=url, account=account)["redirect"]
            assert self.poppy.callback(self.co, redirect, state).get("error") == "invalid_scope", redirect
            COVERAGE["sign_in_without_an_offered_scope: direct invalid_scope"] += 1
        elif kind == "device":
            expect(self.poppy.device_start(self.co, requested), 400, "invalid_scope")
        else:
            fields = self.server.hook("mediated_answers", account=account)["fields"]
            expect(self.poppy.mediated_start(self.co, key, requested, fields), 400, "invalid_scope")
        if not requested:
            self.violation("signin.no-scope")


class MockCompanyMachine(Base, SessionRules, ApiRules, ConversationRules, CoreRules):
    pass


def test_mock_company(mock_server: MockServer) -> None:
    run_state_machine_as_test(lambda: MockCompanyMachine(mock_server))
