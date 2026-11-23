/**
 * A test's fetcher, named as every fetch of another party's document must be
 * (`IdentifiedFetcher`, src/validator/fetch.ts). Tests that check which name
 * reaches a Company use the real callers' fetchers instead.
 */
import { withUserAgent, type Fetcher, type IdentifiedFetcher } from "../src/validator/fetch.ts";

export const TEST_USER_AGENT = "PdaTest/1.0";

export function named(fetcher: Fetcher): IdentifiedFetcher {
  return withUserAgent(fetcher, TEST_USER_AGENT);
}
