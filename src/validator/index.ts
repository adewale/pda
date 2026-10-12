/**
 * Validator for Personal Agent Protocol discovery documents: a Company's
 * poppy.json and OAuth server metadata, and a Personal Agent's client
 * metadata and key set. Self-contained (no Worker APIs), so it runs in a
 * Worker, in Node as a CLI, or as a library.
 *
 * What keeps its fetches off private networks depends on the runtime. The
 * library refuses non-public names itself (`isPublicHost`), never addresses:
 * Workers refuse private destinations on their own, the Node CLI passes a
 * fetcher that checks each resolved address (`pinnedLookup`), and a caller
 * in any other runtime must supply a fetcher that does the same.
 */
export { validateText, validateCompany, validateClient, validateTarget, summarize, domainFromInput, VALIDATOR } from "./validate.ts";
export type { Report, CompanyReport, DocumentResult, Outcome, Skipped, TextOptions } from "./validate.ts";
export type { Message, DocumentKind } from "./primitives.ts";
export type { Fetcher } from "./fetch.ts";
export { MESSAGES, type MessageId, type Severity } from "./messages.ts";
export { BASES, LEVELS, levelOf, severityOf, isBasis, type Basis, type Level } from "./levels.ts";
export { PROFILES, LATEST } from "./profiles/index.ts";
export { isPublicHost } from "./fetch.ts";
export { isPublicAddress, pinnedLookup, NonPublicAddressError, type Resolver, type ResolvedAddress } from "./address.ts";
