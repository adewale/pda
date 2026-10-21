import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "./worker";
import { handleValidator } from "../src/validator/http";
import { JSON_PARSE_LIMITS, parseJson } from "../src/validator/json";
import { validateText } from "../src/validator/validate";

// A small wire payload expands into over a million JSON-pointer characters.
// Keep this witness small: the original 47 KB / 1,000-value variant used
// approximately 48 MB of Node heap, so an OOM-sized fixture is unnecessary.
const amplified = () => JSON.stringify({ ["x".repeat(4_000)]: Array(300).fill(0) });

describe("PR review: validator allocation boundaries", () => {
  it("rejects shallow pointer amplification at the actual public Worker route", async () => {
    const document = amplified();
    expect(document.length).toBeLessThan(5_000);
    const response = await worker.fetch(new Request("https://agent.test/validator/api", {
      method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.201" },
      body: JSON.stringify({ document })
    }), env);
    expect(response.status).toBe(413);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("applies the same bound to fetched documents without reporting a JSON syntax violation", async () => {
    let requests = 0;
    const response = await handleValidator(new Request("https://agent.test/validator/api?url=https%3A%2F%2Fmetadata.example%2Fclient.json"), {
      allowRequest: async () => true, allowFetch: async () => true,
      fetcher: async () => { requests++; return new Response(amplified(), { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=60" } }); }
    });
    expect(response!.status).toBe(200);
    expect(await response!.json()).toMatchObject({
      outcome: "indeterminate", refused: true, counts: { error: 0, warning: 1 },
      messages: [{ id: "json-resource-limit", basis: "Guides", refuses: true }]
    });
    expect(requests).toBe(1);
  });

  it("accepts the exact cumulative location allowance and refuses its first additional path", () => {
    const document: Record<string, unknown> = { ["x".repeat(4_000)]: Array(240).fill(0) };
    const initial = parseJson(JSON.stringify(document));
    if (!initial.ok) throw new Error(initial.error);
    const used = [...initial.positions.keys()].reduce((sum, path) => sum + path.length, 0);
    const padding = JSON_PARSE_LIMITS.pointerCharacters - used;
    document["y".repeat(padding - 1)] = null;
    const text = JSON.stringify(document);
    expect(text.length).toBeLessThan(100_000);
    const accepted = parseJson(text);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error(accepted.error);
    expect(accepted.value).toEqual(JSON.parse(text));
    expect([...accepted.positions.keys()].reduce((sum, path) => sum + path.length, 0)).toBe(JSON_PARSE_LIMITS.pointerCharacters);
    document.z = 0;
    expect(parseJson(JSON.stringify(document))).toMatchObject({ ok: false, resourceLimit: true });
  });

  it("counts escaped path lengths and ancestor prefixes, rather than raw key lengths alone", () => {
    const document = JSON.stringify({ ["~/".repeat(1_000)]: Array(300).fill(0) });
    expect(document.length).toBeLessThan(5_000);
    expect(parseJson(document)).toMatchObject({ ok: false, resourceLimit: true });
  });

  it("preserves normal valid metadata, duplicate locations and syntax diagnostics", async () => {
    const document = { client_id: "https://agent.example/client.json", client_name: "Example", jwks_uri: "https://agent.example/jwks.json", redirect_uris: ["https://agent.example/callback"], token_endpoint_auth_method: "private_key_jwt" };
    const response = await worker.fetch(new Request("https://agent.test/validator/api", {
      method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.202" },
      body: JSON.stringify({ document, kind: "client-metadata", fetchedFrom: document.client_id })
    }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: "valid", refused: false });
    expect(validateText("poppy", '{"a":1,"a":2}').messages).toContainEqual(expect.objectContaining({ id: "json-duplicate-member", pointer: "/a", line: 1, column: 8 }));
    expect(validateText("poppy", "{\n}").messages.some(message => message.id === "json-syntax")).toBe(false);
    expect(validateText("poppy", "{\n!").messages[0]).toMatchObject({ id: "json-syntax", line: 2, column: 1 });
  });
});
