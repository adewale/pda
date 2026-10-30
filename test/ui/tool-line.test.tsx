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

it.each([
  { kind: "authorization_requested", status: "not sent", authorizationRequest: {} },
  { kind: "withheld", status: "not sent" },
  { status: "not sent", authorizationRequest: {} },
  { status: "not sent" }
])("does not present a withheld verification reply as sent: %j", details => {
  const line = describeToolCall("poppy_message", { domain: "manzanita.example", conversation: "c1", text: "The verification code is 482913" }, { error: false, details }, names);
  expect(line?.text).toContain("Kept verification details private");
  expect(line?.text).not.toContain("Wrote");
  expect(line?.quote).toBeUndefined();
});

it("does not quote a failed credential reply as a message sent to the Company", () => {
  const line = describeToolCall("poppy_message", { domain: "manzanita.example", text: "password: hunter2" }, { error: true }, names);
  expect(line?.text).toContain("Couldn't confirm");
  expect(line?.quote).toBeUndefined();
});

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
      { error: false, details: { status: 403, proposed: "apr2_AbCdEfGhIjKlMnOpQrStUv" } },
      names
    )!;
    expect(line).toMatchObject({ text: "Asked you to approve a change at Manzanita", how: "API", access: "view and change", state: "waiting" });
  });

  it("says an upload asked the User to approve sending their photo", () => {
    const line = describeToolCall(
      "poppy_api_call",
      { domain: "manzanita.example", operation: "uploadPhoto", files: { photo: "att_AbCdEfGhIjKlMnOpQrStUv" } },
      { error: false, details: { proposed: "apr_1" } },
      names
    )!;
    expect(line).toMatchObject({ text: "Asked you to approve sending your photo to Manzanita", how: "API", access: "view and change" });
  });

  it.each([
    [undefined, "Sending your photo to Manzanita", "running"],
    [{ error: false, details: { status: 201 } }, "Sent your photo to Manzanita", "done"],
    [{ error: false, details: { status: "in_progress" } }, "Sending your photo to Manzanita", "running"],
    [{ error: true }, "Couldn't confirm sending your photo to Manzanita", "failed"]
  ] as const)("describes a task-authorized upload from its actual outcome: %j", (outcome, text, state) => {
    expect(describeToolCall("poppy_api_call", { domain: "manzanita.example", operation: "uploadPhoto", files: { photo: "att_AbCdEfGhIjKlMnOpQrStUv" } }, outcome, names)).toMatchObject({ text, state });
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

  it("describes a sign-in request, naming no access level for the Company's own scopes", () => {
    expect(describeToolCall("poppy_sign_in", { domain: "manzanita.example", scopes: ["orders:read"], reason: "x" }, { error: false, details: { status: "waiting for the User (direct sign-in card shown)" } }, names)).toMatchObject({
      text: "Asked you to sign in at Manzanita",
      how: "sign-in",
      access: null
    });
    // 0.3 defines no scopes (spec 4.7): a Company's scope named like 0.2's is still only the Company's.
    expect(describeToolCall("poppy_sign_in", { domain: "manzanita.example", scopes: ["poppy:read", "poppy:write"] }, { error: false, details: { status: "signed in with access the User granted earlier" } }, names)).toMatchObject({
      text: "Used the access you gave Manzanita before",
      access: null
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

  it("says poppy_status with no domain checked every Company", () => {
    expect(describeToolCall("poppy_status", {}, done)!.text).toBe("Checked what's open at every Company");
  });

  it("gives an unknown Poppy tool a plain line, and other tools none", () => {
    expect(describeToolCall("poppy_future_thing", {}, done)).toMatchObject({ text: "Used future thing", how: null, access: null });
    expect(describeToolCall("read_file", { path: "/etc/passwd" }, done)).toBeNull();
    expect(describeToolCall("", {}, done)).toBeNull();
  });

  it("says where read_url read, with its status and size, and never what the page said", () => {
    const outcome = { error: false, details: { url: "https://news.example.com/story", status: 200, bytes: 12_400, truncated: true, contentType: "text/html" } };
    expect(describeToolCall("read_url", { url: "https://news.example.com/story?utm=x" }, outcome)).toEqual({
      text: "Read news.example.com/story (HTTP 200, 12 KB, cut short)",
      how: "web page",
      access: null,
      state: "done"
    });
    const rendered = { error: false, details: { url: "https://app.example.com/", status: 200, bytes: 4_200, truncated: false, via: "browser", blocked: 2 } };
    expect(describeToolCall("read_url", { url: "https://app.example.com/", render: true }, rendered)!.text).toBe("Read app.example.com (HTTP 200, 4 KB, rendered in Browser Run)");
    expect(describeToolCall("read_url", { url: "http://localhost/" }, { error: true, text: "Only https:// pages are read" })).toMatchObject({ text: "Couldn't read localhost", state: "failed" });
    expect(describeToolCall("read_url", { url: "https://example.com/" })).toMatchObject({ text: "Reading example.com", state: "running" });
  });

  it("describes memory, time and maths in plain words", () => {
    expect(describeToolCall("remember", { text: "Vegetarian", source: "user" }, { error: false, details: { id: 3, saved: "saved", source: "user" } })).toMatchObject({ text: "Saved a note", quote: "Vegetarian", how: "memory" });
    expect(describeToolCall("remember", { text: "Vegetarian" }, { error: false, details: { saved: "already saved" } })!.text).toBe("Already had this note");
    expect(describeToolCall("remember", { text: "password is x" }, { error: true })).toMatchObject({ text: "Didn't save a note", state: "failed" });
    expect(describeToolCall("recall", { query: "food" }, done)).toMatchObject({ text: "Looked through its notes for", quote: "food" });
    expect(describeToolCall("forget", { id: 3 }, done)!.text).toBe("Forgot note 3");
    expect(describeToolCall("now", {}, done)).toMatchObject({ text: "Checked the date and time", how: "clock" });
    expect(describeToolCall("date_math", { start: "today", add: "P30D" }, { error: false, details: { result: { date: "2026-11-11", weekday: "Wednesday" } } })!.text).toBe(
      "Worked out a date: Wednesday 2026-11-11"
    );
    expect(describeToolCall("calculate", { expression: "0.1 + 0.2" }, { error: false, details: { result: "0.3", exact: true } })).toMatchObject({ text: "Calculated 0.1 + 0.2 = 0.3", how: "calculator" });
  });

  it("describes reminders and scheduled tasks with the User's words and when", () => {
    expect(
      describeToolCall("remind_me", { text: "Call the bank", at: "2026-10-12T17:00" }, { error: false, details: { next_run: "2026-10-12T17:00:00+01:00", repeats: "once", saved: "set" } })
    ).toEqual({ text: "Set a reminder for 2026-10-12 17:00", quote: "Call the bank", how: "schedule", access: null, state: "done" });
    expect(
      describeToolCall("schedule_task", { instruction: "Check my print order" }, { error: false, details: { next_run: "2026-10-13T09:00:00+01:00", repeats: "every weekday at 09:00" } })
    ).toMatchObject({ text: "Scheduled a task every weekday at 09:00", quote: "Check my print order" });
    expect(describeToolCall("schedule_task", { instruction: "Pay Acme" }, { error: true, text: "Refused: this turn wasn't started by the User's own message" })).toMatchObject({
      text: "Didn't schedule a task",
      state: "failed"
    });
    expect(describeToolCall("list_scheduled", {}, done)!.text).toBe("Listed reminders and scheduled tasks");
    expect(describeToolCall("cancel_scheduled", { id: "sch_abc" }, { error: false, details: { id: "sch_abc", status: "cancelled", text: "Bins out" } })).toMatchObject({ text: "Cancelled a reminder or task", quote: "Bins out" });
  });

  it("never throws, and always says something, whatever the arguments", () => {
    const tools = ["poppy_discover", "poppy_sign_in", "poppy_status", "poppy_message", "poppy_read", "poppy_handoff", "poppy_invite_user", "poppy_close", "poppy_api_describe", "poppy_api_call", "poppy_mcp_list", "poppy_mcp_call", "poppy_browse", "poppy_operation", "poppy_x", "read_url", "remember", "recall", "forget", "now", "date_math", "calculate", "remind_me", "schedule_task", "list_scheduled", "cancel_scheduled"];
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
