import { describe, expect, it } from "vitest";
import { pathFor, readOnlyScope, type OpenApiOperation } from "../../src/poppy/apis";
import { covers, grantedScope, parseRateLimit, parseWwwAuthenticate, PoppyError, retryAfterMs, scopeSet } from "../../src/poppy/client";
import { boundedCacheSeconds, protocolEndpoint, type Company } from "../../src/poppy/discovery";
import { assertPublicHost, cacheSeconds, PoppyFetchError, readLimited } from "../../src/poppy/fetch";
import { htu } from "../../src/poppy/jwt";
import { highlights } from "../../src/poppy/operations";
import { chooseSignInType, deviceLink } from "../../src/poppy/signin";
import { cacheSeconds as validatorCacheSeconds, isPublicHost, metadataUrl } from "../../src/validator/fetch";
import { hosts, SCOPE_ALPHABET } from "./companies";
import { gs, jsonValues, property, propertyAsync } from "./hegel";

/** The pure parts of the Poppy client, each against its documented contract, in both directions. */

const scopeTokens = gs.text({ alphabet: SCOPE_ALPHABET, minSize: 1, maxSize: 12 });
const spaces = gs.integers({ minValue: 1, maxValue: 3 }).map((n) => " ".repeat(n));

/** A space-separated scope string (RFC 6749 §3.3) of `tokens`, with any runs of spaces. */
function joined(tc: Parameters<Parameters<typeof property>[0]>[0], tokens: readonly string[]): string {
  return tokens.map((token) => `${token}${tc.draw(spaces)}`).join("").trimEnd().replace(/^/, tc.draw(gs.booleans()) ? " " : "");
}

describe("scopes (4.4, 4.8)", () => {
  it(
    "scopeSet reads a space-separated scope string as its set of tokens",
    property((tc) => {
      const tokens = tc.draw(gs.arrays(scopeTokens, { maxSize: 6 }));
      expect(scopeSet(joined(tc, tokens))).toEqual(new Set(tokens));
    })
  );

  it(
    "covers holds exactly when every needed scope was granted",
    property((tc) => {
      const granted = tc.draw(gs.arrays(scopeTokens, { maxSize: 6 }));
      const needed = tc.draw(gs.arrays(gs.oneOf(gs.sampledFrom(granted.length ? granted : ["x"]), scopeTokens), { maxSize: 6 }));
      expect(covers(joined(tc, granted), needed)).toBe(needed.every((scope) => granted.includes(scope)));
    })
  );

  it(
    "grantedScope takes a given scope as it is, an omitted one as what was asked, and none for a signed-out token (N6)",
    property((tc) => {
      const scope = tc.draw(gs.oneOf(gs.text(), jsonValues(1)));
      const signedIn = tc.draw(jsonValues(0));
      const requested = tc.draw(gs.text());
      const expected = typeof scope === "string" ? scope : signedIn === false ? "" : requested;
      expect(grantedScope({ scope, signed_in: signedIn }, requested)).toBe(expected);
    })
  );

  it(
    "a read-only lookup narrows to the scopes it declares (poppy:read if none) only when the Session holds them and more (Guides)",
    property((tc) => {
      const held = tc.draw(gs.arrays(gs.oneOf(gs.sampledFrom(["poppy:read", "poppy:write"]), scopeTokens), { maxSize: 5 }));
      const declared = tc.draw(gs.arrays(gs.oneOf(gs.sampledFrom(held.length ? held : ["poppy:read"]), scopeTokens), { maxSize: 4 }));
      const op = { operationId: "x", method: "GET", path: "/x", summary: "", parameters: [], acceptsIdempotencyKey: false, scopes: declared } satisfies OpenApiOperation;
      const wanted = new Set(declared.length ? declared : ["poppy:read"]);
      const have = new Set(held);
      const narrows = [...wanted].every((scope) => have.has(scope)) && wanted.size < have.size;
      const result = readOnlyScope(joined(tc, held), op);
      expect(result === null ? null : scopeSet(result)).toEqual(narrows ? wanted : null);
    })
  );

  it(
    "chooses Direct, then Device, then Mediated: the first offered type that can grant every scope (Guides)",
    property((tc) => {
      const offered = (type: string) => tc.draw(gs.optional(gs.arrays(gs.sampledFrom(["poppy:read", "poppy:write", "addresses"]), { maxSize: 3 }))) ?? (type ? null : null);
      const signIn = Object.fromEntries(
        (["direct", "device", "mediated"] as const).flatMap((type) => {
          const scopes = offered(type);
          return scopes ? [[type, type === "mediated" ? { endpoint: "https://a.example/m", fields: [], scopes } : { scopes }]] : [];
        })
      ) as Company["signIn"];
      const needed = tc.draw(gs.arrays(gs.sampledFrom(["poppy:read", "poppy:write", "addresses"]), { maxSize: 3 }));
      const expected = (["direct", "device", "mediated"] as const).find((type) => signIn[type] && needed.every((scope) => signIn[type]!.scopes.includes(scope))) ?? null;
      expect(chooseSignInType({ signIn } as Company, needed)).toBe(expected);
    })
  );
});

