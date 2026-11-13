/**
 * The 1.0 draft (spec/draft-1.0-retrieved-2026-11-13): 0.4's rules, with a
 * required `description` on each `agent.protocols` entry (8.1), a port in
 * `organization.domain` when it isn't 443 (3.1), and client assertions
 * accepted with ES256 and PS384 (4.1). Its other changes are the Personal
 * Agent's (Pushed Authorization Requests, consent and the same DPoP key at
 * refresh, 4.2 and 4.4), or checked under both versions, since RFC 9126
 * defines the PAR metadata (the shared OAuth metadata check).
 */
import { spec10 } from "../messages.ts";
import type { Checker } from "../primitives.ts";
import { checkOAuthMetadata, checkPoppy, draft04, type OAuthRules, type PoppyRules } from "./draft-0.4.ts";
import type { Profile } from "./profile.ts";

const RULES: PoppyRules = { protocolDescriptions: { ref: spec10("8.1", "conversation-protocols") }, domainPort: true };
const OAUTH: OAuthRules = { assertionAlgs: { ref: spec10("4.1", "agent-identity") } };

export const draft10: Profile = {
  ...draft04,
  version: "1.0",
  name: "Draft 1.0",
  poppy: (c: Checker, doc: unknown, context: { requestedDomain?: string }) => checkPoppy(c, doc, context, RULES),
  oauthMetadata: (c, doc, poppy) => checkOAuthMetadata(c, doc, poppy, OAUTH)
};
