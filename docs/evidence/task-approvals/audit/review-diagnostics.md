## Review

Read-only review of the immutable `f10b24e1acab871797bce422cc366d1e83b91943` export and supplied `86f7752..f10b24e` diff. Read project instructions and relevant `pda-spec.md` requirements. No commands, network access, or edits.

### Finding

- **P2 — Per-action capture misses file-disclosure flows, especially batch decisions.**
  - **Locations:** `src/flow-diagnostics.ts:41–49`, `src/poppy/apis.ts:943–946`, `src/poppy/capability.ts:574–581`.
  - **Evidence:** Flow retention indexes only a top-level `approval_id` or tool-call `task_request_id`/`approval_id`. File-consent proposals return their ID without attaching either tool reference. A `poppy.approvals` batch frame records counts, but none of its approval IDs. Consequently, neither originating upload-tool events nor their batch-decision event enters the individual flow buffers.
  - **Minimal repro:** Propose two photo uploads sharing a valid batch key; decide both through one `poppy.approvals` frame; export either approval’s diagnostics. The lifecycle state exists, but those proposal/decision events are absent even before retention limits are reached.
  - **Smallest fix:** Attach the generated file-consent approval ID to its tool trace; attach a bounded, typed approval-ID collection to batch events and consume it in `FlowDiagnostics.keep`.
  - **Confidence:** Source-proven capture omission; repro not executed. This is an observability gap, not a demonstrated dispatch or privacy failure.

### Correct

- **Turn/tool lifetime:** Ended turns detach immediately but emit only after active instrumented tools settle (`src/agent-log.ts:278–289, 375–380`). The regression test exercises a later run finishing first and verifies the late tool’s error remains on its original event without Company error text (`test/log.test.ts:104–130`).

- **Bounded retention:** Flow buffers deduplicate by `(flow_id, seq)` and prune using both event count and actual UTF-8 byte length, then retain the 50 most recently logged flows (`src/flow-diagnostics.ts:49–61`). Tests inspect SQL counts and byte totals rather than relying on suite totals (`test/flow-diagnostics.test.ts:54–83`).

- **Scope isolation and matching:** Validated flow requests are answered on the requesting socket (`src/agent-log.ts:409–418`). Copy/download require the response’s flow ID to match the selected scope (`src/ui/protocol.tsx:216–246`). Tests cover owner-versus-other-agent access and mismatched-scope download rejection.

- **Privacy:** Lifecycle export selects IDs and closed state fields—not requests, results, action fingerprints, or task fingerprints (`src/flow-diagnostics.ts:27–33, 71–76`). Link rejections contain fixed reason names and counts; browser reports contain indexes and booleans, with `client_reported: true` explicitly recorded (`src/poppy/result-links.ts:4–12`; `src/poppy/capability.ts:455–470`). No new URL/body/content fingerprint enters these diagnostics.

- **Renderer safety:** Labels are bounded and directional formatting controls removed during extraction. Result anchors retain the original URL attribute and independently display the parsed hostname (`src/poppy/result-links.ts:34–40`; `src/poppy-ui.tsx:625–634`). Tests distinguish exact attribute equality from browser-resolved normalization. Approval-summary Markdown/HTML remains inert, with explicit negative assertions (`test/ui/poppy-ui.test.tsx:311–318`).

- **Stronger OU oracle:** OU now requires Company-operation identity before approval and matching approved identity afterward. Negative controls reject a preliminary local hold and a completion lacking approval identity (`interop/scenarios/OU.json:15–17`; `interop/test/scenario.test.ts:247–253`).

### Limitations

- Scoped exports explicitly disclose shared turn/frame context and cannot reconstruct pruned history (`src/flow-diagnostics.ts:81–82`). Retention limits govern event lines, not the complete export envelope/current-state section.
- Anchor equality is authenticated-client telemetry—not independent server proof of rendering or navigation.
- OU’s new identity checks strengthen the oracle but still depend on adapter-reported evidence.
- The flow “restart” test invokes Poppy recovery without reconstructing `AgentLog` (`test/worker.ts:974–978`); it is not a full logger/process-restart test.
- Reported focused/property passes were not independently rerun. Final suite, typecheck, and CI remain outstanding.

**Merge verdict: OK with notes for this seam**, with the P2 capture gap recorded; not a whole-PR or final-CI approval.