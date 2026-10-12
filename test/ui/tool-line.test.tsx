import { describe, expect, it } from "vitest";
import { companyNames, describeToolCall } from "../../src/ui/tool-line";
import { gs, jsonValues, property } from "../properties/hegel";

/**
 * The transcript's one-line summary of each Poppy tool call
 * (`src/ui/tool-line.ts`): what the agent did, where, how, and with what
 * access, in the page's words. Tools that aren't Poppy's get no line, so
 * they keep their compact card.
 */

const done = { error: false };
const names = new Map([["manzanita.example", "Manzanita"]]);

describe("describeToolCall", () => {
  it("reads an API GET as viewing, at the Company by name", () => {
    expect(describeToolCall("poppy_api_call", { domain: "manzanita.example", operation: "GET /orders" }, done, names)).toEqual({
      text: "Read orders at Manzanita",
      how: "API",
      access: "view",
      state: "done"
    });
  });

  it("names the last fixed part of a path, skipping parameters", () => {
    const line = describeToolCall("poppy_api_call", { domain: "manzanita.example", operation: "GET /orders/{order_id}/line_items" }, done, names)!;
    expect(line.text).toBe("Read line items at Manzanita");
  });

  it("says a write that became a proposal is waiting for the User's approval", () => {
    const line = describeToolCall(
      "poppy_api_call",
      { domain: "manzanita.example", operation: "POST /orders/{order_id}/exchanges" },
      { error: false, details: { status: 202, proposed: { operation_id: "op_1" } } },
      names
    )!;
    expect(line).toMatchObject({ text: "Asked you to approve a change at Manzanita", how: "API", access: "view and change", state: "waiting" });
  });

  it("says a write that went through changed something", () => {
    const line = describeToolCall("poppy_api_call", { domain: "manzanita.example", operation: "DELETE /saved/{id}" }, { error: false, details: { status: 204 } }, names)!;
    expect(line).toMatchObject({ text: "Made a change at Manzanita: saved", access: "view and change", state: "done" });
  });

  it("quotes what the agent asked the Company's agent", () => {
    expect(describeToolCall("poppy_message", { domain: "manzanita.example", text: "Where is  my\norder?" }, done, names)).toEqual({
      text: "Asked Manzanita's agent:",
      quote: "Where is my order?",
      how: "their agent",
      access: null,
      state: "done"
    });
    expect(describeToolCall("poppy_message", { domain: "manzanita.example", conversation: "c1", text: "Thanks" }, done, names)!.text).toBe("Wrote to Manzanita's agent:");
    expect(describeToolCall("poppy_message", { domain: "manzanita.example", data: { size: "L" } }, done, names)!.text).toBe("Sent details to Manzanita's agent");
  });

  it("clips a long quote", () => {
    const line = describeToolCall("poppy_message", { domain: "x.example", text: "a".repeat(500) }, done)!;
    expect(line.quote!.length).toBeLessThanOrEqual(120);
    expect(line.quote!.endsWith("…")).toBe(true);
  });

  it("describes a sign-in request with its access", () => {
    expect(describeToolCall("poppy_sign_in", { domain: "manzanita.example", scopes: ["poppy:read"], reason: "x" }, { error: false, details: { status: "waiting for the User (direct sign-in card shown)" } }, names)).toMatchObject({
      text: "Asked you to sign in at Manzanita",
      how: "sign-in",
      access: "view"
    });
    expect(describeToolCall("poppy_sign_in", { domain: "manzanita.example", scopes: ["poppy:read", "poppy:write"] }, { error: false, details: { status: "signed in with access the User granted earlier" } }, names)).toMatchObject({
      text: "Used the access you gave Manzanita before",
      access: "view and change"
    });
  });

  it("describes website steps, and a form submit as waiting for approval", () => {
    expect(describeToolCall("poppy_browse", { domain: "manzanita.example", action: "open", url: "https://manzanita.example/account/orders?page=2" }, done, names)!.text).toBe(
      "Opened /account/orders on Manzanita's website"
    );
    expect(describeToolCall("poppy_browse", { domain: "manzanita.example", action: "fill", selector: "#size", value: "L" }, done, names)).toMatchObject({
      text: "Filled in a field on Manzanita's website",
      how: "website"
    });
    expect(describeToolCall("poppy_browse", { domain: "manzanita.example", action: "submit", selector: "form" }, { error: false, details: { proposed: "apr_1" } }, names)).toMatchObject({
      text: "Asked you to approve sending a form on Manzanita's website",
      access: "view and change",
      state: "waiting"
    });
  });

  it("reports running and failed calls", () => {
    expect(describeToolCall("poppy_discover", { domain: "manzanita.example" }, undefined, names)).toMatchObject({ text: "Looked up what Manzanita offers personal agents", state: "running" });
    expect(describeToolCall("poppy_discover", { domain: "nowhere.example" }, { error: true, text: "No poppy.json" })).toMatchObject({ text: "Looked up what nowhere.example offers personal agents", state: "failed" });
  });

  it("falls back to the domain, then to 'the Company'", () => {
    expect(describeToolCall("poppy_status", { domain: "Acme.Example" }, done)!.text).toBe("Checked your accounts and conversations at Acme.Example");
    expect(describeToolCall("poppy_discover", {}, done)!.text).toBe("Looked up what the Company offers personal agents");
  });

  it("says poppy_status with no domain checked every company", () => {
    expect(describeToolCall("poppy_status", {}, done)!.text).toBe("Checked what's open at every company");
  });

  it("gives an unknown Poppy tool a plain line, and other tools none", () => {
    expect(describeToolCall("poppy_future_thing", {}, done)).toMatchObject({ text: "Used future thing", how: null, access: null });
    expect(describeToolCall("read_file", { path: "/etc/passwd" }, done)).toBeNull();
    expect(describeToolCall("", {}, done)).toBeNull();
  });

  it("never throws, and always says something, whatever the arguments", () => {
    const tools = ["poppy_discover", "poppy_sign_in", "poppy_status", "poppy_message", "poppy_read", "poppy_handoff", "poppy_invite_user", "poppy_close", "poppy_api_describe", "poppy_api_call", "poppy_mcp_list", "poppy_mcp_call", "poppy_browse", "poppy_operation", "poppy_x"];
    // Anything: any JSON, undefined, and objects whose names shadow Object.prototype's.
    const anything = gs.oneOf<unknown>(
      jsonValues(3),
      gs.just(undefined),
      gs.maps(gs.sampledFrom(["constructor", "toString", "__proto__", "valueOf", "domain", "company", "scopes"]), jsonValues(1), { maxSize: 3 }).map((map) => Object.fromEntries(map))
    );
    property((tc) => {
      const name = tc.draw(gs.sampledFrom(tools));
      const args = tc.draw(anything);
      const outcome = tc.draw(gs.optional(gs.record({ error: gs.booleans(), details: anything }))) ?? undefined;
      const line = describeToolCall(name, args, outcome);
      expect(line).not.toBeNull();
      expect(line!.text.length).toBeGreaterThan(0);
    })();
  });
});

describe("companyNames", () => {
  it("learns names from discovery results only", () => {
    const found = companyNames([
      { name: "poppy_discover", details: { company: "Manzanita", domain: "Manzanita.example" } },
      { name: "poppy_status", details: { company: "Other", domain: "other.example" } },
      { name: "poppy_discover", details: null }
    ]);
    expect([...found]).toEqual([["manzanita.example", "Manzanita"]]);
  });
});
