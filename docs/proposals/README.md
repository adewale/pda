# Proposals to other projects

These are draft feature requests proposing [Personal Agent Protocol](https://personalagentprotocol.org/) (Poppy) Personal Agent support in other agents. They are written to be posted as GitHub issues and **have not been posted**. Each one follows its project's issue template, cites the files it relies on, and marks anything unverified.

| Draft | Project | Proposed integration point |
| --- | --- | --- |
| [openclaw-poppy.md](openclaw-poppy.md) | [openclaw/openclaw](https://github.com/openclaw/openclaw) (researched at `6f9af588`) | An external native plugin. It registers tools, HTTP routes for the agent's identity, a background service, approval gating through `before_tool_call` and `requireApproval`, and slash commands. No core change; three optional SDK seams. |
| [hermes-agent-poppy.md](hermes-agent-poppy.md) | [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) (researched at `97a9ae8e`) | A standalone Python plugin built on Datalayer's `personal-agent-protocol` SDK, with tools in a `poppy` toolset and approvals through `pre_tool_call` and `request_tool_approval`. It needs two generic seams: a sealed credential route for plugin-owned grants, and a public route for the identity (or Device-only sign-in until there is one). |

## Before submitting

The owner will update and submit these after verifying our agent against a real Company Agent ([deployment-tasks.md](../deployment-tasks.md)). Fold in what changed since they were drafted on 11 October:

- **Browsing:** our agent uses a fetch-based browser with no JavaScript, not Cloudflare Browser Rendering, and every website form submission needs the User's approval ([decisions §12](../decisions.md#12-a-fetch-based-browser-instead-of-browser-rendering)).
- **Model access:** two lanes, an operator-paid demo with daily caps and the person's own Anthropic or OpenAI key sent straight to the vendor ([decisions §13, §14](../decisions.md#13-model-access-two-lanes-caps-in-durable-objects)).
- **Adversarial testing** runs only against our own implementations, and the disclosure process in [SECURITY.md](../../SECURITY.md) applies to anything it would find in theirs.
- **A second client:** the independent Python client and its Hypothesis stateful test of our mock ([decisions §19](../decisions.md#19-a-second-client-in-python-with-hypothesis)).
- **New spec issues** N43 to N45: website submissions with no approval step, when to fetch discovery documents again, and a lost code exchange orphaning an Account Token ([spec-issues.md](../spec-issues.md)). The drafts' counts (65 issues, 142 checks, 22 scenarios) are out of date; say it without numbers or recount.
- **Test vectors:** references to our exported vectors, which were deleted, are already gone from the drafts.

## Before posting

- **adewale/dpa is private.** Both drafts link to it: the interop harness, `docs/spec-issues.md`, and `docs/poppy-issues.md`. Make those public first, or replace the links.
- **Re-check the linked issues.** Their numbers and states were checked on 11 October 2026.
  - OpenClaw: #150247, #138113, #122034, #116052.
  - Hermes: #98958, #75576, #130295, #133512, #132233, #82416.
- **Search again for an existing Poppy proposal.** On 11 October there was none in either repository.
- **Disclose any affiliation** with Sierra or the spec's authors, if there is one.
- **Hermes: issue or Discussion?** Its CONTRIBUTING.md points design proposals to GitHub Discussions. Consider a Discussion for the design and a short issue for the two seams.
- **Fill in the PR-intent fields.** OpenClaw's dropdown is "Do you plan to open a PR for this?"; Hermes has a "Contribution" checkbox.
