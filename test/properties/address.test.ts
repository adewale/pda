import { describe, expect, it } from "vitest";
import { isPublicAddress, NonPublicAddressError, parseIPv4, parseIPv6, pinnedLookup, type ResolvedAddress } from "../../src/validator/address";
import { gs, property, propertyAsync } from "./hegel";

// IANA special-purpose ranges in endpoint form, independent of the implementation's prefix masks.
const V4_RANGES = [
  ["0.0.0.0", "0.255.255.255"], ["10.0.0.0", "10.255.255.255"],
  ["100.64.0.0", "100.127.255.255"], ["127.0.0.0", "127.255.255.255"],
  ["169.254.0.0", "169.254.255.255"], ["172.16.0.0", "172.31.255.255"],
  ["192.0.0.0", "192.0.0.255"], ["192.0.2.0", "192.0.2.255"],
  ["192.168.0.0", "192.168.255.255"], ["198.18.0.0", "198.19.255.255"],
  ["198.51.100.0", "198.51.100.255"], ["203.0.113.0", "203.0.113.255"],
  ["224.0.0.0", "239.255.255.255"], ["240.0.0.0", "255.255.255.255"]
].map(([first, last]) => [v4Number(first!), v4Number(last!)] as const);

function v4Number(text: string): number {
  return text.split(".").reduce((value, part) => value * 256 + Number(part), 0);
}
const v4Text = (value: number) => [3, 2, 1, 0].map((power) => Math.floor(value / 256 ** power) % 256).join(".");
const publicV4 = (value: number) => !V4_RANGES.some(([first, last]) => value >= first && value <= last);
const v4Values = gs.oneOf(
  gs.integers({ minValue: 0, maxValue: 0xffffffff }),
  gs.tuples(gs.sampledFrom(V4_RANGES.flat()), gs.integers({ minValue: -2, maxValue: 2 }))
    .map(([boundary, delta]) => boundary + delta).filter((value) => value >= 0 && value <= 0xffffffff)
);

/** Explicit endpoint intervals for the IPv6 exclusions documented by address.ts. */
const V6_RANGES = [
  [0n, (1n << 32n) - 1n], // unspecified, loopback and deprecated compatible IPv4
  [0x01000000000000000000000000000000n, 0x0100000000000000ffffffffffffffffn],
  [0x20010db8000000000000000000000000n, 0x20010db8ffffffffffffffffffffffffn],
  [0xfc000000000000000000000000000000n, 0xfdffffffffffffffffffffffffffffffn],
  [0xfe800000000000000000000000000000n, 0xfebfffffffffffffffffffffffffffffn],
  [0xfec00000000000000000000000000000n, 0xfeffffffffffffffffffffffffffffffn],
  [0xff000000000000000000000000000000n, 0xffffffffffffffffffffffffffffffffn]
] as const;
function publicV6(value: bigint): boolean {
  if (value >> 32n === 0xffffn || value >> 32n === 0x0064ff9b0000000000000000n) return publicV4(Number(value & 0xffffffffn));
  if (value >> 112n === 0x2002n) return publicV4(Number((value >> 80n) & 0xffffffffn));
  return !V6_RANGES.some(([first, last]) => value >= first && value <= last);
}
const v6Text = (value: bigint) => Array.from({ length: 8 }, (_, i) => Number((value >> BigInt(16 * (7 - i))) & 0xffffn).toString(16)).join(":");
const publicAnswers = gs.oneOf<ResolvedAddress>(
  v4Values.filter(publicV4).map((value) => ({ address: v4Text(value), family: 4 as const })),
  gs.bigIntegers({ minValue: 0n, maxValue: (1n << 128n) - 1n }).filter(publicV6)
    .map((value) => ({ address: v6Text(value), family: 6 as const }))
);

