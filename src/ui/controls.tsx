import { Button, cn, LinkButton, Tooltip } from "@cloudflare/kumo";
import { useEffect, useState, type ButtonHTMLAttributes, type ComponentProps, type ReactNode, type Ref } from "react";

/**
 * Small pieces every page uses, so the house rules live in one place:
 * 40px hit areas (44px on touch screens), a press that scales to 0.97 and
 * back in 150ms (no movement with reduced motion), and a tooltip on every
 * icon-only button.
 */

const PRESS =
  "transition-[transform,background-color,color,box-shadow,opacity] duration-150 ease-(--ease-out) active:scale-[0.97] motion-reduce:active:scale-100";

type KumoButtonProps = ComponentProps<typeof Button>;

export type ActionProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  readonly variant?: KumoButtonProps["variant"];
  readonly shape?: "base" | "square" | "circle";
  readonly icon?: ReactNode;
  readonly loading?: boolean;
  readonly children?: ReactNode;
  readonly ref?: Ref<HTMLButtonElement>;
};

/** A Kumo button with the page's sizing and press feedback. */
export function Action({ className, shape, ...props }: ActionProps) {
  const merged = {
    ...props,
    shape,
    className: cn(shape === "square" || shape === "circle" ? "size-10 max-sm:size-11" : "h-10 max-sm:h-11", PRESS, className)
  } as KumoButtonProps;
  return <Button {...merged} />;
}

/** A link that looks like a button: for leaving the page, such as a Company's sign-in page. */
export function ActionLink({ className, ...props }: ComponentProps<typeof LinkButton>) {
  return <LinkButton {...props} className={cn("h-10 max-sm:h-11", PRESS, className)} />;
}

/** An icon-only button: named for screen readers, with the same name in a tooltip. */
export function IconAction({ label, icon, className, ...props }: Omit<ActionProps, "icon" | "aria-label" | "shape" | "children"> & { label: string; icon: ReactNode }) {
  return (
    <Tooltip
      content={label}
      render={<Action {...props} shape="square" aria-label={label} icon={icon} className={className} />}
    />
  );
}

/** A page's title and what it is for. */
export function PageHeader({ title, description, children }: { title: string; description?: ReactNode; children?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0 max-w-[70ch]">
        <h1 tabIndex={-1} className="text-xl font-semibold text-balance text-kumo-strong">
          {title}
        </h1>
        {description ? <p className="mt-1 text-base text-pretty text-kumo-subtle">{description}</p> : null}
      </div>
      {children}
    </header>
  );
}

/** A titled part of a page. */
export function Section({ title, description, action, children, className }: { title: string; description?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  const id = `section-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <section aria-labelledby={id} className={cn("space-y-3", className)}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 id={id} className="text-base font-semibold text-balance text-kumo-strong">
            {title}
          </h2>
          {description ? <p className="mt-0.5 max-w-[70ch] text-[13px] text-pretty text-kumo-subtle">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Placeholder rows while a list loads: still, not shimmering. */
export function SkeletonRows({ rows = 3, label }: { rows?: number; label: string }) {
  return (
    <div role="status" aria-label={label} className="space-y-2">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="h-12 rounded-xl bg-kumo-recessed" />
      ))}
    </div>
  );
}

/** A typed empty state: what will appear here, and how it gets there. */
export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-xl px-4 py-5 ring ring-kumo-hairline">
      <span aria-hidden className="mt-0.5 text-kumo-subtle">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-base font-medium text-kumo-default">{title}</p>
        <p className="mt-0.5 max-w-[60ch] text-[13px] text-pretty text-kumo-subtle">{children}</p>
      </div>
    </div>
  );
}

/** The time now, refreshed every `everyMs` while `active`, for countdowns. */
export function useNow(everyMs = 1000, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs, active]);
  return now;
}

/** Text that may be cut short, with all of it on hover and for screen readers. */
export function Truncated({ text, className }: { text: string; className?: string }) {
  return (
    <span title={text} className={cn("block min-w-0 truncate", className)}>
      {text}
    </span>
  );
}
