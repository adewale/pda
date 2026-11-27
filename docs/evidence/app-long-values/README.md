# The app's notices and protocol view with long URLs

These captures render the production `Workspace` (`src/ui/shell.tsx`) and the page's own styles with one fixture, `fixture.tsx`, at the base commit and at this branch ([decision 56](../../decisions.md)). The fixture replaces the agent's socket with a fixed session: two notices about departures (a protected resource metadata URL that led to a sign-in page on another host, and an operation whose `operation_id` was too long), an approval to an upload URL on a long host, and a protocol log of three exchanges with long URLs. Every name, domain and URL is an example. No recording or screenshot from a real session is used.

A notice from this branch's agent carries the departure's parts as `problem` beside a lead sentence; the base agent put the whole diagnostic in `text`. The fixture sends each checkout what its own agent would send, telling them apart by whether the checkout has `src/ui/rich.tsx`.

| Image | What to compare |
| --- | --- |
| `before-notices-phone.png`, `after-notices-phone.png` | Before: each notice is one run of text, and a URL breaks wherever the line ends (`example_idp_production_t` / `enant_1`). After: a lead sentence, then the subject, then Expected and Got apart; each URL in code with its host in bold, breaking after a slash, its long tenant segment shortened. |
| `before-notices-desktop.png`, `after-notices-desktop.png` | The same at 1280 px, where the approval card below shows its long upload host. |
| `before-protocol-phone.png`, `after-protocol-phone.png` | Before: "Copy as text" and "Download .txt"; a request URL breaks mid-word (`poppy.j` / `son`) and a URL in a result reads as prose. After: "Copy as Markdown" as well, and every URL set as a value, the host in bold, breaking between segments, a long operation id shortened in its middle with the whole URL in the tooltip. |
| `before-protocol-desktop.png`, `after-protocol-desktop.png` | The same at 1280 px. |

Regenerate, from a checkout with its dependencies installed and Node 24:

```sh
node docs/evidence/app-long-values/capture.mjs --out <dir> --prefix after-
```

For the base images, check out the base commit in another directory, copy this folder into it at the same path, link `node_modules`, and pass `--root <that checkout> --prefix before-`. Each run writes a receipt with the commit, the browser, a SHA-256 for every image and how far each page overflows its width. Captures are 390 px (phone, full page) and 1280×900 (desktop), light theme, reduced motion, device scale factor 2, in headless Chromium.

Neither revision overflows at these widths: the base page already let a line break anywhere. What changes is where it breaks and what reads as a value. What the images can't show: dark mode, other browsers, the tooltip, or what "Copy as Markdown" puts on the clipboard (`test/ui/protocol.test.tsx` checks that).