/** An RFC 9110 quoted-string. */
function quoted(text: string): string {
  return `"${text.replace(/[\\"]/g, (char) => `\\${char}`)}"`;
}

describe("WWW-Authenticate (RFC 6750, RFC 9449)", () => {
  it(
    "reads error and scope from a challenge, whatever order its parameters come in and whatever the description says",
    property((tc) => {
      const error = tc.draw(gs.fromRegex("[a-z_]{1,20}", { fullmatch: true }));
      const scope = tc.draw(gs.arrays(scopeTokens.filter((token) => !token.includes('"') && !token.includes("\\")), { minSize: 1, maxSize: 3 })).join(" ");
      const params = [`error=${quoted(error)}`, `scope=${quoted(scope)}`];
      if (tc.draw(gs.booleans())) params.push(`error_description=${quoted(tc.draw(gs.text({ maxSize: 40 })))}`);
      if (tc.draw(gs.booleans())) params.push(`algs=${quoted("ES256 RS256")}`);
      const order = tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: 1000 }), { minSize: params.length, maxSize: params.length }));
      const shuffled = params.map((param, index) => [order[index]!, param] as const).sort((a, b) => a[0] - b[0]).map(([, param]) => param);
      const header = `${tc.draw(gs.sampledFrom(["DPoP", "Bearer"]))} ${shuffled.join(tc.draw(gs.sampledFrom([", ", ",", " , "])))}`;
      expect(parseWwwAuthenticate(header)).toEqual({ error, scope });
    })
  );
});

const DELAY_SECONDS = /^\d+$/;
const DAY = "(Mon|Tue|Wed|Thu|Fri|Sat|Sun)";
const MONTH = "(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
/** RFC 9110 §5.6.7 HTTP-date: IMF-fixdate, which senders MUST use, and the obsolete RFC 850 and asctime forms. */
const HTTP_DATE = [
  new RegExp(`^${DAY}, \\d{2} ${MONTH} \\d{4} \\d{2}:\\d{2}:\\d{2} GMT$`),
  new RegExp(`^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \\d{2}-${MONTH}-\\d{2} \\d{2}:\\d{2}:\\d{2} GMT$`),
  new RegExp(`^${DAY} ${MONTH} [ \\d]\\d \\d{2}:\\d{2}:\\d{2} \\d{4}$`)
];

/** asctime-date, RFC 9110 §5.6.7: `Sun Nov  6 08:49:37 1994`, in GMT. */
function asctime(at: number): string {
  const [day, , month, , time] = new Date(at).toUTCString().replace(",", "").split(" ");
  const date = new Date(at);
  return `${day} ${month} ${String(date.getUTCDate()).padStart(2, " ")} ${time} ${date.getUTCFullYear()}`;
}

