/**
 * The validator's pages: a form, a results page and a page explaining every
 * message. Plain server-rendered HTML with no scripts, so it works anywhere
 * and results can be linked to (`/validator?url=example.com`).
 */
import { MESSAGES, type MessageId } from "./messages.ts";
import type { Message } from "./primitives.ts";
import { PROFILES } from "./profiles/index.ts";
import type { Report } from "./validate.ts";

const escape = (value: unknown): string =>
  String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const STYLE = `
:root{--bg:#fbfaf7;--fg:#1d1c1a;--muted:#5f5b53;--line:#dedad2;--panel:#ffffff;--accent:#2f5bd3;--error:#b42318;--warn:#8a5a00;--info:#3d5a80;--ok:#1f7a3a;--code:#f3f1ec}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#161615;--fg:#ecebe8;--muted:#a5a199;--line:#33322f;--panel:#1f1f1d;--accent:#8fb0ff;--error:#ff8a80;--warn:#f5c26b;--info:#9db8e0;--ok:#7fd49a;--code:#262624}}
:root[data-theme="dark"]{--bg:#161615;--fg:#ecebe8;--muted:#a5a199;--line:#33322f;--panel:#1f1f1d;--accent:#8fb0ff;--error:#ff8a80;--warn:#f5c26b;--info:#9db8e0;--ok:#7fd49a;--code:#262624}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:1.6rem;margin:0 0 4px}
h2{font-size:1.15rem;margin:32px 0 8px}
h3{font-size:1rem;margin:20px 0 6px}
p{margin:8px 0}
a{color:var(--accent)}
.lede{color:var(--muted);margin-bottom:24px}
form{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;margin:16px 0}
label{display:block;font-weight:600;margin:12px 0 4px}
.hint{color:var(--muted);font-size:.9rem;margin:2px 0 0}
input[type=text],select,textarea{width:100%;font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 10px}
textarea{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9rem;min-height:180px}
button{margin-top:14px;font:inherit;font-weight:600;color:#fff;background:var(--accent);border:0;border-radius:8px;padding:8px 16px;cursor:pointer}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) button{color:#111}}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media (max-width:560px){.row{grid-template-columns:1fr}}
.outcome{border-radius:10px;padding:14px 16px;margin:16px 0;border:1px solid var(--line);background:var(--panel)}
.outcome strong{font-size:1.1rem}
.outcome.valid strong{color:var(--ok)}.outcome.invalid strong{color:var(--error)}.outcome.indeterminate strong{color:var(--warn)}
ul.messages{list-style:none;padding:0;margin:0}
ul.messages li{border-top:1px solid var(--line);padding:10px 0}
.sev{font-weight:600}
.sev.error{color:var(--error)}.sev.warning{color:var(--warn)}.sev.info{color:var(--info)}
.where{color:var(--muted);font-size:.9rem}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.88rem}
code{background:var(--code);padding:1px 4px;border-radius:4px}
pre{background:var(--code);padding:8px 10px;border-radius:8px;overflow-x:auto;margin:6px 0}
dl{margin:0}dt{font-weight:600;margin-top:8px}dd{margin:0 0 4px;color:var(--muted)}
.doc{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 16px;margin:12px 0}
.doc p{margin:2px 0;overflow-wrap:anywhere}
section.msg{border-top:1px solid var(--line);padding:12px 0}
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

const DOCUMENT_NAMES = {
  poppy: "poppy.json",
  "oauth-metadata": "OAuth server metadata",
  "client-metadata": "Client metadata",
  jwks: "Key set (jwks_uri)",
  "protected-resource": "Protected resource metadata"
} as const;

function forms(values: { url?: string; document?: string; kind?: string; domain?: string; fetchedFrom?: string } = {}): string {
  const kinds = Object.entries(DOCUMENT_NAMES)
    .map(([value, name]) => `<option value="${value}"${values.kind === value ? " selected" : ""}>${escape(name)}</option>`)
    .join("");
  return `
<form method="get" action="/validator">
  <label for="url">Domain or URL</label>
  <input type="text" id="url" name="url" value="${escape(values.url ?? "")}" placeholder="example.com" autocapitalize="off" spellcheck="false">
  <p class="hint">A Company's domain checks its poppy.json, the domain's protected resource metadata and the issuer's OAuth server metadata. A Personal Agent's client_id URL checks its client metadata and keys.</p>
  <button type="submit">Check</button>
