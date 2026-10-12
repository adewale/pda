import { GithubLogoIcon, GoogleLogoIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ActionLink } from "./ui/controls";
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

/** Shown instead of the agent when `/api/me` says no one is signed in. */
function SignedOut({ message, providers }: { message: string | null; providers: readonly SignInProvider[] }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-kumo-canvas px-4 py-10 text-kumo-default">
      <div className="w-full max-w-sm">
        <h1 className="text-xl font-semibold text-balance text-kumo-strong">Personal agent</h1>
        <p className="mt-2 text-base text-pretty text-kumo-subtle">
          Your own agent that works with companies for you, and asks before it acts.
        </p>
        {message ? (
          <p role="alert" className="mt-4 rounded-xl bg-kumo-danger-tint px-4 py-3 text-base text-pretty text-kumo-danger">
            {message}
          </p>
        ) : null}
        <div className="mt-6 flex flex-col gap-2">
          {providers.includes("google") ? (
            <ActionLink href="/auth/google" variant="secondary" className="w-full justify-center" icon={<GoogleLogoIcon size={20} aria-hidden />}>
              Sign in with Google
            </ActionLink>
          ) : null}
          {providers.includes("github") ? (
            <ActionLink href="/auth/github" variant="secondary" className="w-full justify-center" icon={<GithubLogoIcon size={20} aria-hidden />}>
              Sign in with GitHub
            </ActionLink>
          ) : null}
        </div>
      </div>
    </main>
  );
}

function SignedIn({ email, provider }: { email: string | null; provider: "google" | "github" }) {
  const session = usePiSession();
  return <Workspace identity={{ email, provider }} session={session} />;
}

function App() {
  const me = useMe();
  if (me.state === "loading") {
    return <div className="h-dvh bg-kumo-canvas" />;
  }
  if (me.state === "signed-out") return <SignedOut message={me.message} providers={me.providers} />;
  return <SignedIn email={me.email} provider={me.provider} />;
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(<App />);
