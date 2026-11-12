"""
The core machine: discovery, Users and Sessions, the three sign-in types,
refresh tokens, the OpenAPI reads, conversations, the version and
extensions each Session declares (3.4), task coverage (9), and the reject
rules for tokens, proofs, client assertions, Session JWTs, versions and
feedback. The model and shared rules are in machine.py.
"""

from __future__ import annotations

import hashlib
import re
import string
import urllib.parse
from typing import Any

from hypothesis import assume
from hypothesis import strategies as st
from hypothesis.stateful import precondition, rule, run_state_machine_as_test

from machine import COVERAGE, MAX_SESSIONS, ApiRules, Base, ConversationRules, MSession, OperatorRules, SessionRules, expect, reached
from mock_server import DOMAIN, MockServer
from poppy_client import Es256Key, Poppy, Session, User, ath, random_id
from strategies import CONFIGS

# 9.3's feedback, as a Company may want it or not, answered 202 or with an alternative (9.2).
CORE_CONFIGS = st.tuples(CONFIGS, st.fixed_dictionaries({"feedback": st.booleans(), "feedbackAlternative": st.booleans()})).map(lambda pair: pair[0] | pair[1])

# Tasks a User's agent couldn't do (9.3: a short phrase, at most 200 characters). ASCII, so "the same task" is
# the same phrase for the model and the Company, whatever their case folding and whitespace.
TASKS = st.sampled_from(["Pay with a gift card", "Move a delivery date", "Split an order", "Change the billing address"]) | st.text(
    alphabet=string.ascii_letters + string.digits + " ", min_size=1, max_size=60
).filter(lambda t: t.strip() != "")
DESCRIPTIONS = st.text(min_size=1, max_size=300)