</form>
<form method="post" action="/validator">
  <label for="document">Or paste a document</label>
  <textarea id="document" name="document" spellcheck="false">${escape(values.document ?? "")}</textarea>
  <div class="row">
    <div><label for="kind">It's a</label><select id="kind" name="kind">${kinds}</select></div>
    <div><label for="domain">Requested domain (optional)</label><input type="text" id="domain" name="domain" value="${escape(values.domain ?? "")}" placeholder="example.com"></div>
  </div>
  <label for="fetched_from">Fetched from URL, for client metadata (optional)</label>
  <input type="text" id="fetched_from" name="fetched_from" value="${escape(values.fetchedFrom ?? "")}" placeholder="https://agent.example/agent.json">
  <button type="submit">Check this document</button>
</form>`;
}

export function formPage(origin: string): string {
  const versions = PROFILES.map((p) => escape(p.name)).join(", ");
  return page(
    "Poppy Validator",
    `<h1>Poppy Validator</h1>
<p class="lede">Checks Personal Agent Protocol discovery documents against the specification (${versions}), so a Company or a Personal Agent can find a problem before the other side runs into it. <a href="/validator/messages">What each message means</a>.</p>
${forms()}
<h2>Use it from code</h2>
<pre>curl -s ${escape(origin)}/validator/api -H 'Content-Type: application/json' \\
  -d '{"url": "example.com"}'</pre>
<p>Or post a document: <code>{"document": "{…}", "kind": "poppy", "domain": "example.com"}</code>. The response is the JSON report described on <a href="/validator/messages#output">the messages page</a>. Errors break a requirement (a MUST, an RFC's MUST, or a normative rule without a key word); warnings depart from a recommendation (a SHOULD, the Guides) or our reading of an open question; info is worth knowing but harmless. Each message names its basis, and the report says separately whether our own agent refuses the documents.</p>`
  );
}

function excerpt(source: string | undefined, message: Message): string {
  if (!source || message.line === undefined) return "";
  const line = source.split("\n")[message.line - 1];
  if (line === undefined) return "";
  const caret = " ".repeat(Math.max(0, (message.column ?? 1) - 1)) + "^";
  return `<pre>${escape(line.slice(0, 200))}\n${caret}</pre>`;
}

function messageItem(message: Message, source: string | undefined): string {
  const where = [
    message.line !== undefined ? `line ${message.line}, column ${message.column}` : "",
    message.pointer ? `<code>${escape(message.pointer)}</code>` : ""
  ]
    .filter(Boolean)
    .join(" · ");
  return `<li><span class="sev ${message.severity}">${SEVERITY_NAMES[message.severity]}</span> ${escape(message.text)}
<div class="where">${where ? `${where} · ` : ""}${escape(basisLabel(message))} · <a href="${escape(message.ref.url)}">${escape(message.ref.label)}</a> · <a href="/validator/messages#${message.id}">${escape(message.id)}</a></div>${excerpt(source, message)}</li>`;
}

const SEVERITY_NAMES = { error: "Error", warning: "Warning", info: "Info" } as const;

/** The basis, and whether our agent's decision differs from the severity's. */
function basisLabel(m: { readonly basis: string; readonly severity: Message["severity"]; readonly refuses: boolean }): string {
  const policy = m.refuses && m.severity !== "error" ? ", but our agent refuses it" : !m.refuses && m.severity === "error" ? ", but our agent tolerates it" : "";
  return `Basis: ${m.basis}${policy}`;
}

