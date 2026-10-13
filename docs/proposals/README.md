# Proposals to other projects

These are draft feature requests proposing [Personal Agent Protocol](https://personalagentprotocol.org/) (Poppy) Personal Agent support in other agents. They are written to be posted as GitHub issues and **have not been posted**. Each one follows its project's issue template, cites the files it relies on, and marks anything unverified.

| Draft | Project | Proposed integration point |
| --- | --- | --- |
| [openclaw-poppy.md](openclaw-poppy.md) | [openclaw/openclaw](https://github.com/openclaw/openclaw) (researched at `6f9af588` on 11 October 2026, rechecked at `a1e82826` on 13 October) | An external native plugin. It registers tools, HTTP routes for the agent's identity, a background service, approval gating through `before_tool_call` and `requireApproval`, and slash commands. No core change; three optional SDK seams. |
| [hermes-agent-poppy.md](hermes-agent-poppy.md) | [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) (researched at `97a9ae8e` on 11 October 2026, rechecked at `6e7b83a2` on 13 October) | A standalone Python plugin built on Datalayer's `personal-agent-protocol` SDK, with tools in a `poppy` toolset and approvals through `pre_tool_call` and `request_tool_approval`. It needs two generic seams: a sealed credential route for plugin-owned grants, and a public route for the identity (or Device-only sign-in until there is one). |

## Before submitting

The owner will submit these after verifying our agent against a real Company Agent ([deployment-tasks.md](../deployment-tasks.md)). Their facts about Poppy, the implementations, the grid and Datalayer were brought up to date on 13 October 2026 from [ecosystem.md](../ecosystem.md), [implementations.md](../implementations.md), [interop-results](../interop-results/README.md), [spec-issues.md](../spec-issues.md), [poppy-issues.md](../poppy-issues.md) and `test/mock-company/violations.ts`. Before submitting:

- **Add the live result.** Neither draft says our agent has run against a live Company, because it hasn't. Say which Company Agent it was verified against and what worked, in each draft's Interop section and Impact or Caveats.
- **Recount from the docs of the day.** The drafts give counts dated 13 October 2026: 14 implementations; a grid of 8 Personal Agents and 12 Companies with 52 scenarios (30 interop; 22 security: 8 malicious agent, 10 malicious Company, 4 network) and 2,880 cells (1,000 pass, 273 fail, all known failures, 1,607 unsupported, 0 errors); 32 of 32 security cells passing, and XR and XT since; 148 mock checks (119 failures, 19 warnings, 10 tentative); 63 spec issues (5 Critical, 13 High, 30 Medium, 15 Low). Change any that have moved, with the new date. Never cite results of the malicious Company against other projects' agents; they stay private until disclosed ([SECURITY.md](../../SECURITY.md)).
- **Recheck Datalayer.** The drafts now rest on the SDK at 0.17.0 (`00216eb`), the grid's pin on 13 October: as a Personal Agent, 201 passes and 8 failures against 12 Companies, and three gaps still open (Device Sign-In polling ignores `use_dpop_nonce`; SSE resume raises `stream_unavailable` against Datalayer's own Companies; handoff and close answers need a `conversation_id` the draft doesn't require). PyPI was at 0.20.0 by the afternoon of 13 October, so rerun its row and update the adapter READMEs before submitting.
- **print-with-poppy.** Both drafts say the store added our `client_id` on 12 October and the live journey ran as far as the photo's approval card, and that the order hasn't run live because the store takes real payments. Update them once it has.
- **Re-research both projects again.** The OpenClaw paths, seams and quotes were rechecked at `a1e82826`, and the Hermes ones at `6e7b83a2`, both on 13 October 2026. Both move daily; check them against each project's `main` once more.

## Before posting

- **adewale/dpa is private.** Both drafts link to it and cite its files: the interop harness and `docs/interop-spec.md`, `docs/interop-results/README.md`, `docs/spec-issues.md`, `docs/poppy-issues.md`, `docs/implementations.md`, `docs/ecosystem.md`, `SECURITY.md`, and the Datalayer adapter READMEs. Make those public first, or replace the links.
- **Re-check the linked issues.** Their numbers and states were checked on 13 October 2026, and each draft shows them.
  - OpenClaw: #150247, #138113 and #116052 open; #122034 closed as completed (12 August).
  - Hermes: #98958, #133512, #132233 and #82416 open; #75576 closed as completed; #130295 closed as not planned.
- **Search again for an existing Poppy proposal.** There was none in either repository on 11 October, nor in searches on 12 and 13 October.
- **Disclose any affiliation** with Sierra or the spec's authors, if there is one.
- **Hermes: issue or Discussion?** Its CONTRIBUTING.md points design proposals to GitHub Discussions. Consider a Discussion for the design and a short issue for the two seams.
- **Fill in the PR-intent fields.** OpenClaw's dropdown is "Do you plan to open a PR for this?"; Hermes has a "Contribution" checkbox.
