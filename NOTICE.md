# Notice

Poppy Demo Agent
Copyright 2026 Ade Oshineye

Licensed under the Apache License, Version 2.0 ([LICENSE](LICENSE)). The exceptions are below.

## Stored copies of the Personal Agent Protocol draft

`spec/draft-0.1-*/` holds snapshots of [personalagentprotocol.org](https://personalagentprotocol.org/), whose specification and documentation are licensed under the Apache License 2.0 (each snapshot's `pages/license.md`). That licence doesn't cover the names Personal Agent Protocol and Poppy, the logo, or the site's design; this project uses the names only to say what it implements.

## Third-party code

`src/protocol.ts`, `src/sockets.ts`, `src/view.ts`, `src/transcript.ts`, `src/use-pi-session.ts`, `src/client.tsx`, `src/styles.css` and `index.html` are copied from Cloudflare's Pi harness example, [`cloudflare/agents` `examples/next/harnesses/pi`](https://github.com/cloudflare/agents/tree/main/examples/next/harnesses/pi) at commit `48d9c36`, under the MIT License, Copyright (c) 2025 Cloudflare, Inc. The first four are unchanged; the hook, page, styles and HTML are adapted as described in `pda-spec.md`.

The example builds on Pi (`@earendil-works/pi-*`), MIT License, Copyright (c) 2025 Mario Zechner.

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
