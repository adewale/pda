/**
 * Validator for Personal Agent Protocol discovery documents: a Company's
 * poppy.json and OAuth server metadata, and a Personal Agent's client
 * metadata and key set. Self-contained (no Worker APIs), so it runs in a
 * Worker, in Node as a CLI, or as a library.
 */
export { validateText, validateCompany, validateClient, validateTarget, summarize, domainFromInput, VALIDATOR } from "./validate.ts";
export type { Report, CompanyReport, DocumentResult, Outcome, Skipped, TextOptions } from "./validate.ts";
export type { Message, DocumentKind } from "./primitives.ts";
export type { Fetcher } from "./fetch.ts";
export { MESSAGES, type MessageId, type Severity } from "./messages.ts";
export { PROFILES, LATEST } from "./profiles/index.ts";
