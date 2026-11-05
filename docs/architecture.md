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

`src/ui/chat.tsx` preserves the chat entry point. `chat-page.tsx` owns the conversation timeline and page layout; `composer.tsx` owns drafts, attachment uploads and explicit permissions for a message.

`src/task-access.ts` validates the composer's explicit Company/file selections. `tools/turn-authority.ts` persists them beside the admitted input, freezes them across retries and binds resumed tools to their originating task. Prose and Company content confer no recipient or file permission.

`src/agent-data.ts` owns streamed export and the deletion receipt/login cutoff. `agent-data-routes.ts` owns the authenticated HTTP interface; `ui/agent-data.tsx` owns its explicit user confirmation. The agent coordinates stopping tools and Company revocation before erasure. A refused revocation retains the local data and credential for retry. Application SQL/KV erasure and the login cutoff commit atomically, so an interruption cannot erase the cutoff and readmit old cookies. Erasure resets the object to clear memory-only caches as well as storage.

Further extraction from `client.ts` or `operations.ts` should follow a state boundary, such as OAuth transport or approval settlement, with the existing replay/concurrency tests retained. Moving methods solely to meet a line limit would obscure which object owns their mutable state.
