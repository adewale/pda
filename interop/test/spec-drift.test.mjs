import { expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

it("reports a changed or removed pinned page as drift, while preserving other HTTP errors", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pda-spec-drift-"));
  try {
    const preload = path.join(directory, "fetch.mjs");
    // Every pinned page's Markdown as stored, except the changelog (changed) and the spec (DRIFT_TEST_STATUS).
    writeFileSync(preload, `import {readFileSync} from 'node:fs';
const pin=JSON.parse(readFileSync('spec/upstream.json'));
const manifest=JSON.parse(readFileSync(pin.snapshot+'/manifest.json'));
globalThis.fetch=async input=>{
 const page=manifest.pages.find(p=>p.markdown.fetched?.url===String(input));
 if(page.name==='0.3-spec')return new Response('',{status:Number(process.env.DRIFT_TEST_STATUS)});
 if(page.name==='changelog')return new Response('a newer changelog');
 return new Response(readFileSync(pin.snapshot+'/'+page.markdown.file));
};`);
    const removed = spawnSync(process.execPath, ["--import", preload, "scripts/check-spec.mjs", "--drift"], { encoding: "utf8", env: { ...process.env, DRIFT_TEST_STATUS: "404" } });
    expect(removed.error).toBeUndefined();
    expect(removed.status, removed.stderr).toBe(1);
    expect(removed.stdout).toContain("REMOVED 0.3-spec");
    expect(removed.stdout).toContain("CHANGED changelog");
    expect(removed.stdout).not.toContain("CHANGED 0.3-guides");
    const unavailable = spawnSync(process.execPath, ["--import", preload, "scripts/check-spec.mjs", "--drift"], { encoding: "utf8", env: { ...process.env, DRIFT_TEST_STATUS: "500" } });
    expect(unavailable.status).toBe(1);
    expect(unavailable.stderr).toContain("HTTP 500");
    expect(unavailable.stdout).not.toContain("REMOVED");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
