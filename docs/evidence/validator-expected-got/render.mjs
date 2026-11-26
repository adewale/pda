// Renders the validator's results page with the production renderer for one checkout.
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
const [root, out] = process.argv.slice(2);
const { validateText } = await import(pathToFileURL(`${root}/src/validator/index.ts`).href);
const { resultPage } = await import(pathToFileURL(`${root}/src/validator/html.ts`).href);
const document = JSON.stringify({ protocol_version: "1.0", organization: { name: "Example Company", domain: "example.com" }, agent: { protocols: "poppy" }, apis: [{ type: "openapi", url: "http://api.example.com/openapi.json", description: "Orders" }] }, null, 2);
const report = validateText("poppy", document, { domain: "example.com" });
writeFileSync(out, resultPage(report, { document, kind: "poppy" }));
process.stdout.write(`${report.messages.map((m) => `${m.id}: ${m.text}`).join("\n")}\n`);
