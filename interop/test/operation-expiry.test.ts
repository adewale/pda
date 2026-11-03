import { describe, expect, it } from "vitest";
import { approvable, parseOperationV2 } from "../../src/poppy/operations-v2";

const operation = (expires_at: string) => ({ operation_id: "op_expiry", revision: "r1", summary: "Exchange the jacket", expires_at });

describe("operation expiry timestamps", () => {
  it.each([
    "2027-02-30T12:00:00Z", "2027-02-29T12:00:00Z", "1900-02-29T12:00:00Z", "2100-02-29T12:00:00Z",
    "2026-04-31T12:00:00Z", "2026-11-31T12:00:00+01:00", "2026-01-01T24:00:00Z",
    "2026-00-10T12:00:00Z", "2026-13-10T12:00:00Z", "2026-01-00T12:00:00Z",
    "2026-01-32T12:00:00Z", "2026-01-01T12:60:00Z", "2026-01-01T12:00:00+24:00",
    "2026-01-01T12:00:00+01:60", "2026-01-01", "2026-01-01T12:00:00"
  ])("refuses an invalid calendar or clock value: %s", expiresAt => {
    expect(parseOperationV2(operation(expiresAt))).toEqual({ problem: "its expires_at isn't an RFC 3339 time" });
  });

  it.each([
    "2028-02-29T12:00:00Z", "2000-02-29T12:00:00Z", "0000-02-29T12:00:00Z",
    "2027-02-28T23:59:59.999999999Z", "2027-02-28t12:00:00z", "2027-02-28T23:30:00-01:00",
    "2027-03-01T00:30:00+01:00", "2027-01-01T12:00:00+23:59", "2027-01-01T12:00:00-00:00"
  ])("keeps a valid RFC 3339 instant and its exact expiry boundary: %s", expiresAt => {
    const parsed = parseOperationV2(operation(expiresAt));
    expect(parsed).toEqual(operation(expiresAt));
    if ("problem" in parsed) throw new Error(parsed.problem);
    const at = Date.parse(expiresAt);
    expect(approvable(parsed, at - 1)).toBe(true);
    expect(approvable(parsed, at)).toBe(false);
    expect(approvable(parsed, at + 1)).toBe(false);
  });
});
