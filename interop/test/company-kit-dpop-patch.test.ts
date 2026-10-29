import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = path.join(import.meta.dirname, "../..");
let directory: string;
beforeAll(() => {
  directory = mkdtempSync(path.join(tmpdir(), "pda-kit-proof-controls-"));
  cpSync(path.join(root, "spec/company-kit-2026-10-29/kit"), directory, { recursive: true });
  execFileSync("git", ["apply", "--unidiff-zero", path.join(root, "test/company-kit/dpop-probes.patch")], { cwd: directory });
});
afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

// Execute the real temporary patched kit with Node's TypeScript loader. Its
// signer and assertion verdicts remain independent of PDA's JWT code.
const probe = String.raw`
import assert from "node:assert/strict";
import path from "node:path";
import {pathToFileURL} from "node:url";
const [kit, mode] = process.argv.slice(1);
const jose = await import(pathToFileURL(path.join(kit,"validate/jose.ts")));
const {checkAssertions} = await import(pathToFileURL(path.join(kit,"validate/checks/assertion.ts")));
const {prepareTokenEndpoint, tokenHeaders} = await import(pathToFileURL(path.join(kit,"validate/checks/token-request.ts")));
const calls=[], verdicts=[];
const identity={clientId:"https://agent.test/poppy/client.json",rootKey:await jose.generateKey(),rsaRootKey:await jose.generateRsaKey()};
const endpoint="https://company.test/token";
let nonce="nonce-1", sequence=1;
const ctx={identity,discovered:{issuer:"https://company.test",metadata:{token_endpoint:endpoint,dpop_signing_alg_values_supported:["ES256"]}},http:{async request(req){
  const fields=new URLSearchParams(req.body);
  const assertion=fields.get("client_assertion");
  const proof=jose.decodeJwt(req.headers.DPoP);
  assert.ok(await jose.verifyJwt(req.headers.DPoP,proof.header.jwk),"Every probe proof must have a valid signature");
  assert.equal(proof.payload.htm,"POST");assert.equal(proof.payload.htu,endpoint);
  const client=jose.decodeJwt(assertion);
  const valid=client.header.alg==="PS384"?await jose.verifyPs384(assertion,identity.rsaRootKey.publicJwk):await jose.verifyJwt(assertion,identity.rootKey.publicJwk);
  if(mode==="retry" && calls.length===0){
    assert.equal(typeof req.refreshHeaders,"function","Nonce preflight must regenerate proofs after a 429");
    const next=await req.refreshHeaders();
    assert.notEqual(jose.decodeJwt(next.DPoP).payload.jti,proof.payload.jti);
    assert.deepEqual(jose.decodeJwt(next.DPoP).header.jwk,proof.header.jwk);
    assert.equal(new URLSearchParams(req.body).get("client_assertion"),assertion,"Retry preserves the separate preflight assertion");
  }
  let error=proof.payload.nonce===nonce?(valid?"invalid_grant":"invalid_client"):"use_dpop_nonce";
  if(mode==="accept-bad-signature" && error==="invalid_client") error="invalid_grant";
  if(error!=="use_dpop_nonce") nonce="nonce-"+(++sequence);
  calls.push({error,nonce:proof.payload.nonce??null,assertionJti:client.payload.jti,proofJti:proof.payload.jti});
  return {status:400,json:{error},responseHeaders:{"dpop-nonce":nonce},requestHeaders:req.headers,url:endpoint,method:"POST"};
}}};
if(mode==="retry") {
 await prepareTokenEndpoint(ctx,endpoint);
 const next=await tokenHeaders(ctx,endpoint);
 assert.equal(jose.decodeJwt(next.DPoP).payload.nonce,nonce);
 console.log(JSON.stringify({retryFresh:true}));
} else {
 const recorder={wants:id=>["assertion.ps384","assertion.signature"].includes(id),pass:id=>verdicts.push({id,status:"pass"}),fail:id=>verdicts.push({id,status:"fail"}),inconclusive:id=>verdicts.push({id,status:"inconclusive"}),skip:id=>verdicts.push({id,status:"skip"})};
 await checkAssertions(ctx,recorder);
 assert.equal(new Set(calls.map(item=>item.proofJti)).size,calls.length,"All requests use fresh DPoP proofs");
 assert.notEqual(calls[0].assertionJti,calls[1].assertionJti,"Nonce preflight must not consume the assertion under test");
 console.log(JSON.stringify({calls,verdicts}));
}
`;
function run(mode: string) {
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", probe, directory, mode], { encoding: "utf8" }));
}

describe("separately patched upstream DPoP probe prerequisites", () => {
  it("uses replacement nonces from ordinary token responses without changing assertion verdicts", () => {
    const result = run("rotation");
    expect(result.verdicts).toEqual([{ id: "assertion.ps384", status: "pass" }, { id: "assertion.signature", status: "pass" }]);
    expect(result.calls.map((item: { error: string }) => item.error)).toEqual(["use_dpop_nonce", "invalid_grant", "invalid_grant", "invalid_client"]);
  });
  it("retains a real failure when the Company accepts an invalid assertion signature", () => {
    const result = run("accept-bad-signature");
    expect(result.verdicts).toEqual([{ id: "assertion.ps384", status: "pass" }, { id: "assertion.signature", status: "fail" }]);
  });
  it("generates a fresh proof for a rate-limited nonce preflight retry", () => {
    expect(run("retry")).toEqual({ retryFresh: true });
  });
});
