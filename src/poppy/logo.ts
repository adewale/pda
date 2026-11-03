import { sniffImage, type AttachmentType } from "../attachments";
import { boundedCacheSeconds, isCompany } from "./discovery";
import { fetchBytes } from "./fetch";
import type { PoppyClient } from "./client";

/** The largest logo the agent keeps and serves. */
export const MAX_LOGO_BYTES = 256 * 1024;

export type Logo = { readonly bytes: Uint8Array; readonly type: AttachmentType };

type Cached = { readonly logo: Logo | null; readonly expiresAt: number };
const caches = new WeakMap<PoppyClient, Map<string, Cached>>();

/**
 * A Company's `organization.logo_uri` (3.1), fetched by the agent so the
 * User's device never loads it from the Company (Guides, "Finding a
 * company"), and served from our own origin. Only a raster image the agent
 * recognizes from its bytes (PNG, JPEG, GIF or WebP; never SVG, which can
 * carry script), at most 256 KB, kept for the logo's cache lifetime bounded
 * like discovery's. Null when the Company names none or it can't be used.
 * The page shows it next to the Company's name and domain, never instead of
 * the domain.
 */
export async function companyLogo(client: PoppyClient, domain: string): Promise<Logo | null> {
  const found = await client.lookup(domain).catch(() => null);
  if (!found || !isCompany(found) || !found.logoUri) return null;
  let cache = caches.get(client);
  if (!cache) caches.set(client, (cache = new Map()));
  const now = client.host.now();
  const cached = cache.get(found.logoUri);
  if (cached && cached.expiresAt > now) return cached.logo;
  let logo: Logo | null = null;
  let seconds: number | null = null;
  try {
    const fetched = await fetchBytes(client.host.fetcher, found.logoUri, { maxBytes: MAX_LOGO_BYTES });
    const type = sniffImage(fetched.bytes);
    if (type) logo = { bytes: fetched.bytes, type };
    seconds = fetched.maxAgeSeconds;
  } catch {
    // Unreachable, too large or not an image: no logo, and the name and domain stand alone.
  }
  cache.set(found.logoUri, { logo, expiresAt: now + boundedCacheSeconds(seconds) * 1000 });
  return logo;
}
