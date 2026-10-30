/**
 * `GET /privacy`: the deployment's privacy policy, which Google's OAuth
 * consent screen links to. The text is the template's; who runs this
 * deployment and how to reach them come from its own vars (`PRIVACY_CONTACT`,
 * `POPPY_CLIENT_NAME`, `PUBLIC_ORIGIN`), so the committed code names nobody.
 * Keep the built behavior and the operator's commitments current. Provider
 * retention depends on deployment and account settings, not this application's logger.
 */
import { ConfigError } from "./config.ts";

/** Bumped whenever the policy's text changes. */
export const PRIVACY_UPDATED = "30 October 2026";

export type PrivacyEnv = {
  readonly PRIVACY_CONTACT?: unknown;
  readonly POPPY_CLIENT_NAME?: unknown;
  readonly PUBLIC_ORIGIN?: unknown;
};

/** How to reach the operator about privacy: an email address or an HTTPS URL. */
export function readPrivacyContact(env: PrivacyEnv): { readonly text: string; readonly href: string } {
  const value = typeof env.PRIVACY_CONTACT === "string" ? env.PRIVACY_CONTACT.trim() : "";
  if (/^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/.test(value)) return { text: value, href: `mailto:${value}` };
  if (/^https:\/\/[^\s<>"]+$/.test(value)) return { text: value, href: value };
  throw new ConfigError("PRIVACY_CONTACT must be an email address or an https:// URL");
}

const escape = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function privacyPage(env: PrivacyEnv): Response {
  const contact = readPrivacyContact(env);
  const name = escape(typeof env.POPPY_CLIENT_NAME === "string" && env.POPPY_CLIENT_NAME ? env.POPPY_CLIENT_NAME : "Poppy Demo Agent");
  const origin = escape(typeof env.PUBLIC_ORIGIN === "string" ? env.PUBLIC_ORIGIN : "");
  const reach = `<a href="${escape(contact.href)}">${escape(contact.text)}</a>`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy policy · ${name}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 16px/1.6 system-ui, sans-serif; background: Canvas; color: CanvasText; }
  main { max-width: 42rem; margin: 0 auto; padding: 2rem 1rem 4rem; }
  h1 { font-size: 1.6rem; line-height: 1.25; margin: 0 0 .25rem; }
  h2 { font-size: 1.1rem; margin: 2rem 0 .5rem; }
  p, li { max-width: 65ch; }
  .updated { color: GrayText; margin: 0 0 1.5rem; }
  a { color: LinkText; }
</style>
</head>
<body>
<main>
<h1>Privacy policy</h1>
<p class="updated">${name}, at ${origin}. Last updated ${PRIVACY_UPDATED}.</p>

<p>${name} is a personal agent: an AI assistant that keeps one conversation with you and, when you ask, deals with companies that support the Personal Agent Protocol on your behalf. This page says what it collects, why, and who sees it. Questions or requests: ${reach}.</p>

<h2>What it collects</h2>
<ul>
<li><strong>When you sign in with Google:</strong> your Google account ID, your email address, and, for a Google Workspace account, its domain. It asks Google only for the <code>openid</code> and <code>email</code> scopes, and reads nothing else from your Google account: no Gmail, Drive, Calendar or contacts.</li>
<li><strong>When you sign in with GitHub:</strong> your GitHub account ID and your primary verified email address.</li>
<li><strong>What you give your agent:</strong> your messages, photos you attach, an Anthropic or OpenAI API key if you add one, short notes your agent saves about you (its memory), reminders and scheduled tasks you ask for, your browser's push subscription if you turn on notifications, and what your agent does for you at companies: the sign-ins, conversations and orders you ask for and approve.</li>
</ul>

<h2>How it's used</h2>
<p>To sign you in and check you're allowed to use this deployment, to run your agent, and to keep the operator's spending within daily limits. The operator does not sell your data, use it for advertising or use it to train AI models. Model providers process submitted data under their own terms and account settings.</p>

<h2>Where it's kept</h2>
<p>Each person's agent has its own storage on Cloudflare, which no other person's agent can read. The operator can access the stored data to operate the service; messages and photos are not end-to-end encrypted. Credentials, such as the tokens companies issue to your agent and any API key you add, are encrypted there. One cookie keeps you signed in; there are no tracking or advertising cookies.</p>

<h2>Who else sees it</h2>
<ul>
<li><strong>The AI model provider</strong> receives conversation context and recent attached images so it can reply: previews when available, or the original image when no preview is available and the file is small enough. The provider is Anthropic, through Cloudflare's AI Gateway, when the operator pays; or Anthropic or OpenAI directly, under your own account, when you use your own key. Providers may retain submitted data under their terms and account settings; the Workers Logs limits below do not describe those copies or AI Gateway retention.</li>
<li><strong>Recognition at companies:</strong> each Company gets its own random User ID for you and can recognize you across signed-out visits. Signing in links those visits to your account there. Your agent keeps the mapping private. It does not currently offer anonymous browsing sessions.</li>
<li><strong>Companies you ask your agent to work with</strong> receive messages and requests your model generates for your task. If you ask it to use a selected photo with a Company, it may upload that photo without another approval. A different stored photo still needs your disclosure approval. When a Company asks you to approve an operation, your agent shows its exact terms and waits for your decision. Routine requests may run without another click. You sign in on the Company's page or a sign-in form in this app; credentials entered in that form go only to the Company's sign-in endpoint, never to the model. The Company handles information it receives under its own policies.</li>
<li><strong>Websites you ask your agent to read</strong> receive a request for that page from Cloudflare's network. General page reads send no cookies or account credentials. The address itself can contain private information in its hostname, path or query. A page that needs JavaScript may also be loaded in a fresh browser in Cloudflare's Browser Run, which runs the page's own scripts, allows only public requests that read, and is closed afterwards. Those scripts can contact other public websites.</li>
<li><strong>Your browser's push service</strong>, if you turn on notifications on a device: Google, Mozilla, Apple or Microsoft, depending on the browser, carries each notification to it. A notification carries only a reminder's words, or that a scheduled task ran, encrypted so that only your device can read it.</li>
<li><strong>Cloudflare</strong> hosts the service. The operator's logs, in Cloudflare Workers Logs, record when and how your agent worked: which companies it dealt with, which tools ran, the model's usage and cost, and what failed. They don't record what you, your agent or anyone else said, and hold no tokens, keys, codes or your email; your agent appears in them under a pseudonymous id. Your agent also keeps its own last 200 of these records and separate copies for up to 50 recently logged actions, each limited to 200 records and 256 KiB. These copies have count and size limits, not a time limit. You can copy them from Activity to send to the operator.</li>
</ul>

<h2>How long it's kept</h2>
<ul>
<li><strong>Photos:</strong> attached photos are deleted after 30 days. This does not delete copies already sent to a model provider or Company.</li>
<li><strong>Memory:</strong> notes about you are kept in its storage until you delete them, one by one or all at once, in Settings. Notes marked as something you said can only be deleted in Settings; the agent can forget its own deductions. Deleting a note does not remove the original conversation, which the agent can still read.</li>
<li><strong>Scheduled work:</strong> reminders and scheduled tasks are kept until they're done or you cancel them, in Settings or by asking your agent. After that, only the newest 100 finished ones and a record of the newest 200 runs are kept for Activity.</li>
<li><strong>Notifications:</strong> a device's push subscription is kept until you turn notifications off on it, or its push service says it has ended.</li>
<li><strong>Operator logs:</strong> kept for Cloudflare Workers Logs' retention period: 7 days on Workers Paid, 3 days on Workers Free. The agent's own diagnostic copies are separate, as described above.</li>
<li><strong>Conversation and other agent state:</strong> kept until you ask for deletion. There is no delete-agent or full-data export button yet. Contact ${reach}, and your agent and everything it stores will be deleted within 30 days. This does not delete copies held by model providers or Companies.</li>
</ul>

<h2>Google user data</h2>
<p>${name}'s use and transfer of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>

<h2>Children</h2>
<p>${name} isn't intended for children under 13, and doesn't knowingly collect their information.</p>

<h2>Changes</h2>
<p>When this policy changes, this page changes, with a new date at the top.</p>
</main>
</body>
</html>
`;
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" }
  });
}
