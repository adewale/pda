import { describe, expect, it } from "vitest";
import { inventedBy, paths, shapeOf, streamShape } from "./shape";

describe("wire shapes", () => {
  it("keep structure, types and discriminators, never values", () => {
    const shape = shapeOf({ type: "message", id: "msg_secret", content: [{ type: "text", text: "private words" }, { type: "text", text: "more" }], usage: { input_tokens: 12 }, stop: null });
    expect(paths(shape)).toEqual(["content[].text: string", "content[].type: =text", "id: string", "stop: null", "type: =message", "usage.input_tokens: number"]);
    expect(JSON.stringify(shape)).not.toMatch(/secret|private|12/);
  });

  it("read a stream's events by name, or by their data's type", () => {
    const anthropic = 'event: message_start\ndata: {"type":"message_start","message":{"id":"m"}}\n\nevent: ping\ndata: {"type":"ping"}\n\n';
    expect(streamShape(anthropic)).toEqual({ message_start: ["message.id: string", "type: =message_start"], ping: ["type: =ping"] });
    const openai = 'data: {"type":"response.created","response":{"id":"r"}}\n\ndata: [DONE]\n\n';
    expect(streamShape(openai)).toEqual({ data: [".: string"], "response.created": ["response.id: string", "type: =response.created"] });
  });

  it("let a fake leave things out, but not send what the real API never does", () => {
    const real = { message_start: ["message.id: string", "message.usage.input_tokens: number"], ping: ["type: =ping"] };
    expect(inventedBy({ message_start: ["message.id: string"] }, real)).toEqual([]);
    expect(inventedBy({ message_start: ["message.id: number"], made_up: ["x: string"] }, real)).toEqual([
      "event message_start: message.id: number",
      "event made_up: never sent by the real API"
    ]);
  });
});
