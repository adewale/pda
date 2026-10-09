import { useAgent } from "agents/react";
import { useCallback, useState } from "react";
import { EMPTY_VIEW, reduceEvents } from "./view";
import type {
  ClientMessage,
  ServerMessage,
  SessionView,
  ToolInfo
} from "./protocol";

export type ConnectionStatus = "connecting" | "open" | "closed";

type State = SessionView & {
  readonly status: ConnectionStatus;
  /** Every registered tool, from the server's hello. */
  readonly catalog: readonly ToolInfo[];
};

const INITIAL_STATE: State = {
  ...EMPTY_VIEW,
  status: "connecting",
  catalog: []
};

/**
 * The signed-in person's one conversation over the harness's WebSocket
 * protocol, connected with `useAgent` at `/ws`. The Worker picks the agent
 * from the Access identity, so the client never names an instance. The
 * server sends pi's own agent events; this folds them with the same
 * `reduceEvents` the tests use. A reconnect gets a fresh snapshot, so there
 * is nothing to resume from.
 */
export function usePiSession() {
  const [state, setState] = useState<State>(INITIAL_STATE);

  const agent = useAgent({
    agent: "personal-agent",
    basePath: "ws",
    onOpen: () => setState((current) => ({ ...current, status: "open" })),
    onClose: () => setState((current) => ({ ...current, status: "closed" })),
    onMessage: (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      switch (message.type) {
        case "hello":
          setState((current) => ({ ...current, catalog: message.tools }));
          return;
        case "events":
          setState((current) => ({
            ...current,
            ...reduceEvents(current, message.events)
          }));
          return;
        case "error":
          setState((current) => ({ ...current, error: message.message }));
          return;
        default:
          return;
      }
    }
  });

  const send = useCallback(
    (message: ClientMessage) => {
      if (agent.readyState === WebSocket.OPEN) {
        agent.send(JSON.stringify(message));
      }
    },
    [agent]
  );

  /** Idle: starts a run. Busy: queued as a follow-up, or steers the run. */
  const submit = useCallback(
    (text: string, whenBusy: "followUp" | "steer" = "followUp") =>
      send({ type: "submit", id: crypto.randomUUID(), input: text, whenBusy }),
    [send]
  );

  const abort = useCallback(
    () => send({ type: "abort", id: crypto.randomUUID() }),
    [send]
  );

  const reset = useCallback(
    () => send({ type: "reset", id: crypto.randomUUID() }),
    [send]
  );

  return { ...state, submit, abort, reset };
}
