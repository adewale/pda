import { useAgent } from "agents/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HistoryFrame, HistoryRequest } from "./history";
import { projectEntries } from "./transcript";
import { historyFromEvents, summaryIds, withEarlier } from "./ui/history";
import { EMPTY_VIEW, reduceEvents } from "./view";
import type {
  ClientMessage,
  ServerMessage,
  SessionView,
  ToolInfo,
  TranscriptMessage
} from "./protocol";
import type {
  ActivityEntry,
  ActivityTask,
  Card,
  ConnectedAccount,
  DirectUpdate,
  Permission,
  PoppyClientFrame,
  PoppyServerFrame
} from "./poppy/wire";

export type ConnectionStatus = "connecting" | "open" | "closed";

/** What the agent is doing and has done at Companies; null until the agent says. */
export type ActivityView = {
  readonly inProgress: readonly ActivityTask[];
  readonly log: readonly ActivityEntry[];
};

/** Poppy's part of the page: cards, settings, activity, Direct Conversations. */
export type PoppyView = {
  readonly cards: readonly Card[];
  readonly accounts: readonly ConnectedAccount[];
  readonly permissions: readonly Permission[];
  readonly direct: Readonly<Record<string, DirectUpdate>>;
  readonly activity: ActivityView | null;
};

type State = SessionView & {
  readonly status: ConnectionStatus;
  /** Every registered tool, from the server's hello. */
  readonly catalog: readonly ToolInfo[];
  readonly poppy: PoppyView;
  /** Messages before a summary, which pi's snapshot leaves out, fetched from the agent. */
  readonly earlier: readonly TranscriptMessage[];
  /** Ids of the messages that are summaries of earlier conversation, shown as notices. */
  readonly summaries: readonly string[];
};

const INITIAL_STATE: State = {
  ...EMPTY_VIEW,
  status: "connecting",
  catalog: [],
  poppy: { cards: [], accounts: [], permissions: [], direct: {}, activity: null },
  earlier: [],
  summaries: []
};

export function reducePoppy(view: PoppyView, frame: PoppyServerFrame): PoppyView {
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
    case "poppy.activity":
      return { ...view, activity: { inProgress: frame.inProgress, log: frame.log } };
    default:
      return view;
  }
}

/** At most one "the User is here" ping per this long (spec 7.4: available while used recently). */
const PRESENCE_EVERY_MS = 2 * 60_000;

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
  /** The `history.before` the page is waiting for, so an answer a newer snapshot overtook is dropped. */
  const historyRef = useRef<number | null>(null);
  const askHistory = (before: number | null) => {
    historyRef.current = before;
    if (before === null) return;
    const frame: HistoryRequest = { type: "history.before", before };
    agentRef.current?.send(JSON.stringify(frame));
  };

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
      if (type === "history") {
        const frame = message as unknown as HistoryFrame;
        if (frame.before !== historyRef.current) return;
        const entries = frame.entries;
        setState((current) => ({
          ...current,
          earlier: [...projectEntries(entries), ...current.earlier],
          summaries: [...current.summaries, ...summaryIds(entries)]
        }));
        askHistory(frame.more && entries.length > 0 ? Number(entries[0]!.id) : null);
        return;
      }
      if (typeof type === "string" && type.startsWith("poppy.")) {
        const frame = message as unknown as PoppyServerFrame;
        setState((current) => ({ ...current, poppy: reducePoppy(current.poppy, frame) }));
        return;
      }
      switch (message.type) {
        case "hello":
          setState((current) => ({ ...current, catalog: message.tools }));
          return;
        case "events": {
          const history = historyFromEvents(message.events);
          setState((current) => ({
            ...current,
            ...reduceEvents(current, message.events),
            earlier: history.clear ? [] : current.earlier,
            summaries: [...(history.clear ? [] : current.summaries), ...history.summaries]
          }));
          if (history.clear) askHistory(history.askBefore);
          return;
        }
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

  // Using the page (not just having it open) keeps the User available to Companies.
  useEffect(() => {
    let last = 0;
    const seen = () => {
      if (Date.now() - last < PRESENCE_EVERY_MS) return;
      last = Date.now();
      sendPoppy({ type: "poppy.activity" });
    };
    window.addEventListener("pointerdown", seen, { passive: true });
    window.addEventListener("keydown", seen, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", seen);
      window.removeEventListener("keydown", seen);
    };
  }, [sendPoppy]);

  const messages = useMemo(() => withEarlier(state.earlier, state.messages), [state.earlier, state.messages]);
  const summaries = useMemo(() => new Set(state.summaries), [state.summaries]);

  return { ...state, messages, summaries, submit, abort, reset, sendPoppy };
}

/** Everything the page gets from its agent, as `usePiSession` returns it. */
export type PiSession = ReturnType<typeof usePiSession>;
