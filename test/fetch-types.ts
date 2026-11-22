/**
 * What the fetch layer's types rule out (src/validator/fetch.ts): `npm run
 * typecheck` checks this file, and each `@ts-expect-error` fails the check if
 * the line under it ever compiles. Never run. What the types can't rule out
 * (a caller passing another caller's name, the library adding a name of its
 * own, a fetcher building a `Response` from any status) is tested at run
 * time: test/poppy-0.4.test.ts and test/validator.test.ts.
 */
import { discover } from "../src/poppy/discovery";
import { fetchBytes, fetchJson, identifiedFetcher } from "../src/poppy/fetch";
import { fetchDocument, unreachable, withUserAgent, type Answer, type Fetcher, type RedirectTarget, type Stop } from "../src/validator/fetch";
import { validateClient, validateCompany, validateTarget } from "../src/validator/index";
import { Checker } from "../src/validator/primitives";

/** Every fetch of another party's document needs a fetcher that names its caller. */
export async function anUnnamedFetcherIsATypeError(plain: Fetcher): Promise<void> {
  // @ts-expect-error a plain fetcher sends no User-Agent
  await validateCompany(plain, "example.com");
  // @ts-expect-error
  await validateClient(plain, "https://agent.example/client.json");
  // @ts-expect-error
  await validateTarget(plain, "example.com");
  // @ts-expect-error
  await fetchDocument(plain, "https://example.com/.well-known/poppy.json", new Checker("poppy"));
  // @ts-expect-error
  await discover(plain, "example.com");
  // @ts-expect-error
  await fetchJson(plain, "https://api.example/openapi.json");
  // @ts-expect-error
  await fetchBytes(plain, "https://example.com/logo.png");
  // @ts-expect-error only withUserAgent makes one: a cast-free plain function doesn't qualify
  const forged: Parameters<typeof validateCompany>[0] = async (request: Request) => fetch(request);
  void forged;

  // Named, they compile.
  await validateCompany(withUserAgent(plain, "Caller/1.0"), "example.com");
  await fetchJson(identifiedFetcher(plain), "https://api.example/openapi.json");
}

/** A redirect's URL exists only after its Location decoded as one. */
export function aRedirectTargetMustBeNarrowed(target: RedirectTarget): URL | undefined {
  // @ts-expect-error a missing or invalid Location has no URL
  void target.url;
  return target.kind === "url" ? target.url : undefined;
}

/** A switch over the answers, stops or failures that misses one doesn't compile. */
export function aMissedCaseIsATypeError(answer: Answer, stop: Stop): void {
  switch (answer.kind) {
    case "served":
    case "redirect":
    case "cloudflare":
    case "bot-protection":
    case "rate-limited":
    case "server-error":
    case "forbidden":
    case "not-found":
    case "other-status":
      break;
    default:
      // @ts-expect-error "invalid-status" isn't handled
      unreachable(answer);
  }
  switch (stop.kind) {
    case "not-https":
    case "userinfo":
    case "non-public-host":
    case "redirect-refused":
    case "too-many-redirects":
    case "bad-redirect":
    case "answered":
    case "failed":
      break;
    default:
      unreachable(stop);
  }
}
