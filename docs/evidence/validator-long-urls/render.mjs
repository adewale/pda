// Renders the validator's results page, with the production renderer of one checkout, for a Company
// whose catch-all redirects its protected resource metadata to a sign-in page with a long URL.
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
const [root, out] = process.argv.slice(2);
const { validateCompany } = await import(pathToFileURL(`${root}/src/validator/index.ts`).href);
const { resultPage } = await import(pathToFileURL(`${root}/src/validator/html.ts`).href);
const { withUserAgent } = await import(pathToFileURL(`${root}/src/validator/fetch.ts`).href);
const signIn = `https://login.example-idp.com/app/example_idp_production_tenant_1/exk7g3v8a0D8kEuzr4h7/sso/saml?SAMLRequest=${"fVLRjtMwEPyVyO%2BJ45".repeat(24)}&RelayState=https%3A%2F%2Fexample.com%2Fapp3%2Fwps%2Fmyportal`;
const json = (body) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" } });
const routes = {
  "https://example.com/.well-known/poppy.json": () => json({ protocol_version: "1.0", organization: { name: "Example Company", domain: "example.com" }, agent: { protocols: [{ type: "poppy", endpoint: "https://agents.example.net/poppy", description: "Claims" }] } }),
  "https://example.com/.well-known/oauth-protected-resource": () => new Response(null, { status: 301, headers: { Location: "/app3/wps/myportal" } }),
  "https://example.com/app3/wps/myportal": () => new Response(null, { status: 302, headers: { Location: signIn } }),
  [signIn]: () => new Response("<!DOCTYPE html><html><body>Sign in</body></html>", { headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-cache" } })
};
const fetcher = withUserAgent(async (request) => (routes[request.url] ?? (() => { throw new TypeError("fetch failed"); }))(), "PoppyValidator/evidence");
const report = await validateCompany(fetcher, "example.com");
writeFileSync(out, resultPage(report, { url: "example.com" }));
process.stdout.write(`${report.messages.map((m) => m.id).join(", ")}\n`);
