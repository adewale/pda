#!/usr/bin/env node
/**
 * Validate Personal Agent Protocol discovery documents from the command line.
 * Needs Node 22.18+ or 23.6+, which run TypeScript directly. See `--help`.
 */
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { validateTarget, validateText, VALIDATOR, type DocumentKind, type Report } from "../src/validator/index.ts";

const HELP = `Usage: poppy-validate [options] <domain | url | file | ->

  example.com                         A Company: its poppy.json and OAuth server metadata
  https://agent.example/client.json   A Personal Agent: its client metadata and key set
  ./poppy.json                        A file (say what it is with --kind)
  -                                   A document on standard input

Options:
  --kind <kind>         poppy (default), oauth-metadata, client-metadata or jwks
  --domain <domain>     For a poppy.json file: the domain that serves it
  --fetched-from <url>  For a client metadata file: the URL that serves it
  --protocol <x.y>      Version for documents that don't declare one (default: newest known)
  --json                Print the JSON report
  --strict              Fail on warnings too
  --quiet               Print errors only
  --version, --help

Exit status: 0 valid, 1 invalid, 2 couldn't check or bad usage.
Every message's explanation: /validator/messages on any deployment of this agent.`;

const KINDS: readonly DocumentKind[] = ["poppy", "oauth-metadata", "client-metadata", "jwks"];

function fail(message: string): never {
  process.stderr.write(`poppy-validate: ${message}\n\n${HELP}\n`);
  process.exit(2);
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      kind: { type: "string" },
      domain: { type: "string" },
      "fetched-from": { type: "string" },
      protocol: { type: "string" },
      json: { type: "boolean" },
      strict: { type: "boolean" },
      quiet: { type: "boolean" },
      version: { type: "boolean" },
      help: { type: "boolean", short: "h" }
    }
  });
} catch (error) {
  fail((error as Error).message);
}
const { values, positionals } = parsed;
if (values.help) {
  process.stdout.write(`${HELP}\n`);
  process.exit(0);
}
if (values.version) {
  process.stdout.write(`${VALIDATOR.name} ${VALIDATOR.version}\n`);
  process.exit(0);
}
if (positionals.length !== 1) fail("give one domain, URL, file or -");
const target = positionals[0]!;
const kind = (values.kind ?? "poppy") as DocumentKind;
if (!KINDS.includes(kind)) fail(`--kind must be one of ${KINDS.join(", ")}`);
const options = {
  ...(values.domain ? { domain: values.domain } : {}),
  ...(values["fetched-from"] ? { fetchedFrom: values["fetched-from"] } : {}),
  ...(values.protocol ? { protocolVersion: values.protocol } : {})
};

let report: Report;
let label: string;
if (target === "-" || existsSync(target)) {
  const text = target === "-" ? readFileSync(0, "utf8") : readFileSync(target, "utf8");
  label = target === "-" ? "<stdin>" : target;
  report = validateText(kind, text, options);
} else {
  label = target;
  report = await validateTarget((request) => fetch(request), target, options);
}

if (values.json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const where = (document: DocumentKind) =>
    report.documents.find((d) => d.kind === document)?.finalUrl ?? report.documents.find((d) => d.kind === document)?.url ?? label;
  for (const message of report.messages) {
    if (values.quiet && message.severity !== "error") continue;
    const position = message.line !== undefined ? `:${message.line}:${message.column}` : "";
    const pointer = message.pointer ? ` at ${message.pointer}` : "";
    process.stdout.write(
      `${where(message.document)}${position}: ${message.severity} [${message.id}] ${message.text}${pointer} (${message.ref.label})\n`
    );
  }
  if (!values.quiet) {
    for (const skipped of report.skipped) process.stdout.write(`not checked: ${skipped.check}. ${skipped.reason}\n`);
  }
  const { error, warning, info } = report.counts;
  const headline =
    report.outcome === "indeterminate"
      ? "couldn't check: a document couldn't be fetched"
      : report.outcome === "invalid"
        ? "not valid"
        : warning > 0
          ? "valid, with recommendations"
          : "valid";
  process.stdout.write(`${headline} (${report.checkedAgainst}): ${error} errors, ${warning} warnings, ${info} info\n`);
}

const failed = report.outcome === "invalid" || (values.strict && report.counts.warning > 0);
process.exit(report.outcome === "indeterminate" ? 2 : failed ? 1 : 0);
