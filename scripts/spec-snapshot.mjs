#!/usr/bin/env node
/**
 * Snapshots the Personal Agent Protocol (Poppy) site, personalagentprotocol.org.
 *
 *   node scripts/spec-snapshot.mjs          compare the live site with the newest stored snapshot
 *   node scripts/spec-snapshot.mjs --save   store a new dated snapshot under spec/
 *
 * It fetches sitemap.xml, then each page the sitemap lists, then each page's
 * own Markdown copy where the page declares one (<link rel="alternate"
 * type="text/markdown">), then the home page's walkthrough bundle: the home
 * page's worked examples exist only in that JavaScript. One request per URL,
 * one at a time, with a descriptive User-Agent and no retries. Nothing else
 * on the host is requested.
 *
 * Without --save it prints, for every page, whether the body and the text
 * differ from the newest snapshot's manifest.json, and exits 1 if any text
 * differs. A body can differ with the same text, since every deployment of
 * the site changes its HTML's asset URLs, so the text is what decides.
 *
 * With --save it writes spec/draft-<version>-<updated>/ (a suffix with the
 * retrieval date if that directory exists): manifest.json, the text of each
 * page as Markdown, each page's content HTML, the walkthroughs as Markdown,
 * LICENSE, and a README with the attribution and the hashes. The site's
 * license (Apache 2.0) covers the specification and documentation and their
 * examples, but not the site's design, names or logo, so the full page
 * bodies, stylesheets and scripts are recorded by hash only; the content
 * HTML keeps the text, structure and anchors, without classes, styles, icons
 * or scripts.
 *
 * Local only: not part of CI or `npm test`. Needs Node 22 and no packages.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ORIGIN = "https://personalagentprotocol.org";
const USER_AGENT =
  "dpa-spec-snapshot/1.0 (Durable Personal Agent; snapshots the Poppy spec for citation; one request per page)";
const root = path.resolve(import.meta.dirname, "..");
const specDir = path.join(root, "spec");

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

// ---------------------------------------------------------------------------
// Fetching

async function get(url) {
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT }, redirect: "manual" });
  const body = Buffer.from(await response.arrayBuffer());
  const header = (name) => response.headers.get(name) ?? undefined;
  return {
    url,
    status: response.status,
    retrieved_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    content_type: header("content-type"),
    last_modified: header("last-modified"),
    etag: header("etag"),
    age: header("age"),
    bytes: body.length,
    sha256: sha256(body),
    body
  };
}

/** A short file name for a page URL: "/" is home, "/docs/extensions/operations" is operations. */
function pageName(url) {
  const p = new URL(url).pathname.replace(/\/$/, "");
  if (p === "") return "home";
  const parts = p.split("/").filter(Boolean);
  return parts.at(-1) === "contributions" ? "contributions" : parts.at(-1);
}

async function fetchSite() {
  const sitemap = await get(`${ORIGIN}/sitemap.xml`);
  if (sitemap.status !== 200) throw new Error(`sitemap.xml: HTTP ${sitemap.status}`);
  const urls = [...sitemap.body.toString("utf8").matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
  const pages = [];
  for (const url of urls) {
    if (new URL(url).origin !== ORIGIN) continue; // only the site itself
    const page = await get(url);
    page.name = pageName(url);
    const html = page.body.toString("utf8");
    const alt = html.match(/<link[^>]*rel="alternate"[^>]*type="text\/markdown"[^>]*href="([^"]+)"/)?.[1];
    if (alt && new URL(alt, url).origin === ORIGIN) page.markdown = await get(new URL(alt, url).href);
    pages.push(page);
  }
  let walkthrough;
  const home = pages.find((page) => page.name === "home");
  if (home) {
    const html = home.body.toString("utf8");
    // The React Server Components payload names the chunks of each client
    // component; the walkthrough component's list ends with its own chunk.
    const list = html.match(/\[((?:\\?"[^"\]]*?\\?",?)+)\],\\?"Walkthroughs\\?"/)?.[1];
    const chunk = list && [...list.matchAll(/(\/_next\/static\/chunks\/[^"\\]+\.js[^"\\]*)/g)].at(-1)?.[1];
    if (chunk) walkthrough = await get(new URL(chunk, ORIGIN).href);
  }
  return { sitemap, pages, walkthrough };
}

// ---------------------------------------------------------------------------
// HTML to a tree, and to Markdown

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const DROP = new Set(["script", "style", "svg", "button", "audio", "video", "nav", "aside", "noscript", "template", "head", "iframe", "form", "input", "select", "textarea"]);

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·", rarr: "→", larr: "←", mdash: "—", ndash: "–", hellip: "…", copy: "©" };
const decode = (text) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === "#") return String.fromCodePoint(name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10));
    return ENTITIES[name.toLowerCase()] ?? whole;
  });

