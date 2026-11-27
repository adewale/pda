#!/usr/bin/env node
/**
 * `npm run record:wire`: one small real call per vendor, through pi-ai as
 * the agent makes it, to record what the real API answers as a shape
 * (`test/contracts/shape.ts`): event names, keys and types, never a value.
 * Each recording replaces the fake's own in `test/contracts/fixtures/` and
 * is marked `"source": "live"`; from then on `test/contracts/wire.test.ts`
 * fails when a fake sends what the real API doesn't. Run it again after a
 * pi upgrade, or when a vendor changes its wire.
 *
 * Keys come from the environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`), are
 * sent only to their vendor, and are never written: a fixture holds shapes.
 * A vendor without a key is skipped. Each call is one short answer (a few
 * cents at most).
 *
 * Exit status: 0 every vendor with a key was recorded, 1 a call failed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { normalizeContext } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { streamShape } from "../test/contracts/shape.ts";

const root = path.resolve(import.meta.dirname, "..");
const fixtures = path.join(root, "test", "contracts", "fixtures");
const VENDORS = [
  { wire: "anthropic-messages", key: "ANTHROPIC_API_KEY", provider: anthropicProvider, model: "claude-sonnet-5-5" },
  { wire: "openai-responses", key: "OPENAI_API_KEY", provider: openaiProvider, model: "gpt-6.1-sol" }
];

const context = normalizeContext({
  systemPrompt: "Answer in one short sentence.",
  tools: [{ name: "calculate", description: "Exact arithmetic.", parameters: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] } }],
  messages: [{ role: "user", content: "Say hello.", timestamp: Date.now() }]
});

let failed = false;
const realFetch = globalThis.fetch;
for (const vendor of VENDORS) {
  const apiKey = process.env[vendor.key];
  if (!apiKey) {
    process.stdout.write(`${vendor.wire}: skipped, no ${vendor.key}.\n`);
    continue;
  }
  const streams = [];
  globalThis.fetch = async (input, init) => {
    const response = await realFetch(input, init);
    streams.push(response.clone().text());
    return response;
  };
  try {
    const provider = vendor.provider();
    const model = provider.getModels().find((candidate) => candidate.id === vendor.model);
    if (!model) throw new Error(`${vendor.model} isn't in pi-ai's ${provider.id} catalog`);
    const message = await provider.streamSimple(model, context, { apiKey, reasoning: "low", maxTokens: 256 }).result();
    if (message.stopReason === "error") throw new Error(message.errorMessage ?? "the call failed");
    const stream = streamShape(await streams.at(-1));
    const file = path.join(fixtures, `${vendor.wire}.json`);
    const fixture = JSON.parse(readFileSync(file, "utf8"));
    fixture.response = { source: "live", recorded: new Date().toISOString().slice(0, 10), stream };
    writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
    process.stdout.write(`${vendor.wire}: recorded ${Object.keys(stream).length} kinds of event.\n`);
  } catch (error) {
    failed = true;
    // The vendor's words, not the key: pi-ai redacts nothing here, so only the message's first line, with anything key-like cut.
    const text = (error instanceof Error ? error.message : String(error)).split("\n")[0].replace(/\b(sk-|AIza)[A-Za-z0-9_*.-]{6,}/g, "[key]");
    process.stderr.write(`${vendor.wire}: not recorded: ${text}\n`);
  } finally {
    globalThis.fetch = realFetch;
  }
}
process.exit(failed ? 1 : 0);