describe("Retry-After (RFC 9110 §10.2.3; spec 4.3)", () => {
  it(
    "waits delay-seconds exactly",
    property((tc) => {
      const seconds = tc.draw(gs.integers({ minValue: 0, maxValue: 1_000_000_000 }));
      const now = tc.draw(gs.integers({ minValue: 0, maxValue: 4_000_000_000_000 }));
      expect(retryAfterMs(new Response(null, { status: 429, headers: { "Retry-After": String(seconds) } }), now)).toBe(seconds * 1000);
    })
  );

  it(
    "waits until an HTTP-date, or not at all once it has passed",
    property((tc) => {
      const at = tc.draw(gs.integers({ minValue: 0, maxValue: 4_000_000_000 })) * 1000;
      const now = tc.draw(gs.integers({ minValue: 0, maxValue: 4_000_000_000_000 }));
      const header = tc.draw(gs.booleans()) ? new Date(at).toUTCString() : asctime(at);
      expect(retryAfterMs(new Response(null, { status: 503, headers: { "Retry-After": header } }), now)).toBe(Math.max(0, at - now));
    })
  );

  it(
    "ignores a value that is neither delay-seconds nor an HTTP-date",
    property((tc) => {
      const header = tc.draw(
        gs.oneOf(
          gs.text({ maxSize: 30 }),
          gs.sampledFrom(["-1", "1.5", "0x10", "1e3", " 5", "5 ", "+5", "Infinity", "5 seconds", "soon", "2", "1/1/2030", "2030-01-01"]),
          gs.integers().map((n) => `${n} `)
        )
      );
      // Headers can't carry control characters, and trim surrounding spaces.
      tc.assume(/^[\x20-\x7e]*$/.test(header) && header.trim() !== "" && !DELAY_SECONDS.test(header.trim()) && !HTTP_DATE.some((form) => form.test(header.trim())));
      expect(retryAfterMs(new Response(null, { status: 429, headers: { "Retry-After": header } }), Date.now())).toBeNull();
    })
  );

  it(
    "reads RateLimit in both of the draft's forms",
    property((tc) => {
      const remaining = tc.draw(gs.integers({ minValue: 0, maxValue: 1_000_000 }));
      const reset = tc.draw(gs.integers({ minValue: 0, maxValue: 1_000_000 }));
      const header = tc.draw(gs.booleans())
        ? `limit=100, remaining=${remaining}, reset=${reset}`
        : `"default";r=${remaining};t=${reset}`;
      expect(parseRateLimit(header)).toEqual({ remaining, reset });
    })
  );
});

/** A path template of literal and `{name}` segments, and values for its names. */
const templates = gs.composite((tc) => {
  const names = [...tc.draw(gs.sets(gs.fromRegex("[a-z_][a-z0-9_]{0,10}", { fullmatch: true }), { maxSize: 3 }))];
  const literals = tc.draw(gs.arrays(gs.fromRegex("[a-z0-9_-]{1,10}", { fullmatch: true }), { maxSize: 3 }));
  const segments = tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: 1000 }), { minSize: names.length + literals.length, maxSize: names.length + literals.length }))
    .map((rank, index) => [rank, index < names.length ? `{${names[index]}}` : literals[index - names.length]!] as const)
    .sort((a, b) => a[0] - b[0])
    .map(([, segment]) => segment);
  const values = Object.fromEntries(names.map((name) => [name, tc.draw(gs.oneOf<string | number | boolean>(gs.text(), gs.integers(), gs.booleans()))]));
  return { path: `/${segments.join("/")}`, segments, names, values };
});

/** Segments a URL removes or merges: a value can't be one of these and stay its own segment. */
const UNSEGMENTS = ["", ".", ".."];

function operation(path: string, declared: readonly string[] = []): OpenApiOperation {
  return {
    operationId: "op",
    method: "POST",
    path,
    summary: "",
    parameters: declared.map((name) => ({ name, in: "path", required: true })),
    acceptsIdempotencyKey: false,
    scopes: []
  };
}

