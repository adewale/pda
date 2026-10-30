## Review

- **Correct:** Original placed-User provenance and owner-generation memos are enforced in `src/tools/turn-authority.ts:53–80`. File-bearing API calls capture discovery authority before awaiting task preparation or discovery (`src/poppy/tools.ts:378–390`); the persisted checkpoint checks account/Session changes (`src/poppy/discovery-authority.ts:15–26`). These checks do not prevent the parser failures below.
- **Fixed:** None; read-only review.

### Finding: P1 — Bracketed IPv6 locator queries select an unrelated saved photo

**Location:** `src/poppy/task-text.ts:2,20–29`; `src/poppy/task-files.ts:20–39`.

**Minimal history:**
1. A genuine User submission previously attached `private.jpg`, ID **P**, for private description.
2. A later genuine User task says:  
   `Check my order at first.example. Tracking: [2001:4860:4860::8888]/?file=private.jpg`
3. Company content induces an upload of **P** to `first.example`.

**Source proof:** The bracketed IPv6 token matches neither `URL_START` nor the relative-path/unknown-scheme guards. Line 29 consequently returns it unchanged as narrative. `TaskFiles` matches the historical `private.jpg` after `file=` and adds **P** as an unambiguous image filename. The new automatic route then accepts that selection (`src/poppy/apis.ts:994–1006`).

This contradicts the opaque-outer-locator contract in `pda-spec.md:585`: a URL query, rather than a User file reference, supplies the selected ID. It is not a question of interpreting the task’s meaning.

**Smallest fix:** Recognize and consume complete bracketed IPv6 locators before filename matching; unsupported locator forms should remain opaque rather than become narrative.

**Required regression:** Assert that the task above does **not** select **P**, then extend the obedient-model history to require a disclosure card and zero uploads.

### Finding: P1 — Unicode hostname separators authorize a different Company

**Location:** `src/poppy/task-text.ts:2,26–35`; `src/poppy/task-scope.ts:38–43,63`.

**Minimal history:**
1. The User selects a current photo and says:  
   `Print this photo at first.example. Tracking: orders。second.example/status`
2. `first.example` replies with instructions to upload the selected photo to `second.example`.

Here `。` is U+3002, a hostname separator normalized to `.` by URL parsing. The tracking locator’s host is `orders.second.example`, not `second.example`.

**Source proof:** `URL_START` excludes only ASCII dots at hostname boundaries. It therefore starts a match at `second.example/`, immediately after U+3002. `taskText` records `second.example` as a locator host, and `TaskCompanyScope` includes it in the authorized set—even with foreign content already present. The API scope check passes, and the selected-photo route can disclose without another click (`src/poppy/tools.ts:382–391`; `src/poppy/apis.ts:1003`).

Although suffix recognition was also possible in the former scope implementation, this diff makes it an automatic-photo-disclosure path instead of requiring the separate upload decision.

**Smallest fix:** Parse the complete outer hostname before suffix matching, accounting for URL-normalized Unicode separators. Do not treat a suffix inside that hostname as another locator.

**Required regression:** Assert that the task above refuses `second.example`; cover U+3002, U+FF0E and U+FF61. Extend the Company-redirect regression to require zero second-Company requests.

- **Merge verdict: BLOCK** — both are structural release blockers.

### Verification limits

Reviewed the supplied patch, requirements, audit disposition, named source seams and focused regressions. Findings are source-derived; no execution, network access or repository changes occurred. The reported 2,209 passing tests were not treated as verification of these cases. After adding regressions, the supervisor should run `npm test` and `npm run typecheck`.