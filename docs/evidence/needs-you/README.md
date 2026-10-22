# Needs-you sheet comparison

These captures use the production `Workspace` and its styles with the same local
component fixture: one pending Print with Poppy sign-in, `poppy:read` access,
and three chat messages. The identity and company domain are examples. Fetches
and session callbacks are stubbed; no live account or sign-in flow is involved.

- Before: `42a464871bc02e6396428a153a2e0d9befb6699d`.
- After: `33fd73868ae91f48dc6b372a14cd4cdce2c3fd99`.
- Browser: installed Chromium on Linux, light theme, device scale factor 1.
- Desktop screenshots: 1440 × 1000. Mobile portrait: 390 × 844; landscape: 844 × 390.
- Mobile captures enable touch and mobile emulation. Their source is
  `1948c662013cfe91f347ac5ca7a7ef93e0714b4a`, whose UI matches the after revision above.

`before-desktop.png` shows the request above the transcript. In
`after-desktop.png`, the same request opens in a modal at the bottom of the
viewport. `after-dismissed.png` shows the pending count above the message box;
closing the sheet leaves the request there. `mobile-portrait.png` and
`mobile-landscape.png` show the same card in both phone orientations. In
landscape, the card's body scrolls within the height limit while its actions
stay visible. Both orientations were checked for horizontal overflow and a
reachable sign-in action.

`interaction.gif` records opening from the pending-count button, closing with
the close button, reopening, and closing with Escape. It was captured at
960 × 720 and encoded at 720 × 540, 15 fps. The recording starts with the request
already pending; automatic opening on arrival and revised terms are covered by
the workspace tests.

These captures show placement and dismissal. They do not establish production
authentication behavior, usability improvements, or support across browsers.
