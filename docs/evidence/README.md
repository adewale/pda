# Privacy copy comparison

`privacy-before.png` uses `src/privacy.ts` from baseline `93777e3ee57efeeaef4005a761a4fdf070a44262`. `privacy-after.png` uses this branch's production `privacyPage` function. Both use the example deployment `https://agent.example.test`, name Poppy Demo Agent and contact privacy@example.test, rendered in installed Chromium at 900×2000 with a light color scheme. The crop ends at the same Company-disclosure paragraph.

The added paragraph explains that an issuer's random User ID recognizes signed-out visits and links them to an account after sign-in. The unchanged model-provider paragraph supplies context. These static captures show the privacy copy; authentication behavior and mobile layout are covered separately by tests and are not proved by these images.
