## Review

### Correct
- **MCP spoof correction:** `taskBy()` accepts lifecycle references only for `poppy_api_call` (`src/ui/tool-line.ts:58–70`). OpenAPI responses wrap Company content under `body` (`src/poppy/apis.ts:857–861`). The rendered regression checks that forged MCP `poppyTask` data neither changes status nor triggers a lookup (`test/ui/chat-steps.test.tsx:130–139`).
- **Earlier UI corrections are present:** missing results remain unknown, confirmed uploads count toward the folded total, and unknown automatic outcomes render distinctly (`test/ui/chat-steps.test.tsx:109–128`).
- **Publication recovery:** completion rereads committed outcomes; SDK-result regressions cover successful and unknown adopted uploads when receipt publication throws (`src/poppy/operations.ts:519–550`; `test/print-journey.test.ts:489–516`).
- **Policy and browser evidence boundaries:** the policy now discloses small-original fallback, operator access and downstream retention limits. The browser script scopes upload checks to the current Company and reload checks to its exact checkout link (`scripts/app-photo-journey.mjs:86–106`).

### Fixed
- None; read-only review.

### Finding: P1 — interrupted adopted uploads still claim a Human approval
**Location:** `src/poppy/operations.ts:1013–1029`, particularly line 1015.

**Minimal history:**
1. An unselected photo creates a pending `apr_…` disclosure.
2. A fresh genuine User task selects that photo; automatic dispatch adopts the existing disclosure (`operations.ts:519–528`).
3. The dispatch claim records `task-selected|<apr_id>` (`operations.ts:761`).
4. The process stops after that claim, before terminal outcome persistence.
5. Startup recovery uses **`isTaskRequest(row.id)`**, not the attribution marker, and saves: **“Interrupted after you approved”**.

Because the adopted ID remains `apr_…`, that statement is false. Activity exposes this stored result for unknown outcomes (`src/poppy/activity.ts:204–206`; `src/ui/activity.tsx:26–29`). Recovery also omits `taskRequested` from its replacement card. The corrected model notification at `operations.ts:1032` does not correct the durable result or card.

**Smallest fix:** use `taskRequested(client.sql, row.id)` for the recovery wording and propagate that attribution onto the recovered card. Keep authorization unchanged.

**Smallest regression:** extend the adopted-disclosure history to interrupt at `executing`, restart, and assert:
- outcome remains unknown, with no resend;
- Activity never says “after you approved”;
- the recovered card retains `taskRequested: true`.

The existing publication-failure regression starts from already committed `done`/`unknown` outcomes, so it does not cover this boundary.

### Finding: P2 — tool table retains the superseded blanket consent promise
**Location:** `pda-spec.md:695`.

The replay column still says **“uploads keep a consent card fixed per call.”** This became false with task-selected automatic uploads and contradicts decision 39 and the updated upload section.

**Smallest fix:** distinguish a fixed per-call routing decision from a consent card required only for unselected files. Documentation correction only.

### Merge verdict: BLOCK
Resolve the P1 recovery-attribution gap before release. No execution-permission escalation is alleged.

### Verification limits
Source-only inspection of the supplied patch and snapshot; no edits, execution or network access. Test results in `audit.md` were not independently reproduced. Earlier-pin browser/crash receipts are not final-source evidence. Supervisor must run the added recovery regression, `npm test`, typecheck, and final-pin browser/crash acceptance separately. Provider/Gateway settings remain unverified; self-service deletion/export and proposed retention controls remain unimplemented.