function parseHtml(html) {
  const rootNode = { tag: "#root", attrs: {}, children: [] };
  const stack = [rootNode];
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-zA-Z0-9-]+)\s*>|<([a-zA-Z0-9-]+)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+|<)/gi;
  for (const m of html.matchAll(re)) {
    const top = stack.at(-1);
    if (m[1]) {
      const tag = m[1].toLowerCase();
      const at = stack.findLastIndex((node) => node.tag === tag);
      if (at > 0) stack.length = at;
    } else if (m[2]) {
      const tag = m[2].toLowerCase();
      const attrs = {};
      for (const a of (m[3] ?? "").matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? "");
      }
      const node = { tag, attrs, children: [] };
      top.children.push(node);
      if (!VOID.has(tag) && !m[4]) {
        stack.push(node);
        if (tag === "script" || tag === "style") {
          // Raw text: skip to the matching close tag.
        }
      }
    } else if (m[5] !== undefined) {
      top.children.push({ text: m[5] });
    }
  }
  return rootNode;
}

function find(node, test) {
  if (!node.children) return undefined;
  for (const child of node.children) {
    if (child.tag && test(child)) return child;
    const found = find(child, test);
    if (found) return found;
  }
  return undefined;
}

const classes = (node) => (node.attrs?.class ?? "").split(/\s+/);
const dropped = (node) =>
  DROP.has(node.tag) || node.attrs["aria-hidden"] === "true" || classes(node).includes("sr-only");

/** The page's content element: the article on docs pages, main elsewhere. */
function contentOf(html) {
  const tree = parseHtml(html);
  return find(tree, (n) => n.tag === "article") ?? find(tree, (n) => n.tag === "main") ?? find(tree, (n) => n.tag === "body") ?? tree;
}

/** The content as plain HTML: ids, hrefs and table spans kept; classes, styles, icons and scripts gone. */
function contentHtml(node) {
  if (node.text !== undefined) return node.text;
  if (dropped(node)) return "";
  const inner = node.children.map(contentHtml).join("");
  if (classes(node).includes("secnum")) return `${inner} `;
  if (["div", "span"].includes(node.tag) && !node.attrs.id) return inner;
  const keep = ["id", "href", "colspan", "rowspan", "scope", "lang"];
  const attrs = Object.entries(node.attrs)
    .filter(([name]) => keep.includes(name))
    .map(([name, value]) => ` ${name}="${value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`)
    .join("");
  if (VOID.has(node.tag)) return `<${node.tag}${attrs}>`;
  return `<${node.tag}${attrs}>${inner}</${node.tag}>`;
}

