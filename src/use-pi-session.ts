import { useAgent } from "agents/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HistoryRequest } from "./history";
import { tryDecode } from "./decode";
import type { ApprovalDecision } from "./poppy/approval-outcome";
import { historyFrame, serverFrame } from "./poppy/frames";
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
  PendingSignOut,
  PoppyClientFrame,
  PoppyServerFrame,
  ProtocolCompany
} from "./poppy/wire";

export type ConnectionStatus = "connecting" | "open" | "closed" | "unauthenticated";

/** What the agent is doing and has done at Companies; null until the agent says. */
export type ActivityView = {
  readonly inProgress: readonly ActivityTask[];
  readonly log: readonly ActivityEntry[];
};

/** One Company's protocol log, as the agent last sent it. */
export type ProtocolLogView = Extract<PoppyServerFrame, { type: "poppy.protocol" }>;

/**
 * The protocol view: which Companies have a log (null until the agent says),
 * and the logs the page has asked for, by key.
 */
export type ProtocolView = {
  readonly companies: readonly ProtocolCompany[] | null;
  readonly logs: Readonly<Record<string, ProtocolLogView>>;
  /** The agent's diagnostics as it last sent them (its newest wide events and the protocol logs), for "Copy diagnostics". */
  readonly diagnostics?: { readonly text: string; readonly at: number; readonly flowId?: string };
};

/** Poppy's part of the page: cards, settings, activity, Direct Conversations, the protocol view. */
export type PoppyView = {
  readonly cards: readonly Card[];
  /** Outcomes requested by the loaded transcript, independent of Activity retention. */
  readonly decisions: Readonly<Record<string, ApprovalDecision>>;
  readonly accounts: readonly ConnectedAccount[];
  /** Sign-outs the Company hasn't accepted yet: its access is still live there. */
  readonly signOuts: readonly PendingSignOut[];
  readonly direct: Readonly<Record<string, DirectUpdate>>;
  readonly activity: ActivityView | null;
  readonly protocol: ProtocolView;
};

export const EMPTY_PROTOCOL: ProtocolView = { companies: null, logs: {} };

/**
 * A message the User sent that the agent hasn't answered yet. The page keeps
 * it until the agent's `result` for it arrives, so a message sent before the
 * socket opens, or on a socket that drops before the agent answers, shows as
 * pending and goes once a socket is open; it is never dropped.
 */
export type Outgoing = {
  /** The submit's id and operation id, the same on every send: pi takes an operation id once, however often it arrives. */
  readonly id: string;
  readonly text: string;
  readonly whenBusy: "followUp" | "steer";
  /** `waiting`: not on an open socket yet. `sent`: on one, no answer yet. `failed`: the agent answered with an error. */
  readonly state: "waiting" | "sent" | "failed";
  readonly error?: string;
};

/** The messages to send now that a socket is open, and the outbox with them marked sent. */
export function takeWaiting(outbox: readonly Outgoing[]): { readonly send: readonly Outgoing[]; readonly outbox: readonly Outgoing[] } {
  return {
    send: outbox.filter((item) => item.state === "waiting"),
    outbox: outbox.map((item) => (item.state === "waiting" ? { ...item, state: "sent" } : item))
  };
}

/**
 * The socket closed: a message sent on it without an answer may never have
 * arrived, so it waits to go again, with the same operation id.
 */
export function unanswered(outbox: readonly Outgoing[]): readonly Outgoing[] {
  return outbox.map((item) => (item.state === "sent" ? { ...item, state: "waiting" } : item));
}

/** The agent answered `id`: a result takes it out of the outbox, an error marks it failed. */
export function answered(outbox: readonly Outgoing[], id: string, error?: string): readonly Outgoing[] {
  if (error === undefined) return outbox.filter((item) => item.id !== id);
  return outbox.map((item) => (item.id === id ? { ...item, state: "failed", error } : item));
}

/** Retry a failed submit with its original operation id and payload. */
export function retryFailed(outbox: readonly Outgoing[], id: string): readonly Outgoing[] {
  return outbox.map((item) => item.id === id && item.state === "failed"
    ? { id: item.id, text: item.text, whenBusy: item.whenBusy, state: "waiting" } : item);
}

/** A User may dismiss only a failed submit; pending work stays in the outbox. */
export function dismissFailed(outbox: readonly Outgoing[], id: string): readonly Outgoing[] {
  return outbox.filter((item) => item.id !== id || item.state !== "failed");
}

function submitFrame(item: Outgoing): ClientMessage {
  return { type: "submit", id: item.id, input: item.text, whenBusy: item.whenBusy, operationId: item.id };
}

