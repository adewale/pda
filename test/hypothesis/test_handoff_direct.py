"""
Handoff to a person (8.9) and Direct Conversations (8.10), on top of the
conversation rules: the status and responder each action leads to, who may
open a Direct Conversation from which parent, what the parent answers while
one is open, and the events each step adds. machine.py's log checks hold
every read to 8.5, 8.7, 8.10 and 8.12.
"""

from __future__ import annotations

from hypothesis import strategies as st
from hypothesis.stateful import precondition, rule, run_state_machine_as_test

from machine import Base, ConversationRules, MConversation, MSession, SessionRules, expect, reached
from mock_server import MockServer
from strategies import CONFIGS, honest_text, serialisations

# Small pages too, so reads of longer logs take several (8.5: `has_more`, read again right away).
FLOW_CONFIGS = st.tuples(CONFIGS, st.fixed_dictionaries({"eventPageSize": st.sampled_from([20, 1, 2, 5])})).map(lambda pair: pair[0] | pair[1])

# Staff lines and reasons: what a person or the Company says is free text (8.7, 8.10); the hooks take any non-empty string.
STAFF_TEXT = st.text(min_size=1, max_size=40)


class HandoffDirectRules:
    def open_conversations(self) -> list[MConversation]:
        return [c for c in self.conversations if not c.closed]

    # ---- handoff (8.9) ----

    @precondition(lambda self: [(c, s) for c, s in self.readable() if not c.closed and c.direct_child is None])
    @rule(data=st.data())
    def hand_off(self, data: st.DataObject) -> None:
        """
        8.9: the Company answers 202 with `status` and `responder`, and the
        status becomes `queued` while it finds someone, `responder` staying
        `agent` (8.7). When a person already handles the conversation there is
        no one to find: nothing changes (our reading; the draft doesn't say).
        """
        conversation, ms = data.draw(st.sampled_from([(c, s) for c, s in self.readable() if not c.closed and c.direct_child is None]))
        reply = self.poppy.handoff(ms.session, self.co, conversation.id)
        self.touch(ms, reply)
        expect(reply, 202)
        if conversation.responder == "agent":
            conversation.status = "queued"
        else:
            reached("a person already handles it")
        self.check_status(conversation, reply.body, "a handoff")

    @precondition(lambda self: [c for c in self.conversations if not c.closed])
    @rule(data=st.data())
    def person_joins(self, data: st.DataObject) -> None:
        """A person at the Company joins and writes (the `staff_join` hook): `responder` becomes `human` (8.7, 8.9)."""
        conversation = data.draw(st.sampled_from(self.open_conversations()))
        self.server.hook("staff_join", conversation=conversation.id, text=data.draw(STAFF_TEXT))
        conversation.status, conversation.responder = "idle", "human"
        reached("staff_join")

    @precondition(lambda self: [c for c in self.conversations if c.status == "queued"])
    @rule(data=st.data())
    def no_one_available(self, data: st.DataObject) -> None:
        """8.9: no one is available, so the status goes back to `idle` with `responder` still `agent`."""
        conversation = data.draw(st.sampled_from([c for c in self.conversations if c.status == "queued"]))
        self.server.hook("staff_unavailable", conversation=conversation.id, text=data.draw(STAFF_TEXT))
        conversation.status = "idle"
        reached("staff_unavailable")

    @precondition(lambda self: [c for c in self.conversations if not c.closed])
    @rule(data=st.data())
    def company_closes(self, data: st.DataObject) -> None:
        """8.12: the Company can close a conversation too; 8.10: that closes its open Direct Conversation."""
        conversation = data.draw(st.sampled_from(self.open_conversations()))
        self.server.hook("company_close", conversation=conversation.id)
        reached("closed by the Company" + (", with an open Direct Conversation" if conversation.direct_child else ""))
        self.close_in_model(conversation)

    @precondition(lambda self: [c for c in self.conversations if not c.closed])
    @rule(data=st.data())
    def company_asks_for_the_user(self, data: st.DataObject) -> None:
        """8.10: a `user_requested` event with a short `reason`, read back in order (machine.py's log checks)."""
        conversation = data.draw(st.sampled_from(self.open_conversations()))
        reason = data.draw(STAFF_TEXT)
        self.server.hook("request_user", conversation=conversation.id, reason=reason)
        conversation.requested.append(reason)
        reached("user_requested")

    @precondition(lambda self: [(c, s) for c, s in self.readable() if c.closed])
    @rule(data=st.data())
    def hand_off_closed(self, data: st.DataObject) -> None:
        """Reject: a handoff to a closed conversation is `conversation_closed` (8.13)."""
        conversation, ms = data.draw(st.sampled_from([(c, s) for c, s in self.readable() if c.closed]))
        reply = self.poppy.handoff(ms.session, self.co, conversation.id)
        self.touch(ms, reply)
        expect(reply, 409, "conversation_closed")

    # ---- Direct Conversations (8.10) ----

    @precondition(lambda self: self.conversations and self.live())
    @rule(data=st.data())
    def open_direct(self, data: st.DataObject) -> None:
        """
        8.10: a Direct Conversation starts like any other, with
        `parent_conversation_id`, and carries the User's own words as
        `human`. The parent MUST be open, the same owner's (8.2), and not a
        Direct Conversation itself, with no other one open; otherwise
        `conversation_not_found`, `conversation_closed` or
        `direct_conversation_open` naming the open one. Who owns the parent
        is 8.2 and 8.11 (`machine.refusal`: S17 lets any User signed in to
        the account it used continue it). Any parent and any Session can be
        drawn.
        """
        parent = data.draw(st.sampled_from(self.conversations))
        ms = data.draw(st.sampled_from(self.live()))
        message = self.a_message(data, ms.user) | {"author": {"type": "human"}, "text": honest_text(data.draw(st.text(min_size=1)))}
        reply = self.poppy.post_message(ms.session, self.co, data.draw(serialisations(message)), None, parent=parent.id)
        self.touch(ms, reply)
        refused = self.refusal(ms, parent)
        if refused is not None:
            self.expect_refusal(reply, refused)
        elif parent.direct:
            expect(reply, 404, "conversation_not_found")
        elif parent.closed:
            expect(reply, 409, "conversation_closed")
        elif parent.direct_child is not None:
            expect(reply, 409, "direct_conversation_open")
            assert reply.body.get("conversation_id") == parent.direct_child.id, reply.body
        else:
            expect(reply, 201)
            child = self.started(ms, message, reply, parent=parent)
            assert child.direct

    @precondition(lambda self: [(c, s) for c, s in self.readable() if c.direct_child is not None])
    @rule(data=st.data())
    def parent_while_direct_is_open(self, data: st.DataObject) -> None:
        """
        8.10: while a Direct Conversation is open, the parent can be read,
        but a message or handoff to it is `direct_conversation_open`, with
        the Direct Conversation's id in `conversation_id`.
        """
        conversation, ms = data.draw(st.sampled_from([(c, s) for c, s in self.readable() if c.direct_child is not None]))
        assert conversation.direct_child is not None
        if data.draw(st.booleans(), label="handoff"):
            reply = self.poppy.handoff(ms.session, self.co, conversation.id)
        else:
            message = self.a_message(data, ms.user)
            reply = self.poppy.post_message(ms.session, self.co, data.draw(serialisations(message)), conversation.id)
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
        message = self.a_message(data, ms.user) | {"author": {"type": "agent"}, "text": "The user would like to talk to you."}
        reply = self.poppy.post_message(ms.session, self.co, data.draw(serialisations(message)), None, parent=parent.id)
        self.touch(ms, reply)
        expect(reply, 201)
        self.violation("direct.agent-words")
        self.started(ms, message, reply, parent=parent)

    @precondition(lambda self: [(c, s) for c, s in self.readable() if c.direct and not c.closed])
    @rule(data=st.data())
    def agent_words_into_direct(self, data: st.DataObject) -> None:
        """Reject, by our reading of S12: the agent's own words sent into an open Direct Conversation, recorded (8.10)."""
        conversation, ms = data.draw(st.sampled_from([(c, s) for c, s in self.readable() if c.direct and not c.closed]))
        message = {"id": self.new_message_id(data, ms.user), "author": {"type": "agent"}, "text": "Summary for the person: the jacket is too thin."}
        reply = self.poppy.post_message(ms.session, self.co, data.draw(serialisations(message)), conversation.id)
        self.touch(ms, reply)
        expect(reply, 202)
        self.violation("direct.agent-words-later")
        self.accepted(conversation, ms, message)
        self.scripted_agent(conversation, ms, message)
        self.check_status(conversation, reply.body, "a message")


class HandoffDirectMachine(Base, SessionRules, ConversationRules, HandoffDirectRules):
    CONFIG = FLOW_CONFIGS


def test_handoff_and_direct_conversations(mock_server: MockServer) -> None:
    run_state_machine_as_test(lambda: HandoffDirectMachine(mock_server))