describe("network addresses, independent numeric and spelling oracles", () => {
  it("parses any dotted quad and classifies both sides of every IPv4 special-purpose boundary", property((tc) => {
    const value = tc.draw(v4Values), text = v4Text(value);
    expect(parseIPv4(text)).toEqual(text.split(".").map(Number));
    expect(isPublicAddress(text), text).toBe(publicV4(value));
  }));

  it("classifies IPv4-mapped, NAT64 and 6to4 spellings by their embedded IPv4 address", property((tc) => {
    const value = tc.draw(v4Values), text = v4Text(value);
    const high = Math.floor(value / 65536).toString(16), low = (value % 65536).toString(16);
    for (const spelling of [`::ffff:${text}`, `0:0:0:0:0:FFFF:${high}:${low}`, `64:ff9b::${text}`, `2002:${high}:${low}::1`]) {
      expect(isPublicAddress(spelling), spelling).toBe(publicV4(value));
    }
  }));

  it("classifies generated IPv6 values and every documented range boundary by numeric interval", property((tc) => {
    const value = tc.draw(gs.oneOf(
      gs.bigIntegers({ minValue: 0n, maxValue: (1n << 128n) - 1n }),
      gs.tuples(gs.sampledFrom(V6_RANGES.flat()), gs.integers({ minValue: -2, maxValue: 2 }))
        .map(([boundary, delta]) => boundary + BigInt(delta)).filter((v) => v >= 0n && v < 1n << 128n)
    ));
    const text = v6Text(value);
    expect(isPublicAddress(text), text).toBe(publicV6(value));
  }));

  it("preserves all eight groups through uppercase, padding, compression, brackets and zone spellings", property((tc) => {
    const groups = tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: 0xffff }), { minSize: 8, maxSize: 8 }));
    const start = tc.draw(gs.integers({ minValue: 0, maxValue: 7 }));
    const count = tc.draw(gs.integers({ minValue: 1, maxValue: 8 - start }));
    groups.fill(0, start, start + count);
    const words = groups.map((v) => v.toString(16).padStart(tc.draw(gs.integers({ minValue: 1, maxValue: 4 })), "0"));
    const compressed = `${words.slice(0, start).join(":")}::${words.slice(start + count).join(":")}`;
    const spelling = tc.draw(gs.sampledFrom([words.join(":"), compressed, compressed.toUpperCase(), `[${compressed}]`, `${compressed}%eth0`]));
    expect(parseIPv6(spelling), spelling).toEqual(groups);
    expect(isPublicAddress(spelling)).toBe(isPublicAddress(words.join(":")));
  }));

  it("refuses structured invalid quads and IPv6 groups rather than normalizing them into addresses", property((tc) => {
    const value = tc.draw(v4Values), quad = v4Text(value);
    const invalid = tc.draw(gs.sampledFrom([`0${quad}`, `${quad}.1`, `${quad} `, `256.${quad.split(".").slice(1).join(".")}`, "1::2::3", "10000::", "::ffff:256.0.0.1"]));
    expect(parseIPv4(invalid)).toBeNull();
    expect(parseIPv6(invalid)).toBeNull();
    expect(isPublicAddress(invalid)).toBe(false);
  }));
});

describe("pinned DNS lookup", () => {
  it("uses exactly the checked answer once per connection, even when the resolver's next answer changes", propertyAsync(async (tc) => {
    const first = tc.draw(gs.arrays(publicAnswers, { minSize: 1, maxSize: 8 }));
    const unsafe = tc.draw(gs.sampledFrom(["127.0.0.1", "10.1.2.3", "::1", "::ffff:169.254.169.254"]));
    const all = tc.draw(gs.booleans());
    let calls = 0;
    const lookup = pinnedLookup(async (host) => {
      expect(host).toBe("rebind.example");
      return ++calls === 1 ? first : [{ address: unsafe, family: unsafe.includes(":") ? 6 : 4 }];
    });
    const invoke = () => new Promise<{ error: Error | null; address: string | ResolvedAddress[]; family?: number }>((resolve) =>
      lookup("rebind.example", { all }, (error, address, family) => resolve({ error, address, family })));
    expect(await invoke()).toEqual(all ? { error: null, address: first, family: undefined } : { error: null, address: first[0]!.address, family: first[0]!.family });
    expect(calls).toBe(1);
    const refused = await invoke();
    expect(refused.error).toBeInstanceOf(NonPublicAddressError);
    expect(refused.address).toBe("");
    expect(calls).toBe(2);
  }));

  it("rejects a mixed answer regardless of where the non-public address occurs", propertyAsync(async (tc) => {
    const addresses: ResolvedAddress[] = tc.draw(gs.arrays(publicAnswers, { maxSize: 8 }));
    const unsafe = tc.draw(gs.sampledFrom(["127.0.0.1", "::1", "fc00::123", "169.254.169.254"]));
    addresses.splice(tc.draw(gs.integers({ minValue: 0, maxValue: addresses.length })), 0, { address: unsafe, family: unsafe.includes(":") ? 6 : 4 });
    const result = await new Promise<Error | null>((resolve) => pinnedLookup(async () => addresses)("mixed.example", { all: tc.draw(gs.booleans()) }, (error) => resolve(error)));
    expect(result).toBeInstanceOf(NonPublicAddressError);
    expect((result as NonPublicAddressError).address).toBe(unsafe);
  }));
});
