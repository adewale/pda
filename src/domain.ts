/** Host key from a typed domain or URL; validation remains the caller's responsibility. */
export function domainFromInput(input: string): string {
  return input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[/?#].*$/, "");
}
