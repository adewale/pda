/** Public error codes carried from the OAuth callback to the sign-in page. */
export const SIGN_IN_ERROR_CODES = [
  "denied", "state", "code", "not_allowed", "token", "profile"
] as const;

export type SignInErrorCode = (typeof SIGN_IN_ERROR_CODES)[number];

export function isSignInErrorCode(value: string): value is SignInErrorCode {
  return (SIGN_IN_ERROR_CODES as readonly string[]).includes(value);
}
