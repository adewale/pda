# Needs-you panel comparison

These captures use the production `Workspace` and its styles with the same local
component fixture: one pending Print with Poppy sign-in, `poppy:read` access,
and three chat messages. The identity and company domain are examples. Fetches
and session callbacks are stubbed; no live account or sign-in flow is involved.

- Before: `42a464871bc02e6396428a153a2e0d9befb6699d`.
- After: `b42b5700c23cab34828c9b36cb2bdb24b4f15a31`.
- Browser: installed Chromium on Linux, light theme, device scale factor 1.
- Desktop: 1440 × 1000. Mobile portrait: 390 × 844; landscape: 844 × 390.
  These are viewport captures, not physical-device tests.

`before-desktop.png` shows the request above the transcript. In
`after-desktop.png`, the same request appears in a single panel docked above the
composer. The conversation remains undimmed, and the composer stays available.
`after-dismissed.png` shows the pending count after collapse. The
`mobile-portrait.png` and `mobile-landscape.png` captures show the same panel in
both orientations. Its body scrolls within the height limit while its actions
stay visible.

`interaction.gif` records a request arriving while a draft is being written,
collapse, manual reopen, and Escape. It was captured at 960 × 720 and encoded
at 720 × 540, 15 fps. The draft is kept throughout; no approval is sent.

Browser assertions check that arrival retains composer focus, Tab can leave the
panel, Escape acts within the panel, the panel stays above the composer in both
mobile orientations, and no horizontal overflow occurs. Dark themes and reduced
motion were also checked. Workspace tests cover revised terms, preserved sign-in
input, collapsed counts, and focus recovery when a request disappears.

These captures show placement and interaction. They do not establish production
authentication behavior, usability improvements, or support across browsers.
