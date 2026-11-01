# Poppy support for openclaw/openclaw

Parked draft for [openclaw/openclaw](https://github.com/openclaw/openclaw); not submitted. Refresh host API details only when submission is scheduled. [Dated implementation research](https://github.com/adewale/pda/blob/289c6592c6f6e629b1d525247f3c4e2243662bc2/docs/proposals/openclaw-poppy.md) remains available for that review.

## Request

Add Poppy as an optional OpenClaw plugin. [Poppy](https://personalagentprotocol.org/) gives a person's agent a way to discover a business, sign in with scoped OAuth grants, converse with its agent and use its APIs. Keep this integration outside the host's core.

Use the supported plugin tool, route and approval APIs. The historical research proposed `before_tool_call` with `requireApproval`; verify the current API before implementation.

## One useful journey

A person attaches a photo and asks for a print. The plugin discovers the print shop, obtains account access through the shop's sign-in page if needed, and sends the task request. If the shop returns `approval_required`, the plugin presents its exact price and terms. Only the person's decision may send the stored request with approval; the model cannot manufacture that decision. Show the returned receipt and checkout link directly.

[Recorded verification and limits](../poppy-0.3-conformance.md#current-verification) distinguish isolated demos from live services. This proposal does not claim completed payments or broad interoperability.

## Implementation boundaries

- Keep refresh tokens and signing keys in sealed, per-person storage, outside model context. Use the host's trusted identity, not a tool argument, to select that storage.
- Present Company content as untrusted data. Route Company API and MCP calls through the plugin's checked client.
- Bind approval to the Company's exact operation and revision, immutable request and person. Offer approve-once or decline; refuse automated approval when nobody can answer.
- Task-selected photos need no extra disclosure click. Unselected files and website forms retain local consent.
- Preserve uncertain outcomes after crashes; do not resend a business action merely because its answer was lost.
- Host the required HTTPS client metadata and public keys; investigate self-hosted identity deployment before promising a turnkey plugin.

Choose a client implementation that supports the [pinned wire text](../../spec/upstream.json). Evaluate a maintained SDK at implementation time; the [independent Python test client](../../test/hypothesis/README.md) is research, not a production SDK.

Before posting: verify host APIs and issue format, search for an existing proposal, and obtain owner approval. See the [proposal policy](README.md). Do not copy ecosystem statistics into this draft.
