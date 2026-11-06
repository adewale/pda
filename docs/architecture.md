# Implementation boundaries

`src/agent.ts` composes per-person capabilities. The Worker authenticates requests before selecting an agent. Model arguments do not select an agent or supply approval authority.

## Company APIs

`src/poppy/apis.ts` is the stable public entry point. Its implementation is separated by responsibility:

| Module | Owns |
| --- | --- |
| `api-authority.ts` | API selection and authority snapshots/dispatch checks |
| `api-schema.ts` | JSON Schema validation, local references and input diagnostics |
| `api-approvals.ts` | Company terms, immutable revisions and publication of their cards |
| `openapi-document.ts` | OpenAPI document parsing, caches, scopes and descriptions |
| `openapi-request.ts` | Construction of a checked method, destination, parameters and upload |
| `openapi-dispatch.ts` | Durable task identities, file routing, replay and OpenAPI executor registration |
| `mcp-transport.ts` | MCP lifecycle negotiation, partitioned sessions, JSON-RPC and tool catalogue caching |
| `mcp-dispatch.ts` | Tool argument validation, durable task dispatch and MCP executor registration |

Transport code cannot decide an approval. Dispatch code uses shared authority and terms functions. Executor registration remains initialized by importing the public entry point; consumers must not switch to deep imports that bypass that initialization. Schema/document type dependencies do not transfer ownership of caches or dispatch state.

## Interface and personal data

`src/poppy-ui.tsx` preserves the existing UI exports. `src/ui/poppy-*` separates shared card presentation, sign-in, approval decisions, card/receipt routing, the request tray and Direct Conversations. The request tray owns layout; sign-in and approval components own their interaction state.

`src/ui/chat.tsx` preserves the chat entry point. `chat-page.tsx` owns the conversation timeline and page layout; `composer.tsx` owns drafts, attachment uploads, the Company selection and a message's photo permissions.

`src/task-access.ts` validates the composer's explicit Company/file selections. `tools/turn-authority.ts` persists them beside the admitted input, freezes them across retries and binds resumed tools to their originating task. Prose and Company content confer no recipient or file permission.

The Company list stays in the composer between messages, but authority still travels with each message: every submit carries the list its composer shows, and that message's copy is what tools check. `task_company_selection` only remembers the latest list so the composer can show it after a reload or on another device; reading it grants nothing, a message that states no selection leaves it alone and gets no Company access, and reset clears it. Photo upload permissions never persist. `runAccess` keeps a Company-started run from a message's photo permission and gives a run mixing a User message with a scheduled task only what both hold.

Scheduled tasks store those selections when created and pass them to their own background input on each run. An explicit empty selection stays empty; it cannot borrow a later chat's recipients. Scheduled runs retain background provenance, so they cannot create schedules or save notes as the User. Company-notice continuation correlation still uses the existing latest-User fallback; this change does not establish an independent originating-message binding for every unsolicited notice.

`src/agent-data-export.ts` owns the streamed export, which contains only tables and columns it lists; `src/agent-data.ts` owns the deletion receipt, login cutoff and revocation waivers. `agent-data-routes.ts` owns the authenticated HTTP interface; `ui/agent-data.tsx` owns its explicit user confirmation. The agent coordinates stopping tools and Company revocation before erasure. `poppy/signout.ts` reports what couldn't be revoked; that retains the local data and credential until the person retries or abandons those exact credentials, and the waiver is durable so an interrupted deletion can't widen or lose it. Application SQL/KV erasure and the login cutoff commit atomically, so an interruption cannot erase the cutoff and readmit old cookies. Erasure resets the object to clear memory-only caches as well as storage.

Further extraction from `client.ts` or `operations.ts` should follow a state boundary, such as OAuth transport or approval settlement, with the existing replay/concurrency tests retained. Moving methods solely to meet a line limit would obscure which object owns their mutable state.
