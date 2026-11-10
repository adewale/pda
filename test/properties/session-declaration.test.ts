import { describe, expect, it } from "vitest";
import { declaration, declarationHeaders } from "../../src/poppy/declaration";
import type { Company } from "../../src/poppy/discovery";
import { EndpointRequest } from "../../src/poppy/outgoing";
import { parseDictionary } from "../kit-schemas";
import { world } from "./client-fixture";

/**
 * What a Session declares (0.4, 3.4; F2 in docs/poppy-0.4-upgrade.md):
 * `Poppy-Version` and `Poppy-Extensions` on every request with the Session
 * header, the same for the whole Session, and a new Session to change them.
 * The 0.4 Company here is the mock's discovered 0.3 Company read as 0.4,
 * since the mock doesn't serve 0.4 yet; it checks the headers with M1.
 */

async function send(client: Awaited<ReturnType<typeof world>>["client"], company: Company) {
  const response = await client.resource(company, EndpointRequest.to(company, { method: "GET", url: `${company.conversations!.endpoint}/conv_unknown/events` }));
  await response.body?.cancel();
}

describe("what a Session declares (3.4)", () => {
  it("declares the 0.4 version and Operations 3, but not Mediated Sign-In, whose grant type the Company recognizes", async () => {
    const { company } = await world({ protocolVersion: "0.3" });
    const as04: Company = { ...company, protocolVersion: "0.4", extensions: { operations: true } };
    expect(declarationHeaders(declaration(as04))).toEqual([["Poppy-Version", "0.4"], ["Poppy-Extensions", `"operations";v="3"`]]);
    expect(declarationHeaders(declaration({ ...as04, extensions: {} }))).toEqual([["Poppy-Version", "0.4"]]);
    expect(declarationHeaders(declaration(company))).toEqual([]);
  });

  it("writes Poppy-Extensions as an RFC 9651 List of Strings with a String v parameter", () => {
    const value = declaration({ protocolVersion: "0.4", extensions: { operations: true } } as Company).extensions;
    expect(value).toBe(`"operations";v="3"`);
    // The independent parser reads one member, a String with a parameter, as a Dictionary value.
    expect(parseDictionary(`x=${value}`)).toEqual({ x: "operations" });
  });
});

describe("a Session's declaration is fixed for its sid (3.4)", () => {
  it("sends the version and extensions under 0.4, and starts a new Session to change them", async () => {
    const { client, company, mock } = await world({ protocolVersion: "0.3" });
    const as04: Company = { ...company, protocolVersion: "0.4", extensions: { operations: true } };
    const sid = () => client.session(company.issuer, "main")!.session_id;
    const last = async () => (await mock.state()).requests.at(-1)!.headers;

    await send(client, company);
    const first = sid();
    // The Company moved to 0.4: a new Session, before anything is sent with other values.
    await send(client, as04);
    expect(await last()).toMatchObject({ "poppy-version": "0.4", "poppy-extensions": `"operations";v="3"` });
    const second = sid();
    expect(second).not.toBe(first);
    await send(client, as04);
    expect(sid()).toBe(second);
    // An extension it no longer uses: another new Session, which declares none.
    await send(client, { ...as04, extensions: {} });
    expect(await last()).toMatchObject({ "poppy-version": "0.4" });
    expect(await last()).not.toHaveProperty("poppy-extensions");
    expect(sid()).not.toBe(second);
  });

  it("sends no declaration headers under 0.3", async () => {
    const { client, company, mock } = await world({ protocolVersion: "0.3" });
    await send(client, company);
    const headers = (await mock.state()).requests.at(-1)!.headers;
    expect(headers).toHaveProperty("poppy-session");
    expect(headers).not.toHaveProperty("poppy-version");
    expect(headers).not.toHaveProperty("poppy-extensions");
  });

  it("keeps the same Session while nothing changes", async () => {
    const { client, company, sql } = await world({ protocolVersion: "0.3" });
    await send(client, company);
    const sid = client.session(company.issuer, "main")!.session_id;
    await send(client, company);
    expect(client.session(company.issuer, "main")!.session_id).toBe(sid);
    expect(sql.exec("SELECT declared FROM poppy_sessions").toArray()).toEqual([{ declared: JSON.stringify({ version: "0.3", extensions: "" }) }]);
  });

  it("lets a Session started before its first request declare the Company's version, rather than restarting it", async () => {
    const { client, company } = await world({ protocolVersion: "0.3" });
    const as04: Company = { ...company, protocolVersion: "0.4", extensions: { operations: true } };
    // As an authority guard does: the Session exists, bound, before the request is made.
    const sid = client.sessionFor(as04, "main").session_id;
    await send(client, as04);
    expect(client.session(company.issuer, "main")!.session_id).toBe(sid);
  });

  it("starts a new Session, keeping its account, before sending values its Session didn't declare", async () => {
    const { client, company, sql, mock } = await world({ protocolVersion: "0.3" });
    await send(client, company);
    const before = client.session(company.issuer, "main")!;
    // As if the Session had started while the Company served 0.4, and the Company is now read as 0.3.
    sql.exec("UPDATE poppy_sessions SET declared = ?", JSON.stringify({ version: "0.4", extensions: `"operations";v="3"` }));
    await send(client, company);
    const after = client.session(company.issuer, "main")!;
    expect(after.session_id).not.toBe(before.session_id);
    expect(after.account).toBe(before.account);
    // The request went in the new Session: the Company saw both sids.
    expect((await mock.state()).sessions.map((session) => session.sid)).toEqual([before.session_id, after.session_id]);
    expect(sql.exec("SELECT declared FROM poppy_sessions").toArray()).toEqual([{ declared: JSON.stringify({ version: "0.3", extensions: "" }) }]);
  });
});