function inline(node) {
  if (node.text !== undefined) return decode(node.text).replace(/\s+/g, " ");
  if (dropped(node)) return "";
  const inner = () => node.children.map(inline).join("");
  switch (node.tag) {
    case "code":
      return "`" + textOf(node) + "`";
    case "strong":
    case "b":
      return `**${inner().trim()}**`;
    case "em":
    case "i":
      return `*${inner().trim()}*`;
    case "a": {
      const text = inner().trim();
      const href = node.attrs.href;
      return href && text ? `[${text}](${href})` : text;
    }
    case "br":
      return " ";
    default:
      if (classes(node).includes("secnum")) return inner() + " ";
      if (node.tag === "div" || node.tag === "p") return inner() + " ";
      return inner();
  }
}

const textOf = (node) => (node.text !== undefined ? decode(node.text) : dropped(node) ? "" : node.children.map(textOf).join(""));

function table(node) {
  const rows = [];
  const walk = (n) => {
    for (const child of n.children ?? []) {
      if (!child.tag || dropped(child)) continue;
      if (child.tag === "tr") rows.push(child);
      else walk(child);
    }
  };
  walk(node);
  const cells = rows.map((row) =>
    row.children
      .filter((c) => c.tag === "td" || c.tag === "th")
      .map((c) => {
        const text = blocks(c).replace(/\n+/g, " ").replace(/\|/g, "\\|").trim();
        return { text, head: c.tag === "th", span: Number(c.attrs.colspan ?? 1) };
      })
  );
  const width = Math.max(...cells.map((r) => r.reduce((sum, c) => sum + c.span, 0)), 1);
  const line = (r) => {
    const out = [];
    for (const c of r) {
      out.push(c.head && r.length === 1 ? `**${c.text}**` : c.text);
      for (let i = 1; i < c.span; i++) out.push("");
    }
    while (out.length < width) out.push("");
    return `| ${out.join(" | ")} |`;
  };
  const [head, ...body] = cells;
  if (!head) return "";
  return [line(head), `| ${Array(width).fill("---").join(" | ")} |`, ...body.map(line)].join("\n");
}

/** Block-level Markdown for a node's children. */
function blocks(node, depth = 0) {
  const out = [];
  let para = "";
  const flush = () => {
    const text = para.replace(/\s+/g, " ").trim();
    if (text) out.push(text);
    para = "";
  };
  for (const child of node.children ?? []) {
    if (child.text !== undefined) {
      para += inline(child);
      continue;
    }
    if (dropped(child)) continue;
    const tag = child.tag;
    if (/^h[1-6]$/.test(tag)) {
      flush();
      out.push(`${"#".repeat(Number(tag[1]))} ${child.children.map(inline).join("").replace(/\s+/g, " ").trim()}`);
    } else if (tag === "p" || tag === "figcaption") {
      flush();
      const text = child.children.map(inline).join("").replace(/\s+/g, " ").trim();
      if (text) out.push(text);
    } else if (tag === "pre") {
      flush();
      out.push("```\n" + textOf(child).replace(/\n+$/, "") + "\n```");
    } else if (tag === "ul" || tag === "ol") {
      flush();
      let n = 0;
      const items = child.children
        .filter((li) => li.tag === "li")
        .map((li) => {
          n += 1;
          const marker = tag === "ol" ? `${n}. ` : "- ";
          const body = blocks(li, depth + 1).split("\n");
          return marker + body.map((l, i) => (i === 0 ? l : l ? " ".repeat(marker.length) + l : l)).join("\n");
        });
      out.push(items.join("\n").replace(/\n\n(?=\s*(?:- |\d+\. ))/g, "\n"));
    } else if (tag === "table") {
      flush();
      out.push(table(child));
    } else if (tag === "blockquote") {
      flush();
      out.push(blocks(child, depth).split("\n").map((l) => `> ${l}`).join("\n"));
    } else if (tag === "hr") {
      flush();
      out.push("---");
    } else if (classes(child).includes("code-label")) {
      flush();
      out.push(`*${child.children.map(inline).join("").trim()}*`);
    } else if (["div", "section", "header", "footer", "main", "article", "li", "figure", "dl", "dd", "dt"].includes(tag)) {
      flush();
      const inner = blocks(child, depth);
      if (inner) out.push(inner);
    } else {
      para += inline(child);
    }
  }
  flush();
  return out.join("\n\n");
}

