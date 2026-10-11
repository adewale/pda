import { useCallback, useEffect, useState } from "react";

/**
 * The page's four places, as real paths so they can be bookmarked and opened
 * in a new tab. Static assets serve the page for any path outside the
 * Worker's own (`/ws`, `/api/*`, `/auth/*`, `/logout`, `/poppy/*`,
 * `/validator*`), so none of these needs a server route.
 */
export type Place = "chat" | "activity" | "companies" | "settings";

export type Route = { readonly place: Place; readonly company: string | null };

const PATHS: Record<Place, string> = {
  chat: "/",
  activity: "/activity",
  companies: "/companies",
  settings: "/settings"
};

export function parseRoute(location: { readonly pathname: string; readonly search: string }): Route {
  const path = location.pathname.replace(/\/+$/, "") || "/";
  const place = (Object.keys(PATHS) as Place[]).find((key) => PATHS[key] === path) ?? "chat";
  const company = place === "companies" ? new URLSearchParams(location.search).get("company") : null;
  return { place, company: company || null };
}

export function routePath(route: Route): string {
  const path = PATHS[route.place];
  return route.place === "companies" && route.company ? `${path}?company=${encodeURIComponent(route.company)}` : path;
}

/** The current place, and a way to go somewhere else without reloading. */
export function useRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState(() => parseRoute(window.location));
  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((next: Route) => {
    const path = routePath(next);
    if (`${window.location.pathname}${window.location.search}` !== path) window.history.pushState(null, "", path);
    setRoute(next);
  }, []);
  return [route, navigate];
}

/** A plain click on a link: one the page handles itself, rather than a new tab or window. */
export function isPlainClick(event: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}
