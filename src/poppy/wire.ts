import type { Issuer } from "./issuer";
/**
 * Poppy's messages on the chat WebSocket, beside the Pi protocol in
 * `protocol.ts` (which stays an unchanged copy). Frames whose `type` starts
 * with `poppy.` are handled by the Poppy capability before the chat sees
 * them. Nothing here ever carries a token, key, device code or credential
 * back to the page.
 */

type CardBase = {
  readonly id: string;
  /** The Company's display name, which it chooses itself. */
  readonly company: string;
  /**
   * The Company's verified `organization.domain`, shown beside the name so a
   * look-alike name can't pass for another Company (docs/spec-issues.md, N14).
   * Absent on notices that aren't about one Company.
   */
  readonly domain?: string;
  /** Open cards wait for the User; closed ones show an outcome. */
  readonly open: boolean;
  /** When the card last changed, in epoch ms: set as cards are sent, so the page can place an outcome in the conversation. */
  readonly at?: number;
};

export type Card =
  | (CardBase & {
      readonly kind: "signin_link";
      readonly signInId: string;
      readonly url: string;
      readonly scopes: readonly ScopeInfo[];
      readonly reason: string;
    })
  | (CardBase & {
      readonly kind: "signin_device";
      readonly signInId: string;
      readonly verificationUri: string;
      readonly verificationUriComplete?: string;
      readonly userCode: string;
      readonly expiresAt: number;
      readonly scopes: readonly ScopeInfo[];
      readonly reason: string;
    })
  | (CardBase & {
      readonly kind: "signin_credentials";
      readonly signInId: string;
      readonly fields: readonly { name: string; label: string; secret: boolean }[];
      readonly scopes: readonly ScopeInfo[];
      readonly reason: string;
    })
  | (CardBase & {
      readonly kind: "signin_code";
      readonly signInId: string;
      readonly sentTo: string;
      readonly expiresAt?: string;
    })
  | (CardBase & {
      readonly kind: "approval";
      readonly approvalId: string;
      readonly summary: string;
      /**
       * `done`: the Company answered 2xx. `terms`: sent as approved, and the
       * Company answered with an operation, whose terms wait on a card of
       * their own (Ops 4), so nothing is done yet. `refused`: sent as approved, and
       * the Company answered with another status (`answer`). `unknown`: no
       * answer came, or the agent restarted mid-call, so it may or may not
       * have reached the Company. `failed`: it wasn't sent, or its answer
       * couldn't be read.
       */
      readonly status: "pending" | "approved" | "declined" | "done" | "terms" | "refused" | "failed" | "unknown";
      readonly result?: string;
      /** What the Company answered a `refused` write: its HTTP status and error code, if it gave one. */
      readonly answer?: { readonly status: number; readonly error?: string };
      /** The User's photos the request sends: names, types and sizes, which the page shows with the photo itself. */
      readonly attachments?: readonly { readonly id: string; readonly name: string; readonly type: string; readonly size: number }[];
      /**
       * Approvals waiting with the same key may be decided together on one
       * card (`poppy.approvals`): uploads of the User's photos to one
       * Company's same method and URL. Absent on every other approval.
       */
      readonly batchKey?: string;
      /** An operation a Company returned: its own summary and what its terms name (Ops 5). */
      readonly terms?: ApprovalTerms;
    })
  | (CardBase & {
      readonly kind: "direct_invite";
      readonly conversationId: string;
      readonly reason: string;
    })
  | (CardBase & { readonly kind: "notice"; readonly text: string });

/**
 * What an approval card shows of an operation a Company returned (Ops 5):
 * the Company's own summary, quoted as theirs, when the approval stops being
 * accepted, what its terms name, and where the terms disagree with the
 * summary or with the request (Ops 5's SHOULD).
 */
export type ApprovalTerms = {
  readonly summary: string;
  readonly expiresAt: string;
  /** Costs, dates and conditions in the terms, and whether the Company says it can be undone. */
  readonly highlights: readonly string[];
  /** The total the terms name, shown large and on the button. */
  readonly total?: { readonly amount: string; readonly currency: string };
  /** HTTPS links on the Company's own hosts under a key with "preview" in it, such as a print's crop. */
  readonly previews?: readonly { readonly label: string; readonly url: string }[];
  readonly differences?: readonly string[];
};

export type ScopeInfo = { readonly scope: string; readonly description: string };

