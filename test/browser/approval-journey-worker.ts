/** Browser acceptance fixture: real Worker/auth/tools; only the model and Company are synthetic. */
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type AssistantMessage, type AssistantMessageEventStream, type TranscriptContext } from "@earendil-works/pi-ai";
import type { DemoRoute, LaneModel } from "../../src/model-router";
import { PersonalAgent as TestAgent } from "../worker";

export { default, CompanyLimiter, DomainBudget, MockCompany, StorageProbe } from "../worker";

function text(context: TranscriptContext): string {
  const user = context.messages.filter(message => message.role === "user").at(-1);
  return typeof user?.content === "string" ? user.content : user?.content.filter(part => part.type === "text").map(part => part.type === "text" ? part.text : "").join("") ?? "";
}

function respond(context: TranscriptContext): AssistantMessage {
  const prompt = text(context);
  const request = /^Please exchange my Stormline Jacket for the insulated medium at ([a-z0-9.-]+) using (OpenAPI|MCP)\.$/.exec(prompt);
  let response;
  if (request) {
    const domain = request[1]!;
    const api = request[2] === "OpenAPI";
    const name = api ? "poppy_api_call" : "poppy_mcp_call";
    let latestUser = context.messages.length - 1;
    while (latestUser >= 0 && context.messages[latestUser]!.role !== "user") latestUser--;
    const made = context.messages.slice(latestUser + 1).some(message => message.role === "assistant" && message.content.some(part => part.type === "toolCall" && part.name === name && part.arguments.domain === domain));
    const call = api
      ? fauxToolCall(name, { domain, operation: "exchangeItem", params: { order_id: "ord_7Hk2" }, body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" } })
      : fauxToolCall(name, { domain, tool: "exchange_item", args: { order_id: "ord_7Hk2", item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" } });
    response = made
      ? fauxAssistantMessage([fauxText("The approval cards and the request below show its current status.")])
      : fauxAssistantMessage([call], { stopReason: "toolUse" });
  } else {
    response = fauxAssistantMessage([fauxText(prompt.startsWith("[system]") ? "The request and its approval cards show the current status." : `echo: ${prompt}`)]);
  }
  return response;
}

/** Same known synthetic charge as test/worker.ts, after fauxProvider calculates its final usage. */
function priced(stream: AssistantMessageEventStream): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream();
  const price = (message: AssistantMessage): AssistantMessage => ({ ...message, usage: { ...message.usage, cost: { ...message.usage.cost, total: 0.000001 } } });
  void (async () => {
    for await (const event of stream) out.push(event.type === "done" ? { ...event, message: price(event.message) } : event.type === "error" ? { ...event, error: price(event.error) } : event);
    out.end(price(await stream.result()));
  })();
  return out;
}

export class PersonalAgent extends TestAgent {
  #model: ReturnType<typeof fauxProvider> | undefined;

  protected override demoLane(_route: DemoRoute): LaneModel {
    this.#model ??= fauxProvider({ tokensPerSecond: 1000 });
    this.#model.setResponses(Array.from({ length: 200 }, () => respond));
    const inner = this.#model.provider;
    return { provider: { ...inner, stream: (...args) => priced(inner.stream(...args)), streamSimple: (...args) => priced(inner.streamSimple(...args)) }, model: this.#model.getModel() };
  }
}
