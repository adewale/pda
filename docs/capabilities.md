# What the agent can do, and where each part comes from

The [README](../README.md#what-you-can-do-with-it) says what a person can ask for. This page maps each capability to its source: a Poppy feature, with the section of [Draft 0.1](../spec/draft-0.1-2026-10-12/README.md) or the Operations extension (Ops, version 1) it implements, or a feature of this project. Each model tool is listed once, beside the feature it serves, with what needs the User's approval and the file that defines it. How each part works is in the [spec](../pda-spec.md); why it was built that way is in [decisions.md](decisions.md).

Back to the [README](../README.md)

## The model's tools

The model is offered 25 tools: 14 `poppy_*` tools from `src/poppy/tools.ts`, 7 general tools from `src/tools/extensions.ts` and 4 for reminders and scheduled tasks from `src/tools/schedules.ts`. Nothing else adds any:

- `PiHarness` runs a registry we fill (`src/agent.ts`). Its `persona` extension has `tools: []`; the others are `poppy`, `web`, `memory`, `time`, `schedule`, `attachments` and `compaction`, and only the first five have tools.
- pi-durable's built-in tasks (generation, tool calls, compaction) are tasks, not tools. Its shell and file tools (`bash`, `read`, `write`, `edit`) are a separate export, `@earendil-works/pi-durable/tools`, which nothing here imports.
- The Agents SDK's `skills()` extension, which would add `activate_skill` and a resource reader, isn't installed.
- A test checks the exact list of tool names in a request the model receives: "are the Poppy tools and the general tools, and nothing the harness adds", in `test/general-tools.test.ts`.

Some things look like they could be tools but are features of the agent or the page, which the model can't call: photo attachments, compaction, the protocol log, Activity, and every decision that belongs to the User (below).

## Who approves what

Two kinds of approval card exist, and they come from different places:

- **A Company's proposal is Poppy's.** When a Company has the Operations extension and answers a write with an operation (Ops §4), the User approves its exact revision and terms on a card (Ops §5.1), and only then does the agent confirm it (Ops §5.2). A standing permission the User set can approve a proposal instead, within its limits (Ops §5.1). This is the only approval a Company ever sees.
- **Our own cards are this project's.** Every write a Company doesn't propose waits on a local approval card before anything is sent: an OpenAPI write whose description doesn't declare an operation, an MCP tool without `readOnlyHint: true`, and a website form submit. Every upload of the User's photo waits on one too, even to an endpoint that proposes. The draft doesn't ask for these; we add them so that nothing changes the User's account, and none of their files leaves, on the model's word alone ([decision 6](decisions.md#6-prompt-injection-defences-that-are-structural), [decision 26](decisions.md#26-photos-in-the-chat-uploaded-only-with-the-users-approval)). Once approved, the card's receipt says what the Company answered: done for a 2xx; sent as approved but answered with that status and error code, so nothing changed unless the Company says otherwise; or, with no answer, that it may or may not have reached the Company.
- **Some writes get no card at all.** A write the Company's description leaves outside its Poppy Session (its own sign-in, session, token or compatibility endpoint) is refused before any card: the agent's only access is its Poppy Session ([readings.md](readings.md#poppy-session-only)).

No tool approves, confirms or cancels anything. A scheduled task's run is a background turn like a Company message's, so the same holds for it: it can ask for approval, never give it. Confirming, declining, cancelling, standing permissions, entering credentials, signing out and speaking in a Direct Conversation are actions on the page.

## Poppy features

| Capability | Draft | Tool | Needs the User | Defined in |
| --- | --- | --- | --- | --- |
| Find out whether a Company supports Poppy and what it offers; the validator checks its documents first | §3, §3.1–3.3 | `poppy_discover` | No | `src/poppy/tools.ts`, `src/poppy/discovery.ts`, `src/validator/` |
| The agent's public identity at Companies | §4.1 | None: the Worker serves `/poppy/client.json` and `/poppy/jwks.json` | No | `src/poppy/routes.ts` |
| Start a Session, signed out, and use it with DPoP | §4.2–4.3 | None: every Company tool starts one when it needs one | No | `src/poppy/client.ts`, `src/poppy/jwt.ts` |
| Sign in at the Company when a task needs the User's account: Direct, Device or Mediated Sign-In, reusing an Account Token that covers the scopes | §4.4–4.8 | `poppy_sign_in` | Yes: the User signs in on the Company's page or on the card; the tool never takes a password | `src/poppy/signin.ts` |
| Sign out of a Company | §4.9 | None: the Companies page | It is the User's action | `src/poppy/signin.ts` |
| Browse the Company's website in the Session, with no JavaScript | §5 | `poppy_browse` | A form submit waits for our own card | `src/poppy/browser.ts`, `src/poppy/fetch-browser.ts` |
| Look things up and make changes through the Company's OpenAPI API, including uploading the User's photo | §6 | `poppy_api_describe`, `poppy_api_call` (a JSON body as `body`, an object, or `bodyValue`, anything else) | Reads: no. A write whose every declared success is a 202 that requires `operation`: the Company's proposal (Ops §4.1). Any other write, and every upload: our own card. A write outside the Poppy Session: never made | `src/poppy/apis.ts` |
| Use the Company's MCP tools | §6 | `poppy_mcp_list`, `poppy_mcp_call` (`args` checked against the tool's `inputSchema` first) | A tool without `readOnlyHint: true`: the Company's proposal when its output schema requires `operation` (Ops §4.2), otherwise our own card | `src/poppy/apis.ts` |
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
| Read a public web page the User points it at, signed out, sending nothing about them, and answer a question about it: a reader with no tools reads the page and the agent gets only its answer; a page that needs JavaScript is rendered in Cloudflare Browser Run, which may send only GET and HEAD requests to public hosts | `read_url` | No; it can't send anything but the address, and the rendering browser can't post anything | `src/tools/web.ts`, `src/tools/render.ts`, `src/tools/extensions.ts` (the reader) |
| Remember things about the User across the conversation | `remember` | No; the User sees and deletes every note in Settings | `src/tools/memory-store.ts` |
| Search what it remembers | `recall` | No | `src/tools/memory-store.ts` |
| Forget a note | `forget` | No | `src/tools/memory-store.ts` |
| The date and time in the User's time zone, or another | `now` | No | `src/tools/clock.ts` |
| Date arithmetic and differences, with weekdays | `date_math` | No | `src/tools/clock.ts` |
| Exact sums, including money | `calculate` | No | `src/tools/calculate.ts` |
| Remind the User at a time, once or daily, on weekdays or weekly: a card in the tray and a notification on their devices; a card that can't be shown is tried again after 1, 5 and 30 minutes, then marked failed | `remind_me` | Only the User's own message sets one; no model call when it fires | `src/tools/schedules.ts`, `src/schedules.ts` |
| Run the agent in the background at a time, or on a repeat, with the User's instruction | `schedule_task` | Only the User's own message sets one; the run's writes need approval as any turn's do, and its model calls count against the demo's caps | `src/tools/schedules.ts`, `src/schedules.ts` |
| List reminders and tasks waiting, paused or failed | `list_scheduled` | No | `src/tools/schedules.ts` |
| Cancel one, or dismiss a failed one | `cancel_scheduled` | Only in a turn the User started; also Settings' Cancel and Dismiss | `src/tools/schedules.ts` |
| Notifications on the User's devices (Web Push), for reminders and tasks | None: Settings' toggle | Turning them on is the User's action | `src/web-push.ts`, `src/ui/notifications.tsx`, `public/sw.js` |
| Photos in the chat: kept in the agent, shown to the model, sent to a Company only in an approved upload | None: the composer, the agent's storage and a request hook | Sending one, on our own card | `src/attachments.ts`, `src/attachment-images.ts`, `src/ui/attachments.tsx` |
| One never-ending conversation, summarised past about 150,000 tokens | None: a compaction hook | No | `src/compaction.ts` |
| Activity: what the agent did at each Company, and every Poppy exchange with its spec section | None: the Activity page | No | `src/poppy/activity.ts`, `src/poppy/protocol-log.ts`, `src/ui/activity.tsx` |
| Pay for the model with the operator's capped demo or the User's own Anthropic or OpenAI key | None: Settings | Pasting a key is the User's action | `src/model-router.ts`, `src/model-keys.ts`, `src/budget.ts` |
| Sign in to the agent with Google or GitHub | None: the Worker | It is the User's action | `src/oauth.ts`, `src/session.ts` |

All eleven general tools are ours, built for this project in `src/tools/`: `read_url` fetches pages from Cloudflare's network directly and renders the ones that need JavaScript in Cloudflare Browser Run, and the other ten run in the agent itself. Reminders and tasks wake on the agent's own Durable Object alarm; a notification goes through the push service the User's browser chose (Google, Mozilla, Apple or Microsoft).
