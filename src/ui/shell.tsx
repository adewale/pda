import { Sidebar, TooltipProvider, useSidebar } from "@cloudflare/kumo";
import { ChatsCircleIcon, GearSixIcon, ListIcon, ListChecksIcon, PlugsIcon, SignOutIcon, StorefrontIcon, WifiSlashIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ComponentType, type MouseEvent } from "react";
import { needsYou, openDirect } from "../poppy-ui";
import type { PiSession } from "../use-pi-session";
import { ActivityPage } from "./activity";
import { ChatPage } from "./chat";
import { CompaniesPage } from "./companies";
import { ConnectionProvider } from "./connection";
import { Action, IconAction } from "./controls";
import { ModelBanner, useEntitlement } from "./model";
import { isPlainClick, routePath, useRoute, type Place, type Route } from "./route";
import { PROVIDER_NAME, SettingsPage, useFollowDeviceTheme, type Identity } from "./settings";

type IconProps = { size?: number; weight?: "regular" | "fill"; "aria-hidden"?: boolean };

const PLACES: { place: Place; label: string; Icon: ComponentType<IconProps> }[] = [
  { place: "chat", label: "Chat", Icon: ChatsCircleIcon },
  { place: "activity", label: "Activity", Icon: ListChecksIcon },
  { place: "companies", label: "Companies", Icon: StorefrontIcon },
  { place: "settings", label: "Settings", Icon: GearSixIcon }
];

const TITLE = "Personal agent";

/** The agent's mark, shown once: in the rail, not on every message. */
function AgentMark() {
  return (
    <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-kumo-contrast text-kumo-inverse">
      <PlugsIcon size={16} weight="bold" />
    </span>
  );
}

function Nav({ route, navigate, waiting }: { route: Route; navigate: (route: Route) => void; waiting: number }) {
  const { setOpenMobile } = useSidebar();
  return (
    <nav aria-label="Places">
      <Sidebar.Menu>
        {PLACES.map(({ place, label, Icon }) => {
          const active = route.place === place;
          const target: Route = { place, company: null };
          return (
            <Sidebar.MenuButton
              key={place}
              href={routePath(target)}
              active={active}
              aria-current={active ? "page" : undefined}
              icon={<Icon size={20} weight={active ? "fill" : "regular"} aria-hidden />}
              className="min-h-10 text-base focus-visible:ring-2 focus-visible:ring-kumo-brand max-md:min-h-11"
              onClick={(event: MouseEvent) => {
                if (!isPlainClick(event)) return;
                event.preventDefault();
                navigate(target);
                setOpenMobile(false);
              }}
            >
              <span className="flex-1">{label}</span>
              {place === "chat" && waiting > 0 ? (
                <>
                  <span aria-hidden className="rounded-full bg-kumo-warning-tint px-2 text-[13px] font-semibold text-kumo-warning tabular-nums">
                    {waiting}
                  </span>
                  <span className="sr-only">, {waiting === 1 ? "1 thing needs you" : `${waiting} things need you`}</span>
                </>
              ) : null}
            </Sidebar.MenuButton>
          );
        })}
      </Sidebar.Menu>
    </nav>
  );
}

/** Phones: the rail becomes a sheet, opened from this bar. */
function MobileBar({ title, waiting, onChat }: { title: string; waiting: number; onChat: (() => void) | null }) {
  const { setOpenMobile, isMobile } = useSidebar();
  if (!isMobile) return null;
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-kumo-hairline bg-kumo-base px-2">
      <IconAction label="Open navigation" variant="ghost" icon={<ListIcon size={20} />} onClick={() => setOpenMobile(true)} />
      <p className="min-w-0 flex-1 truncate text-base font-semibold">{title}</p>
      {waiting > 0 && onChat ? (
        <button
          type="button"
          onClick={onChat}
          className="mr-1 flex min-h-11 items-center rounded-full px-2 transition-[transform] duration-150 ease-(--ease-out) active:scale-[0.97] motion-reduce:active:scale-100"
        >
          <span className="rounded-full bg-kumo-warning-tint px-2.5 py-0.5 text-[13px] font-semibold text-kumo-warning tabular-nums">
            {waiting} {waiting === 1 ? "needs" : "need"} you
          </span>
        </button>
      ) : null}
    </header>
  );
}

/** Shown only while the page isn't connected to the agent; the agent itself keeps working. */
function ConnectionBanner({ status }: { status: PiSession["status"] }) {
  if (status === "open") return null;
  return (
    <div role="status" className="flex shrink-0 items-start gap-2 border-b border-kumo-hairline bg-kumo-elevated px-4 py-2 text-[13px] text-kumo-default">
      <WifiSlashIcon size={16} aria-hidden className="mt-px shrink-0 text-kumo-subtle" />
      <p className="text-pretty">
        {status === "connecting"
          ? "Connecting to your agent."
          : "Reconnecting to your agent. It keeps working meanwhile, and what you send now goes once it's back."}
      </p>
    </div>
  );
}