describe("OpenAPI path templates (spec 6)", () => {
  it(
    "fills every template with its value as one segment, which a URL then keeps as one segment",
    property((tc) => {
      const { path, segments, names, values } = tc.draw(templates);
      // The values a whole segment can't take have their own property, below.
      tc.assume(Object.values(values).every((value) => !UNSEGMENTS.includes(String(value))));
      const declared = tc.draw(gs.booleans()) ? names : [];
      const filled = pathFor(operation(path, declared), values);
      // A template of no segments is "/", whose one segment is empty.
      const resolved = new URL(filled, "https://api.example.com").pathname.split("/").slice(1).filter((segment, index, all) => all.length > 1 || segment !== "");
      expect(resolved).toHaveLength(segments.length);
      segments.forEach((segment, index) => {
        const name = /^\{(.+)\}$/.exec(segment)?.[1];
        expect(decodeURIComponent(resolved[index]!)).toBe(name === undefined ? segment : String(values[name]));
      });
    })
  );

  it(
    "refuses, before any request, a value that would fill a whole segment with nothing, . or ..",
    property((tc) => {
      const { path, names, values } = tc.draw(templates);
      tc.assume(names.length > 0);
      const which = tc.draw(gs.sampledFrom(names));
      const bad = { ...values, [which]: tc.draw(gs.sampledFrom(UNSEGMENTS)) };
      expect(() => pathFor(operation(path, tc.draw(gs.booleans()) ? names : []), bad)).toThrow(PoppyError);
    })
  );

  it(
    "refuses, before any request, a call that leaves a template unfilled",
    property((tc) => {
      const { path, names, values } = tc.draw(templates);
      tc.assume(names.length > 0);
      const missing = tc.draw(gs.sampledFrom(names));
      const { [missing]: _dropped, ...rest } = values;
      const declared = tc.draw(gs.booleans());
      expect(() => pathFor(operation(path, declared ? names : []), rest)).toThrow(PoppyError);
    })
  );
});

const hostnames = gs.oneOf(
  hosts,
  gs.ipAddresses().map((address) => (address.includes(":") ? `[${address}]` : address)),
  gs.sampledFrom(["localhost", "LOCALHOST", "foo.localhost", "intranet", "printer", "a.b"]),
  gs.fromRegex("[a-z0-9-]{1,20}", { fullmatch: true })
);

/** A host as a URL may spell it: its own case, and maybe the root's trailing dot. */
const spelled = gs.composite((tc) => {
  const host = tc.draw(hostnames);
  return { host, url: new URL(`https://${host}${tc.draw(gs.booleans()) && !host.startsWith("[") ? "." : ""}/x`) };
});

function clientRefuses(url: URL): boolean {
  try {
    assertPublicHost(url);
    return false;
  } catch (error) {
    if (error instanceof PoppyFetchError) return true;
    throw error;
  }
}

describe("fetching what Companies control (Guides, 'Fetching metadata safely')", () => {
  it(
    "the client and the validator agree on which hosts are private",
    property((tc) => {
      const { url } = tc.draw(spelled);
      expect(clientRefuses(url)).toBe(!isPublicHost(url));
    })
  );

  it(
    "a host and its fully qualified form, with the root's trailing dot, are refused alike",
    property((tc) => {
      const host = tc.draw(hostnames);
      tc.assume(!host.startsWith("["));
      const plain = new URL(`https://${host}/`);
      const rooted = new URL(`https://${host}./`);
      expect(clientRefuses(rooted)).toBe(clientRefuses(plain));
      expect(isPublicHost(rooted)).toBe(isPublicHost(plain));
    })
  );

  it(
    "refuses every IP literal",
    property((tc) => {
      const address = tc.draw(gs.ipAddresses());
      const url = new URL(`https://${address.includes(":") ? `[${address}]` : address}/`);
      expect(clientRefuses(url)).toBe(true);
      expect(isPublicHost(url)).toBe(false);
    })
  );

  it(
    "reads a body of at most maxBytes as UTF-8, and refuses anything longer or not UTF-8 with a PoppyFetchError",
    propertyAsync(async (tc) => {
      const bytes = tc.draw(gs.oneOf(gs.binary({ maxSize: 300 }), gs.text({ maxSize: 100 }).map((text) => new TextEncoder().encode(text))));
      const maxBytes = tc.draw(gs.integers({ minValue: 0, maxValue: 400 }));
      const cuts = tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: bytes.length }), { maxSize: 4 })).sort((a, b) => a - b);
      const chunks = [0, ...cuts, bytes.length].slice(1).map((end, index, ends) => bytes.slice(index === 0 ? 0 : ends[index - 1], end));
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        }
      });
      let decoded: string | null = null;
      try {
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        decoded = null;
      }
      const read = readLimited(new Response(body), maxBytes);
      if (bytes.length > maxBytes || decoded === null) await expect(read).rejects.toBeInstanceOf(PoppyFetchError);
      else await expect(read).resolves.toBe(decoded);
    })
  );

  it(
    "the client and the validator read Cache-Control alike",
    property((tc) => {
      const directives = tc.draw(
        gs.arrays(
          gs.oneOf(
            gs.sampledFrom(["no-store", "no-cache", "private", "public", "must-revalidate", "immutable", "No-Store"]),
            gs.integers({ minValue: 0, maxValue: 10_000_000 }).map((n) => `max-age=${n}`),
            gs.integers({ minValue: 0, maxValue: 10_000_000 }).map((n) => `s-maxage=${n}`),
            gs.fromRegex("[a-z-]{1,12}(=[a-z0-9]{1,6})?", { fullmatch: true })
          ),
          { maxSize: 4 }
        )
      );
      const headers = new Headers({ "Cache-Control": directives.join(", ") });
      expect(cacheSeconds(new Response(null, { headers }))).toBe(validatorCacheSeconds(headers));
    })
  );

  it(
    "keeps cache lifetimes between a minute and a day (Guides)",
    property((tc) => {
      const seconds = tc.draw(gs.optional(gs.integers({ minValue: 0, maxValue: 10_000_000_000 })));
      const bounded = boundedCacheSeconds(seconds);
      expect(bounded).toBe(seconds === null ? 60 : Math.min(86_400, Math.max(60, seconds)));
    })
  );

  it(
    "puts the OAuth metadata's well-known segment between the issuer's host and its path (RFC 8414 §3.1)",
    property((tc) => {
      const host = tc.draw(hosts).toLowerCase();
      const path = tc.draw(gs.arrays(gs.fromRegex("[A-Za-z0-9_~-]{1,8}", { fullmatch: true }), { maxSize: 3 })).map((segment) => `/${segment}`).join("");
      const issuer = `https://${host}${path}${tc.draw(gs.booleans()) ? "/" : ""}`;
      expect(metadataUrl(issuer)).toBe(`https://${host}/.well-known/oauth-authorization-server${path}`);
    })
  );
});

