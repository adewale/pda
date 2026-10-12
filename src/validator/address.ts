/**
 * Which IP addresses are public, for a fetcher that resolves host names
 * itself (the Guides, "Fetching metadata safely": refuse loopback, private
 * and link-local addresses, judged by "the address you actually connect to").
 *
 * The validator's own check (`isPublicHost` in fetch.ts) sees only names. A
 * name such as `127.0.0.1.nip.io` passes it and resolves to loopback, so a
 * runtime that can reach private networks has to check the address it
 * connects to as well. Workers can't reach them, and refuse such
 * destinations themselves. The Node CLI (`scripts/poppy-validate.ts`) checks
 * each resolved address here and pins its connection to the address it
 * checked (`pinnedLookup`), so a second DNS answer can't swap it. Pure: no
 * Node or Worker APIs, so it is tested in either.
 */

/** Thrown by a fetcher that refuses a name because of what it resolves to; `fetchDocument` reports it as `http-non-public-address`. */
export class NonPublicAddressError extends Error {
  override readonly name = "NonPublicAddressError";
  readonly hostname: string;
  readonly address: string;
  constructor(hostname: string, address: string) {
    super(`${hostname} resolves to ${address}, which isn't a public address`);
    this.hostname = hostname;
    this.address = address;
  }
}

/** IPv4 ranges that aren't globally reachable (IANA's special-purpose address registry), as [first octets, prefix length]. */
const PRIVATE_V4: readonly (readonly [readonly number[], number])[] = [
  [[0], 8], // "this network", including 0.0.0.0 (unspecified)
  [[10], 8], // RFC 1918
  [[100, 64], 10], // shared address space, carrier-grade NAT (RFC 6598)
  [[127], 8], // loopback
  [[169, 254], 16], // link-local, cloud metadata services among them
  [[172, 16], 12], // RFC 1918
  [[192, 0, 0], 24], // IETF protocol assignments (ipv4only.arpa's 192.0.0.170 and .171 among them)
  [[192, 0, 2], 24], // documentation
  [[192, 168], 16], // RFC 1918
  [[198, 18], 15], // benchmarking
  [[198, 51, 100], 24], // documentation
  [[203, 0, 113], 24], // documentation
  [[224], 4], // multicast
  [[240], 4] // reserved, and 255.255.255.255 (broadcast)
];

/** Four octets, or null when `text` isn't a dotted-quad IPv4 address. */
export function parseIPv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

