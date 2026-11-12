"""
Handoff to a person (8.9) and Direct Conversations (8.10), on top of the
conversation rules: the state (`handoff`, `responder`, `closed`) each action
leads to, handoff requests and cancels, who may open a Direct Conversation
from which parent, accepting a Company's invitation (`user_requested`), what
the parent answers while one is open, retries of every kind of request,
and the events each step adds. machine.py's log checks hold every read to
8.4, 8.5, 8.7, 8.10 and 8.12.
"""

from __future__ import annotations

import json

from hypothesis import assume
from hypothesis import strategies as st
from hypothesis.stateful import precondition, rule, run_state_machine_as_test

from machine import Base, ConversationRules, MConversation, MSession, SessionRules, expect, reached
from mock_server import MockServer
from strategies import CONFIGS, MESSAGE_IDS, honest_text, serialisations

# Small pages too, so reads of longer logs take several (8.5: `has_more`, read again right away).
FLOW_CONFIGS = st.tuples(CONFIGS, st.fixed_dictionaries({"eventPageSize": st.sampled_from([20, 1, 2, 5])})).map(lambda pair: pair[0] | pair[1])

# Staff lines and reasons: what a person or the Company says is free text (8.7, 8.10); the hooks take any non-empty string.
STAFF_TEXT = st.text(min_size=1, max_size=40)


