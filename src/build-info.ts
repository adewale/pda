import { PROTOCOL_REVISION, PROTOCOL_REVISIONS, PROTOCOL_VERSIONS } from "./poppy/protocol-version";

declare const __PDA_COMMIT__: string | undefined;
declare const __PDA_DIRTY__: boolean | undefined;

/** Public source provenance for release checks; no deployment settings or secrets. */
export function buildInfo(env: Pick<Env, "CF_VERSION_METADATA">): Response {
  return Response.json({
    commit: typeof __PDA_COMMIT__ === "string" ? __PDA_COMMIT__ : "unknown",
    dirty: typeof __PDA_DIRTY__ === "boolean" ? __PDA_DIRTY__ : true,
    workerVersion: env.CF_VERSION_METADATA?.id ?? null,
    protocolVersions: PROTOCOL_VERSIONS,
    protocolRevision: PROTOCOL_REVISION,
    protocolRevisions: PROTOCOL_REVISIONS
  }, { headers: { "Cache-Control": "no-store" } });
}
