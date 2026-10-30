import { integer, jsonText, literal, nullable, object, record, string } from "../decode";
import { domainFromInput } from "../domain";
import { one } from "../rows";
import { sameAuthority, sessionAuthority } from "./authority";
import { PoppyClient, PoppyError } from "./client";
import type { Company } from "./discovery";
import { domainsTable, intent } from "./store";

const checkpoint = jsonText(object({
  version: literal(1), domain: string, label: string, issuer: nullable(string),
  bindings: record(object({ sessionId: nullable(string), account: nullable(string), authorityGeneration: integer }))
}));

/** Persist before discovery can yield; a resumed tool keeps the same checkpoint. */
export function beforeCompanyDiscovery(client: PoppyClient, domain: string, label: string, callKey: string): (company: Company) => void {
  const host = domainFromInput(domain);
  const bindings = Object.fromEntries(client.sessions().filter(session => session.label === label).map(session => [session.issuer, sessionAuthority(session)]));
  const issuer = one(client.sql, domainsTable.pick("issuer"), "SELECT issuer FROM poppy_domains WHERE domain = ?", host)?.issuer ?? null;
  const saved = checkpoint(intent(client.sql, `discovery-authority|${callKey}`, () => JSON.stringify({ version: 1, domain: host, label, issuer, bindings })), "discovery authority");
  if (saved.domain !== host || saved.label !== label) throw new PoppyError("approval_changed", "This call already selected a different Company or Session label. Nothing was sent.", 0);
  return company => {
    const expected = saved.bindings[company.issuer] ?? sessionAuthority(undefined);
    if ((saved.issuer !== null && saved.issuer !== company.issuer) || !sameAuthority(expected, sessionAuthority(client.session(company.issuer, label)))) {
      throw new PoppyError("approval_changed", "The account or Session changed during Company discovery. Start a fresh request; nothing was sent.", 0);
    }
  };
}
