import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  type AssistantMessage,
  type Message,
  type TranscriptContext
} from "@earendil-works/pi-ai";
import { PersonalAgent as ProductionAgent, type ModelSource } from "../src/agent";
import { readModelConfig } from "../src/config";
import worker from "../src/index";

function textOf(content: Message["content"] | undefined): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .map((part) =>
      "text" in part && typeof part.text === "string" ? part.text : ""
    )
    .join("");
}

/**
 * The faux model's script, derived from the transcript alone so it answers
 * the same way after a crash as before: it echoes the latest user message
 * and says how many user turns it has seen, which proves history survived.
 */
function script(context: TranscriptContext): AssistantMessage {
  const users = context.messages.filter((m) => m.role === "user");
  const prompt = textOf(users.at(-1)?.content);
  return fauxAssistantMessage([
    fauxText(`echo: ${prompt} (turn ${users.length})`)
  ]);
}

/** The production agent with pi-ai's faux provider in place of AI Gateway. */
export class PersonalAgent extends ProductionAgent {
  protected override modelSource(): ModelSource {
    // Still read the real settings, so a bad var fails here as in production.
    const config = readModelConfig(this.env);
    const faux = fauxProvider({
      tokensPerSecond: 400,
      tokenSize: { min: 2, max: 4 }
    });
    faux.setResponses(Array.from({ length: 200 }, () => script));
    return {
      provider: faux.provider,
      model: faux.getModel(),
      thinkingLevel: config.thinkingLevel
    };
  }
}

export default worker;
