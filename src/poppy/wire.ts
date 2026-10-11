/**
 * Poppy's messages on the chat WebSocket, beside the Pi protocol in
 * `protocol.ts` (which stays an unchanged copy). Frames whose `type` starts
 * with `poppy.` are handled by the Poppy capability before the chat sees
 * them. Nothing here ever carries a token, key, device code or credential
 * back to the page.
 */

type CardBase = {
  readonly id: string;
  /** The Company's display name. */
  readonly company: string;
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
      readonly approvedBy?: string;
    })
  | (CardBase & {
      readonly kind: "approval";
      readonly approvalId: string;
      readonly summary: string;
      readonly status: "pending" | "approved" | "declined" | "done" | "failed" | "unknown";
      readonly result?: string;
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

/** Server → page. */
export type PoppyServerFrame =
  | { readonly type: "poppy.cards"; readonly cards: readonly Card[] }
  | { readonly type: "poppy.direct"; readonly update: DirectUpdate }
  | {
      readonly type: "poppy.settings";
      readonly accounts: readonly ConnectedAccount[];
      readonly permissions: readonly Permission[];
    };

/** Page → server. */
export type PoppyClientFrame =
  | { readonly type: "poppy.context"; readonly locale?: string; readonly time_zone?: string }
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
  | { readonly type: "poppy.card.dismiss"; readonly id: string };
