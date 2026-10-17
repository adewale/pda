import { GithubLogoIcon, GoogleLogoIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Workspace } from "./ui/shell";
import { usePiSession } from "./use-pi-session";
import "./styles.css";

/** Who is signed in, from `/api/me`; the Worker checks the session cookie. */
type Me =
  | { readonly state: "loading" }
  | {
      readonly state: "signed-in";
      readonly email: string | null;
      readonly provider: "google" | "github";
    }
  | { readonly state: "signed-out"; readonly message: string | null; readonly providers: readonly SignInProvider[] };

type SignInProvider = "google" | "github";

/** The deployment's sign-in providers, from `/api/sign-in-options`; both if it can't say. */
async function signInProviders(): Promise<readonly SignInProvider[]> {
  try {
    const response = await fetch("/api/sign-in-options", { credentials: "same-origin" });
    if (!response.ok) return ["google", "github"];
    const body = (await response.json()) as { providers?: unknown };
    const providers = Array.isArray(body.providers) ? body.providers.filter((item): item is SignInProvider => item === "google" || item === "github") : [];
    return providers.length ? providers : ["google", "github"];
  } catch {
    return ["google", "github"];
  }
}

/** What the page says for each `?signin_error=` code the Worker's OAuth callback sets. */
export const SIGN_IN_ERRORS: Record<string, string> = {
  denied: "Sign-in was cancelled.",
  state: "That sign-in expired. Try again.",
  code: "The provider didn't complete sign-in. Try again.",
  token: "The provider didn't confirm who you are. Try again.",
  profile: "The provider didn't share your account ID. Try again.",
  not_allowed: "That account isn't on this agent's allowlist. Ask the owner to add it, or sign in with another account."
};

function takeSignInError(): string | null {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("signin_error");
  if (code === null) return null;
  url.searchParams.delete("signin_error");
  window.history.replaceState(null, "", url);
  return SIGN_IN_ERRORS[code] ?? "Sign-in failed. Try again.";
}

