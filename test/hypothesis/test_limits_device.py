"""
Rate limits (5.6) and Device Sign-In's polling (4.3, RFC 8628 3.4, 3.5),
both on the agent's clock (poppy_client.Clock), which moves only when the
agent waits, so every timing here is exact and costs nothing.

Rate limits: the `rate_limit` hook makes the Company answer the next n
token or resource requests with 429 and `Retry-After`. The model replays
the Company's limiter over every request the client sent and holds each
answer to it: which got 429, with which `Retry-After`. The client shares
one limiter for the Company (Guides "Rate limits"), so after a 429 it sends
nothing until the `Retry-After` has passed; the MUST (5.6) is that it
doesn't send *the request* again sooner. The reject rules resend the same
request too soon, and send a different one.

Device Sign-In: polls every `interval` seconds, `slow_down` adds 5 seconds
for this and every later poll, and polling stops after a final answer
(`access_denied`, `expired_token`, or the tokens). The model tracks each
device request through the User's decision, the clock and the polls; the
tokens go to a Session as any sign-in's do (5.4: a sign-in names no Session).
"""

from __future__ import annotations

import math
import urllib.parse
from dataclasses import dataclass

from hypothesis import strategies as st
from hypothesis.stateful import invariant, precondition, rule, run_state_machine_as_test

from machine import DEVICE_GRANTS, ApiRules, Base, MGrant, MUser, SessionRules, WarmUp, expect, reached
from mock_server import MockServer
from poppy_client import Exchange, random_id
from strategies import CONFIGS

LIMITS_CONFIGS = st.tuples(
    CONFIGS,
    st.fixed_dictionaries({"deviceInterval": st.integers(1, 10), "deviceExpiresIn": st.sampled_from([5, 30, 120, 600])}),
).map(lambda pair: pair[0] | pair[1])


def limit_kind(exchange: Exchange) -> str | None:
    """
    Which of the mock's limits a request counts against (its `rateLimit`
    calls in test/mock-company): `token` for the token, device and
    revocation endpoints (Mediated Sign-In among them, a grant there);
    `other` for API, conversation, feedback and MCP requests; `page` for the
    website; none for discovery, metadata and the browser join.
    """
    parts = urllib.parse.urlsplit(exchange.url)
    sub = (parts.hostname or "").split(".")[0]
    path, method = parts.path, exchange.method
    if sub == "auth":
        return "token" if method == "POST" and path in ("/oauth/token", "/oauth/revoke", "/oauth/device") else None
    if sub == "mcp":
        return "other" if path == "/mcp" else None
    if sub == "api":
        return None if (method == "GET" and (path == "/openapi.json" or path.startswith("/.well-known/"))) else "other"
    if sub == "cdn" or path.startswith("/.well-known/") or path.startswith("/poppy/browser-session") or path == "/poppy/excluded-tasks.json":
        return None
    return "page" if method == "GET" or (method == "POST" and path == "/account/address") else None


@dataclass(eq=False)
class MDevice:
    user: MUser
    device_code: str
    user_code: str
    interval: int  # seconds, plus 5 for every slow_down (RFC 8628 3.5)
    expires_at_ms: int
    scopes: list[str]  # as requested
    grantable: list[str]  # what of them Device Sign-In can grant (RFC 6749 3.3)
    decision: str = "pending"  # pending, approved, denied, done
    account: str | None = None
    granted: list[str] | None = None
    last_poll_ms: int | None = None
    slowed: bool = False
    final: str | None = None  # the final answer the agent got: it stops polling (4.3)