/** One message in a Direct Conversation, for the page. */
export type DirectMessage = {
  readonly id: string;
  readonly role: "user" | "company";
  readonly sender: "agent" | "human";
  /** The name a Company message's author gives (spec 8.4), shown as text. */
  readonly authorName?: string;
  readonly text?: string;
  readonly data?: unknown;
};

export type DirectUpdate = {
  readonly conversationId: string;
  readonly company: string;
  readonly status: string;
  readonly responder: string;
  readonly messages?: readonly DirectMessage[];
  /** Text pieces of a Company message still being written: display only (spec 8.6). */
  readonly partial?: { readonly messageId: string; readonly text: string } | null;
  readonly closed?: boolean;
};

export type ConnectedAccount = {
  readonly issuer: Issuer;
  readonly company: string;
  readonly account: string;
  readonly scope: string;
  readonly expiresAt: number | null;
};

/**
 * A sign-out the Company hasn't accepted yet (spec 4.6): the agent no longer
 * uses the account, but the refresh token it held is still live there.
 */
export type PendingSignOut = {
  readonly id: string;
  readonly issuer: Issuer;
  readonly company: string;
  readonly account: string;
  /** `sign_out`: the User signed out. `step_up`: more access replaced this token, and the account stays signed in. */
  readonly reason: "sign_out" | "step_up";
  /** The code the Company last answered, or ours when no answer came. */
  readonly error: string | null;
  readonly attempts: number;
  /** When the access ends by itself at the Company; null when it gave no expiry. */
  readonly expiresAt: number | null;
  /** When the agent tries again by itself; null once it has stopped trying. */
  readonly nextAt: number | null;
};

/** How the agent reached the Company. */
export type ActivityChannel = "api" | "company_agent" | "website" | "sign_in" | "direct" | "schedule";

/** What an action could do with the account: read it, or read and change it. */
export type ActivityAccess = "view" | "view_and_change";

export type ActivityResult =
  | "waiting"
  | "in_progress"
  | "done"
  | "declined"
  | "cancelled"
  | "expired"
  | "failed"
  | "unknown";

/**
 * One line of the activity log, built from the agent's own records (approvals, sign-ins, conversations, messages), so it outlives the cards.
 * It never carries a token, key, code, credential or sign-in secret.
 */
export type ActivityEntry = {
  readonly id: string;
  readonly at: number;
  /** `scheduled`: a reminder or scheduled task ran (src/schedules.ts); its issuer is empty. */
  readonly kind: "approval" | "sign_in" | "sign_out" | "conversation" | "message" | "scheduled";
  readonly issuer: Issuer | "";
  readonly company: string;
  readonly account: string | null;
  /** What happened, in plain words. */
  readonly what: string;
  /** Words quoted verbatim, and whose they are. */
  readonly quote?: string;
  readonly quoteBy?: "company" | "agent" | "you";
  readonly how: ActivityChannel | null;
  readonly access: ActivityAccess | null;
  /** Who decided: the User. Null when no decision was needed. */
  readonly decidedBy: "you" | null;
  readonly result: ActivityResult;
  /** The outcome in words: the Company's account of it, or why it failed. */
  readonly outcome?: string;
  readonly outcomeBy?: "company" | "agent";
};

/** Work running in the background now. */
export type ActivityTask = {
  readonly id: string;
  readonly kind: "conversation" | "device_sign_in" | "sign_out" | "approval";
  readonly issuer: Issuer;
  readonly company: string;
  readonly what: string;
  readonly quote?: string;
  readonly quoteBy?: "company" | "agent";
  readonly note?: string;
  readonly since: number;
  /** When it ends by itself, such as a device code's expiry. */
  readonly until?: number;
  /** The page frame that stops it, where the protocol lets the User stop it. */
  readonly stop?: PoppyClientFrame;
};

/**
 * How one Poppy exchange ended: answered (`ok`), answered with an error
 * (`error`), sent again (`retry`), never answered (`failed`), refused by our
 * client (`refused`), or a state change with no request of its own (`info`).
 */
export type ProtocolOutcome = "ok" | "error" | "retry" | "failed" | "refused" | "info";

/**
 * One line of a Company's protocol log (src/poppy/protocol-log.ts): a Poppy
 * request the agent made, or a protocol state change, with the spec section
 * it follows. Built from an allowlist of fields: never a header, body, token,
 * assertion, proof, key, code, `state`, verifier, sign-in value or query.
 */