function htmlToMarkdown(html) {
  return blocks({ children: [contentOf(html)] }).replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// ---------------------------------------------------------------------------
// The home page's walkthroughs, read (not run) from the bundle's object literal

function parseLiteral(src, start, scope) {
  let i = start;
  const ws = () => {
    while (/\s/.test(src[i])) i++;
  };
  const value = () => {
    ws();
    const ch = src[i];
    if (ch === "{") {
      i++;
      const obj = {};
      for (;;) {
        ws();
        if (src[i] === "}") return i++, obj;
        let key;
        if (src[i] === '"' || src[i] === "'") key = string();
        else {
          const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
          if (!m) throw new Error(`key at ${i}`);
          key = m[0];
          i += key.length;
        }
        ws();
        if (src[i] === ":") {
          i++;
          obj[key] = value();
        } else obj[key] = scope[key]; // shorthand
        ws();
        if (src[i] === ",") i++;
      }
    }
    if (ch === "[") {
      i++;
      const arr = [];
      for (;;) {
        ws();
        if (src[i] === "]") return i++, arr;
        arr.push(value());
        ws();
        if (src[i] === ",") i++;
      }
    }
    if (ch === '"' || ch === "'") return string();
    if (ch === "`") return template();
    if (ch === "!" && /[01]/.test(src[i + 1])) return (i += 2), src[i - 1] === "0";
    const num = /^-?\d+(\.\d+)?/.exec(src.slice(i));
    if (num) return (i += num[0].length), Number(num[0]);
    const id = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
    if (id) {
      i += id[0].length;
      if (id[0] === "null") return null;
      if (id[0] === "true" || id[0] === "false") return id[0] === "true";
      if (!(id[0] in scope)) throw new Error(`unknown name ${id[0]} at ${i}`);
      return scope[id[0]];
    }
    throw new Error(`unexpected ${JSON.stringify(src.slice(i, i + 20))} at ${i}`);
  };
  const escape = (c) => ({ n: "\n", t: "\t", r: "\r", "\\": "\\", '"': '"', "'": "'", "`": "`", $: "$" })[c];
  const string = () => {
    const quote = src[i++];
    let s = "";
    while (src[i] !== quote) {
      if (src[i] === "\\") {
        const c = src[i + 1];
        if (c === "x") (s += String.fromCharCode(parseInt(src.slice(i + 2, i + 4), 16))), (i += 4);
        else if (c === "u" && src[i + 2] === "{") {
          const end = src.indexOf("}", i);
          s += String.fromCodePoint(parseInt(src.slice(i + 3, end), 16));
          i = end + 1;
        } else if (c === "u") (s += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16))), (i += 6);
        else (s += escape(c) ?? c), (i += 2);
      } else s += src[i++];
    }
    i++;
    return s;
  };
  const template = () => {
    i++;
    let s = "";
    while (src[i] !== "`") {
      if (src[i] === "\\") {
        const c = src[i + 1];
        if (c === "x") (s += String.fromCharCode(parseInt(src.slice(i + 2, i + 4), 16))), (i += 4);
        else if (c === "u") (s += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16))), (i += 6);
        else (s += escape(c) ?? c), (i += 2);
      } else if (src[i] === "$" && src[i + 1] === "{") {
        const end = src.indexOf("}", i);
        const name = src.slice(i + 2, end).trim();
        if (!(name in scope)) throw new Error(`unknown name ${name} in template at ${i}`);
        s += scope[name];
        i = end + 1;
      } else s += src[i++];
    }
    i++;
    return s;
  };
  const result = value();
  return { value: result, end: i };
}