describe("DPoP htu (spec 4.3)", () => {
  it(
    "is the request URL without its query or fragment",
    property((tc) => {
      const url = new URL(tc.draw(gs.urls()));
      url.search = tc.draw(gs.text({ maxSize: 10 }));
      url.hash = tc.draw(gs.text({ maxSize: 10 }));
      const value = htu(url.href);
      expect(value).toBe(`${url.origin}${url.pathname}`);
      expect(value).not.toMatch(/[?#]/);
    })
  );
});

/** A Company with the hosts device links and endpoints are checked against. */
function companyAt(domain: string): Company {
  return {
    issuer: `https://auth.${domain}`,
    name: "Shop",
    domain,
    protocolVersion: "0.1",
    endpoints: {
      token: `https://auth.${domain}/oauth/token`,
      revocation: `https://auth.${domain}/oauth/revoke`,
      deviceAuthorization: `https://login.${domain}/device`
    },
    signIn: { mediated: { endpoint: `https://auth.${domain}/poppy/sign-in`, fields: [], scopes: [] } },
    customScopes: {},
    conversations: { endpoint: `https://api.${domain}/poppy/conversations` },
    apis: [],
    web: { browserSessionEndpoint: `https://${domain}/poppy/browser-session` },
    extensions: { operations: { endpoint: `https://api.${domain}/poppy/operations` } }
  };
}

describe("device sign-in links (4.6)", () => {
  it(
    "shows an HTTPS link on the Company's domain, its issuer or its device endpoint's host",
    property((tc) => {
      const domain = tc.draw(hosts).toLowerCase();
      const host = tc.draw(gs.sampledFrom([domain, `www.${domain}`, `auth.${domain}`, `login.${domain}`, `a.b.${domain}`]));
      const link = `https://${host}${tc.draw(gs.fromRegex("(/[a-z0-9]{1,6}){0,2}", { fullmatch: true }))}?user_code=${tc.draw(gs.fromRegex("[A-Z0-9]{4}-[A-Z0-9]{4}", { fullmatch: true }))}`;
      expect(deviceLink(companyAt(domain), link)).toBe(new URL(link).href);
    })
  );

  it(
    "shows nothing else: other hosts, other schemes, user info, or text that isn't a URL",
    property((tc) => {
      const domain = tc.draw(hosts).toLowerCase();
      const other = tc.draw(hosts).toLowerCase();
      tc.assume(other !== domain && !other.endsWith(`.${domain}`));
      const value = tc.draw(
        gs.oneOf<unknown>(
          gs.just(`https://${other}/device`),
          gs.just(`http://${domain}/device`),
          gs.just(`javascript:alert(1)//${domain}`),
          gs.just(`https://user:pass@${domain}/device`),
          gs.just(`https://${domain}.${other}/device`),
          gs.text(),
          jsonValues(1)
        )
      );
      expect(deviceLink(companyAt(domain), value)).toBeNull();
    })
  );
});

describe("Poppy endpoints never reached through an API tool (Ops 5.1, 7.8)", () => {
  it(
    "finds the endpoint a URL is at or under, however its path is cased or percent-encoded",
    property((tc) => {
      const domain = tc.draw(hosts).toLowerCase();
      const company = companyAt(domain);
      const endpoint = tc.draw(
        gs.sampledFrom([company.endpoints.token, company.endpoints.revocation, company.conversations!.endpoint, company.extensions.operations!.endpoint, company.signIn.mediated!.endpoint])
      );
      const url = new URL(endpoint);
      const spelledPath = [...url.pathname]
        .map((char) => {
          const choice = tc.draw(gs.integers({ minValue: 0, maxValue: 2 }));
          if (char === "/" || choice === 0) return char;
          return choice === 1 ? char.toUpperCase() : `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`;
        })
        .join("");
      const suffix = tc.draw(gs.fromRegex("(/[A-Za-z0-9_-]{1,8}){0,3}/?", { fullmatch: true }));
      expect(protocolEndpoint(company, new URL(`${url.origin}${spelledPath}${suffix}`))).toBe(endpoint);
    })
  );

  it(
    "finds none for the Company's other API paths",
    property((tc) => {
      const domain = tc.draw(hosts).toLowerCase();
      const path = tc.draw(gs.fromRegex("(/[A-Za-z0-9_-]{1,10}){0,4}", { fullmatch: true }));
      tc.assume(!/^\/poppy(\/|$)/i.test(path));
      expect(protocolEndpoint(companyAt(domain), new URL(`https://api.${domain}${path}`))).toBeNull();
    })
  );
});

describe("operation highlights (Guides, Operations)", () => {
  it(
    "names every cost in terms, and ends by saying whether the action can be undone, for any terms",
    property((tc) => {
      const terms = tc.draw(jsonValues(4));
      const found = highlights(terms);
      expect(found.at(-1)).toMatch(/undone/);
      const amounts: string[] = [];
      const walk = (value: unknown) => {
        if (Array.isArray(value)) value.forEach(walk);
        else if (typeof value === "object" && value !== null) {
          const record = value as Record<string, unknown>;
          if (typeof record.amount === "string" || typeof record.amount === "number") amounts.push(String(record.amount));
          else Object.values(record).forEach(walk);
        }
      };
      walk(terms);
      expect(found.filter((line) => line.startsWith("Cost (")).length).toBe(amounts.length);
    })
  );
});

describe("what these properties found, as examples", () => {
  it("reads a Retry-After that is neither delay-seconds nor an HTTP-date as none, not as a date long past", () => {
    for (const junk of [":0", "1/1/2000", "soon 5", "-1", "1.5"]) {
      expect(retryAfterMs(new Response(null, { status: 503, headers: { "Retry-After": junk } }), Date.now()), junk).toBeNull();
    }
  });

  it("refuses localhost and single-label hosts written with the root's trailing dot", () => {
    for (const host of ["localhost.", "foo.localhost.", "intranet."]) {
      expect(clientRefuses(new URL(`https://${host}/`)), host).toBe(true);
      expect(isPublicHost(new URL(`https://${host}/`)), host).toBe(false);
    }
  });

  it("refuses a body that isn't UTF-8 with a PoppyFetchError", async () => {
    await expect(readLimited(new Response(new Uint8Array([0xff, 0xfe])), 100)).rejects.toBeInstanceOf(PoppyFetchError);
  });

  it("refuses a path value of nothing, . or .., which would reach another resource", () => {
    for (const value of ["", ".", ".."]) {
      expect(() => pathFor(operation("/orders/{order_id}/exchanges"), { order_id: value }), value).toThrow(/another resource/);
    }
    expect(pathFor(operation("/files/{name}.json"), { name: "" })).toBe("/files/.json");
  });
});
