// The service worker for notifications (Web Push, src/web-push.ts). It does
// nothing else: no caching, no fetch handler. A push carries a short title
// and body, encrypted for this browser; clicking one opens the agent.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === "string" && data.title ? data.title.slice(0, 100) : "Your personal agent";
  const body = typeof data.body === "string" ? data.body.slice(0, 300) : "";
  const tag = typeof data.tag === "string" && data.tag ? data.tag.slice(0, 100) : undefined;
  event.waitUntil(self.registration.showNotification(title, { body, tag, icon: "/logo.svg" }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of open) {
        if (new URL(client.url).origin === self.location.origin && "focus" in client) return client.focus();
      }
      return self.clients.openWindow("/");
    })()
  );
});

// The browser replaced the subscription (keys rotate, or it expired): hand the
// new one to the agent, as the Settings toggle would.
self.addEventListener("pushsubscriptionchange", (event) => {
  const key = event.oldSubscription && event.oldSubscription.options.applicationServerKey;
  if (!key) return;
  event.waitUntil(
    (async () => {
      const fresh = event.newSubscription || (await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
      await fetch("/api/push/subscription", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fresh.toJSON())
      });
    })()
  );
});
