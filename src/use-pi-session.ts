import { useAgent } from "agents/react";
import { useCallback, useRef, useState } from "react";
import { EMPTY_VIEW, reduceEvents } from "./view";
import type {
  ClientMessage,
  ServerMessage,
  SessionView,
  ToolInfo
} from "./protocol";
import type {
  Card,
  ConnectedAccount,
  DirectUpdate,
  Permission,
  PoppyClientFrame,
  PoppyServerFrame
} from "./poppy/wire";

export type ConnectionStatus = "connecting" | "open" | "closed";

/** Poppy's part of the page: cards, settings, Direct Conversations. */
export type PoppyView = {
  readonly cards: readonly Card[];
  readonly accounts: readonly ConnectedAccount[];
  readonly permissions: readonly Permission[];
  readonly direct: Readonly<Record<string, DirectUpdate>>;
};

type State = SessionView & {
  readonly status: ConnectionStatus;
  /** Every registered tool, from the server's hello. */
  readonly catalog: readonly ToolInfo[];
  readonly poppy: PoppyView;
};

const INITIAL_STATE: State = {
  ...EMPTY_VIEW,
  status: "connecting",
  catalog: [],
  poppy: { cards: [], accounts: [], permissions: [], direct: {} }
};

function reducePoppy(view: PoppyView, frame: PoppyServerFrame): PoppyView {
  switch (frame.type) {
    case "poppy.cards": {
      // A full list replaces ours; a one-off notice is added to it.
      const ids = new Set(frame.cards.map((card) => card.id));
      const replaced = frame.cards.length !== 1 || !frame.cards[0]!.id.startsWith("error-");
      return { ...view, cards: replaced ? frame.cards : [...view.cards.filter((card) => !ids.has(card.id)), ...frame.cards] };
    }
    case "poppy.settings":
      return { ...view, accounts: frame.accounts, permissions: frame.permissions };
    case "poppy.direct":
      return { ...view, direct: { ...view.direct, [frame.update.conversationId]: frame.update } };
  }
}

/**
 * The signed-in person's one conversation over the harness's WebSocket
 * protocol, connected with `useAgent` at `/ws`. The Worker picks the agent
 * from the app session, so the client never names an instance. The
 * server sends pi's own agent events; this folds them with the same
 * `reduceEvents` the tests use. A reconnect gets a fresh snapshot, so there
 * is nothing to resume from.
 */
export function usePiSession() {
  const [state, setState] = useState<State>(INITIAL_STATE);
  const agentRef = useRef<{ send(data: string): void } | null>(null);

  const agent = useAgent({
    agent: "personal-agent",
    basePath: "ws",
    onOpen: () => {
      setState((current) => ({ ...current, status: "open" }));
      // The person's locale and time zone, for conversations with companies.
      const frame: PoppyClientFrame = {
        type: "poppy.context",
        locale: navigator.language,
        time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone
      };
      agentRef.current?.send(JSON.stringify(frame));
    },
    onClose: () => setState((current) => ({ ...current, status: "closed" })),
    onMessage: (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      const type = (message as { type?: string }).type;
      if (typeof type === "string" && type.startsWith("poppy.")) {
        const frame = message as unknown as PoppyServerFrame;
        setState((current) => ({ ...current, poppy: reducePoppy(current.poppy, frame) }));
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

  agentRef.current = agent;

  /** A Poppy frame to the agent: decisions, sign-in input, settings. */
  const sendPoppy = useCallback(
    (frame: PoppyClientFrame) => {
      if (agent.readyState === WebSocket.OPEN) agent.send(JSON.stringify(frame));
    },
    [agent]
  );

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

  return { ...state, submit, abort, reset, sendPoppy };
}