/** The walkthrough data: the array literal starting `[{id:`, with the constants declared before it. */
function walkthroughs(js) {
  const at = js.search(/[A-Za-z_$][\w$]*=\[\{id:"/);
  if (at < 0) throw new Error("no walkthrough array found");
  // The `let` statement that declares the constants and the array.
  const letAt = js.lastIndexOf("let ", at);
  const scope = {};
  let i = letAt + 4;
  for (;;) {
    const m = /^([A-Za-z_$][\w$]*)=/.exec(js.slice(i));
    if (!m) throw new Error(`declaration at ${i}`);
    i += m[0].length;
    const { value, end } = parseLiteral(js, i, scope);
    scope[m[1]] = value;
    i = end;
    if (js[i] === ",") i++;
    if (Array.isArray(value) && value[0]?.steps) return value;
    if (js[i] === ";") throw new Error("walkthrough array not in the declaration");
  }
}

function walkthroughMarkdown(list) {
  const out = ["# Walkthroughs", "", "The home page's worked examples, read from its JavaScript bundle and written out as text. The companies are fictional."];
  const code = (s) => "```\n" + s.replace(/\n+$/, "") + "\n```";
  const row = (cells) => `| ${cells.map((c) => String(c ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ")} |`;
  for (const w of list) {
    out.push("", `## ${w.title}`, "", `*${w.shows}*`, "", w.summary);
    for (const [n, step] of (w.steps ?? []).entries()) {
      out.push("", `### ${n + 1}. ${step.title}${step.time ? ` (${step.time})` : ""}`);
      if (step.caption) out.push("", step.caption);
      if (step.chat?.length) {
        out.push("", "Chat:", "");
        for (const line of step.chat) out.push(`- **${line.t ?? line.from}:** ${line.text ?? ""}${line.reaction ? ` (${line.reaction})` : ""}`);
      }
      const company = step.company ?? step.view;
      if (company) {
        const co = company.co ?? {};
        out.push("", `What ${co.name ?? "the company"}${co.domain ? ` (${co.domain})` : ""} sees:`);
        for (const [key, value] of Object.entries(company)) {
          if (key === "co" || key === "rows") continue;
          if (typeof value === "string") out.push("", `${key}: ${value}`);
          else if (Array.isArray(value) && value.every((v) => typeof v === "object"))
            for (const v of value) out.push("", `- ${Object.values(v).filter((x) => typeof x === "string").join(" — ")}`);
        }
        if (company.rows?.length) out.push("", row(["Field", "Value"]), row(["---", "---"]), ...company.rows.map((r) => row(r)));
      }
      for (const wire of step.wire ?? []) {
        out.push("", `*${wire.dir}${wire.kind ? ` (${wire.kind})` : ""}*`, "", code(wire.body ?? ""));
      }
    }
  }
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Counting RFC 2119 sentences

const KEYWORD = /\b(MUST NOT|MUST|SHALL NOT|SHALL|SHOULD NOT|SHOULD|REQUIRED|RECOMMENDED|NOT RECOMMENDED|MAY|OPTIONAL)\b/g;

/**
 * Sentences with a BCP 14 keyword in capitals, outside code, without the
 * boilerplate that defines the keywords: [{ section, text }], where section
 * is the nearest heading above. Table cells count as sentences of their own.
 */
export function keywordSentences(markdown) {
  const spans = [];
  const text = markdown
    .replace(/```[\s\S]*?```/g, "\n")
    .replace(/`[^`]*`/g, (span) => `\u0001${spans.push(span) - 1}\u0001`);
  const restore = (s) => s.replace(/\u0001(\d+)\u0001/g, (_, i) => spans[Number(i)]);
  const found = [];
  let section = "";
  for (const block of text.split(/\n\s*\n|\n(?=\s*(?:[-*] |\d+\. |\||#))/)) {
    const heading = block.trim().match(/^#+\s+(.*)/);
    if (heading) {
      section = heading[1].trim();
      continue;
    }
    const cells = block.trim().startsWith("|") ? block.split(/\s\|\s/) : [block];
    for (const cell of cells) {
      for (const sentence of cell.replace(/\s+/g, " ").split(/(?<=[.!?])\s+(?=[A-Z*[("])/)) {
        const s = sentence.trim();
        if (s.match(KEYWORD) && !/key words .*BCP 14|in the sense of SHOULD|it says MUST and links/.test(s)) {
          found.push({ section, text: restore(s) });
        }
      }
    }
  }
  return found;
}

function keywordCounts(markdown) {
  const sentences = keywordSentences(markdown);
  const words = {};
  for (const { text } of sentences) for (const [w] of text.matchAll(KEYWORD)) words[w] = (words[w] ?? 0) + 1;
  return { sentences: sentences.length, words };
}

// ---------------------------------------------------------------------------
// Rendering a fetched site

function render(site) {
  const pages = site.pages.map((page) => {
    const html = page.body.toString("utf8");
    const updated = html.replace(/<!--.*?-->/g, "").match(/Updated\s*(?:<[^>]+>\s*)*([A-Z][a-z]{2} \d{1,2}, \d{4})/)?.[1];
    const markdown = page.markdown?.status === 200 ? page.markdown.body.toString("utf8") : htmlToMarkdown(html);
    const content = contentHtml(contentOf(html));
    return {
      ...page,
      updated,
      markdownText: markdown,
      markdownSource: page.markdown?.status === 200 ? page.markdown.url : "converted from the page's HTML",
      // Exactly what save() writes to html/<name>.html, so the manifest hashes the file it names.
      storedHtml: `<!-- ${page.url}, content only; see ../README.md -->\n${content}\n`,
      counts: keywordCounts(markdown)
    };
  });
  let walk;
  if (site.walkthrough) {
    try {
      walk = walkthroughMarkdown(walkthroughs(site.walkthrough.body.toString("utf8")));
    } catch (error) {
      walk = undefined;
      console.warn(`walkthroughs not extracted: ${error.message}`);
    }
  }
  return { pages, walkthroughText: walk };
}

const fetchedFields = ({ url, status, retrieved_at, content_type, last_modified, etag, age, bytes, sha256: hash }) => ({
  url,
  status,
  retrieved_at,
  content_type,
  last_modified,
  etag,
  age,
  bytes,
  sha256: hash
});

function manifestOf(site, rendered, dir) {
  const spec = rendered.pages.find((page) => page.name === "spec");
  const version = spec?.markdownText.match(/draft version (\d+\.\d+)/)?.[1];
  return {
    site: ORIGIN,
    directory: dir,
    protocol_version: version,
    user_agent: USER_AGENT,
    sitemap: fetchedFields(site.sitemap),
    pages: rendered.pages.map((page) => ({
      name: page.name,
      ...fetchedFields(page),
      updated: page.updated ?? null,
      markdown: {
        file: `pages/${page.name}.md`,
        source: page.markdownSource,
        ...(page.markdown ? { fetched: fetchedFields(page.markdown) } : {}),
        sha256: sha256(page.markdownText)
      },
      content_html: { file: `html/${page.name}.html`, sha256: sha256(page.storedHtml) },
      rfc2119: page.counts
    })),
    walkthrough_bundle: site.walkthrough
      ? {
          ...fetchedFields(site.walkthrough),
          stored: "hash only (site code); its examples are in pages/walkthroughs.md",
          ...(rendered.walkthroughText ? { markdown: { file: "pages/walkthroughs.md", sha256: sha256(rendered.walkthroughText) } } : {})
        }
      : null
  };
}

function readme(manifest, licenseText) {
  const date = manifest.sitemap.retrieved_at.slice(0, 10);
  const rows = manifest.pages.map(
    (p) =>
      `| [${p.name}](${p.url}) | ${p.status} | ${p.retrieved_at} | ${p.updated ?? "(none shown)"} | \`${p.sha256}\` | [${p.markdown.file}](${p.markdown.file}) |`
  );
  const w = manifest.walkthrough_bundle;
  return `# Personal Agent Protocol, Draft ${manifest.protocol_version}: snapshot of ${date}

A copy of [personalagentprotocol.org](${ORIGIN}) as published on ${date}, so that what we say about the specification can be checked against the text it was written against. Made by \`scripts/spec-snapshot.mjs --save\`; \`node scripts/spec-snapshot.mjs\` compares the live site with the newest snapshot.

## Attribution and license

The Personal Agent Protocol specification and documentation, including their examples, are © their authors and licensed under the [Apache License 2.0](${ORIGIN}/license); a copy of the license is in [LICENSE](LICENSE). This is a copy of that work, changed only in form:

- \`pages/*.md\` is each page's own Markdown copy where the page publishes one (\`<link rel="alternate" type="text/markdown">\`), unchanged; for the other pages it is converted from the page's HTML.
- \`html/*.html\` is each page's content element, with the site's classes, styles, icons, buttons and scripts removed, kept for its section anchors.
- \`pages/walkthroughs.md\` is the home page's worked examples, read from the data in its JavaScript bundle and written out as text.

The license doesn't cover the names Personal Agent Protocol and Poppy, the logo, or the design of the site, so none of the site's stylesheets, scripts, images or full page bodies are stored here: each page body and the walkthrough bundle is recorded by its SHA-256 below and in \`manifest.json\`. The names are used only to say where this came from. The companies in the examples are fictional.

## Pages

| Page | HTTP | Retrieved (UTC) | "Updated" shown | SHA-256 of the body | Text |
| --- | --- | --- | --- | --- | --- |
${rows.join("\n")}

The sitemap (${manifest.sitemap.url}) had SHA-256 \`${manifest.sitemap.sha256}\`. ${
    w
      ? `The home page's walkthroughs live only in the JavaScript bundle ${w.url} (HTTP ${w.status}, ${w.bytes} bytes, SHA-256 \`${w.sha256}\`).`
      : "The walkthrough bundle wasn't found."
  }

Each page's \`Last-Modified\`, \`ETag\` and \`Age\` headers, the hashes of the Markdown and content HTML, and the RFC 2119 keyword counts are in \`manifest.json\`. A page body changes with every deployment of the site, because its asset URLs carry a deployment id; the Markdown is what to compare.
`;
}

function licenseOf(rendered) {
  const page = rendered.pages.find((p) => p.name === "license");
  if (!page) return undefined;
  // The license text is the page's preformatted block.
  const block = page.markdownText.match(/```\n(\s*Apache License[\s\S]*?)\n```/)?.[1];
  return block ? block.replace(/^\s*(?=Apache License)/, "                                 ") + "\n" : undefined;
}

function save(site) {
  const rendered = render(site);
  const spec = rendered.pages.find((page) => page.name === "spec");
  const version = spec?.markdownText.match(/draft version (\d+\.\d+)/)?.[1] ?? "unknown";
  const updated = spec?.updated ? new Date(`${spec.updated} UTC`).toISOString().slice(0, 10) : "undated";
  let dir = `draft-${version}-${updated}`;
  if (existsSync(path.join(specDir, dir))) dir += `-retrieved-${site.sitemap.retrieved_at.slice(0, 10)}`;
  const out = path.join(specDir, dir);
  mkdirSync(path.join(out, "pages"), { recursive: true });
  mkdirSync(path.join(out, "html"), { recursive: true });
  for (const page of rendered.pages) {
    writeFileSync(path.join(out, "pages", `${page.name}.md`), page.markdownText);
    writeFileSync(path.join(out, "html", `${page.name}.html`), page.storedHtml);
  }
  if (rendered.walkthroughText) writeFileSync(path.join(out, "pages", "walkthroughs.md"), rendered.walkthroughText);
  const manifest = manifestOf(site, rendered, dir);
  writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const license = licenseOf(rendered);
  if (license) writeFileSync(path.join(out, "LICENSE"), license);
  writeFileSync(path.join(out, "README.md"), readme(manifest, license));
  console.log(`saved spec/${dir}`);
  summary(manifest);
}

function summary(manifest) {
  for (const p of manifest.pages) {
    console.log(`${p.name.padEnd(14)} ${p.status} updated=${p.updated ?? "-"} body=${p.sha256.slice(0, 12)} text=${p.markdown.sha256.slice(0, 12)} rfc2119=${p.rfc2119.sentences}`);
  }
}

function newestSnapshot() {
  if (!existsSync(specDir)) return undefined;
  const manifests = readdirSync(specDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(specDir, d.name, "manifest.json")))
    .map((d) => JSON.parse(readFileSync(path.join(specDir, d.name, "manifest.json"), "utf8")))
    .sort((a, b) => a.sitemap.retrieved_at.localeCompare(b.sitemap.retrieved_at));
  return manifests.at(-1);
}

function compare(site) {
  const stored = newestSnapshot();
  if (!stored) {
    console.log("No stored snapshot under spec/; run with --save.");
    return 1;
  }
  const rendered = render(site);
  const now = manifestOf(site, rendered, stored.directory);
  console.log(`Comparing with spec/${stored.directory} (retrieved ${stored.sitemap.retrieved_at})`);
  let changed = 0;
  const line = (name, body, text, extra = "") => console.log(`${name.padEnd(14)} body ${body}  text ${text}${extra}`);
  const same = (a, b) => (a === b ? "same   " : "DIFFERS");
  console.log(`${"sitemap".padEnd(14)} ${same(stored.sitemap.sha256, now.sitemap.sha256)}`);
  if (stored.sitemap.sha256 !== now.sitemap.sha256) changed++;
  const names = new Set([...stored.pages.map((p) => p.name), ...now.pages.map((p) => p.name)]);
  for (const name of names) {
    const a = stored.pages.find((p) => p.name === name);
    const b = now.pages.find((p) => p.name === name);
    if (!a || !b) {
      console.log(`${name.padEnd(14)} ${a ? "GONE from the sitemap" : "NEW in the sitemap"}`);
      changed++;
      continue;
    }
    const textChanged = a.markdown.sha256 !== b.markdown.sha256;
    if (textChanged) changed++;
    const updated = a.updated !== b.updated ? `  updated ${a.updated} -> ${b.updated}` : "";
    const counts = a.rfc2119.sentences !== b.rfc2119.sentences ? `  rfc2119 ${a.rfc2119.sentences} -> ${b.rfc2119.sentences}` : "";
    line(name, same(a.sha256, b.sha256), same(a.markdown.sha256, b.markdown.sha256), updated + counts);
  }
  const wa = stored.walkthrough_bundle;
  const wb = now.walkthrough_bundle;
  const wText = wa?.markdown?.sha256 !== wb?.markdown?.sha256;
  if (wText) changed++;
  line("walkthroughs", same(wa?.sha256, wb?.sha256), same(wa?.markdown?.sha256, wb?.markdown?.sha256));
  console.log(changed ? `\n${changed} text change(s); run with --save to store a new snapshot.` : "\nNo text changes.");
  return changed ? 1 : 0;
}

// ---------------------------------------------------------------------------

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--save");
  if (unknown.length) {
    console.error(`usage: node scripts/spec-snapshot.mjs [--save]`);
    process.exit(2);
  }
  const site = await fetchSite();
  if (args.includes("--save")) save(site);
  else process.exitCode = compare(site);
}

export { save, compare, htmlToMarkdown, walkthroughs, walkthroughMarkdown, render, manifestOf, readme, licenseOf, contentHtml, contentOf, keywordCounts };
