import { expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

it("reports drift per pin: a frozen version's own pages and changelog entries, the shared pages once, for the newest pin", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pda-spec-drift-"));
  try {
    const preload = path.join(directory, "fetch.mjs");
    // Each URL answers with the newest pin's stored page (the site serves shared pages once), except the pages
    // DRIFT_TEST names: "removed:<page>" answers DRIFT_TEST_STATUS, "changed:<page>" answers other text.
    writeFileSync(preload, `import {readFileSync} from 'node:fs';
const {pins}=JSON.parse(readFileSync('spec/upstream.json'));
const stored=new Map();
for(const pin of pins)for(const page of JSON.parse(readFileSync(pin.snapshot+'/manifest.json')).pages){
 if(page.markdown.fetched?.url)stored.set(page.markdown.fetched.url,{name:page.name,file:pin.snapshot+'/'+page.markdown.file});
}
const test=(process.env.DRIFT_TEST??'').split(',');
globalThis.fetch=async input=>{
 const page=stored.get(String(input));
 if(test.includes('removed:'+page.name))return new Response('',{status:Number(process.env.DRIFT_TEST_STATUS)});
 if(test.includes('changed:'+page.name))return new Response('## Draft 0.4\\n\\n#### A newer entry\\n\\n## Version 0.3\\n\\n#### Another entry\\n');
 return new Response(readFileSync(page.file));
};`);
    const run = (test, status = "404") => spawnSync(process.execPath, ["--import", preload, "scripts/check-spec.mjs", "--drift"], { encoding: "utf8", env: { ...process.env, DRIFT_TEST: test, DRIFT_TEST_STATUS: status } });

    const unchanged = run("");
    expect(unchanged.status, unchanged.stderr).toBe(0);
    expect(unchanged.stdout).toContain("No drift");

    const moved = run("removed:0.3-spec,changed:0.4-spec,changed:0.3-guides");
    expect(moved.error).toBeUndefined();
    expect(moved.status, moved.stderr).toBe(1);
    expect(moved.stdout).toContain("REMOVED 0.3-spec");
    expect(moved.stdout).toContain("CHANGED 0.4-spec");
    expect(moved.stdout).toContain("CHANGED 0.3-guides");

    // The shared changelog: each published version compares only its own entry titles (a draft would compare the whole text).
    const changelog = run("changed:changelog");
    expect(changelog.status).toBe(1);
    expect(changelog.stdout).not.toContain("CHANGED changelog ");
    expect(changelog.stdout).toContain("CHANGED 0.3 changelog entries");
    expect(changelog.stdout).toContain("CHANGED 0.4 changelog entries");

    // A shared page is checked once, for the newest pin (a draft if there is one); the older version ignores it.
    const shared = run("changed:introduction");
    expect(shared.status).toBe(1);
    expect(shared.stdout.match(/CHANGED introduction/g)).toHaveLength(1);
    expect(shared.stdout).toContain("the 0.4 pin");

    const unavailable = run("removed:0.3-spec", "500");
    expect(unavailable.status).toBe(1);
    expect(unavailable.stderr).toContain("HTTP 500");
    expect(unavailable.stdout).not.toContain("REMOVED");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
