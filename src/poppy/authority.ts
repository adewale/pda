/** Only the identity/withdrawal fields shared by approval guards; browser context is additional authority. */
export type Authority = { readonly sessionId: string | null; readonly account: string | null; readonly authorityGeneration?: number };
export type ApprovalAuthority = Authority & { readonly sessionId: string };

export function sessionAuthority(session: { readonly session_id: string; readonly account: string | null; readonly authority_generation: number } | undefined): Required<Authority> {
  return { sessionId: session?.session_id ?? null, account: session?.account ?? null, authorityGeneration: session?.authority_generation ?? 0 };
}

/** Bindings saved before withdrawal generations mean generation zero. */
export function sameAuthority(expected: Authority, current: Authority): boolean {
  return expected.sessionId === current.sessionId && expected.account === current.account
    && (expected.authorityGeneration ?? 0) === (current.authorityGeneration ?? 0);
}
