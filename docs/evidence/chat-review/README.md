# Chat review: outcomes on their steps, uploads on one card

These captures render the production `Workspace` (`src/ui/shell.tsx`) and the page's own styles with one fixture, `fixture.tsx`, at the base commit and at this branch. The fixture replaces the agent's socket with a fixed session: a person asks a print shop for ten 4×6 prints, the agent uploads each photo after approval, one photo (a GIF) is refused with 422 `invalid_image`, and the shop proposes an order. Every name, domain and address is an example (`prints.example`, `ada@example.com`), and the photos are ffmpeg test patterns that `capture.mjs` makes. No recording, screenshot or photo from a real session is used.

Regenerate, from a checkout with its dependencies installed and Node 24:

```sh
node docs/evidence/chat-review/capture.mjs --out <dir>
```

For the base images, check out the base commit in another directory, copy this folder into it at the same path, link `node_modules`, and pass `--root <that checkout>`. Each run writes `receipt.json` with the commit, the browser and a SHA-256 for every image. Captures are 1280×900 (desktop) and 390×844 (phone), light theme, reduced motion, device scale factor 1, in headless Chromium.

## The journey, filmed

`before-flow.mp4` and `after-flow.mp4` (and a GIF of each, at 960 px and 6 frames a second) follow the reported run from start to finish on the fixture's `flow` scene: ten photos waiting, the person's decisions, the shop refusing the GIF, an address typed into the composer, the order approved, and its checkout. The page and its clicks are real. The agent is the fixture's script, which answers the frames the page sends the way the agent does: one notice per photo decided on its own card, one for a batch. The pointer is drawn in, since headless Chromium has none.

```sh
node docs/evidence/chat-review/record.mjs --out <dir> --name after-flow
```

`record.mjs` clicks whatever the checkout offers: "Send 10 photos" on the batch card, or Approve on each of the ten cards at the base commit. Each frame lasts until the next was taken, so the film keeps the page's own timing. Before: about 40 seconds, ten clicks, and the agent's messages pushed above a stack of receipts. After: about 29 seconds, one click, each outcome on its step, and the agent's last message at the bottom.

## Stills

| Scene | What to compare |
| --- | --- |
| `chat` | Before: each upload's receipt, with the store's raw JSON and signed preview links, stacked under the agent's newest message. After: each outcome on the step that asked for it, with the status code and a few facts; the failed photo with its code and **Ask your agent to try again**; the agent's message last. |
| `batch` | Before: "10 requests", one photo per card. After: one card with a tile per photo, one unticked, and "Send 9 of 10 photos". Desktop and phone. |
| `order` | Before: Approve with the total inside the Company's paragraph. After: the total large and on the button, the terms lined up. |
| `ordered` | Before: the finished order as a receipt at the bottom. After: in the conversation by its time, with checkout and **Ask your agent to check on it**. |
| `activity` | Before: ten rows. After: one row for the ten uploads, "9 done · 1 failed", which opens to each. |
| `companies` | Before: "No Companies yet" after an order placed without signing in. After: the Company, "Used without signing in". |

The before images use the same fixture, so fields the base commit doesn't know (`batchKey`, `at`, `total`) are ignored there, as an older page would ignore them. What the images and films can't show: the agent sending each photo once and telling the model once (`test/print-journey.test.ts`), the order of events on a real socket, other browsers, dark mode, or whether people approve more carefully with one card than with ten.
