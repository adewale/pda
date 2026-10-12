# Proposals to other projects

These are draft feature requests proposing [Personal Agent Protocol](https://personalagentprotocol.org/) (Poppy) Personal Agent support in other agents. They are written to be posted as GitHub issues and **have not been posted**. Each one follows its project's issue template, cites the files it relies on, and marks anything unverified.

| Draft | Project | Proposed integration point |
| --- | --- | --- |
| [openclaw-poppy.md](openclaw-poppy.md) | [openclaw/openclaw](https://github.com/openclaw/openclaw) (researched at `6f9af588`) | An external native plugin. It registers tools, HTTP routes for the agent's identity, a background service, approval gating through `before_tool_call` and `requireApproval`, and slash commands. No core change; three optional SDK seams. |
| [hermes-agent-poppy.md](hermes-agent-poppy.md) | [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) (researched at `97a9ae8e`) | A standalone Python plugin built on Datalayer's `personal-agent-protocol` SDK, with tools in a `poppy` toolset and approvals through `pre_tool_call` and `request_tool_approval`. It needs two generic seams: a sealed credential route for plugin-owned grants, and a public route for the identity (or Device-only sign-in until there is one). |

## Before submitting

The owner will submit these after verifying our agent against a real Company Agent ([deployment-tasks.md](../deployment-tasks.md)). Their facts about Poppy, the implementations, the grid and Datalayer were brought up to date on 12 October 2026 from [ecosystem.md](../ecosystem.md), [implementations.md](../implementations.md), [interop-results](../interop-results/README.md), [spec-issues.md](../spec-issues.md), [poppy-issues.md](../poppy-issues.md) and `test/mock-company/violations.ts`. Before submitting:

- **Add the live result.** Neither draft says our agent has run against a live Company, because it hasn't. Say which Company Agent it was verified against and what worked, in each draft's Interop section and Impact or Caveats.
- **Recount from the docs of the day.** The drafts give dated counts: 13 implementations; a grid of 6 Personal Agents and 10 Companies with 50 scenarios (30 interop, 20 security and fault) and 1,800 cells (849 pass, 171 fail, 780 unsupported); 25 of 25 security cells passing; 147 mock checks (119 failures, 18 warnings, 10 tentative); 62 spec issues (5 Critical, 13 High, 29 Medium, 15 Low). Change any that have moved, with the new date.
- **Recheck Datalayer.** The Hermes draft rests on the Python SDK at 0.10.0 (`0c048aa`): its README's claims, 151 passes and 3 failures as a Personal Agent, and the two gaps still open (Device Sign-In polling ignores `use_dpop_nonce`; SSE resume raises `stream_unavailable` against Datalayer's own Companies). If PyPI has moved on, rerun its row and update the adapter READMEs first.
- **print-with-poppy.** Both drafts say our agent completes the store's journey only in the grid, because the live store admits agents on an allowlist. Update that if the store has added our `client_id` and the journey has run live.
- **Re-research both projects.** The OpenClaw paths, seams and quotes are from `6f9af588`, and the Hermes ones from `97a9ae8e`, both on 11 October 2026. Check them against each project's `main`.

## Before posting

- **adewale/dpa is private.** Both drafts link to it and cite its files: the interop harness and `docs/interop-spec.md`, `docs/interop-results/README.md`, `docs/spec-issues.md`, `docs/poppy-issues.md`, `docs/implementations.md`, `docs/ecosystem.md`, `SECURITY.md`, and the Datalayer adapter READMEs. Make those public first, or replace the links.
- **Re-check the linked issues.** Their numbers and states were checked on 11 October 2026.
  - OpenClaw: #150247, #138113, #122034, #116052.
  - Hermes: #98958, #75576, #130295, #133512, #132233, #82416.
- **Search again for an existing Poppy proposal.** There was none in either repository on 11 October, nor in a search on 12 October.
- **Disclose any affiliation** with Sierra or the spec's authors, if there is one.
- **Hermes: issue or Discussion?** Its CONTRIBUTING.md points design proposals to GitHub Discussions. Consider a Discussion for the design and a short issue for the two seams.
- **Fill in the PR-intent fields.** OpenClaw's dropdown is "Do you plan to open a PR for this?"; Hermes has a "Contribution" checkbox.
