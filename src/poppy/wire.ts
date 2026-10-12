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
      readonly kind: "operation";
      readonly issuer: string;
      readonly operationId: string;
      readonly revision: number;
      readonly state: string;
      /** The Company's own summary, shown verbatim (Ops 5.1). */
      readonly summary: string;
      readonly account: string | null;
      readonly terms?: unknown;
      readonly highlights: readonly string[];
      readonly previousSummary?: string;
      readonly expiresAt?: string;
      readonly userApprovalRequired: boolean;
      readonly url?: string;
      readonly result?: string;
      /** HTTPS links on the Company's hosts from a final operation's `result.data`, such as a checkout. */
      readonly links?: readonly { readonly label: string; readonly url: string }[];
      /**
       * The Company no longer has it (`operation_not_found`), so nothing more
       * can be done with it (N19): whether it may have happened (`unknown`, a
       * confirm's answer never came) or wasn't done.
       */
      readonly lost?: "unknown" | "not_done";
      readonly approvedBy?: string;
    })
  | (CardBase & {
      readonly kind: "approval";
      readonly approvalId: string;
      readonly summary: string;
      readonly status: "pending" | "approved" | "declined" | "done" | "failed" | "unknown";
      readonly result?: string;
      /** The User's photos the request sends: names, types and sizes, which the page shows with the photo itself. */
      readonly attachments?: readonly { readonly id: string; readonly name: string; readonly type: string; readonly size: number }[];
    })
  | (CardBase & {
      readonly kind: "direct_invite";
      readonly conversationId: string;
      readonly reason: string;
    })
  | (CardBase & { readonly kind: "notice"; readonly text: string });

export type ScopeInfo = { readonly scope: string; readonly description: string };

/** One message in a Direct Conversation, for the page. */
export type DirectMessage = {
  readonly id: string;
  readonly role: "user" | "company";
  readonly sender: "agent" | "human";
  readonly text?: string;
  readonly data?: unknown;
};

export type DirectUpdate = {
  readonly conversationId: string;
  readonly company: string;
  readonly status: string;
  readonly responder: string;
  readonly messages?: readonly DirectMessage[];
  /** Text pieces of a Company message still being written: display only (spec 7.6). */
  readonly partial?: { readonly messageId: string; readonly text: string } | null;
  readonly closed?: boolean;
};

export type ConnectedAccount = {
  readonly issuer: string;
  readonly company: string;
  readonly account: string;
  readonly scope: string;
  readonly expiresAt: number | null;
};

export type Permission = {
  readonly id: string;
  readonly issuer: string;
  readonly company: string;
  readonly account: string;
  readonly action: string;
  readonly maxAmount: string | null;
  readonly currency: string | null;
  readonly maxUses: number | null;
  readonly uses: number;
  readonly expiresAt: number | null;
};

/** How the agent reached the Company. */
export type ActivityChannel = "api" | "company_agent" | "website" | "sign_in" | "direct";

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
 * One line of the activity log, built from the agent's own records (operations,
 * approvals, sign-ins, conversations, messages), so it outlives the cards.
 * It never carries a token, key, code, credential or sign-in secret.
 */
export type ActivityEntry = {
  readonly id: string;
  readonly at: number;
  readonly kind: "operation" | "approval" | "sign_in" | "conversation" | "message";
  readonly issuer: string;
  readonly company: string;
  readonly account: string | null;
  /** What happened, in plain words. */
  readonly what: string;
  /** Words quoted verbatim, and whose they are. */
  readonly quote?: string;
  readonly quoteBy?: "company" | "agent" | "you";
  readonly how: ActivityChannel | null;
  readonly access: ActivityAccess | null;
  /** Who decided: the User, or a standing permission they set. Null when no decision was needed. */
  readonly decidedBy: "you" | "standing_permission" | null;
  readonly result: ActivityResult;
  /** The outcome in words: the Company's account of it, or why it failed. */
  readonly outcome?: string;
  readonly outcomeBy?: "company" | "agent";
};

/** Work running in the background now. */
export type ActivityTask = {
  readonly id: string;
  readonly kind: "conversation" | "device_sign_in" | "operation" | "approval";
  readonly issuer: string;
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
 * it follows. Built from a whitelist of fields: never a header, body, token,
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
  /** The Company's issuer; a domain when discovery refused it before an issuer was known. */
  readonly key: string;
  readonly company: string;
  readonly domain: string | null;
  readonly issuer: string | null;
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
      readonly permissions: readonly Permission[];
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
      readonly issuer: string | null;
      readonly entries: readonly ProtocolEntry[];
    };

/** Page → server. */
export type PoppyClientFrame =
  | { readonly type: "poppy.context"; readonly locale?: string; readonly time_zone?: string }
  /** The User is using the page, so they count as available (spec 7.4). Not the server's `poppy.activity`. */
  | { readonly type: "poppy.activity" }
  | {
      readonly type: "poppy.credentials";
      readonly signInId: string;
      readonly values: Readonly<Record<string, string>>;
    }
  | { readonly type: "poppy.code"; readonly signInId: string; readonly code: string }
  | { readonly type: "poppy.signin.cancel"; readonly signInId: string }
  | {
      readonly type: "poppy.operation";
      readonly issuer: string;
      readonly operationId: string;
      readonly revision: number;
      readonly decision: "approve" | "decline" | "cancel";
    }
  | { readonly type: "poppy.approval"; readonly approvalId: string; readonly decision: "approve" | "decline" }
  | { readonly type: "poppy.direct.start"; readonly conversationId: string; readonly text: string }
  | { readonly type: "poppy.direct.decline"; readonly conversationId: string }
  | { readonly type: "poppy.direct.say"; readonly conversationId: string; readonly text: string }
  | { readonly type: "poppy.direct.close"; readonly conversationId: string }
  | { readonly type: "poppy.signout"; readonly issuer: string; readonly account: string }
  | {
      readonly type: "poppy.permission.add";
      readonly issuer: string;
      readonly account: string;
      readonly action: string;
      readonly maxAmount?: string;
      readonly currency?: string;
      readonly maxUses?: number;
      readonly expiresAt?: number;
    }
  | { readonly type: "poppy.permission.remove"; readonly id: string }
  | { readonly type: "poppy.card.dismiss"; readonly id: string }
  /** Ask for one Company's protocol log; the answer goes to this page only. */
  | { readonly type: "poppy.protocol"; readonly key: string };
