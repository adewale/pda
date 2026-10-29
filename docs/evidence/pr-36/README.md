# The approval card, before and after Operations 2

The same print order, as a Company returns it, rendered by each revision's own `PoppyCard` and stylesheet:

- `approval-card-before.png`: base `977e3bf146b958e8301fc1963379532d0fdad761`, where the order is an Operations 1 `operation` card.
- `approval-card-after.png`: the initial PR 36 capture, where it is an `approval` card carrying the operation's terms (Ops 5). The second card shows the terms check: the Company's terms name a different number of copies from the request, so the card says so before the User approves.

These are archived static captures. The [original drivers and instructions at their immutable revision](https://github.com/adewale/pda/tree/4a5d2143c2d46a88e37c90e48247b5a7162f2b5e/docs/evidence/pr-36) retain their inputs and reproduction commands. The current tree keeps the images but no longer maintains this separate rendering pipeline.

Use the [application browser journey](../pr-36-conformance/README.md#reproduce) for new evidence; it exercises the production UI and actual approval clicks.

These are static renders of one card each. They don't show the card in the conversation, the needs-you tray, a narrow screen, or what happens when the buttons are pressed; `test/ui/poppy-ui.test.tsx` covers the card's behaviour.