export type ProtocolEntry = {
  readonly seq: number;
  readonly at: number;
  /** "§4.2", or "Ops §5.2" for the Operations extension. */
  readonly section: string;
  /** What the section is about: "Session", "Direct Sign-In". */
  readonly title: string;
  /** A stable name for the step, such as `session.start`. */
  readonly step: string;
  readonly method: string | null;
  /** Origin and path, with an id that is a secret replaced by a template. */
  readonly url: string | null;
  readonly status: number | null;
  /** The error code the Company answered, or ours for a request that got no answer. */
  readonly error: string | null;
  readonly outcome: ProtocolOutcome;
  /** What the agent sent, in one line. */
  readonly summary: string;
  /** What came back, in one line. */
  readonly result: string;
};

/** Protocol log rows kept per Company; older ones are pruned as new ones arrive. */
export const PROTOCOL_LOG_LIMIT = 500;

/** One Company in the protocol view, without its entries: the page asks for those. */
export type ProtocolCompany = {
  /** The Company's issuer; the https origin of its domain when discovery refused it before an issuer was known. */
  readonly key: string;
  readonly company: string;
  readonly domain: string | null;
  readonly issuer: Issuer | null;
  readonly count: number;
  /** The newest entry's `seq`: when it changes, an open log asks again. */
  readonly lastSeq: number;
  readonly lastAt: number;
};

/** Server → page. */
export type PoppyServerFrame =
  | { readonly type: "poppy.cards"; readonly cards: readonly Card[] }
  | { readonly type: "poppy.direct"; readonly update: DirectUpdate }
  | {
      readonly type: "poppy.settings";
      readonly accounts: readonly ConnectedAccount[];
      /** Sign-outs the Company hasn't accepted yet. */
      readonly signOuts: readonly PendingSignOut[];
    }
  | {
      readonly type: "poppy.activity";
      readonly inProgress: readonly ActivityTask[];
      /** Newest first. */
      readonly log: readonly ActivityEntry[];
    }
  /** The Companies with a protocol log, newest first: sent on connect and whenever one changes. */
  | { readonly type: "poppy.protocol.index"; readonly companies: readonly ProtocolCompany[] }
  /** One Company's protocol log, oldest first, to the page that asked for it. */
  | {
      readonly type: "poppy.protocol";
      readonly key: string;
      readonly company: string;
      readonly domain: string | null;
      readonly issuer: Issuer | null;
      readonly entries: readonly ProtocolEntry[];
    }
  /**
   * The agent's diagnostics, to the page that asked (src/agent-log.ts): its
   * newest wide events and every Company's protocol log, as text to copy.
   */
  | { readonly type: "poppy.diagnostics"; readonly text: string; readonly at: number };

/** Page → server. */
export type PoppyClientFrame =
  | { readonly type: "poppy.context"; readonly locale?: string; readonly time_zone?: string }
  /** The User is using the page, so they count as available (spec 8.10). Not the server's `poppy.activity`. */
  | { readonly type: "poppy.activity" }
  | {
      readonly type: "poppy.credentials";
      readonly signInId: string;
      readonly values: Readonly<Record<string, string>>;
    }
  | { readonly type: "poppy.code"; readonly signInId: string; readonly code: string }
  | { readonly type: "poppy.signin.cancel"; readonly signInId: string }
  | { readonly type: "poppy.approval"; readonly approvalId: string; readonly decision: "approve" | "decline" }
  /**
   * Several approvals decided on one card. The agent checks again that they
   * share one `batchKey`, sends them one at a time, and tells the model once.
   */
  | {
      readonly type: "poppy.approvals";
      readonly decisions: readonly { readonly approvalId: string; readonly decision: "approve" | "decline" }[];
    }
  | { readonly type: "poppy.direct.start"; readonly conversationId: string; readonly text: string }
  | { readonly type: "poppy.direct.decline"; readonly conversationId: string }
  | { readonly type: "poppy.direct.say"; readonly conversationId: string; readonly text: string }
  | { readonly type: "poppy.direct.close"; readonly conversationId: string }
  | { readonly type: "poppy.signout"; readonly issuer: Issuer; readonly account: string }
  /** Try again: one revocation the Company hasn't accepted (`PendingSignOut.id`), never an account still in use. */
  | { readonly type: "poppy.revoke.retry"; readonly id: string }
  | { readonly type: "poppy.card.dismiss"; readonly id: string }
  /** Ask for one Company's protocol log; the answer goes to this page only. */
  | { readonly type: "poppy.protocol"; readonly key: string }
  /** Ask for the agent's diagnostics; the answer goes to this page only. Answered by the agent's log, never Poppy. */
  | { readonly type: "poppy.diagnostics" };