def phrase(task: str) -> str:
    """One task however it is written: case, spacing and closing punctuation aside (9.3: one report for each task)."""
    return re.sub(r"[.!?]+$", "", re.sub(r"\s+", " ", task.lower().strip()))


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
            options["header"] = {"typ": data.draw(st.sampled_from(["JWT", "dpop+jwt", "poppy-delegation+jwt", "session+jwt"]))}
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
            options["header"] = {"poppy_dlg": self.agent.delegation(user.session_key, hours=hours, extra=extra)}
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
        header = {"kid": first.session_key.thumbprint(), "poppy_dlg": self.poppy.delegation_for(first)}

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
        # The Session header was verified first, so the Company has the Session and its declaration (3.4).
        ms.seen = True
        ms.declared = ms.declared or not ms.ended
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
        the mock refuses with `session_ended`, as a Company MAY). The token
        is a real one, from a refresh of another sign-in.
        """
        ms = data.draw(st.sampled_from([s for s in self.live() if s.bound and any(g.account != s.bound for g in self.live_grants())]))
        grant = data.draw(st.sampled_from([g for g in self.live_grants() if g.account != ms.bound]))
        key = grant.user.user.dpop_key
        body = self.token_body(self.poppy.refresh(self.co, key, grant.current), scope=grant.scope)
        self.rotate(grant, body)
        token = self.token_from(body, grant, grant.scope, key)
        reply = self.poppy.resource(ms.session, "GET", self.api_base + "/orders", self.co, token=token.value, scheme=token.token_type, key=token.key)
        expect(reply, 400, "session_ended")
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
        assume(not set(extra) <= set(self.co.metadata["scopes_supported"]) | set(self.co.resource_scopes))
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


class VersionRules:
    """3.4: `Poppy-Version` and `Poppy-Extensions`, the same on every request of a Session."""

    @precondition(lambda self: self.live())
    @rule(data=st.data())
    def wrong_version(self, data: st.DataObject) -> None:
        """
        Reject: a Session request without `Poppy-Version`, or with a version
        the Company never listed, is `version_unsupported` (400, 3.4). The
        Session header is verified first, so the Company has the Session.
        """
        ms = data.draw(st.sampled_from(self.live()))
        version = data.draw(st.none() | st.sampled_from(["0.3", "0.5", "1.0", "2.0", "0.2"]), label="Poppy-Version")
        before = len(self.transport.log)
        reply = self.poppy.resource(ms.session, "GET", self.public_url(), self.co, version=version)
        self.seen_only(ms)
        expect(reply, 400, "version_unsupported")
        sent, checked = self.sent_since(before)
        self.version_misdeclared += sent
        self.expected += ["version.missing" if version is None else "version.unlisted"] * checked

    @precondition(lambda self: any(s.declared for s in self.live()))
    @rule(data=st.data())
    def extensions_changed_in_session(self, data: st.DataObject) -> None:
        """
        Reject: a Session's `Poppy-Extensions` changed after its first
        request (3.4: "starts a new Session to change them"). The Company
        records it and answers under the Session's first values.
        """
        ms = data.draw(st.sampled_from([s for s in self.live() if s.declared]))
        current = ms.session.extensions_header()
        changed = data.draw(st.sampled_from([None, '"operations";v="3"', '"operations";v="2"', '"mock.test/gift-wrap";v="1"']).filter(lambda v: v != current))
        before = len(self.transport.log)
        reply = self.poppy.resource(ms.session, "GET", self.public_url(), self.co, extensions=changed)
        self.touch(ms, reply)
        expect(reply, 200)
        sent, checked = self.sent_since(before)
        self.extensions_changed += sent
        self.expected += ["version.changed-in-session"] * checked


class TaskRules:
    """Task coverage (9): the tasks response, skills (9.4) and feedback (9.3)."""

    @precondition(lambda self: self.live() and self.co.tasks)
    @rule(data=st.data())
    def get_tasks(self, data: st.DataObject) -> None:
        """
        9: `GET {tasks.endpoint}` with the Session header and no access
        token, signed in or not, is 200 with the excluded tasks (9.1), the
        skill index (9.4) and the feedback endpoint (9.3) the Company has,
        each in the form the text gives. The Session keeps it, for itself only.
        """
        ms = data.draw(st.sampled_from(self.live()))
        reply = self.poppy.tasks(ms.session, self.co)
        self.touch(ms, reply, None)
        expect(reply, 200)
        body = reply.body
        assert isinstance(body, dict), reply.text
        for entry in body.get("excluded_tasks", []):
            assert isinstance(entry.get("task"), str) and entry["task"], entry
            if "alternative" in entry:
                self.check_alternative(entry["alternative"])
        index = body.get("skill_index")
        if index is not None:
            assert isinstance(index.get("$schema"), str) and isinstance(index.get("skills"), list), index
            for skill in index["skills"]:
                for name in ("name", "description", "type", "url", "digest"):
                    assert isinstance(skill.get(name), str), f"a skill without {name} (9.4): {skill}"
                assert re.fullmatch(r"sha256:[0-9a-f]{64}", skill["digest"]), skill
        assert ("feedback" in body) == bool(self.config["feedback"]), body
        if "feedback" in body:
            assert urllib.parse.urlsplit(body["feedback"]["endpoint"]).scheme == "https", body
        ms.tasks = body

    def check_alternative(self, alternative: Any) -> None:
        """9.2: at least one of `instructions` and `references`; a `web` reference is an HTTPS URL."""
        assert isinstance(alternative, dict) and ("instructions" in alternative or "references" in alternative), alternative
        for reference in alternative.get("references", []):
            if reference.get("type") == "web":
                assert urllib.parse.urlsplit(reference["url"]).scheme == "https", reference

    def skills(self) -> list[tuple[MSession, dict[str, Any]]]:
        return [(s, skill) for s in self.live() if s.tasks for skill in (s.tasks.get("skill_index") or {}).get("skills", []) if skill.get("type") == "skill-md"]

    def skill_url(self, skill: dict[str, Any]) -> str:
        """9.4: an entry's `url` resolved against `tasks.endpoint` (RFC 3986 5); HTTPS, as section 3 requires."""
        assert self.co.tasks is not None
        url = urllib.parse.urljoin(self.co.tasks, skill["url"])
        assert urllib.parse.urlsplit(url).scheme == "https", url
        return url

    @precondition(lambda self: self.skills())
    @rule(data=st.data())
    def fetch_skill(self, data: st.DataObject) -> None:
        """9.4: fetch a skill from its resolved `url` with no credentials or Session header, and check its `digest` over the raw bytes."""
        _, skill = data.draw(st.sampled_from(self.skills()))
        response = self.http.get(self.skill_url(skill))
        assert response.status_code == 200, (response.status_code, response.text[:200])
        assert skill["digest"] == "sha256:" + hashlib.sha256(response.content).hexdigest(), "a skill whose bytes don't match its digest (9.4)"
        reached("skill fetched and verified")

    @precondition(lambda self: self.skills())
    @rule(data=st.data())
    def skill_with_session_header(self, data: st.DataObject) -> None:
        """Reject: listing a skill doesn't authorize sending it a Session header (9.4); the Company records it and serves the skill."""
        ms, skill = data.draw(st.sampled_from(self.skills()))
        reply = self.poppy.resource(ms.session, "GET", self.skill_url(skill), self.co, token=None, accept="text/markdown")
        expect(reply, 200)
        self.session_header_misplaced += 1
        self.violation("skills.credentials")

    @precondition(lambda self: [s for s in self.live() if s.tasks and s.token])
    @rule(data=st.data())
    def tasks_with_a_token(self, data: st.DataObject) -> None:
        """Reject: the tasks request carries no access token, even signed in (9); the Company records one and answers."""
        ms = data.draw(st.sampled_from([s for s in self.live() if s.tasks and s.token]))
        reply = self.poppy.tasks(ms.session, self.co, token=ms.session.token)
        self.touch(ms, reply)
        expect(reply, 200)
        self.violation("tasks.token")

    def reporters(self) -> list[MSession]:
        """Sessions whose own tasks response named a feedback endpoint (9: never another Session's)."""
        return [s for s in self.live() if s.tasks and "feedback" in s.tasks]

    def excluded(self, ms: MSession) -> set[str]:
        return {phrase(e["task"]) for e in (ms.tasks or {}).get("excluded_tasks", [])}

    def send_report(self, ms: MSession, task: Any, description: Any) -> Any:
        assert ms.tasks is not None
        body: dict[str, Any] = {}
        if task is not None:
            body["task"] = task
        if description is not None:
            body["description"] = description
        reply = self.poppy.report(ms.session, self.co, ms.tasks["feedback"]["endpoint"], body)
        self.touch(ms, reply, None)
        return reply

    def check_report_answer(self, reply: Any) -> None:
        """9.3: 202 and no body, or, when the Company has a way after all, 200 and an alternative (9.2)."""
        if self.config["feedbackAlternative"]:
            expect(reply, 200)
            self.check_alternative(reply.body)
        else:
            expect(reply, 202)
            assert reply.text == "", reply.text

    @precondition(lambda self: self.reporters())
    @rule(data=st.data())
    def report_feedback(self, data: st.DataObject) -> None:
        """9.3: one report for each task the User's agent couldn't do, never an excluded one, signed in or out, with no token."""
        ms = data.draw(st.sampled_from(self.reporters()))
        task = data.draw(TASKS, label="task")
        assume(phrase(task) not in ms.user.reported and phrase(task) not in self.excluded(ms))
        reply = self.send_report(ms, task, data.draw(DESCRIPTIONS))
        self.check_report_answer(reply)
        ms.user.reported.add(phrase(task))

    @precondition(lambda self: [s for s in self.reporters() if s.user.reported or self.excluded(s)])
    @rule(data=st.data())
    def report_again(self, data: st.DataObject) -> None:
        """
        Reject: a second report about one task (9.3: SHOULD send one for
        each task), or one about a task the Company lists as excluded
        (SHOULD NOT). Each is taken and recorded.
        """
        ms = data.draw(st.sampled_from([s for s in self.reporters() if s.user.reported or self.excluded(s)]))
        assert ms.tasks is not None
        choices = sorted(ms.user.reported) + [e["task"] for e in ms.tasks.get("excluded_tasks", [])]
        task = data.draw(st.sampled_from(choices))
        task = data.draw(st.sampled_from([task, task.upper(), task + ".", "  " + task]))
        reply = self.send_report(ms, task, data.draw(DESCRIPTIONS))
        self.check_report_answer(reply)
        if phrase(task) in self.excluded(ms):
            self.violation("feedback.excluded-task")
        if phrase(task) in ms.user.reported:
            self.violation("feedback.repeated")
        ms.user.reported.add(phrase(task))

    @precondition(lambda self: self.reporters())
    @rule(data=st.data())
    def malformed_report(self, data: st.DataObject) -> None:
        """Reject: a report without `task` or `description`, or longer than 200 and 2,000 characters, is `invalid_request` (9.3)."""
        ms = data.draw(st.sampled_from(self.reporters()))
        kind = data.draw(st.sampled_from(["no task", "no description", "long task", "long description"]))
        task: Any = None if kind == "no task" else ("x" * data.draw(st.integers(201, 400)) if kind == "long task" else "Pay with a gift card")
        description: Any = None if kind == "no description" else ("y" * data.draw(st.integers(2001, 2500)) if kind == "long description" else "No way to apply it.")
        reply = self.send_report(ms, task, description)
        expect(reply, 400, "invalid_request")
        self.violation("feedback.fields")


class MockCompanyMachine(Base, SessionRules, ApiRules, ConversationRules, OperatorRules, CoreRules, VersionRules, TaskRules):
    CONFIG = CORE_CONFIGS


def test_mock_company(mock_server: MockServer) -> None:
    run_state_machine_as_test(lambda: MockCompanyMachine(mock_server))
