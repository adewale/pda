/** Draft 0.2 overlays only changed rules; unchanged 0.1 checks remain shared. */
import { draft0 } from "./draft-0.ts";
import { httpsMember, isObject, member, unknownMembers, type Obj } from "../primitives.ts";
import type { Profile } from "./profile.ts";

export const draft02: Profile = {
  ...draft0,
  version: "0.2",
  name: "Draft 0.2",
  poppy(c, doc, context) {
    c.protocolVersion = "0.2";
    // 0.1 compares the requested domain with www normalization. 0.2 uses
    // the final serving host and case only. Other organization checks reuse 0.1.
    const facts = draft0.poppy(c, doc, {});
    if (facts.domain && context.requestedDomain && facts.domain.toLowerCase() !== context.requestedDomain.toLowerCase()) {
      c.report("organization-domain-mismatch", "/organization/domain", `organization.domain is ${facts.domain}, but the document was served by ${context.requestedDomain}.`);
    }
    if (isObject(doc) && "feedback" in doc) {
      const feedback = member<Obj>(c, doc, "", "feedback", "object", false);
      if (feedback) {
        httpsMember(c, feedback, "/feedback", "endpoint", true);
        unknownMembers(c, feedback, "/feedback", ["endpoint"]);
      }
      if (!isObject(doc.auth)) c.report("auth-required", "/auth", "feedback requires auth and Sessions.");
    }
    return facts;
  },
  oauthMetadata(c, doc, poppy) {
    c.protocolVersion = "0.2";
    draft0.oauthMetadata(c, doc, poppy);
    if (isObject(doc) && "dpop_signing_alg_values_supported" in doc) {
      const algs = member<unknown[]>(c, doc, "", "dpop_signing_alg_values_supported", "array", false);
      if (algs && algs.includes("ES256") && algs.some((alg) => typeof alg !== "string")) {
        c.report("metadata-dpop-alg", "/dpop_signing_alg_values_supported", "DPoP algorithms must be strings and include ES256.");
      }
    }
  },
  clientMetadata(c, doc, context) { c.protocolVersion = "0.2"; return draft0.clientMetadata(c, doc, context); },
  jwks(c, doc) { c.protocolVersion = "0.2"; draft0.jwks(c, doc); }
};
