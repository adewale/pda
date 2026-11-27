/**
 * A report as Markdown, to paste into an issue, a pull request or a chat:
 * the outcome, then each document with its messages, a departure's subject,
 * expected and got apart as the results page shows them. One renderer for
 * the API (`format=markdown`), the results page and the CLI (`--markdown`).
 *
 * The report's text is shown text (src/diagnostic.ts), but it carries values
 * from the documents, so nothing in it is trusted as Markdown: words are
 * escaped, and a URL in them becomes a code span, never a link, so a
 * Company's address isn't made clickable in someone else's issue.
 */
import { show } from "../diagnostic.ts";
import { codeSpan, markdownText as text, markdownWords as words } from "../rich-text.ts";
import type { DocumentResult, Report } from "./validate.ts";
import type { Message } from "./primitives.ts";

const DOCUMENT_NAMES: Readonly<Record<DocumentResult["kind"], string>> = {
  poppy: "poppy.json",
  "oauth-metadata": "OAuth server metadata",
  "client-metadata": "Client metadata",
  jwks: "Key set (jwks_uri)",
  "protected-resource": "Protected resource metadata"
};

const SEVERITY_NAMES = { error: "Error", warning: "Warning", info: "Info" } as const;

function headline(report: Report): string {
  const { error, warning, info } = report.counts;
  const outcome =
    report.outcome === "indeterminate"
      ? "Couldn't check: a document wasn't served, or couldn't be fetched within the limits"
      : report.outcome === "invalid"
        ? "Not valid"
        : warning > 0
          ? "Valid, with recommendations"
          : "Valid";
  const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const ours = report.outcome === "indeterminate" ? "" : report.refused ? " Our Personal Agent refuses them." : "";
  return `**${outcome}.** Checked against ${words(report.checkedAgainst)}: ${plural(error, "error", "errors")}, ${plural(warning, "warning", "warnings")}, ${info} info.${ours}`;
}

function message(m: Message): string {
  const head = `- **${SEVERITY_NAMES[m.severity]}** ${codeSpan(m.id)} · ${words(m.basis)} · [${words(m.ref.label)}](${m.ref.url})${m.pointer ? ` · ${codeSpan(m.pointer)}` : ""}${m.line !== undefined ? ` · line ${m.line}, column ${m.column}` : ""}`;
  if (m.subject !== undefined && m.expected !== undefined && m.got !== undefined) {
    const lines = [head, `  ${text(m.subject)}`, `  - Expected: ${text(m.expected)}`, `  - Got: ${text(m.got)}`];
    if (m.detail !== undefined) lines.push(`  - ${text(m.detail)}`);
    return lines.join("\n");
  }
  return `${head}\n  ${text(m.text)}`;
}

function document(doc: DocumentResult, messages: readonly Message[]): string {
  const where = doc.url === undefined ? "" : `${text(show.url(doc.url, doc.url))}${doc.finalUrl !== undefined && doc.finalUrl !== doc.url ? ` → ${text(show.url(doc.finalUrl, doc.url))}` : ""}`;
  const answer = doc.status === undefined ? "" : `HTTP ${doc.status}${doc.contentType ? ` · ${codeSpan(doc.contentType)}` : ""}`;
  const facts = [where, answer].filter(Boolean).join(" · ");
  const list = messages.length ? messages.map(message).join("\n") : "No problems found.";
  return `## ${DOCUMENT_NAMES[doc.kind]}\n\n${facts ? `${facts}\n\n` : ""}${list}`;
}

export function reportMarkdown(report: Report): string {
  const documents = report.documents.map((doc) => document(doc, report.messages.filter((m) => m.document === doc.kind)));
  // A document that was never fetched (a pasted one) has its messages under its kind all the same.
  const orphans = report.messages.filter((m) => !report.documents.some((doc) => doc.kind === m.document));
  const skipped = report.skipped.length ? `## Not checked\n\n${report.skipped.map((s) => `- ${words(s.check)}. ${words(s.reason)}`).join("\n")}` : "";
  return [
    "# Poppy Validator report",
    headline(report),
    ...documents,
    ...(orphans.length ? [`## Messages\n\n${orphans.map(message).join("\n")}`] : []),
    ...(skipped ? [skipped] : []),
    `Checked by ${words(report.validator.name)} ${words(report.validator.version)} against the ${words(report.specificationRevision)} revision.`
  ].join("\n\n") + "\n";
}
