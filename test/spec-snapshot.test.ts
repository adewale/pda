/**
 * Each stored snapshot of the draft (spec/<dir>/, made by
 * `scripts/spec-snapshot.mjs --save`) records the SHA-256 of every file it
 * stores. Those hashes are how a reader checks that a quoted passage is the
 * text we stored, so each must be the hash of the file it names, byte for
 * byte: the Markdown, the content HTML (with the attribution comment the
 * script writes around it) and the walkthroughs.
 */
import { describe, expect, it } from "vitest";

type Stored = { file: string; sha256: string };
type Manifest = {
  files?: Record<string, string>;
  pages: { name: string; markdown: Stored; content_html: Stored }[];
  walkthrough_bundle: { markdown?: Stored } | null;
};

const manifests = import.meta.glob("../spec/*/manifest.json", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const stored = import.meta.glob(["../spec/*/pages/*.md", "../spec/*/html/*.html", "../spec/*/kit/**/*", "../spec/*/LICENSE"], { query: "?raw", import: "default", eager: true }) as Record<
  string,
  string
>;

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Every file a manifest names, with the hash it records. */
function recorded(manifest: Manifest): Stored[] {
  if (manifest.files) return Object.entries(manifest.files).map(([file, sha256]) => ({ file, sha256 }));
  return [
    ...manifest.pages.flatMap((page) => [page.markdown, page.content_html]),
    ...(manifest.walkthrough_bundle?.markdown ? [manifest.walkthrough_bundle.markdown] : [])
  ];
}

describe("spec snapshots", () => {
  it("there is at least one stored snapshot", () => {
    expect(Object.keys(manifests).length).toBeGreaterThan(0);
  });

  for (const [manifestPath, text] of Object.entries(manifests)) {
    const dir = manifestPath.replace(/manifest\.json$/, "");
    const manifest = JSON.parse(text) as Manifest;
    it(`every hash in ${manifestPath.replace(/^\.\.\//, "")} is the hash of the file it names`, async () => {
      const mismatches: string[] = [];
      for (const entry of recorded(manifest)) {
        const content = stored[`${dir}${entry.file}`];
        if (content === undefined) mismatches.push(`${entry.file}: missing`);
        else if ((await sha256(content)) !== entry.sha256) mismatches.push(`${entry.file}: hash differs`);
      }
      expect(mismatches).toEqual([]);
    });
  }
});
