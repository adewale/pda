import { cn } from "@cloudflare/kumo";
import { CheckCircleIcon, CircleIcon, ClockIcon, HourglassIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { ActivityResult } from "../poppy/wire";
import { RESULT } from "./format";

/**
 * One set of words and marks for how something stands, wherever the page
 * shows it: a step in the chat, a request's tile, a line in Activity. The
 * words are Activity's (`RESULT`); a step running is "In progress" there too.
 */
export const STATUS_STYLE: Record<ActivityResult, { className: string; icon: ReactNode }> = {
  waiting: { className: "text-kumo-warning", icon: <HourglassIcon size={16} aria-hidden /> },
  in_progress: { className: "text-kumo-default", icon: <ClockIcon size={16} aria-hidden /> },
  done: { className: "text-kumo-success", icon: <CheckCircleIcon size={16} aria-hidden /> },
  declined: { className: "text-kumo-subtle", icon: <CircleIcon size={16} aria-hidden /> },
  cancelled: { className: "text-kumo-subtle", icon: <CircleIcon size={16} aria-hidden /> },
  expired: { className: "text-kumo-subtle", icon: <CircleIcon size={16} aria-hidden /> },
  failed: { className: "text-kumo-danger", icon: <WarningCircleIcon size={16} aria-hidden /> },
  unknown: { className: "text-kumo-danger", icon: <WarningCircleIcon size={16} aria-hidden /> }
};

/** The mark and the word, coloured by what they say. */
export function Status({ result, detail, className }: { result: ActivityResult; detail?: string | null; className?: string }) {
  const style = STATUS_STYLE[result];
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap", style.className, className)}>
      {style.icon}
      {RESULT[result]}
      {detail ? <span className="tabular-nums"> · {detail}</span> : null}
    </span>
  );
}
