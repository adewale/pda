import { createContext, useContext, useState, type ReactNode } from "react";
import type { PoppyClientFrame } from "../poppy/wire";
import { Action } from "./controls";

/**
 * Sends a frame to the agent. False when the socket isn't open: nothing was
 * sent, and nothing waits to be sent later. A decision (Approve, Confirm, a
 * sign-in, a setting) is never queued, because one replayed after the User
 * has looked away is worse than one refused; the page says it wasn't sent.
 */
export type Send = (frame: PoppyClientFrame) => boolean;

const Connected = createContext(true);

/** Whether the page's socket to the agent is open, for every action below it that sends a frame. */
export function ConnectionProvider({ connected, children }: { connected: boolean; children: ReactNode }) {
  return <Connected.Provider value={connected}>{children}</Connected.Provider>;
}

export function useConnected(): boolean {
  return useContext(Connected);
}

export const CONNECTING = "Connecting to your agent… You can do this once it's connected.";
export const NOT_SENT = "Not sent: your agent isn't connected. Try again when it is.";

/** Why an action that sends a frame can't be used, or didn't go: nothing while all is well. */
function SendNote({ connected, notSent }: { connected: boolean; notSent: boolean }) {
  if (!connected) {
    return (
      <p role="status" className="text-[13px] text-pretty text-kumo-subtle">
        {CONNECTING}
      </p>
    );
  }
  if (notSent) {
    return (
      <p role="alert" className="text-[13px] text-pretty text-kumo-danger">
        {NOT_SENT}
      </p>
    );
  }
  return null;
}

/**
 * For a card or form whose actions send frames: `disabled` while the socket
 * isn't open, and a `send` that remembers a frame that didn't go (the page
 * thought the socket open, but it had closed), so `note` says so instead of
 * the click vanishing. The caller keeps its own state (a typed code, the
 * card itself) unless `send` returns true.
 */
export function useSend(send: Send, { quiet = false }: { readonly quiet?: boolean } = {}) {
  const connected = useConnected();
  const [notSent, setNotSent] = useState(false);
  // `quiet`: for a one-line receipt, where the page's connection banner says why its buttons are disabled.
  const shown = connected ? notSent : !quiet;
  return {
    disabled: !connected,
    send: (frame: PoppyClientFrame): boolean => {
      const sent = send(frame);
      setNotSent(!sent);
      return sent;
    },
    note: shown ? <SendNote connected={connected} notSent={notSent} /> : null
  };
}

/** One button that sends one frame, with its own note under it: for rows of settings and things in progress. */
export function SendAction({
  send,
  frame,
  children,
  variant = "secondary",
  className
}: {
  send: Send;
  frame: PoppyClientFrame;
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost";
  className?: string;
}) {
  const action = useSend(send);
  return (
    <span className="inline-flex max-w-xs flex-col items-end gap-1 text-right">
      <Action variant={variant} disabled={action.disabled} {...(className ? { className } : {})} onClick={() => action.send(frame)}>
        {children}
      </Action>
      {action.note}
    </span>
  );
}
