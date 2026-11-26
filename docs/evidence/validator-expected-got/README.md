# The validator's results page: expected and got

`before.png` is the results page that `resultPage` in `src/validator/html.ts` renders at baseline `a188f5c70898dff2fe368d035512e6afb08387df` (`main`). `after.png` is the same function at `3db95d58abe0020b68e1d2d1c6529ba94793a47e`. Both render one input, the poppy.json in `render.mjs`: `agent.protocols` written as a string, and an API whose `url` is `http://`. The crop is the poppy.json section, in installed Chromium at 760 px wide, device scale 2, light color scheme.

Each error now reads "subject: expected X, got Y" and shows the two sides as an Expected/Got pair under its text. The source excerpt and the line, pointer, basis and id below each message are unchanged, as a control.

To regenerate, from a checkout of each revision:

```sh
node docs/evidence/validator-expected-got/render.mjs "$PWD" /tmp/page.html
node docs/evidence/validator-expected-got/shoot.cjs /tmp/page.html /tmp/page.png
```

`render.mjs` takes the checkout to render from as its first argument, so the baseline can be rendered from a worktree of `a188f5c`. The images show the light theme at one width. They don't show the dark theme or a phone width, which no test checks either; the wording of every message, the fetch messages included, is pinned by `test/validator.test.ts`, and that every departure has both sides by its fixture runner.
