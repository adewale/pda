# The approval card, before and after Operations 2

The same print order, as a Company returns it, rendered by each revision's own `PoppyCard` and stylesheet:

- `approval-card-before.png`: base `977e3bf146b958e8301fc1963379532d0fdad761`, where the order is an Operations 1 `operation` card.
- `approval-card-after.png`: this branch, where it is an `approval` card carrying the operation's terms (Ops 5). The second card shows the terms check: the Company's terms name a different number of copies from the request, so the card says so before the User approves.

Both come from `fixtures.mjs`, built by `build.sh` with Vite, React and Tailwind from that revision's `src/`, and captured by `shoot.cjs` in the pre-installed Chromium at 640 px wide, 2× scale, `en-US`, UTC, with no page errors:

```sh
docs/evidence/pr-36/build.sh <checkout> <base|head> <outdir>
node docs/evidence/pr-36/shoot.cjs <outdir> <png>
```

`build.sh` writes a `.shot/` folder into the checkout and deletes it after the build.

These are static renders of one card each. They don't show the card in the conversation, the needs-you tray, a narrow screen, or what happens when the buttons are pressed; `test/ui/poppy-ui.test.tsx` covers the card's behaviour.