export function resultPage(
  result: Report,
  input: { url?: string; document?: string; kind?: string; domain?: string; fetchedFrom?: string }
): string {
  const { error, warning, info } = result.counts;
  const headline =
    result.outcome === "indeterminate"
      ? "Couldn't check: a document couldn't be fetched within the limits"
      : result.outcome === "invalid"
        ? `Not valid: ${error} error${error === 1 ? "" : "s"}`
        : warning > 0
          ? "Valid, with recommendations"
          : "Valid";
  const verdict =
    result.outcome === "invalid"
      ? "An error is a MUST, or a normative rule of the draft or an RFC it builds on, that the documents break."
      : result.outcome === "valid" && warning > 0
        ? "Agents can use these documents, but the warnings below (a SHOULD, the Guides, or our reading of an open question) may stop some of them working well."
        : result.outcome === "valid"
          ? "Agents can use these documents."
          : "";
  const ours =
    result.outcome === "indeterminate"
      ? ""
      : result.refused
        ? result.outcome === "invalid"
          ? " Our Personal Agent refuses them."
          : " Our Personal Agent still refuses them, for the warnings marked so below."
        : result.outcome === "invalid"
          ? " Our Personal Agent tolerates these errors, as the draft tells readers to, and would use them."
          : "";
  const note = `${verdict}${ours}`;
  const documents = result.documents
    .map((doc) => {
      const messages = result.messages.filter((m) => m.document === doc.kind);
      const facts = [
        doc.url ? `<p>${escape(doc.url)}${doc.finalUrl && doc.finalUrl !== doc.url ? ` → ${escape(doc.finalUrl)}` : ""}</p>` : "",
        doc.status !== undefined ? `<p class="where">HTTP ${doc.status}${doc.contentType ? ` · ${escape(doc.contentType)}` : ""}${doc.maxAgeSeconds != null ? ` · cacheable for ${doc.maxAgeSeconds} s` : ""}</p>` : ""
      ].join("");
      const list = messages.length
        ? `<ul class="messages">${messages.map((m) => messageItem(m, input.document)).join("")}</ul>`
        : "<p>No problems found.</p>";
      return `<div class="doc"><h3>${escape(DOCUMENT_NAMES[doc.kind])}</h3>${facts}${list}</div>`;
    })
    .join("");
  const skipped = result.skipped.length
    ? `<h2>Not checked</h2><ul>${result.skipped.map((s) => `<li>${escape(s.check)}. ${escape(s.reason)}</li>`).join("")}</ul>`
    : "";
  const json = input.url ? `<p><a href="/validator/api?url=${encodeURIComponent(input.url)}">This report as JSON</a></p>` : "";
  return page(
    "Poppy Validator results",
    `<h1><a href="/validator" style="color:inherit;text-decoration:none">Poppy Validator</a></h1>
<div class="outcome ${result.outcome}"><strong>${escape(headline)}</strong><p>${escape(note)} Checked against ${escape(result.checkedAgainst)}: ${error} error${error === 1 ? "" : "s"}, ${warning} warning${warning === 1 ? "" : "s"}, ${info} info.</p></div>
${documents}${skipped}${json}
<h2>Check again</h2>${forms(input)}`
  );
}

export function messagesPage(): string {
  const entries = (Object.entries(MESSAGES) as [MessageId, (typeof MESSAGES)[MessageId]][])
    .map(
      ([id, m]) => `<section class="msg" id="${id}"><h3>${escape(m.title)}</h3>
<p class="where"><code>${id}</code> · <span class="sev ${m.severity}">${SEVERITY_NAMES[m.severity]}</span> · ${escape(basisLabel(m))} · <a href="${escape(m.ref.url)}">${escape(m.ref.label)}</a></p>
<p>${escape(m.explain)}</p><p><strong>Fix:</strong> ${escape(m.fix)}</p></section>`
    )
    .join("");
  return page(
    "Poppy Validator messages",
    `<h1>What the messages mean</h1>
<p class="lede"><a href="/validator">Back to the validator</a>. Message ids are stable, so tools can key on them. Each message names its basis, and its severity follows from it. An error breaks a requirement: a MUST in the specification (basis MUST), a MUST of an RFC it builds on (RFC), or a normative statement written without a key word (Rule). A warning departs from a recommendation: a SHOULD (SHOULD), the Guides, which call each item "a recommendation, in the sense of SHOULD" (Guides), or our answer to a question the draft leaves open (Reading). Info reports something worth knowing that breaks nothing, such as a field this version doesn't define (agents ignore those, so later versions can add fields). Only errors make documents invalid. What our own Personal Agent refuses is a separate choice, shown where it differs: it also refuses a few warnings that guard against hostile documents, and tolerates a few errors the draft tells readers to tolerate.</p>
<h2 id="output">The JSON report</h2>
<dl>
<dt>outputVersion</dt><dd>1. Changes that break readers of the report get a new number.</dd>
<dt>outcome</dt><dd>valid (no errors), invalid (an error), or indeterminate (a document couldn't be fetched, or not within the limits the Guides recommend, so it couldn't be checked).</dd>
<dt>refused</dt><dd>Whether our Personal Agent refuses these documents: an error it doesn't tolerate, a warning it refuses, or a document it couldn't check.</dd>
<dt>checkedAgainst</dt><dd>The protocol version whose rules were applied, chosen from poppy.json's protocol_version.</dd>
<dt>documents</dt><dd>Each document checked: kind, url, finalUrl after redirects, status, contentType, maxAgeSeconds, and the parsed value.</dd>
<dt>messages</dt><dd>id, basis (MUST, RFC, Rule, SHOULD, Guides or Reading), severity, refuses (whether our agent refuses the documents over it), document, pointer (a JSON Pointer), line and column (1-based) when known, text, and ref (the section of the specification or RFC).</dd>
<dt>skipped</dt><dd>Checks that needed something the input didn't give, such as the domain a pasted poppy.json was served from.</dd>
</dl>
<h2>Messages</h2>${entries}`
  );
}
