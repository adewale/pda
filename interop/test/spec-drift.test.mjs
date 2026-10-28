import { expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

it("reports a removed upstream schema as drift and continues checking, while preserving other HTTP errors", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pda-spec-drift-"));
  try {
    const preload = path.join(directory, "fetch.mjs");
    writeFileSync(preload, `import {readFileSync} from 'node:fs';
const pin=JSON.parse(readFileSync('spec/upstream.json'));
globalThis.fetch=async input=>{
 const url=new URL(input);const parts=url.pathname.split('/');const ref=parts[3], file=parts.slice(4).join('/');
 if(ref==='main' && file==='kit/company/schemas/browser-assertion.schema.json')return new Response('',{status:Number(process.env.DRIFT_TEST_STATUS)});
 return new Response(file.startsWith('kit/')?readFileSync(pin.snapshot+'/'+file):'same upstream source');
};`);
    const removed = spawnSync(process.execPath, ["--import", preload, "scripts/check-spec.mjs", "--drift"], { encoding: "utf8", env: { ...process.env, DRIFT_TEST_STATUS: "404" } });
    expect(removed.error).toBeUndefined();
    expect(removed.status).toBe(1);
    expect(removed.stdout, removed.stderr).toContain("REMOVED kit/company/schemas/browser-assertion.schema.json");
    expect(removed.stderr).not.toContain("HTTP 404");
    const unavailable = spawnSync(process.execPath, ["--import", preload, "scripts/check-spec.mjs", "--drift"], { encoding: "utf8", env: { ...process.env, DRIFT_TEST_STATUS: "500" } });
    expect(unavailable.status).toBe(1);
    expect(unavailable.stderr).toContain("HTTP 500");
    expect(unavailable.stdout).not.toContain("REMOVED");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
