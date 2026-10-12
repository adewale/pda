/**
 * The cross-check corpus: poppy.json documents every validator is run over.
 *
 * - `ours`: the poppy.json fixtures of test/validator.test.ts, restated here.
 * - `probe`: one document per rule the validators were found to read differently.
 * - `theirs/valid`, `theirs/invalid`: tusharck/poppy-validator's own fixtures.
 * - `sidecar`: habib-analyst/poppy-sidecar's generated examples.
 *
 * The last two are read as data from the pinned sources; nothing of theirs
 * runs here. `buildCorpus` writes `docs/NNN-name.json` and `manifest.json`
 * (file, name, source, the domain it is checked as) into `out`.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const SPEC_POPPY = {
  protocol_version: "0.1",
  organization: { name: "Example Company", domain: "example.com" },
  auth: {
    issuer: "https://auth.example.com",
    direct: { scopes: ["poppy:read", "poppy:write", "addresses"] },
    device: { scopes: ["poppy:read", "poppy:write"] },
    mediated: {
      endpoint: "https://auth.example.com/poppy/sign-in",
      fields: [
        { name: "email", label: "Email", secret: false },
        { name: "password", label: "Password", secret: true }
      ],
      scopes: ["poppy:read"]
    },
    custom_scopes: { addresses: "Manage saved shipping addresses" }
  },
  agent: { protocols: [{ type: "poppy", endpoint: "https://api.example.com/poppy/conversations" }] },
  web: { browser_session_endpoint: "https://example.com/poppy/browser-session" },
  apis: [
    { type: "openapi", url: "https://api.example.com/openapi.json", description: "Orders, returns, and exchanges" },
    { type: "mcp", url: "https://mcp.example.com/mcp", description: "Product search and sizing" }
  ]
};
const DEMO =
  '{"protocol_version":"0.1","organization":{"name":"Northstar Outfitters","domain":"poppy-receiver.roundtrip.workers.dev"},"auth":{"issuer":"https://poppy-receiver.roundtrip.workers.dev","direct":{"scopes":["poppy:read","poppy:write"]}},"agent":{"protocols":[{"type":"poppy","endpoint":"https://poppy-receiver.roundtrip.workers.dev/poppy/conversations"}]},"apis":[{"type":"openapi","url":"https://poppy-receiver.roundtrip.workers.dev/openapi.json","description":"Orders and jacket exchanges"}],"web":{}}';

export function buildCorpus({ theirsFixtures, sidecarExamples, out }) {
  mkdirSync(path.join(out, "docs"), { recursive: true });
  const w = (f) => {
    const d = structuredClone(SPEC_POPPY);
    f(d);
    return d;
  };
  const entries = [];
  const add = (name, source, doc, domain = "example.com") => entries.push({ name, source, domain, doc });

  // Ours: the poppy.json fixtures of test/validator.test.ts
  add("spec-example", "ours", SPEC_POPPY);
  add("poppy-demo-live", "ours", JSON.parse(DEMO), "poppy-receiver.roundtrip.workers.dev");
  add("duplicate-member", "ours", '{"protocol_version":"0.1","protocol_version":"0.1","organization":{"name":"A","domain":"a.example"},"web":{}}', "a.example");
  add("bom", "ours", `﻿${JSON.stringify(SPEC_POPPY)}`);
  add("version-not-major-minor", "ours", w((d) => (d.protocol_version = "1")));
  add("version-major-1", "ours", w((d) => (d.protocol_version = "1.0")));
  add("version-newer-minor", "ours", w((d) => { d.protocol_version = "0.2"; d.later = true; }));
  add("version-missing", "ours", w((d) => delete d.protocol_version));
  add("organization-string", "ours", w((d) => (d.organization = "Example")));
  add("organization-no-name", "ours", w((d) => delete d.organization.name));
  add("organization-domain-url", "ours", w((d) => (d.organization.domain = "https://example.com/")));
  add("organization-other-domain", "ours", SPEC_POPPY, "evil.example");
  add("organization-www", "ours", SPEC_POPPY, "www.example.com");
  add("auth-missing", "ours", w((d) => delete d.auth));
  add("website-only", "ours", { protocol_version: "0.1", organization: { name: "A", domain: "a.example" }, web: {} }, "a.example");
  add("nothing-offered", "ours", w((d) => { delete d.agent; delete d.apis; delete d.web; }));
  add("issuer-http", "ours", w((d) => (d.auth.issuer = "http://auth.example.com")));
  add("issuer-query", "ours", w((d) => (d.auth.issuer = "https://auth.example.com?tenant=1")));
  add("issuer-fragment", "ours", w((d) => (d.auth.issuer = "https://auth.example.com/#x")));
  add("issuer-not-url", "ours", w((d) => (d.auth.issuer = "auth.example.com")));
  add("signed-out-only", "ours", w((d) => (d.auth = { issuer: "https://auth.example.com" })));
  add("mediated-fields-empty", "ours", w((d) => (d.auth.mediated.fields = [])));
  add("mediated-secret-missing-looks-secret-duplicate", "ours", w((d) => (d.auth.mediated.fields = [
    { name: "email", label: "Email" },
    { name: "pin", label: "PIN", secret: false },
    { name: "email", label: "Email again", secret: false }
  ])));
  add("conversation-endpoint-http", "ours", w((d) => (d.agent.protocols[0].endpoint = "http://api.example.com/poppy/conversations")));
  add("operations-unknown-version", "ours", w((d) => (d.extensions = { operations: { version: "2" } })));
  add("operations-no-endpoint", "ours", w((d) => (d.extensions = { operations: { version: "1" } })));

  // Probes: one document per rule the two validators read differently
  add("probe-api-type-unknown-0.1", "probe", w((d) => d.apis.push({ type: "graphql", url: "https://api.example.com/graphql", description: "GraphQL" })));
  add("probe-api-type-unknown-0.2", "probe", w((d) => { d.protocol_version = "0.2"; d.apis.push({ type: "graphql", url: "https://api.example.com/graphql", description: "GraphQL" }); }));
  add("probe-api-description-missing", "probe", w((d) => delete d.apis[0].description));
  add("probe-apis-empty", "probe", w((d) => (d.apis = [])));
  add("probe-api-url-http", "probe", w((d) => (d.apis[0].url = "http://api.example.com/openapi.json")));
  add("probe-mediated-endpoint-http", "probe", w((d) => (d.auth.mediated.endpoint = "http://auth.example.com/poppy/sign-in")));
  add("probe-browser-session-http", "probe", w((d) => (d.web.browser_session_endpoint = "http://example.com/poppy/browser-session")));
  add("probe-scope-reserved", "probe", w((d) => d.auth.direct.scopes.push("poppy:admin")));
  add("probe-scope-space", "probe", w((d) => d.auth.direct.scopes.push("read orders")));
  add("probe-scope-undescribed", "probe", w((d) => d.auth.direct.scopes.push("loyalty")));
  add("probe-scopes-empty", "probe", w((d) => (d.auth.device.scopes = [])));
  add("probe-scope-duplicate", "probe", w((d) => d.auth.device.scopes.push("poppy:read")));
  add("probe-custom-scope-unoffered", "probe", w((d) => (d.auth.custom_scopes.loyalty = "Loyalty points")));
  add("probe-protocols-empty", "probe", w((d) => (d.agent.protocols = [])));
  add("probe-protocol-type-only-unknown", "probe", w((d) => (d.agent.protocols[0].type = "a2a")));
  add("probe-extension-plain-unknown", "probe", w((d) => (d.extensions = { "gift-wrap": { version: "1" } })));
  add("probe-extension-bad-prefix", "probe", w((d) => (d.extensions = { "gift/wrap": { version: "1" } })));
  add("probe-extension-version-integer", "probe", w((d) => (d.extensions = { "example.com/gift-wrap": { version: 1 } })));
  add("probe-extension-version-minor", "probe", w((d) => (d.extensions = { "example.com/gift-wrap": { version: "1.2" } })));
  add("probe-extension-no-version", "probe", w((d) => (d.extensions = { "example.com/gift-wrap": {} })));
  add("probe-domain-uppercase", "probe", w((d) => (d.organization.domain = "Example.com")));
  add("probe-domain-trailing-dot", "probe", w((d) => (d.organization.domain = "example.com.")));
  add("probe-name-blank", "probe", w((d) => (d.organization.name = "")));
  add("probe-mcp-resource-differs", "probe", w((d) => (d.apis[1].resource = "https://mcp.example.com/")));
  add("probe-web-no-endpoint", "probe", w((d) => (d.web = {})));
  add("probe-unknown-member", "probe", w((d) => (d.protocol_verison = "0.1")));
  add("probe-mediated-label-missing", "probe", w((d) => delete d.auth.mediated.fields[0].label));

  // Theirs: tusharck/poppy-validator's fixtures, as data
  for (const kind of ["valid", "invalid"]) {
    for (const file of readdirSync(path.join(theirsFixtures, kind)).sort()) {
      const raw = readFileSync(path.join(theirsFixtures, kind, file), "utf8");
      add(`theirs-${kind}-${file.replace(/\.json$/, "")}`, `theirs/${kind}`, raw, file === "web-only-no-auth.json" ? "brochure.example" : "example.com");
    }
  }

  // habib-analyst/poppy-sidecar's generated examples, as data
  if (sidecarExamples) {
    for (const file of readdirSync(sidecarExamples).filter((f) => f.endsWith(".poppy.json")).sort()) {
      const raw = readFileSync(path.join(sidecarExamples, file), "utf8");
      add(`sidecar-${file.replace(/\.poppy\.json$/, "")}`, "sidecar", raw, JSON.parse(raw).organization.domain);
    }
  }

  const manifest = entries.map((e, i) => {
    const file = `${String(i).padStart(3, "0")}-${e.name}.json`;
    writeFileSync(path.join(out, "docs", file), typeof e.doc === "string" ? e.doc : JSON.stringify(e.doc, null, 2));
    return { file, name: e.name, source: e.source, domain: e.domain };
  });
  writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}
