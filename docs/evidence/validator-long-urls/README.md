# The validator's results page with a long redirect URL

All three images render one input with `resultPage` in `src/validator/html.ts`: the report `render.mjs` builds for a signed-out Company whose catch-all redirects `/.well-known/oauth-protected-resource`, through one same-host hop, to a sign-in page on another host whose URL carries a long `SAMLRequest`. `before-360.png` is baseline `64a04aba8dd113e3ee8be538cefec34ec4b9ad74` (`main`); `after-360.png` and `after-760.png` are this branch. Each is the protected resource metadata section, in installed Chromium at device scale 2 and a light color scheme, 360 px and 760 px wide.

At 360 px the baseline's error line runs past the section's edge, and its header spends about thirty lines on the sign-in request. After: the header shows where the redirects led without its query, its long tenant segment shortened, with the whole URL in a collapsed "The whole URL"; each URL is set as code with its host in bold, breaking between segments; a departure shows its subject once, then Expected and Got. `shoot.cjs` measures overflow as it captures:

| Revision | 360 px | 760 px |
| --- | --- | --- |
| Baseline | page 317 px, section 334 px | none |
| This branch | none | none |

To regenerate, from a checkout of each revision:

```sh
node docs/evidence/validator-long-urls/render.mjs "$PWD" /tmp/page.html
node docs/evidence/validator-long-urls/shoot.cjs /tmp/page.html /tmp/page.png 360
```

The images show the light theme only. At 360 px the bold host still breaks at its hyphen, which keeps a very long host name from overflowing instead. `test/validator-presentation.test.ts` pins the markup (code, bold host, break opportunities, the tooltip, the collapsed URL and the wrap rule); the overflow figures come from this script, not from a test, since the page tests can't measure layout.