/**
 * The signed-in page: a rail with the four places, and the place itself.
 * `session` is the live connection in the app and a fixture in tests.
 */
export function Workspace({ identity, session }: { identity: Identity; session: PiSession }) {
  const [route, navigate] = useRoute();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  useFollowDeviceTheme();
  const hiddenOpen = openDirect(session.poppy).filter((update) => hidden.has(update.conversationId)).length;
  const waiting = needsYou(session.poppy.cards).length + hiddenOpen;
  const [entitlement, refreshEntitlement] = useEntitlement();
  // The agent posts a notice when model calls stop or start again: read the lane again then.
  const modelNotice = session.poppy.cards.find((card) => card.id === "model-access");
  const modelNoticeKey = modelNotice ? `${modelNotice.open}:${modelNotice.kind === "notice" ? modelNotice.text : ""}` : "";
  useEffect(() => {
    if (modelNoticeKey) refreshEntitlement();
  }, [modelNoticeKey, refreshEntitlement]);

  useEffect(() => {
    document.title = waiting > 0 ? `(${waiting}) ${TITLE}` : TITLE;
  }, [waiting]);

  // Motion only after the first render settles: nothing animates on load.
  useEffect(() => {
    const timer = setTimeout(() => document.documentElement.setAttribute("data-settled", ""), 600);
    return () => clearTimeout(timer);
  }, []);

  // A new place: start at its top, and move focus to its heading for screen readers.
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    main.current?.scrollTo?.({ top: 0 });
    main.current?.querySelector<HTMLElement>("h1")?.focus({ preventScroll: true });
  }, [route.place, route.company]);

  const label = PLACES.find((item) => item.place === route.place)!.label;
  return (
    <ConnectionProvider connected={session.status === "open"}>
      <TooltipProvider>
        <Sidebar.Provider collapsible="offcanvas" className="h-dvh min-h-0 overflow-hidden bg-kumo-canvas text-kumo-default">
          <Sidebar aria-label="Personal agent">
            <Sidebar.Header className="h-14 gap-2 border-kumo-hairline px-4">
              <AgentMark />
              <span className="min-w-0 flex-1 truncate text-base font-semibold">{TITLE}</span>
              <Sidebar.Close className="md:hidden" />
            </Sidebar.Header>
            <Sidebar.Content>
              <Nav route={route} navigate={navigate} waiting={waiting} />
            </Sidebar.Content>
            <Sidebar.Footer className="h-auto flex-col items-stretch gap-1 border-kumo-hairline py-3 whitespace-normal">
              <p className="min-w-0 text-[13px] text-kumo-subtle">
                <span className="block truncate font-medium text-kumo-default" title={identity.email ?? undefined}>
                  {identity.email ?? "Signed in"}
                </span>
                {PROVIDER_NAME[identity.provider]}
              </p>
              <form method="post" action="/logout">
                <Action type="submit" variant="ghost" icon={<SignOutIcon size={16} aria-hidden />} className="-ml-2 w-full justify-start pl-2">
                  Sign out
                </Action>
              </form>
            </Sidebar.Footer>
          </Sidebar>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-kumo-canvas">
            <MobileBar title={label} waiting={waiting} onChat={route.place === "chat" ? null : () => navigate({ place: "chat", company: null })} />
            <ConnectionBanner status={session.status} />
            <ModelBanner entitlement={entitlement} onSettings={route.place === "settings" ? null : () => navigate({ place: "settings", company: null })} />
            <main ref={main} className={route.place === "chat" ? "min-h-0 flex-1" : "min-h-0 flex-1 overflow-y-auto"}>
              {route.place === "chat" ? (
                <ChatPage session={session} hidden={hidden} setHidden={setHidden} />
              ) : (
                <div className="mx-auto max-w-5xl px-4 py-8 sm:px-8 [&_h1]:outline-none" >
                  {route.place === "activity" ? (
                    <ActivityPage activity={session.poppy.activity} protocol={session.poppy.protocol} send={session.sendPoppy} />
                  ) : route.place === "companies" ? (
                    <CompaniesPage
                      view={session.poppy}
                      send={session.sendPoppy}
                      selected={route.company}
                      onSelect={(issuer) => navigate({ place: "companies", company: issuer })}
                    />
                  ) : (
                    <SettingsPage identity={identity} entitlement={entitlement} onEntitlement={refreshEntitlement} />
                  )}
                </div>
              )}
            </main>
          </div>
        </Sidebar.Provider>
      </TooltipProvider>
    </ConnectionProvider>
  );
}
