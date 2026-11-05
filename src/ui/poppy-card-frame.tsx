/** Shared presentation primitives for Company requests. */
import { type ReactNode, createContext, useId, useContext } from "react";
import { cn } from "@cloudflare/kumo";

/** A Company-supplied link, only if it is an HTTPS URL: never `javascript:`, `data:` or `http:`. */
export function httpsHref(value: string | undefined): string | null {
  if (!value || !URL.canParse(value)) return null;
  const url = new URL(value);
  return url.protocol === "https:" ? url.href : null;
}

/** Words a Company wrote, quoted as theirs. */
export function CompanySays({ company, children, className }: { company: string; children: ReactNode; className?: string }) {
  return (
    <figure className={className}>
      <figcaption className="text-[13px] text-kumo-subtle">{company} says:</figcaption>
      <blockquote className="mt-0.5 text-base text-pretty text-kumo-default">{children}</blockquote>
    </figure>
  );
}

export const RequestPanelContext = createContext(false);

/** One request waiting for the User. Primary action last, at the right. */
export function CardFrame({
  domain,
  icon,
  title,
  meta,
  children,
  actions,
  note
}: {
  /** The Company's verified domain, under its self-chosen name (N14). */
  domain: string | undefined;
  icon: ReactNode;
  title: string;
  meta?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  /** Why the actions can't be used yet, or didn't go (`useSend`). */
  note?: ReactNode;
}) {
  const id = useId();
  const inPanel = useContext(RequestPanelContext);
  return (
    <article aria-labelledby={id} className={cn("p-4", inPanel ? undefined : "enter rounded-xl bg-kumo-base ring ring-kumo-hairline")}>
      <div className="flex items-start gap-3">
        <span aria-hidden className="mt-0.5 shrink-0 text-kumo-warning">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <h3 id={id} className="text-base font-semibold text-balance text-kumo-strong">
            {title}
          </h3>
          {domain ? (
            <p className="mt-0.5 text-[13px] text-kumo-subtle">
              <code className="font-mono break-all" title="The Company's verified domain">
                {domain}
              </code>
            </p>
          ) : null}
          {meta ? <div className="mt-0.5 text-[13px] text-kumo-subtle">{meta}</div> : null}
          <div className="mt-3 space-y-3">{children}</div>
        </div>
      </div>
      {/* Sticky, so a tall card (a photo on a phone) never scrolls its buttons out of the tray; the shadow says there's more above. */}
      {actions ? (
        <div
          data-card-actions
          className={cn("sticky bottom-0 -mx-4 -mb-4 mt-4 flex flex-wrap justify-end gap-2 bg-kumo-base px-4 py-3 shadow-[0_-8px_12px_-8px_rgb(0_0_0/0.15)]", inPanel ? undefined : "rounded-b-xl")}
        >
          {note ? <div className="basis-full text-right">{note}</div> : null}
          {actions}
        </div>
      ) : null}
    </article>
  );
}