type State = SessionView & {
  readonly status: ConnectionStatus;
  /** Every registered tool, from the server's hello. */
  readonly catalog: readonly ToolInfo[];
  readonly poppy: PoppyView;
  /** Messages before a summary, which pi's snapshot leaves out, fetched from the agent. */
  readonly earlier: readonly TranscriptMessage[];
  /** Ids of the messages that are summaries of earlier conversation, shown as notices. */
  readonly summaries: readonly string[];
  /** What the User sent that the agent hasn't answered, oldest first. */
  readonly outbox: readonly Outgoing[];
};

const INITIAL_STATE: State = {
  ...EMPTY_VIEW,
  status: "connecting",
  catalog: [],
  poppy: { cards: [], decisions: {}, accounts: [], signOuts: [], direct: {}, activity: null, protocol: EMPTY_PROTOCOL },
  earlier: [],
  summaries: [],
  outbox: []
};

export function reducePoppy(view: PoppyView, frame: PoppyServerFrame): PoppyView {
  switch (frame.type) {
    case "poppy.approvals.state": {
      const decisions = { ...view.decisions };
      for (const id of frame.ids) delete decisions[id];
      for (const item of frame.decisions) decisions[item.approvalId] = item;
      return { ...view, decisions };
    }
    case "poppy.cards": {
      // A full list replaces ours; a one-off notice is added to it.
      const ids = new Set(frame.cards.map((card) => card.id));
      const replaced = frame.cards.length !== 1 || !frame.cards[0]!.id.startsWith("error-");
      return { ...view, cards: replaced ? frame.cards : [...view.cards.filter((card) => !ids.has(card.id)), ...frame.cards] };
    }
    case "poppy.settings":
      return { ...view, accounts: frame.accounts, signOuts: frame.signOuts };
    case "poppy.direct":
      return { ...view, direct: { ...view.direct, [frame.update.conversationId]: frame.update } };
    case "poppy.activity":
      return { ...view, activity: { inProgress: frame.inProgress, log: frame.log } };
    case "poppy.protocol.index":
      return { ...view, protocol: { ...view.protocol, companies: frame.companies } };
    case "poppy.protocol":
      return { ...view, protocol: { ...view.protocol, logs: { ...view.protocol.logs, [frame.key]: frame } } };
    case "poppy.diagnostics":
      return { ...view, protocol: { ...view.protocol, diagnostics: { text: frame.text, at: frame.at, ...(frame.flowId ? { flowId: frame.flowId } : {}) } } };
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
export function usePiSession(workspaceId: string) {
  const [state, setState] = useState<State>(INITIAL_STATE);
  const agentRef = useRef<{ send(data: string): void; close?(code?: number, reason?: string): void; readonly readyState: number } | null>(null);
  const accessEnded = useRef(false);
  const connectionEpoch = useRef(0);
  useEffect(() => () => { connectionEpoch.current++; }, []);
  const opened = useRef(false);
  const verifiedSocket = useRef(false);
  const authCheck = useRef<Promise<boolean> | null>(null);
  const checkWorkspace = (): Promise<boolean> => fetch("/api/me", { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(10_000) })
    .then(async response => {
      if (response.status === 401) return false;
      if (!response.ok) return true; // The workspace-bound WebSocket still enforces identity at the edge.
      const body = await response.json() as { workspaceId?: unknown };
      return body.workspaceId === workspaceId;
    }).catch(() => true); // Network failure alone does not end a valid workspace-bound connection.
  const endAccess = () => {
    accessEnded.current = true;
    verifiedSocket.current = false;
    setState(current => ({ ...current, status: "unauthenticated" }));
    try { agentRef.current?.close?.(1000, "Sign in again"); } catch { /* All send paths remain blocked. */ }
  };
  /** The outbox as it is now, for the socket's handlers; `state.outbox` is its copy for rendering. */
  const outboxRef = useRef<readonly Outgoing[]>([]);
  const setOutbox = (next: readonly Outgoing[]) => {
    outboxRef.current = next;
    setState((current) => ({ ...current, outbox: next }));
  };
  /** Sends every waiting message, oldest first, if the socket is open; otherwise they wait for `onOpen`. */
  const flush = () => {
    const socket = agentRef.current;
    if (accessEnded.current || !verifiedSocket.current || socket?.readyState !== WebSocket.OPEN) return;
    const { send, outbox } = takeWaiting(outboxRef.current);
    if (send.length === 0) return;
    setOutbox(outbox);
    for (const item of send) socket.send(JSON.stringify(submitFrame(item)));
  };
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
    query: { workspace: workspaceId },
    // A policy close needs explicit sign-in/reload. Retrying forever cannot
    // repair an expired session or a retired agent generation.
    shouldReconnectOnClose: event => !accessEnded.current && event.code !== 1008,
    onOpen: () => {
      const epoch = ++connectionEpoch.current;
      if (accessEnded.current) return;
      const finishOpen = () => {
        if (epoch !== connectionEpoch.current || accessEnded.current || agentRef.current?.readyState !== WebSocket.OPEN) return;
        verifiedSocket.current = true;
        setState((current) => ({ ...current, status: "open" }));
        const frame: PoppyClientFrame = {
          type: "poppy.context",
          locale: navigator.language,
          time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone
        };
        agentRef.current?.send(JSON.stringify(frame));
        flush();
      };
      if (!opened.current) {
        opened.current = true;
        finishOpen(); // The initial upgrade is bound to the workspace from the page's authenticated /api/me.
      } else {
        // A reconnect cannot release queued text before an in-progress identity check.
        const check = authCheck.current ?? checkWorkspace();
        authCheck.current = check;
        void check.then(same => {
          if (epoch !== connectionEpoch.current || accessEnded.current) return;
          if (same) finishOpen();
          else endAccess();
        });
      }
    },
    onClose: event => {
      const epoch = ++connectionEpoch.current;
      verifiedSocket.current = false;
      if (event.code === 1008) accessEnded.current = true;
      setOutbox(unanswered(outboxRef.current));
      setState((current) => ({ ...current, status: accessEnded.current ? "unauthenticated" : "closed" }));
      if (!accessEnded.current) {
        // A rejected upgrade appears as 1006. Preserve drafts while checking its authenticated workspace.
        const check = checkWorkspace();
        authCheck.current = check;
        void check.then(same => {
          if (!same && epoch === connectionEpoch.current && !accessEnded.current) endAccess();
        });
      }
    },
    onMessage: (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      const type = (message as { type?: string }).type;
      if (type === "history") {
        const decoded = tryDecode(historyFrame, message, "history frame");
        if (!decoded.ok) return;
        const frame = decoded.value;
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
        const decoded = tryDecode(serverFrame, message, "Poppy frame");
        if (!decoded.ok) return;
        const frame = decoded.value;
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
        case "result": {
          const { id } = message;
          if (outboxRef.current.some((item) => item.id === id)) setOutbox(answered(outboxRef.current, id));
          return;
        }
        case "error": {
          const { id, message: text } = message;
          if (id !== undefined && outboxRef.current.some((item) => item.id === id)) {
            setOutbox(answered(outboxRef.current, id, text));
            return;
          }
          setState((current) => ({ ...current, error: text }));
          return;
        }
        default:
          return;
      }
    }
  });

  agentRef.current = agent;

  /** A Poppy frame to the agent: decisions, sign-in input, settings. */
  /**
   * Returns whether it went: false when the socket isn't open, and then
   * nothing is sent, now or later. A decision isn't queued, because one
   * replayed after the User looked away is worse than one refused; the page
   * says it wasn't sent (`src/ui/connection.tsx`).
   */
  const sendPoppy = useCallback(
    (frame: PoppyClientFrame): boolean => {
      if (accessEnded.current || !verifiedSocket.current || agent.readyState !== WebSocket.OPEN) return false;
      agent.send(JSON.stringify(frame));
      return true;
    },
    [agent]
  );

  /** Stop and reset, which aren't queued either: true when the frame went. */
  const send = useCallback(
    (message: ClientMessage): boolean => {
      if (accessEnded.current || !verifiedSocket.current || agent.readyState !== WebSocket.OPEN) return false;
      agent.send(JSON.stringify(message));
      return true;
    },
    [agent]
  );

  /**
   * Idle: starts a run. Busy: queued as a follow-up, or steers the run.
   * Never dropped: it goes into the outbox, shown as pending, and is sent
   * now if the socket is open, or as soon as one opens.
   */
  const submit = useCallback((text: string, whenBusy: "followUp" | "steer" = "followUp") => {
    setOutbox([...outboxRef.current, { id: crypto.randomUUID(), text, whenBusy, state: "waiting" }]);
    flush();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Sends a message the agent refused again, with the same operation id. */
  const resend = useCallback((id: string) => {
    setOutbox(retryFailed(outboxRef.current, id));
    flush();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Drops a message the agent refused. */
  const discard = useCallback((id: string) => {
    setOutbox(dismissFailed(outboxRef.current, id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  return { ...state, messages, summaries, submit, resend, discard, abort, reset, sendPoppy };
}

/** Everything the page gets from its agent, as `usePiSession` returns it. */
export type PiSession = ReturnType<typeof usePiSession>;