function useMe(): Me {
  const [me, setMe] = useState<Me>({ state: "loading" });
  useEffect(() => {
    let cancelled = false;
    fetch("/api/me", { credentials: "same-origin" })
      .then(async (response) => {
        if (cancelled) return;
        if (response.ok) {
          const body = (await response.json()) as {
            email: string | null;
            provider: "google" | "github";
          };
          setMe({ state: "signed-in", ...body });
        } else if (response.status === 401) {
          const message = takeSignInError();
          const providers = await signInProviders();
          if (!cancelled) setMe({ state: "signed-out", message, providers });
        } else {
          setMe({
            state: "signed-out",
            message: `Sign-in isn't set up yet: ${await response.text()}`,
            providers: []
          });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setMe({ state: "signed-out", message: String(error), providers: [] });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return me;
}

const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/**
 * The page's drawing: the User and their Personal Agent (a lake circle in an
 * ink outline), Poppy (the flower) and a Company and its Company Agent (a
 * sierra mountain), joined by one ink line. Strokes keep their width at any
 * size; below 640px the labels go and the shapes only shrink.
 */
function Diagram() {
  return (
    <svg
      viewBox="0 90 1200 370"
      role="img"
      aria-label="Your Personal Agent, a circle in an ink outline, joined by one line through the Poppy flower to a Company Agent, a mountain. The flower grows on a stem from the line at the foot of the page."
      className="relative block h-auto w-full"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="210" cy="270" r="100" className="stroke-lake" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <path
        d="M338 280 C338 364 284 404 208 404 C130 404 82 356 82 272 C82 188 136 138 214 138 C290 138 338 196 338 280 C360 282 420 268 470 268 L928 268"
        className="stroke-ink"
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
      />
      <path d="M840 440 L1015 100 L1170 440 Z" className="stroke-sierra" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <path className="fill-poppy-shade" d="M600 268 C622.3 211.4 679.5 182.7 721.8 199.8 C754.8 213 764.9 251.9 750.5 281.6 C745.5 290.7 753.4 296.5 753.3 306.7 C748.9 346.7 710 385.4 674.4 379.9 C630.9 372.7 596.2 324.4 600 268 Z" />
      <path className="fill-poppy-shade" d="M600 268 C577.7 324.6 520.5 353.3 478.2 336.2 C445.2 323 435.1 284.1 449.5 254.4 C454.5 245.3 446.6 239.5 446.7 229.3 C451.1 189.3 490 150.6 525.6 156.1 C569.1 163.3 603.8 211.6 600 268 Z" />
      <path className="fill-poppy" d="M600 268 C545.1 246.4 517.2 190.9 533.9 149.8 C546.6 117.8 584.4 108 613.2 122 C622.1 126.9 627.7 119.2 637.6 119.3 C676.3 123.6 713.9 161.3 708.5 195.9 C701.6 238 654.7 271.7 600 268 Z" />
      <path className="fill-poppy" d="M600 268 C654.9 289.6 682.8 345.1 666.1 386.2 C653.4 418.2 615.6 428 586.8 414 C577.9 409.1 572.3 416.8 562.4 416.7 C523.7 412.4 486.1 374.7 491.5 340.1 C498.4 298 545.3 264.3 600 268 Z" />
      <path fill="#1d1d1f" d="M566 272 C562 244 588 230 612 234 C636 238 642 262 636 284 C628 306 598 310 580 302 C568 296 567 284 566 272 Z" />
      {/* Each baseline sits 0.35em below its shape's centre, so the capitals are centred on it. */}
      <g className="max-sm:hidden" fontFamily={MONO} fontSize="14" textAnchor="middle">
        <text x="210" y="274.9" className="fill-lake">
          Personal Agent
        </text>
        <text x="604" y="274.55" fontSize="13" fill="#f7f4ec">
          Poppy
        </text>
        <text x="1008.3" y="331.6" className="fill-sierra">
          Company Agent
        </text>
      </g>
    </svg>
  );
}

const PROVIDER_NAMES: Record<SignInProvider, string> = { google: "Google", github: "GitHub" };

/** [symbol | Sign in], named in full for screen readers. */
function SignInLink({ provider }: { provider: SignInProvider }) {
  const Icon = provider === "google" ? GoogleLogoIcon : GithubLogoIcon;
  return (
    <a
      href={`/auth/${provider}`}
      aria-label={`Sign in with ${PROVIDER_NAMES[provider]}`}
      className="inline-flex min-h-12 items-stretch rounded-[2px] bg-bark text-[15px] font-medium text-white transition-[background-color,transform] duration-150 ease-(--ease-out) hover:bg-kumo-brand-hover active:scale-[0.97] motion-reduce:active:scale-100"
    >
      <span className="inline-flex items-center border-r border-white/30 px-3.5">
        <Icon size={20} aria-hidden />
      </span>
      <span className="inline-flex items-center px-5">Sign in</span>
    </a>
  );
}

const STEM = "w-[1.5px] bg-ink";

/** Shown instead of the agent when `/api/me` says no one is signed in. */
function SignedOut({ message, providers }: { message: string | null; providers: readonly SignInProvider[] }) {
  const [first, second] = (["google", "github"] as const).filter((provider) => providers.includes(provider));
  return (
    <div className="flex min-h-dvh flex-col bg-kumo-canvas text-kumo-default">
      <header className="mx-auto w-full max-w-[1080px] px-6">
        <h1 className="border-b-2 border-ink pt-6 pb-3.5 text-[17px] font-semibold text-kumo-strong">Poppy Demo Agent</h1>
      </header>
      <main className="mx-auto flex w-full max-w-[1080px] flex-1 flex-col px-6 pt-12">
        <div className="min-h-6 flex-1" />
        {message ? (
          <p role="alert" className="mx-auto mb-8 max-w-md rounded-[2px] bg-kumo-danger-tint px-4 py-3 text-base text-pretty text-kumo-danger">
            {message}
          </p>
        ) : null}
        {/* The stem starts at the flower's centre, behind the petals, and runs on to the footer's rule. */}
        <div className="relative">
          <div aria-hidden className={`absolute top-[48%] bottom-0 left-1/2 -ml-[0.75px] ${STEM}`} />
          <Diagram />
        </div>
        <div aria-hidden className={`h-10 self-center ${STEM}`} />
        <div className="grid grid-cols-[1fr_auto_1fr] gap-x-6">
          <div className="justify-self-end">{first ? <SignInLink provider={first} /> : null}</div>
          <div aria-hidden className={STEM} />
          <div className="justify-self-start">{second ? <SignInLink provider={second} /> : null}</div>
        </div>
        {/* What this is, beside the stem's root, so the stem still reaches the rule. */}
        <div className="grid min-h-12 flex-1 grid-cols-[1fr_auto_1fr] gap-x-6">
          <p className="max-w-[52ch] self-end pt-8 pb-4 text-xs/relaxed text-pretty text-granite">
            Poppy Demo Agent (PDA) is a Personal Agent to demonstrate the use of Poppy (Personal Agent Protocol) for interacting with companies and their Company Agents.
          </p>
          <div aria-hidden className={STEM} />
          <div />
        </div>
      </main>
      <footer className="mx-auto w-full max-w-[1080px] px-6">
        <nav aria-label="About" className="flex flex-wrap gap-x-5 gap-y-1.5 border-t-2 border-ink pt-3 pb-5 text-xs text-granite">
          <a href="https://personalagentprotocol.org" className="underline underline-offset-2 hover:text-kumo-default">
            Personal Agent Protocol
          </a>
          <a href="/validator" className="underline underline-offset-2 hover:text-kumo-default">
            Validator
          </a>
          <a href="/privacy" className="underline underline-offset-2 hover:text-kumo-default">
            Privacy
          </a>
        </nav>
      </footer>
    </div>
  );
}

function SignedIn({ email, provider }: { email: string | null; provider: "google" | "github" }) {
  const session = usePiSession();
  return <Workspace identity={{ email, provider }} session={session} />;
}

export function App() {
  const me = useMe();
  if (me.state === "loading") {
    return <div className="h-dvh bg-kumo-canvas" />;
  }
  if (me.state === "signed-out") return <SignedOut message={me.message} providers={me.providers} />;
  return <SignedIn email={me.email} provider={me.provider} />;
}