/** Eight 16-bit groups, or null when `text` isn't an IPv6 address. A trailing dotted quad (`::ffff:127.0.0.1`) is read as two groups; a zone (`%eth0`) is ignored. */
export function parseIPv6(text: string): number[] | null {
  let rest = text.replace(/^\[|\]$/g, "").replace(/%.*$/, "").toLowerCase();
  const tail: number[] = [];
  const quad = /(?:^|:)(\d+\.\d+\.\d+\.\d+)$/.exec(rest);
  if (quad) {
    const v4 = parseIPv4(quad[1]!);
    if (!v4) return null;
    tail.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
    rest = rest.slice(0, rest.length - quad[1]!.length);
    if (rest.endsWith(":") && !rest.endsWith("::")) rest = rest.slice(0, -1);
  }
  const halves = rest.split("::");
  if (halves.length > 2) return null;
  const groups = (half: string) => (half === "" ? [] : half.split(":"));
  const head = groups(halves[0]!);
  const back = halves.length === 2 ? groups(halves[1]!) : [];
  if (![...head, ...back].every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
  const known = head.length + back.length + tail.length;
  if (halves.length === 1 ? known !== 8 : known > 7) return null;
  const zeros = new Array<number>(8 - known).fill(0);
  return [...head.map((g) => parseInt(g, 16)), ...zeros, ...back.map((g) => parseInt(g, 16)), ...tail];
}

function v4IsPublic(octets: readonly number[]): boolean {
  const value = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
  return !PRIVATE_V4.some(([prefix, bits]) => {
    const base = ((prefix[0] ?? 0) << 24) | ((prefix[1] ?? 0) << 16) | ((prefix[2] ?? 0) << 8) | (prefix[3] ?? 0);
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (value & mask) >>> 0 === (base & mask) >>> 0;
  });
}

const embeddedV4 = (groups: readonly number[]) => [groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff];

function v6IsPublic(groups: readonly number[]): boolean {
  const [g0, g1, g2, g3, g4, g5] = groups as [number, number, number, number, number, number];
  const zeroTo = (n: number) => groups.slice(0, n).every((g) => g === 0);
  // ::ffff:a.b.c.d (IPv4-mapped) and 64:ff9b::a.b.c.d (NAT64): the IPv4 address decides.
  if (zeroTo(5) && g5 === 0xffff) return v4IsPublic(embeddedV4(groups));
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return v4IsPublic(embeddedV4(groups));
  // :: (unspecified), ::1 (loopback) and the deprecated IPv4-compatible ::a.b.c.d.
  if (zeroTo(6)) return false;
  // 2002::/16 (6to4) carries an IPv4 address in its next 32 bits.
  if (g0 === 0x2002) return v4IsPublic([g1 >> 8, g1 & 0xff, g2 >> 8, g2 & 0xff]);
  if ((g0 & 0xfe00) === 0xfc00) return false; // fc00::/7, unique local
  if ((g0 & 0xffc0) === 0xfe80) return false; // fe80::/10, link-local
  if ((g0 & 0xffc0) === 0xfec0) return false; // fec0::/10, site-local (deprecated)
  if ((g0 & 0xff00) === 0xff00) return false; // ff00::/8, multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return false; // 2001:db8::/32, documentation
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return false; // 100::/64, discard
  return true;
}

/**
 * Whether a resolved address may be fetched: false for loopback, RFC 1918,
 * link-local, carrier-grade NAT (100.64/10), unique local (fc00::/7),
 * unspecified, multicast, documentation and other ranges that aren't
 * globally reachable, including an IPv4-mapped IPv6 form of any of them.
 * Anything that isn't an IP address is refused too.
 */
export function isPublicAddress(address: string): boolean {
  const v4 = parseIPv4(address);
  if (v4) return v4IsPublic(v4);
  const v6 = parseIPv6(address);
  return v6 ? v6IsPublic(v6) : false;
}

export type ResolvedAddress = { readonly address: string; readonly family: 4 | 6 };
/** Every address a name resolves to, as `dns.promises.lookup(name, { all: true })` gives them. */
export type Resolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

type LookupCallback = (error: Error | null, address: string | ResolvedAddress[], family?: number) => void;

/**
 * A `lookup` for Node's `net.connect` (and so `https.request`) that resolves
 * the name with `resolve`, refuses it with a `NonPublicAddressError` when
 * any address it resolves to isn't public, and otherwise hands the
 * connection exactly the addresses it checked. The socket connects to what
 * was checked, never to a second answer, so DNS rebinding can't swap the
 * address between the check and the connection.
 */
export function pinnedLookup(resolve: Resolver) {
  return (hostname: string, options: { all?: boolean } | number | undefined, callback: LookupCallback): void => {
    resolve(hostname).then(
      (addresses) => {
        if (addresses.length === 0) return callback(Object.assign(new Error(`${hostname} has no address`), { code: "ENOTFOUND" }), "", 4);
        const refused = addresses.find((entry) => !isPublicAddress(entry.address));
        if (refused) return callback(new NonPublicAddressError(hostname, refused.address), "", 4);
        if (typeof options === "object" && options?.all) return callback(null, addresses.map((entry) => ({ ...entry })));
        callback(null, addresses[0]!.address, addresses[0]!.family);
      },
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), "", 4)
    );
  };
}
