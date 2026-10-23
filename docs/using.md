# Using your agent

For someone signing in for the first time: how to get in, how the model is paid for, what to ask, what needs your say-so, and how to check that each part works. What the agent can't do yet is at the end.

Back to the [README](../README.md) · Each tool and where it comes from: [capabilities.md](capabilities.md)

Public pages need no sign-in: `/about` introduces the project and links to the Poppy ecosystem map at `/about/ecosystem`. The map has an About breadcrumb, section links and tables that scroll sideways on narrow screens. `/validator` checks Poppy documents, `/validator/messages` explains its results, and `/privacy` describes how the app handles your data.

## Signing in

Open the address the operator gave you (the live deployment is https://poppydemoagent.dev) and choose **Google** or **GitHub**. The agent asks Google only for your email address; it reads nothing else from either account.

- **Who gets in.** On the live deployment, sign-up is open: any Google or GitHub account gets an agent. To use it you add your own Anthropic or OpenAI key in **Settings**, unless the operator has put you on the demo, which they pay for. A deployment that hasn't opened sign-up lets in only the accounts its operator listed: a Google email address, every account of a Google Workspace domain, or a GitHub account. Anyone else sees "That account isn't on this agent's allowlist"; ask the operator to add you.
- **One agent per account.** Signing in with Google and with GitHub gives you two separate agents, each with its own conversation, notes, key and reminders. Pick one and keep to it.
- You stay signed in for 30 days on that browser. **Settings → Account** says who you are signed in as, and has **Sign out of this agent**.

## Paying for the model

Your agent can't answer until one of these is in place. **Settings → Model** shows which one it is using.

- **The demo allowance.** If the operator put you on their demo list, they pay for your agent's model calls up to a daily amount, which resets at midnight UTC. The meter in Settings shows how much of today's you've used. Everyone on the demo from one Google Workspace domain also shares a daily allowance, and everyone on a personal Google account or a GitHub account shares another. When yours or the shared one runs out, a banner says so and the agent waits until midnight UTC or until you add a key.
- **Your own key.** In **Settings → Model**, choose Anthropic or OpenAI and paste an API key. The agent checks it with the vendor before keeping it, keeps it encrypted, and sends it only to that vendor. Once a working key is in place, the agent uses it instead of the demo. A key the vendor refuses when you paste it isn't kept, and the vendor's reason is shown; if the vendor refuses it later, Settings says so and the agent stops calling the model until you replace it.
- **An organisation-wide Anthropic key** needs its **Workspace ID** (the optional field under the key), because Anthropic then needs to know which workspace to bill. A key created inside a workspace doesn't.

## What to ask

One conversation, kept for good: it survives closing the tab, a deploy or a crash. Past about 150,000 tokens the oldest part is summarised, and a notice says so.

You can send while the page is still connecting or reconnecting. The message shows in the chat, faded, with "Waiting to connect" under it, and goes once the page is connected; the agent takes it once even if the connection drops and the page sends it again. If the agent refuses it, the reason shows under it with **Try again** and **Remove**. Approvals, sign-ins and other buttons on cards don't wait like this: while the page is connecting they are greyed out, and one that didn't reach your agent says "Not sent", so press it again once the page is connected.

**Companies that support Poppy.** The agent finds a company's `poppy.json`, checks it with the validator, starts a Session and talks to the company's own agent or calls its APIs.

- "Does withpoppyseed.dev support Poppy?"
- "Ask Manzanita whether the Stormline jacket comes in medium."
- "What's the status of my last order?" (it asks you to sign in on the company's own page first; it never sees your password)
- "Print this photo as a 6×4 at print-with-poppy."

**Reading a web page you name.** "What does https://example.com/article say?" It sends only the address: no cookies, no sign-in, nothing about you. It can't search, so give it the address. A page that needs JavaScript, such as a shop built as an app, it loads in a fresh browser in Cloudflare's Browser Run that only reads, up to 10 such pages an hour. It treats what a page says as information, never as your instructions.

**Remembering.** "Remember I'm vegetarian." It keeps short notes, one fact each, and sees the newest 50 with every message. It won't save a password, code, key or card number. Delete a User-supplied note in Settings → Memory; a model tool cannot delete these protected notes. The agent may remove its own deductions. Deleting a note doesn't remove what you said from the conversation itself, which the agent can still read.

**Dates, times and sums.** "What date is 90 days from today?", "What time is it in Tokyo?", "What's 15% of €84.20?" It uses your browser's time zone, and sums are exact to the cent.

**Reminders and tasks.**

- "Remind me at 5pm to call the bank." At that time a reminder card appears in the chat, and on your devices if you turned notifications on. No model call is made. If the card can't be shown, your agent tries again after 1, 5 and 30 minutes; if every try fails, Settings → Scheduled says the reminder didn't reach you, and Activity says why.
- "Every weekday at 9, check whether my print order has shipped." A task runs your agent in the background with your words, as a model call on your key or the demo, and tells you when it has run. Anything it would change still waits for your approval. A task that fails three runs in a row is paused; cancel it and ask again.
- Times are in your time zone, at most a year ahead, and nothing repeats more often than daily: once, daily, on weekdays, or weekly on a day. Up to 20 can wait at once.
- Only you can set or cancel one, by asking in the chat. A company's message, a web page or a task's own run can't.

## Approvals and standing permissions

Nothing that changes your account at a company happens until you approve it. Each request opens in the **Needs you** panel above the message box, with **Approve** and **Decline**. You can keep chatting while it is open. Collapse the panel, or press Escape while working in it, without answering; the **Needs you** button keeps the pending count and opens it again. Anything you entered in a sign-in form stays there while the panel is collapsed.

- **A company's proposal** shows the company's summary, its total in large figures, and its terms. The button says the total ("Approve $14.50"). Approving lets your agent confirm exactly that.
- **Our own card** covers every other change your agent would make: it shows the exact request, and only Approve sends it, once.
- **Sending a photo** always needs a card showing the photo and the company it goes to. Several photos going to the same place at one company share one card: each photo is a tile, ticked to start, and the button counts what it sends ("Send 9 of 10 photos"). Untick any you don't want sent; your agent hears that you declined them. Once you decide, each tile shows how its photo went. A photo for another company, or anything that isn't a photo, keeps its own card.

When you've decided, the outcome shows on the line in the chat where your agent asked: "Sent “lake.jpg” to Print Shop", or "Couldn't send “meadow.gif”" with the company's status code and **Ask your agent to try again**. The company's raw answer, and every exchange in order, are behind **Details** and in **Activity → Protocol**; a link from Details opens that company's log. Links in an answer that carry a signature or a token show as "…" after the address, because anyone holding one could use it.
- **Standing permissions are paused.** Every new operation asks you to approve its exact revision. Older permissions remain visible on the Company's page and can be removed; they no longer authorize new work. The old summary-prefix matcher could not check the full action and every term.

Signing in to a company, signing out, and talking to a company's staff directly in a Direct Conversation are also yours to do on the page; the agent can only ask.

**Signing out of a company.** On the **Companies** page, open the company and press **Sign out of** it. Your agent stops using that account at once, and asks the company to revoke the access it granted. If the company doesn't accept that request, a notice says so, with the company's error code. The agent no longer uses the account, but the access stays live at the company until the date the notice gives, unless you revoke it there. Your agent tries again after 1 minute, 10 minutes, 1 hour and 6 hours, then stops and says so. Until the company accepts, its page lists the sign-out with how many times your agent tried, and a **Try again** button. When you sign in again to give your agent more access, it asks the company to revoke the access it had before. If the company doesn't accept, you get the same kind of notice and **Try again**; your account stays signed in with the new access.

## Photos

Attach a photo with **Attach a photo** beside the message box, or paste or drop one in: JPEG, PNG, WebP or GIF, up to 10 MB each. The agent sees a smaller copy so it can talk about it. The photo stays in your own agent and is deleted 30 days after you attached it; after that it can't be seen, shown to the agent or sent anywhere. It goes to a company only when you approve a card that shows it, and only to that company's own servers. Your agent keeps up to 100 MB of photos. HEIC photos aren't taken yet; most browsers convert them when you pick a file, but a pasted HEIC is refused.

## Settings

- **Account:** who you're signed in as, and sign out.
- **Model:** the demo meter, or your key (add, replace, remove, and the Workspace ID).
- **Memory:** every note your agent has saved, marked "You said" or "Your agent noted", each with **Delete**, and **Forget everything**.
- **Scheduled:** each reminder and task waiting, paused or failed, with when it runs next and how it repeats, and **Cancel**. A reminder being tried again says so. A one-off reminder that never reached you, or a one-off task that didn't run, stays here with **Dismiss** until you dismiss it.
- **Notifications:** shown when the deployment has them and your browser supports them. **Notifications on this device** asks the browser's permission, then delivers reminders, and a word when a task has run, even with the page closed. Turn it on in each browser you want them in.
  - **On iPhone and iPad**, notifications reach only the app added to your Home Screen: in Safari, tap **Share**, then **Add to Home Screen**, open the agent from that icon, and turn notifications on there.
  - If you blocked notifications earlier, allow them in the browser's site settings first.
- **Appearance:** light, dark, or match the device.
- **Agent:** the model in use, and the identity companies see your agent as, which is the same for everyone on this deployment.

## Activity and the protocol log

The **Activity** page shows what your agent is doing and has done.

- **In progress:** conversations it is following, sign-ins it is waiting on, sign-outs a company hasn't accepted yet, and operations still open. Each that can be stopped has a button: **End conversation**, **Cancel sign-in**, or ask the company to stop an operation.
- **Log:** newest first, what it did at each company, how and with what access, and who decided (you or a standing permission). Each sign-out has a line, done or not accepted, and so does each reminder and task run.
- **Protocol:** for each company, every Poppy request your agent made, oldest first, with the section of the spec it follows and what came back. It never records headers, bodies, tokens, keys or codes. **Copy as text** or **Download** it to send with a bug report.
- **Diagnostics:** when something went wrong, press **Copy diagnostics** and paste the text into your message to whoever runs your deployment (or **Download diagnostics** for a file). It holds your agent's last 200 events and the protocol log: when and how it worked, which companies and tools it used, the model's usage and cost, and what failed with which error code. It never holds what you, your agent or anyone else said, page text, tokens, keys, codes or your email. The operator's own logs record the same kind of events and keep them for 7 days.

## Checking that it works, end to end

A run-through that touches every part. Each step says what you should see; if you don't, tell the operator what you asked and what happened.

1. **Sign in.** Settings → Account names your account and the provider.
2. **The model.** Settings → Model shows the demo meter, or "Needs a key". Add a key if it asks. Settings → Agent names the model.
3. **Chat and the clock.** Ask "What's today's date, and what's 15% of 84.20?" Under the reply, tool lines read "Checked the date and time" and "Calculated … = 12.63", and the answer agrees.
4. **A web page.** Ask "What does https://example.com say?" The tool line reads "Read example.com (HTTP 200, …)". A page built as an app should say "rendered in Browser Run".
5. **Memory.** Say "Remember I take my coffee black." The tool line reads "Saved a note". Settings → Memory lists it, marked "You said". Delete it there, then ask "Search your notes for coffee": it finds none. (The conversation itself still holds what you said.)
6. **A reminder.** Say "Remind me in 3 minutes to stretch." The tool line reads "Set a reminder", and Settings → Scheduled lists it. Close the tab. After three minutes, a notification arrives if you turned them on; reopen the page and a "Reminder: …" card is in **Needs you**.
7. **A task.** Say "In 5 minutes, tell me the time in Tokyo." Settings → Scheduled lists it as a task. After it runs, a notice says "Your scheduled task ran", and Activity's log has a line for it.
8. **The validator.** Open `/validator` on the same address, which anyone can use without signing in, and check `spotmeplease.com` or `withpoppyseed.dev`. The report lists errors (a broken MUST) and warnings (a departed SHOULD).
9. **A company.** Ask "Does withpoppyseed.dev support Poppy?" The tool line reads "Looked up what withpoppyseed.dev offers personal agents". Activity → Protocol lists the exchanges for that company with their spec sections. A company may not have approved this agent yet, and the agent then says so. It has run against only one live company so far, print-with-poppy's store, as far as asking to upload a photo, so whatever happens next is worth reporting.

## What it can't do yet

- **Skills,** and **web search**: it reads a page only when you give it the address.
- **Reminders by email:** only the chat and Web Push.
- **Delete my agent, or export your data,** from the page. Ask the operator through the contact on the privacy policy (`/privacy`); they delete your agent and everything it stores within 30 days.
- **Browse a company's website when the site needs JavaScript.** Inside a company Session the agent's browser runs no scripts; only `read_url`, signed out and read only, renders pages.
- **Resume a paused task:** cancel it in Settings and ask again.
- **A proper iPhone home-screen icon:** iOS doesn't use the SVG logo.
- **A whole task at a live company:** it has run against one, print-with-poppy's store, only as far as asking to upload a photo; everything else only against our mock company and other projects' demos and SDKs.
- More than one conversation, or a choice of model: each deployment sets one model for the demo and one for each vendor's keys.
