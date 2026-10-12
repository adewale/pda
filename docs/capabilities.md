# What the agent can do, and where each part comes from

The [README](../README.md#what-you-can-do-with-it) says what a person can ask for. This page maps each capability to its source: a Poppy feature, with the section of [Draft 0.1](../spec/draft-0.1-2026-10-09/README.md) or the Operations extension (Ops, version 1) it implements, or a feature of this project. Each model tool is listed once, beside the feature it serves, with what needs the User's approval and the file that defines it. How each part works is in the [spec](../durable-personal-agent-spec.md); why it was built that way is in [decisions.md](decisions.md).

Back to the [README](../README.md)

## The model's tools

The model is offered 21 tools: 14 `poppy_*` tools from `src/poppy/tools.ts` and 7 general tools from `src/tools/extensions.ts`. Nothing else adds any:

- `PiHarness` runs a registry we fill (`src/agent.ts`). Its `persona` extension has `tools: []`; the others are `poppy`, `web`, `memory`, `time`, `attachments` and `compaction`, and only the first four have tools.
- pi-durable's built-in tasks (generation, tool calls, compaction) are tasks, not tools. Its shell and file tools (`bash`, `read`, `write`, `edit`) are a separate export, `@earendil-works/pi-durable/tools`, which nothing here imports.
- The Agents SDK's `skills()` extension, which would add `activate_skill` and a resource reader, isn't installed.
- A test checks the exact list of tool names in a request the model receives: "are the Poppy tools and the general tools, and nothing the harness adds", in `test/general-tools.test.ts`.

Some things look like they could be tools but are features of the agent or the page, which the model can't call: photo attachments, compaction, the protocol log, Activity, and every decision that belongs to the User (below).

## Who approves what

Two kinds of approval card exist, and they come from different places:

- **A Company's proposal is Poppy's.** When a Company has the Operations extension and answers a write with an operation (Ops §4), the User approves its exact revision and terms on a card (Ops §5.1), and only then does the agent confirm it (Ops §5.2). A standing permission the User set can approve a proposal instead, within its limits (Ops §5.1). This is the only approval a Company ever sees.
- **Our own cards are this project's.** Every write a Company doesn't propose waits on a local approval card before anything is sent: an OpenAPI write whose description doesn't declare an operation, an MCP tool without `readOnlyHint: true`, and a website form submit. Every upload of the User's photo waits on one too, even to an endpoint that proposes. The draft doesn't ask for these; we add them so that nothing changes the User's account, and none of their files leaves, on the model's word alone ([decision 6](decisions.md#6-prompt-injection-defences-that-are-structural), [decision 26](decisions.md#26-photos-in-the-chat-uploaded-only-with-the-users-approval)).

No tool approves, confirms or cancels anything. Confirming, declining, cancelling, standing permissions, entering credentials, signing out and speaking in a Direct Conversation are actions on the page.

## Poppy features

| Capability | Draft | Tool | Needs the User | Defined in |
| --- | --- | --- | --- | --- |
| Find out whether a Company supports Poppy and what it offers; the validator checks its documents first | §3, §3.1–3.3 | `poppy_discover` | No | `src/poppy/tools.ts`, `src/poppy/discovery.ts`, `src/validator/` |
| The agent's public identity at Companies | §4.1 | None: the Worker serves `/poppy/client.json` and `/poppy/jwks.json` | No | `src/poppy/routes.ts` |
| Start a Session, signed out, and use it with DPoP | §4.2–4.3 | None: every Company tool starts one when it needs one | No | `src/poppy/client.ts`, `src/poppy/jwt.ts` |
| Sign in at the Company when a task needs the User's account: Direct, Device or Mediated Sign-In, reusing an Account Token that covers the scopes | §4.4–4.8 | `poppy_sign_in` | Yes: the User signs in on the Company's page or on the card; the tool never takes a password | `src/poppy/signin.ts` |
| Sign out of a Company | §4.9 | None: the Companies page | It is the User's action | `src/poppy/signin.ts` |
| Browse the Company's website in the Session, with no JavaScript | §5 | `poppy_browse` | A form submit waits for our own card | `src/poppy/browser.ts`, `src/poppy/fetch-browser.ts` |
| Look things up and make changes through the Company's OpenAPI API, including uploading the User's photo | §6 | `poppy_api_describe`, `poppy_api_call` | Reads: no. A write whose description says it answers with an operation: the Company's proposal (Ops §4.1). Any other write, and every upload: our own card | `src/poppy/apis.ts` |
| Use the Company's MCP tools | §6 | `poppy_mcp_list`, `poppy_mcp_call` | A tool without `readOnlyHint: true`: the Company's proposal when its output schema declares an operation (Ops §4.2), otherwise our own card | `src/poppy/apis.ts` |
| Talk to the Company's agent, with replies read in the background or streamed | §7.1–7.7 | `poppy_message`, `poppy_read` | No: a message never authorizes an account action (§7.11) | `src/poppy/conversations.ts` |
| Ask for a person at the Company | §7.9 | `poppy_handoff` | No | `src/poppy/conversations.ts` |
| Let the User talk to the Company directly | §7.10 | `poppy_invite_user` | Yes: the User decides whether to start it, and writes their own messages | `src/poppy/conversations.ts`, `src/poppy-ui.tsx` |
| Sign in during a conversation when the Company asks | §7.11 | None: the client reacts to the event, through `poppy_sign_in`'s card | As for signing in | `src/poppy/conversations.ts` |
| Close a conversation | §7.12 | `poppy_close` | No | `src/poppy/conversations.ts` |
| Read a Company's proposal, its terms, state and result | Ops §3, §6 | `poppy_operation` | No: reading only | `src/poppy/operations.ts` |
| Approve, decline or cancel a proposal, or set a standing permission | Ops §5.1, §5.2, §7 | None: cards and the Companies page | It is the User's action | `src/poppy/operations.ts`, `src/poppy-ui.tsx` |
| See what is still open at every Company: operations, approvals, sign-ins, conversations | Spans §4, §7 and Ops §3 | `poppy_status` | No | `src/poppy/tools.ts`, `src/poppy/activity.ts` |

## This project's own features

| Capability | Tool | Needs the User | Defined in |
| --- | --- | --- | --- |
| Read a public web page the User points it at, as text, signed out, sending nothing about them | `read_url` | No; it can't send anything but the address | `src/tools/web.ts` |
| Remember things about the User across the conversation | `remember` | No; the User sees and deletes every note in Settings | `src/tools/memory-store.ts` |
| Search what it remembers | `recall` | No | `src/tools/memory-store.ts` |
| Forget a note | `forget` | No | `src/tools/memory-store.ts` |
| The date and time in the User's time zone, or another | `now` | No | `src/tools/clock.ts` |
| Date arithmetic and differences, with weekdays | `date_math` | No | `src/tools/clock.ts` |
| Exact sums, including money | `calculate` | No | `src/tools/calculate.ts` |
| Photos in the chat: kept in the agent, shown to the model, sent to a Company only in an approved upload | None: the composer, the agent's storage and a request hook | Sending one, on our own card | `src/attachments.ts`, `src/attachment-images.ts`, `src/ui/attachments.tsx` |
| One never-ending conversation, summarised past about 150,000 tokens | None: a compaction hook | No | `src/compaction.ts` |
| Activity: what the agent did at each Company, and every Poppy exchange with its spec section | None: the Activity page | No | `src/poppy/activity.ts`, `src/poppy/protocol-log.ts`, `src/ui/activity.tsx` |
| Pay for the model with the operator's capped demo or the User's own Anthropic or OpenAI key | None: Settings | Pasting a key is the User's action | `src/model-router.ts`, `src/model-keys.ts`, `src/budget.ts` |
| Sign in to the agent with Google or GitHub | None: the Worker | It is the User's action | `src/oauth.ts`, `src/session.ts` |

All seven general tools are ours, built for this project in `src/tools/`, with no third-party service: `read_url` fetches pages from Cloudflare's network directly, and the other six run in the agent itself.