class LimitRules:
    def init_limits(self) -> None:
        self.counts = {"token": 0, "other": 0, "page": 0}
        self.limits = {"token": 0, "other": 0, "page": 0}
        self.retry_after_s = 1
        self.until_ms = 0
        self.replayed = 0  # log entries the invariant has replayed
        self.too_soon_allowed = 0  # requests inside a Retry-After a reject rule sent on purpose
        self.devices: list[MDevice] = []

    def wait_out_limits(self) -> None:
        if self.clock.now_ms() < self.transport.blocked_until_ms:
            self.clock.sleep((self.transport.blocked_until_ms - self.clock.now_ms()) / 1000)

    def limit_pending(self, kind: str) -> bool:
        return self.counts[kind] < self.limits[kind]

    @invariant()
    def answers_match_the_rate_limits(self) -> None:
        """
        Replay the Company's limiter over every request since the last
        step: a request inside an earlier `Retry-After` is 429 with what is
        left of it; otherwise it counts against its limit, and the first n
        after the hook are 429 with the hook's `Retry-After`. Every 429
        carries `Retry-After` (5.6).
        """
        if self.company is None:
            return
        for exchange in self.transport.log[self.replayed:]:
            self.replayed += 1
            kind = limit_kind(exchange)
            if kind is None:
                assert exchange.status != 429, exchange
                continue
            if exchange.at_ms < self.until_ms:
                assert self.too_soon_allowed > 0, f"the client sent {exchange.method} {exchange.url} inside a Retry-After"
                self.too_soon_allowed -= 1
                assert exchange.status == 429, exchange
                assert exchange.retry_after == max(1, math.ceil((self.until_ms - exchange.at_ms) / 1000)), exchange
                continue
            self.counts[kind] += 1
            if self.counts[kind] <= self.limits[kind]:
                assert exchange.status == 429, f"{exchange.method} {exchange.url}: the hook's limit, but {exchange.status}"
                assert exchange.retry_after == self.retry_after_s, exchange
                self.until_ms = exchange.at_ms + self.retry_after_s * 1000
            else:
                assert exchange.status != 429, f"{exchange.method} {exchange.url}: 429 the model didn't expect"

    # ---- rate limits (5.6) ----

    @precondition(lambda self: self.company is not None)
    @rule(data=st.data())
    def company_limits(self, data: st.DataObject) -> None:
        """The next n token or resource requests get 429 with `Retry-After` (the `rate_limit` hook)."""
        self.answers_match_the_rate_limits()
        kind = data.draw(st.sampled_from(["token", "other"]))
        n = data.draw(st.integers(1, 3))
        retry_after = data.draw(st.integers(1, 5))
        self.server.hook("rate_limit", endpoint="token" if kind == "token" else "resource", requests=n, retry_after=retry_after)
        self.limits[kind] = self.counts[kind] + n
        self.retry_after_s = retry_after
        reached(f"{kind} limited")

    @precondition(lambda self: self.live())
    @rule(data=st.data())
    def resend_too_soon(self, data: st.DataObject) -> None:
        """
        Reject: the Personal Agent MUST wait at least `Retry-After` before
        sending the request again (5.6). The same request resent at once is
        429 again, and recorded; after the wait it goes through.
        """
        ms = data.draw(st.sampled_from(self.live()))
        self.wait_out_limits()
        self.answers_match_the_rate_limits()
        retry_after = data.draw(st.integers(1, 5))
        self.server.hook("rate_limit", endpoint="resource", requests=1, retry_after=retry_after)
        self.limits["other"] = self.counts["other"] + 1
        self.retry_after_s = retry_after
        url = self.api_base + "/products"
        self.transport.ignore_limits = True
        try:
            expect(self.poppy.resource(ms.session, "GET", url, self.co, retry_limited=False), 429)
            self.clock.sleep(data.draw(st.integers(0, retry_after * 1000 - 1)) / 1000)
            self.too_soon_allowed += 1
            expect(self.poppy.resource(ms.session, "GET", url, self.co, retry_limited=False), 429)
            self.violation("rate-limit.retry-after-ignored")
        finally:
            self.transport.ignore_limits = False
        reply = self.poppy.resource(ms.session, "GET", url, self.co)
        self.touch(ms, reply)
        expect(reply, 200)

    @precondition(lambda self: self.live())
    @rule(data=st.data())
    def another_request_inside_retry_after(self, data: st.DataObject) -> None:
        """
        5.6's MUST is about sending *the request* again. After a 429 on a
        token request, a different request (an API read) inside its
        `Retry-After` breaks only the Guides' advice to share a Company's
        limits across tasks: the Company may still answer 429, and records
        a warning, not the MUST.
        """
        ms = data.draw(st.sampled_from(self.live()))
        self.wait_out_limits()
        self.answers_match_the_rate_limits()
        retry_after = data.draw(st.integers(1, 5))
        self.server.hook("rate_limit", endpoint="token", requests=1, retry_after=retry_after)
        self.limits["token"] = self.counts["token"] + 1
        self.retry_after_s = retry_after
        self.transport.ignore_limits = True
        try:
            form = {"token": random_id("rt_"), "token_type_hint": "refresh_token"}
            expect(self.poppy.token_request(self.co, None, form, endpoint=self.co.revocation_endpoint, dpop=False, retry_limited=False), 429)
            self.too_soon_allowed += 1
            expect(self.poppy.resource(ms.session, "GET", self.api_base + "/products", self.co, retry_limited=False), 429)
            self.violation("rate-limit.shared-limit-ignored")
        finally:
            self.transport.ignore_limits = False

    # ---- Device Sign-In polling (4.3) ----

    @precondition(lambda self: self.co.offered("device"))
    @rule(data=st.data())
    def device_start(self, data: st.DataObject) -> None:
        """4.3 step 1: the device authorization response has the codes, `verification_uri`, `expires_in` and, here, `interval`."""
        mu = data.draw(st.sampled_from(self.users))
        scopes = data.draw(st.lists(st.sampled_from(self.co.offered("device")), min_size=1, unique=True))
        grantable = [scope for scope in scopes if scope in DEVICE_GRANTS]
        if not grantable:
            expect(self.poppy.device_start(self.co, scopes), 400, "invalid_scope")
            return
        body = expect(self.poppy.device_start(self.co, scopes), 200).body
        for name in ("device_code", "user_code", "verification_uri", "expires_in"):
            assert name in body, f"device authorization response without {name} (RFC 8628 3.2)"
        at = self.transport.log[-1].at_ms
        interval = body.get("interval", 5)  # RFC 8628 3.2: 5 seconds when absent
        device = MDevice(mu, body["device_code"], body["user_code"], interval, at + body["expires_in"] * 1000, scopes, grantable)
        self.devices.append(device)
        # The User may act on the code at once, or later, between polls (`user_decides`).
        if data.draw(st.booleans(), label="the User acts at once"):
            self.decide(data, device)

    def undecided(self) -> list[MDevice]:
        return [d for d in self.devices if d.decision == "pending" and d.final is None and self.clock.now_ms() < d.expires_at_ms]

    @precondition(lambda self: self.undecided())
    @rule(data=st.data())
    def user_decides(self, data: st.DataObject) -> None:
        """4.3 step 2: the User approves some or all of the scopes, for an account, or declines."""
        self.decide(data, data.draw(st.sampled_from(self.undecided())))

    def decide(self, data: st.DataObject, device: MDevice) -> None:
        if data.draw(st.booleans(), label="approve"):
            device.account = data.draw(st.sampled_from(self.fixture["accounts"]))
            device.granted = data.draw(st.just(device.grantable) | st.lists(st.sampled_from(device.grantable), unique=True))
            self.server.hook("approve_device", user_code=device.user_code, account=device.account, scopes=device.granted)
            device.decision = "approved"
        else:
            self.server.hook("deny_device", user_code=device.user_code)
            device.decision = "denied"

    @precondition(lambda self: self.company is not None)
    @rule(seconds=st.sampled_from([0.25, 1, 5, 60, 600]) | st.floats(0, 900, allow_nan=False))
    def time_passes(self, seconds: float) -> None:
        """The agent waits: rate limits lapse, devices expire."""
        self.clock.sleep(seconds)

    def pollable(self) -> list[MDevice]:
        return [d for d in self.devices if d.final is None]

    @precondition(lambda self: self.pollable())
    @rule(data=st.data())
    def device_poll(self, data: st.DataObject) -> None:
        """
        4.3 step 3, honest: every `interval` seconds, until a final answer.
        Pending is `authorization_pending`; declined is `access_denied`;
        past `expires_in`, `expired_token`; approved, the tokens, for a
        Session they fit (5.4).
        """
        device = data.draw(st.sampled_from(self.pollable()))
        if device.last_poll_ms is not None:
            due = device.last_poll_ms + device.interval * 1000
            if self.clock.now_ms() < due:
                self.clock.sleep((due - self.clock.now_ms()) / 1000)
        key = device.user.user.dpop_key
        reply = self.poppy.device_poll(self.co, key, device.device_code)
        at = self.transport.log[-1].at_ms
        if device.decision == "denied":
            expect(reply, 400, "access_denied")
            device.final = "access_denied"
            return
        if at >= device.expires_at_ms:
            expect(reply, 400, "expired_token")
            device.final = "expired_token"
            return
        device.last_poll_ms = at
        if device.decision == "pending":
            expect(reply, 400, "authorization_pending")
            return
        assert device.account is not None and device.granted is not None
        body = self.token_body(reply, scope=frozenset(device.granted), sign_in=True, requested=device.scopes)
        grant = MGrant(device.user, device.account, frozenset(device.granted), body["refresh_token"])
        device.user.grants.append(grant)
        ms = self.target_session(data, device.user, device.account)
        self.set_token(ms, self.token_from(body, grant, frozenset(device.granted), key))
        device.decision, device.final = "done", "done"

    def too_soon(self) -> list[MDevice]:
        return [
            d
            for d in self.pollable()
            if d.decision != "denied" and d.last_poll_ms is not None and self.clock.now_ms() + d.interval * 1000 < d.expires_at_ms
        ]

    @precondition(lambda self: not self.limit_pending("token") and self.too_soon())
    @rule(data=st.data())
    def poll_too_soon(self, data: st.DataObject) -> None:
        """
        Reject: a poll sooner than `interval` after the last is `slow_down`,
        and the interval grows by 5 seconds for every later poll (RFC 8628
        3.5, MUST); polling too soon again after that is recorded. (The mock
        allows 250 ms of jitter, so the draw stays 300 ms short of the interval.)
        """
        device = data.draw(st.sampled_from(self.too_soon()))
        assert device.last_poll_ms is not None
        self.wait_out_limits()
        elapsed = self.clock.now_ms() - device.last_poll_ms
        early = device.interval * 1000 - 300
        if elapsed < early:
            self.clock.sleep(data.draw(st.integers(0, early - elapsed)) / 1000)
        if self.clock.now_ms() - device.last_poll_ms >= early:
            return  # time already passed: this poll wouldn't be too soon
        reply = self.poppy.device_poll(self.co, device.user.user.dpop_key, device.device_code)
        expect(reply, 400, "slow_down")
        if device.slowed:
            self.violation("device.too-fast")
        device.slowed = True
        device.interval += 5
        device.last_poll_ms = self.transport.log[-1].at_ms

    @precondition(lambda self: [d for d in self.devices if d.final is not None])
    @rule(data=st.data())
    def poll_after_the_end(self, data: st.DataObject) -> None:
        """Reject: the agent stops asking after `access_denied`, `expired_token` or the tokens (4.3); asking again is recorded."""
        device = data.draw(st.sampled_from([d for d in self.devices if d.final is not None]))
        reply = self.poppy.device_poll(self.co, device.user.user.dpop_key, device.device_code)
        if device.decision == "done":
            expect(reply, 400, "invalid_grant")
            self.violation("device.polled-after-final")
        elif device.decision == "denied":
            expect(reply, 400, "access_denied")
            self.violation("device.polled-after-final")
        else:
            expect(reply, 400, "expired_token")
            self.violation("device.polled-after-expiry")


class LimitsDeviceMachine(WarmUp, Base, SessionRules, ApiRules, LimitRules):
    CONFIG = LIMITS_CONFIGS

    def __init__(self, server: MockServer) -> None:
        super().__init__(server)
        self.init_limits()


def test_rate_limits_and_device_polling(mock_server: MockServer) -> None:
    run_state_machine_as_test(lambda: LimitsDeviceMachine(mock_server))