class HandoffDirectRules:
    def open_conversations(self) -> list[MConversation]:
        return [c for c in self.conversations if not c.closed]

    def handoff_targets(self) -> list[tuple[MConversation, MSession]]:
        """Where the honest agent asks for a person, or stops asking: open, and not waiting on a Direct Conversation (8.10)."""
        return [(c, s) for c, s in self.readable() if not c.closed and c.direct_child is None]

    def handoff_request(self, conversation: MConversation, ms: MSession, request_id: str, path: str) -> None:
        """A handoff or cancel accepted (8.3, 8.9): its id is one `as_of_request` may name (8.4)."""
        conversation.requests.append(request_id)
        self.request_accepted(ms, request_id, f"/{conversation.id}/{path}")

    # ---- handoff (8.9) ----

    @precondition(lambda self: self.handoff_targets())
    @rule(data=st.data())
    def hand_off(self, data: st.DataObject) -> None:
        """
        8.9: a handoff request is the request `id` alone, answered 202 with
        `conversation_id` (8.3); `handoff` becomes `pending` while the
        Company looks for someone, `responder` staying `agent` (8.7). When a
        person already handles the conversation there is no one to find:
        nothing changes (our reading; the draft doesn't say).
        """
        conversation, ms = data.draw(st.sampled_from(self.handoff_targets()))
        request_id = self.new_request_id(data, ms.user)
        reply = self.poppy.handoff(ms.session, self.co, conversation.id, request_id)
        self.touch(ms, reply)
        expect(reply, 202)
        assert reply.body == {"conversation_id": conversation.id}, reply.body
        self.handoff_request(conversation, ms, request_id, "handoff")
        if conversation.responder == "agent":
            conversation.handoff = "pending"
        else:
            reached("a person already handles it")

    @precondition(lambda self: self.handoff_targets())
    @rule(data=st.data())
    def cancel_handoff(self, data: st.DataObject) -> None:
        """
        8.9: `handoff/cancel` withdraws a pending handoff, answered 202 with
        `conversation_id`: `handoff` goes back to `none`. With none pending
        it changes nothing.
        """
        conversation, ms = data.draw(st.sampled_from(self.handoff_targets()))
        request_id = self.new_request_id(data, ms.user)
        reply = self.poppy.cancel_handoff(ms.session, self.co, conversation.id, request_id)
        self.touch(ms, reply)
        expect(reply, 202)
        assert reply.body == {"conversation_id": conversation.id}, reply.body
        self.handoff_request(conversation, ms, request_id, "handoff/cancel")
        if conversation.handoff == "pending":
            conversation.handoff = "none"
            reached("cancelled a pending handoff")
        else:
            reached("nothing pending")

    @precondition(lambda self: [c for c in self.conversations if not c.closed])
    @rule(data=st.data())
    def person_joins(self, data: st.DataObject) -> None:
        """A person at the Company joins and writes (the `staff_join` hook): `responder` becomes `human`, and nothing is pending (8.7, 8.9)."""
        conversation = data.draw(st.sampled_from(self.open_conversations()))
        self.server.hook("staff_join", conversation=conversation.id, text=data.draw(STAFF_TEXT))
        conversation.handoff, conversation.responder = "none", "human"
        reached("staff_join")

    @precondition(lambda self: [c for c in self.conversations if c.handoff == "pending"])
    @rule(data=st.data())
    def no_one_available(self, data: st.DataObject) -> None:
        """8.9: no one is available, so `handoff` goes back to `none` with `responder` still `agent`, and the Company Agent says so."""
        conversation = data.draw(st.sampled_from([c for c in self.conversations if c.handoff == "pending"]))
        self.server.hook("staff_unavailable", conversation=conversation.id, text=data.draw(STAFF_TEXT))
        conversation.handoff = "none"
        reached("staff_unavailable")

    @precondition(lambda self: [c for c in self.conversations if not c.closed])
    @rule(data=st.data())
    def company_closes(self, data: st.DataObject) -> None:
        """8.12: the Company can close a conversation too; 8.10: that closes its open Direct Conversation."""
        conversation = data.draw(st.sampled_from(self.open_conversations()))
        self.server.hook("company_close", conversation=conversation.id)
        reached("closed by the Company" + (", with an open Direct Conversation" if conversation.direct_child else ""))
        self.close_in_model(conversation)

    @precondition(lambda self: [c for c in self.conversations if not c.closed and not c.direct])
    @rule(data=st.data())
    def company_asks_for_the_user(self, data: st.DataObject) -> None:
        """8.10: a `user_requested` event with a short `reason`, read back in order (machine.py's log checks)."""
        conversation = data.draw(st.sampled_from([c for c in self.conversations if not c.closed and not c.direct]))
        reason = data.draw(STAFF_TEXT)
        event = self.server.hook("request_user", conversation=conversation.id, reason=reason)["event"]
        conversation.requested.append((event, reason))
        reached("user_requested")

    @precondition(lambda self: [(c, s) for c, s in self.readable() if c.closed])
    @rule(data=st.data())
    def hand_off_closed(self, data: st.DataObject) -> None:
        """Reject: a handoff request or cancel to a closed conversation is `conversation_closed` (8.12, 8.13)."""
        conversation, ms = data.draw(st.sampled_from([(c, s) for c, s in self.readable() if c.closed]))
        request_id = self.new_request_id(data, ms.user)
        send = data.draw(st.sampled_from([self.poppy.handoff, self.poppy.cancel_handoff]))
        reply = send(ms.session, self.co, conversation.id, request_id)
        self.touch(ms, reply)
        expect(reply, 409, "conversation_closed")

    def retryable(self) -> list[tuple[MSession, str]]:
        """Accepted handoffs, cancels and closes, with a live Session of their User."""
        return [(s, rid) for s in self.live() for rid in sorted(s.user.requests) if rid not in s.user.sent]

    @precondition(lambda self: self.retryable())
    @rule(data=st.data())
    def resend_request(self, data: st.DataObject) -> None:
        """
        A retry (8.3) of a handoff, cancel or close: the same id, path and
        body get the original response, 202 with `conversation_id`, and
        change nothing, even after the conversation closed. Who may send it
        is 8.2 and 8.11, as for a read.
        """
        ms, request_id = data.draw(st.sampled_from(self.retryable()))
        path, _ = ms.user.requests[request_id]
        cid, action = path[1:].split("/", 1)
        conversation = self.conversation(cid)
        reply = self.poppy.conversation_post(ms.session, self.co, path, request_id)
        self.touch(ms, reply)
        refused = self.refusal(ms, conversation)
        if refused is not None:
            self.expect_refusal(reply, refused)
            return
        expect(reply, 202)
        assert reply.body == {"conversation_id": cid}, reply.body
        reached(f"{action} retried")

    @precondition(lambda self: self.retryable() and self.handoff_targets())
    @rule(data=st.data())
    def request_id_reused_on_another_path(self, data: st.DataObject) -> None:
        """Reject: a handoff with the id of an accepted handoff, cancel or close on another path is `request_id_conflict` (8.3)."""
        ms, request_id = data.draw(st.sampled_from(self.retryable()))
        targets = [c for c, s in self.readable() if s is ms]
        assume(targets)
        conversation = data.draw(st.sampled_from(targets))
        path = f"/{conversation.id}/handoff"
        assume(ms.user.requests[request_id][0] != path)
        reply = self.poppy.conversation_post(ms.session, self.co, path, request_id)
        self.touch(ms, reply)
        expect(reply, 409, "request_id_conflict")
        self.violation("request.id-reused")

    # ---- Direct Conversations (8.10) ----

    @precondition(lambda self: self.conversations and self.live())
    @rule(data=st.data())
    def open_direct(self, data: st.DataObject) -> None:
        """
        8.10: a Direct Conversation starts like any other, with
        `parent_conversation_id`, and carries the User's own words as
        `human`. The parent MUST be open, the same owner's (8.2), and not a
        Direct Conversation itself, with no other one open; otherwise
        `conversation_not_found`, `conversation_closed`, `invalid_request`
        for a Direct parent, or `direct_conversation_open` naming the open
        one. Who owns the parent is 8.2 and 8.11 (`machine.refusal`). Any
        parent and any Session can be drawn.
        """
        parent = data.draw(st.sampled_from(self.conversations))
        ms = data.draw(st.sampled_from(self.live()))
        request_id = self.new_request_id(data, ms.user)
        message = self.a_message(data, ms.user) | {"author": {"type": "human"}, "text": honest_text(data.draw(st.text(min_size=1)))}
        wait = data.draw(st.sampled_from([None, 0]), label="wait")
        reply = self.poppy.post_message(ms.session, self.co, request_id, data.draw(serialisations(message)), None, parent=parent.id, wait=wait)
        self.touch(ms, reply)
        refused = self.refusal(ms, parent)
        if refused is not None:
            self.expect_refusal(reply, refused)
        elif parent.direct:
            expect(reply, 400, "invalid_request")
        elif parent.closed:
            expect(reply, 409, "conversation_closed")
        elif parent.direct_child is not None:
            expect(reply, 409, "direct_conversation_open")
            assert reply.body.get("conversation_id") == parent.direct_child.id, reply.body
        else:
            expect(reply, 201)
            child = self.started(ms, request_id, message, reply, parent=parent, wait=wait)
            assert child.direct

    def invitations(self) -> list[tuple[MConversation, MSession, str]]:
        """`user_requested` events the honest agent may accept: in an open parent it may use, with no Direct Conversation open."""
        return [
            (c, s, event)
            for c, s in self.readable()
            if not c.closed and not c.direct and c.direct_child is None
            for event, _ in c.requested
            if event not in c.invitations
        ]

    @precondition(lambda self: self.invitations())
    @rule(data=st.data())
    def accept_invitation(self, data: st.DataObject) -> None:
        """
        8.10: accepting a `user_requested` event opens a Direct Conversation
        from both IDs, with the User's first words or without them, in which
        case the Company speaks first; with `wait`, the response is a read
        of it (8.3). The parent's `reason` stays an invitation.
        """
        parent, ms, event = data.draw(st.sampled_from(self.invitations()))
        request_id = self.new_request_id(data, ms.user)
        message = None
        if data.draw(st.booleans(), label="with the User's words"):
            message = {"author": {"type": "human"}, "text": honest_text(data.draw(st.text(min_size=1)))}
        wait = data.draw(st.sampled_from([None, 0, 1]), label="wait")
        raw = data.draw(serialisations(message)) if message is not None else None
        reply = self.poppy.post_message(ms.session, self.co, request_id, raw, None, parent=parent.id, invitation=event, wait=wait)
        self.touch(ms, reply)
        expect(reply, 201)
        child = self.started(ms, request_id, message, reply, parent=parent, invitation=event, wait=wait)
        reached("invitation accepted" + (" with the User's words" if message else ", the Company first"))
        assert child.direct

    @precondition(lambda self: [(c, s, e) for c, s in self.readable() for e, child in c.invitations.items()])
    @rule(data=st.data())
    def accept_invitation_again(self, data: st.DataObject) -> None:
        """8.10: the same parent and event again, in a new request, return the same Direct Conversation, open or closed, without another message."""
        parent, ms, event = data.draw(st.sampled_from([(c, s, e) for c, s in self.readable() for e in c.invitations]))
        child = parent.invitations[event]
        request_id = self.new_request_id(data, ms.user)
        reply = self.poppy.post_message(ms.session, self.co, request_id, None, None, parent=parent.id, invitation=event)
        self.touch(ms, reply)
        refused = self.refusal(ms, child)
        if refused is not None:
            self.expect_refusal(reply, refused)
            return
        expect(reply, 201)
        assert reply.body == {"conversation_id": child.id}, f"accepting {event} again opened another Direct Conversation: {reply.body} (8.10)"
        reached("invitation accepted again")

    @precondition(lambda self: [(c, s) for c, s in self.readable() if not c.closed and not c.direct and c.direct_child is None])
    @rule(data=st.data())
    def accept_what_is_no_invitation(self, data: st.DataObject) -> None:
        """Reject: `user_requested_event_id` that doesn't name a `user_requested` event in that parent is `invalid_request` (8.10)."""
        parent, ms = data.draw(st.sampled_from([(c, s) for c, s in self.readable() if not c.closed and not c.direct and c.direct_child is None]))
        others = [e["id"] for e in parent.log if e.get("type") != "user_requested"] + [e for c in self.conversations if c is not parent for e, _ in c.requested]
        event = data.draw(st.sampled_from(others) | MESSAGE_IDS if others else MESSAGE_IDS)
        assume(event not in [e for e, _ in parent.requested])
        request_id = self.new_request_id(data, ms.user)
        reply = self.poppy.post_message(ms.session, self.co, request_id, None, None, parent=parent.id, invitation=event)
        self.touch(ms, reply)
        expect(reply, 400, "invalid_request")

    @precondition(lambda self: [(c, s) for c, s in self.readable() if c.direct_child is not None])
    @rule(data=st.data())
    def parent_while_direct_is_open(self, data: st.DataObject) -> None:
        """
        8.10: while a Direct Conversation is open, the parent can be read,
        but a message, handoff request or handoff cancel to it is
        `direct_conversation_open`, with the Direct Conversation's id in
        `conversation_id`. A refused request isn't accepted, so no later
        Company message names it in `as_of_request` (8.4).
        """
        conversation, ms = data.draw(st.sampled_from([(c, s) for c, s in self.readable() if c.direct_child is not None]))
        assert conversation.direct_child is not None
        request_id = self.new_request_id(data, ms.user)
        kind = data.draw(st.sampled_from(["message", "handoff", "handoff/cancel"]), label="request")
        if kind == "handoff":
            reply = self.poppy.handoff(ms.session, self.co, conversation.id, request_id)
        elif kind == "handoff/cancel":
            reply = self.poppy.cancel_handoff(ms.session, self.co, conversation.id, request_id)
        else:
            message = self.a_message(data, ms.user)
            reply = self.poppy.post_message(ms.session, self.co, request_id, data.draw(serialisations(message)), conversation.id)
        self.touch(ms, reply)
        expect(reply, 409, "direct_conversation_open")
        assert reply.body.get("conversation_id") == conversation.direct_child.id, reply.body

    def direct_parents(self) -> list[tuple[MConversation, MSession]]:
        return [(c, s) for c, s in self.readable() if not c.closed and not c.direct and c.direct_child is None]

    @precondition(lambda self: self.direct_parents())
    @rule(data=st.data())
    def open_direct_with_agent_words(self, data: st.DataObject) -> None:
        """
        Reject, by our reading of S12: a Direct Conversation opened with the
        agent's own words, not the User's (8.10). The draft gives the Company
        no error, so it is accepted and recorded.
        """
        parent, ms = data.draw(st.sampled_from(self.direct_parents()))
        request_id = self.new_request_id(data, ms.user)
        message = self.a_message(data, ms.user) | {"author": {"type": "agent"}, "text": "The user would like to talk to you."}
        message.pop("as_of_cursor", None)
        reply = self.poppy.post_message(ms.session, self.co, request_id, data.draw(serialisations(message)), None, parent=parent.id)
        self.touch(ms, reply)
        expect(reply, 201)
        self.violation("direct.agent-words")
        self.started(ms, request_id, message, reply, parent=parent)

    @precondition(lambda self: [(c, s) for c, s in self.readable() if c.direct and not c.closed])
    @rule(data=st.data())
    def agent_words_into_direct(self, data: st.DataObject) -> None:
        """Reject, by our reading of S12: the agent's own words sent into an open Direct Conversation, recorded (8.10)."""
        conversation, ms = data.draw(st.sampled_from([(c, s) for c, s in self.readable() if c.direct and not c.closed]))
        request_id = self.new_request_id(data, ms.user)
        message = {"author": {"type": "agent"}, "text": "Summary for the person: the jacket is too thin."}
        reply = self.poppy.post_message(ms.session, self.co, request_id, json.dumps(message), conversation.id)
        self.touch(ms, reply)
        expect(reply, 202)
        self.violation("direct.agent-words-later")
        self.accepted(conversation, ms, request_id, message)
        self.scripted_agent(conversation, ms, message)
        self.check_post(conversation, reply, None, None, "a message")


class HandoffDirectMachine(Base, SessionRules, ConversationRules, HandoffDirectRules):
    CONFIG = FLOW_CONFIGS


def test_handoff_and_direct_conversations(mock_server: MockServer) -> None:
    run_state_machine_as_test(lambda: HandoffDirectMachine(mock_server))
