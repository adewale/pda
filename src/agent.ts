import { DurableObject } from "cloudflare:workers";
import type { Provider, ThinkingLevel } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { createAI } from "agents/models/pi-ai";
import { WebSockets } from "agents/websockets";
import { readModelConfig } from "./config";
import { PiSessionSockets } from "./sockets";

const PREAMBLE =
  "You are the user's personal agent: a helpful, concise assistant in one long-running conversation with the person who owns you. Earlier turns are your memory of them, so use what they have told you. Be direct, and say plainly when you do not know something.";

/** What the harness runs on: a pi-ai provider, a model on it, a thinking level. */
export type ModelSource = {
  readonly provider: Provider;
  readonly model: { readonly provider: string; readonly id: string };
  readonly thinkingLevel: ThinkingLevel;
};

/** One person's agent: a Pi harness whose root session is their one chat. */
export class PersonalAgent extends DurableObject<Env> {
  readonly registry = createRegistry();
  readonly harness: PiHarness;
  readonly sockets: PiSessionSockets;
  readonly webSockets: WebSockets;
  readonly lifecycle: Lifecycle;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const source = this.modelSource();
    this.harness = new PiHarness({
      harness: async ({ storage, context }) => {
        this.registry.install({
          name: "persona",
          sections: [{ key: "preamble", render: () => PREAMBLE, tag: false }],
          tools: []
        });
        const models = createModels();
        models.setProvider(source.provider);
        return Harness.open(
          storage,
          {
            models,
            registry: this.registry,
            settings: {
              // pi doubles the delay before each retry: 1, 2, 4, 8 and 16
              // seconds, so a rate-limited model gets about 30 seconds.
              retry: { enabled: true, maxRetries: 5, baseDelayMs: 1000 }
            },
            onReport: (error) => console.warn("pi report", error)
          },
          context
        );
      },
      defaults: { model: source.model, thinkingLevel: source.thinkingLevel }
    });
    this.sockets = new PiSessionSockets(this.harness, this.registry, (tag) =>
      this.ctx.getWebSockets(tag)
    );
    this.webSockets = new WebSockets(this.sockets.options());
    this.lifecycle = Lifecycle.install(this)
      .use(this.webSockets)
      .use(this.harness);
  }

  /** Tests override this with pi-ai's faux provider; nothing else differs. */
  protected modelSource(): ModelSource {
    const config = readModelConfig(this.env);
    const ai = createAI({ binding: this.env.AI, id: config.aiGatewayId });
    return {
      provider: ai.provider,
      model: ai(config.modelId),
      thinkingLevel: config.thinkingLevel
    };
  }

  /** Host startup, after the harness has opened pi. */
  async onStart(): Promise<void> {
    // Give sockets that outlived the last isolate a new watch.
    await this.sockets.reattach();
  }
}
