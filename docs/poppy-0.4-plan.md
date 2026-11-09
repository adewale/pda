# Poppy 0.4 upgrade plan

What PDA needs to change to speak Poppy 0.4, from the [0.4 changelog](https://personalagentprotocol.org/docs/changelog#v0-4) and a diff of every normative 0.3 page against its 0.4 draft, both read on 9 November 2026. 0.4 is still a draft that grows; recheck this list against the text that gets pinned, following [the upgrade procedure](upgrading.md). 0.3 was published on 4 November and won't change; its text matches our [3 November pin](../spec/draft-0.3-retrieved-2026-11-03/README.md).

Each item names the side it touches: **agent** (`src/poppy/`), **mock** (the strict mock Company in `test/mock-company/`, with a `violations.ts` id and a negative `TAMPERS` case for each new check), **validator** (`src/validator/`). Extension version numbers don't change in 0.4: Operations stays 2 and Mediated Sign-In 1, even though Operations 2 gains the website flow.

## Decide first

- **One version or two.** 0.4 is built for Companies and agents that serve several versions at once (3.4), and Print with Poppy still serves 0.3. [Decision 37](decisions.md#37-03-alone-what-dropping-01-and-02-overturns-and-settles) keeps one version. Running 0.3 and 0.4 side by side means a version-selection layer, per-conversation versions and a second validator profile; replacing 0.3 cuts us off from Companies still on it.
- **When.** Port once 0.4 is pinned upstream or a peer speaks it, not while the draft grows.
- **Website operations.** Whether PDA's fetch browser takes on the new Operations flow, or declares it can't and keeps website forms behind local consent only.

## Done ahead of the port

These are 0.4 rules that 0.3 also allows. They're shipped under 0.3 with tests that fail on the earlier code.

- [x] Device Sign-In links only on the issuer's host or `organization.domain` (0.4 4.3). `deviceLink` in `src/poppy/signin.ts`.
- [x] Protected resource metadata from the derived URL is used only when its `resource` is that URL (0.4 4.5, RFC 9728 3.3). `serviceResource` in `src/poppy/client.ts`.
- [x] One DPoP key per User ID (0.4 4.5). `dpopKey` in `src/poppy/client.ts`.

## Versions and extensions (breaking)

- [ ] **agent** Choose a version from `poppy.json` and `supported_versions`: the newest compatible one. Use a linked document only on the same host, without redirects, with the `protocol_version` it's listed under, no nested `supported_versions`, and the same `organization.domain` and issuer (3.4). `protocol-version.ts`, `discovery.ts`.
- [ ] **agent** Send `Poppy-Version` (`major.minor`) on every request with the Session header, the same throughout a Session (3.4, 5.2).
- [ ] **agent** On `version_unsupported`, fetch `poppy.json` again without the cache; if another version is chosen, start a new Session and send the request once more, otherwise stop (8.13). Reconcile this with unknown-outcome holds before resending anything that has an effect.
- [ ] **agent** Drop `extensions` from the client metadata (`routes.ts`, `interop/` client) and declare extensions per request in `Poppy-Extensions`, an RFC 9651 List of Strings with the version in `v`, the same throughout a Session (3.3, 3.4).
- [ ] **agent** Read each extension in `poppy.json` as a list of versions (`discovery.ts`).
- [ ] **agent** Read `extension_required` at APIs from a JSON body instead of the `WWW-Authenticate` challenge (3.3, 7). `client.ts` challenge parsing, `openapi-dispatch.ts`.
- [ ] **agent** Store the versions each conversation started in, and handle `version_mismatch` (409) by finishing in a Session with those versions or starting a new conversation (8.2, 8.13).
- [ ] **mock** `supported_versions` with a linked document; reject a missing or unserved `Poppy-Version`; take the extension declaration from the header instead of client metadata (`core.ts`); extension lists in `poppy.json` (`web.ts`); `extension_required` as a body (`apis.ts`); a configurable `version_mismatch`.
- [ ] **validator** A 0.4 profile next to `profiles/draft-0.3.ts`: extension lists, `supported_versions` and its linked documents, no client-metadata `extensions`.

## Conversations (breaking)

- [ ] **agent** Replace `status` with `working`, `handoff`, `closed` and `responder` (8.7): the `STATUSES` set, the conversation table, the busy check and Activity. A new conversation starts with `handoff` `none`, `responder` `agent`, `closed` `false`. Treat an unknown `handoff` as `pending`. Read until `working` is `false`; trust the state fields only once `has_more` is `false` (8.5). `conversations.ts`, `activity.ts`.
- [ ] **agent** Read a `working` stream event with no SSE `id` (8.6).
- [ ] **agent** Every conversation `POST` has a top-level `id`, unique for the User across all requests; a message has no `id` or `role` of its own (8.2–8.4). Migrate stored message intents to the request `id`. `request_id_conflict` replaces `message_id_conflict` (`error-codes.ts`). A missing `id` is `invalid_request`.
- [ ] **agent** A `POST` without `wait` returns only `conversation_id`; acceptance isn't action (8.3). `wait` is allowed on every `POST`. Send the next request only after the previous one is accepted when order matters.
- [ ] **agent** `POST {endpoint}/{id}/handoff/cancel`, and read the outcome from `handoff` and `responder` (8.9). Messages, handoff requests and cancels to a Direct Conversation's parent get `direct_conversation_open` (8.10).
- [ ] **agent** Close returns 202 and may drop requests not yet acted on; read until `working` is `false` before closing (8.12). Closing a closed conversation is 202 too.
- [ ] **agent** Optionally send `as_of_cursor` on messages with `author.type` `agent` and never on `human`; read `as_of_request` from Company Agent messages as a hint only (8.4).
- [ ] **mock** All of the above as the Company side, with violations for a missing request `id`, an ID reused with another path or body, `as_of_*` on a human message, and `status` still sent. Retire `neverQueued` and the `queued` paths.

## Task coverage (breaking)

- [ ] **agent** Read `tasks.endpoint` from `poppy.json` in place of `excluded_tasks.url`, `skill_index` and `feedback.endpoint`. GET it with the Session header and no access token early in each Session; use the response only in that Session. Its excluded list is `excluded_tasks`; `feedback.endpoint` comes from it; skill URLs resolve against `tasks.endpoint`. No response means no excluded tasks (9). `coverage.ts`, `discovery.ts`. The Skills milestone should read the skill index from here.
- [ ] **agent** Add `tasks.endpoint` to the destinations that never get secrets after a redirect, and `feedback.endpoint` from the tasks response to the Session-header destinations (3, 5.2).
- [ ] **mock** Serve `tasks.endpoint`, optionally varying per Session with `Cache-Control: private`.
- [ ] **validator** `tasks.endpoint` in `poppy.json`; the old members are gone.

## Web browsing

- [ ] **agent** Request `poppy:browser-sign-in` only from a Company that lists `browser_session_endpoint`, for a signed-in browser join. On `insufficient_scope` at `/authorize`, join signed out with the same code, or get the scope and start again (6). `browser.ts`.
- [ ] **agent** Read `web.unscoped` before requesting the scope, and tell the User it signs the browser in to everything the account can do there. Don't browse a Company that sets `web.disabled` (3.1, 6).
- [ ] **mock** Require the scope for a signed-in join; `web.unscoped` and `web.disabled` options.
- [ ] **validator** `web.disabled` lists no `browser_session_endpoint` and lists `agent` or `apis`; `web.unscoped` comes with `browser_session_endpoint`.

## Operations

- [ ] **agent, website flow** (Operations 4–8.2), if adopted:
  - Take a `Poppy-Operation` header (RFC 9651 Dictionary with `sid` and `ref`) only from a response the agent's own browser received, never from page content, and only when `sid` names the Session that browser was joined to. `fetch-browser.ts` doesn't surface response headers today.
  - Don't re-join the browser on that 403.
  - `POST {operations.endpoint}` with `{"ref"}`, the Session header and the token. A 403 `approval_required` carries the operation for the terms card; a 400 `invalid_request` means the browser makes the request again for a new reference.
  - Check the operation is for the action the browser just took.
  - Send the approval to `endpoint` (204, nothing performed yet), then have the browser repeat the request. That's a second dispatch of a stored submission and needs its own replay safety.
  - On a new reference after an approval, look up the earlier one: wait while `performing`, don't ask again when `performed` (7).
  - Keep the local form-consent card, so the User sees two cards.
- [ ] **agent** Send `approved_at` (Unix seconds) and `input_type` (such as `tap`) with approvals; `input_type` holds no personal or device data (6). `operations-v2.ts`, `conversations.ts`, `mcp-dispatch.ts`, with the decision time from `approval-decisions.ts`.
- [ ] **agent** A revision may keep its number when only `summary` changes (3); an earlier revision the User prefers can still be approved, and the Company may refuse it.
- [ ] **mock** The website flow and its `endpoint`, with violations for an approval accepted at the wrong interface, an approval applied to a Session that can't approve, and a used-up approval used twice. Accept an approval from another Session of the same agent and User (`operations.ts`); compare requests by meaning rather than bytes.

## Sign-in, tokens and Sessions

- [ ] **agent** Prefer Direct Sign-In (4, 4.3). Already our order in `chooseSignInType`.
- [ ] **agent** Use `auth.scopes` when an OpenAPI security scheme also describes a scope (3.1, 4.7).
- [ ] **mock** `auth.disabled` without other clients answers refresh with `invalid_grant` and revocation with success, without checking the assertion while it has issued no refresh token (3.2).
- [ ] **mock** Find Sessions by `client_id`, `sid` and User ID (5.3, 5.5); reword or retire the check that a known `sid` with another User ID is `invalid_session`. It may reject a delegated key that already signed for another User ID (5.2).
- [ ] **mock** Refresh-token lifetimes are the Company's choice (4.4); drop any check that depends on a fixed one.

## Carrying it through

- [ ] Save the 0.4 snapshot with `scripts/spec-snapshot.mjs --save`, update `spec/upstream.json` and the runtime constants together, and add a 0.4 requirement ledger (`npm run spec:docs`).
- [ ] Re-pin the official Company kit to its 0.4 download and rerun it against the mock profiles.
- [ ] Update the independent Python Hypothesis client in `test/hypothesis/` for the conversation and header changes, so the mock and our client aren't the only readers.
- [ ] Run the interop grid against any peer that speaks 0.4; keep the 0.3 peers' pins.
- [ ] Add an Unreleased CHANGELOG entry with migration and rollback: stored conversation rows and message intents change shape.
- [ ] Rework the [unsent spec feedback](proposals/poppy-feedback.md): 0.4 resolves its refresh-token item (4.7), and the other two are still open.

## Readings to settle

Open questions in the 0.4 text, for [readings](readings.md) once it's pinned:

- Whether "sends the request again, once" after `version_unsupported` is per request or per Session, and how it meets an unknown outcome.
- Whether a signed-in Session's JWT to `tasks.endpoint` omits `ath`, since it carries no access token; and what counts as "no response" there.
- Where `feedback.endpoint` may point now that it comes from the tasks response, which can differ per Session.
- Whether a request rejected with `version_mismatch` or `conversation_closed` uses up its `id`.
- What a close with `wait` returns, and whether requests it drops leave events.
- Whether a 0.3-era Operations 2 agent or Company owes the website flow, given no version change.
- Which reference an approval names after a new one arrives, and what `endpoint` returns for an already performed operation.
- Which list entry's `fields` and `scopes` apply in Mediated Sign-In when there are several.
- Metadata from a `WWW-Authenticate` `resource_metadata` hint: RFC 9728 3.3 also expects its `resource` to match the requested URL, but neither text changes how PDA treats it today.
