/**
 * A notice card about an error. For a departure, `text` is the lead ("That
 * didn't work.") and `problem` its parts, which the page lays out as the
 * validator's results page does, the subject, then expected and got, then
 * what follows; for a fact, `text` is the whole sentence.
 */
import { partsOf, ProblemError, render, sentence, show, shown, type ProblemParts, type Shown } from "../diagnostic";

/** A notice card's `problem`: a departure's parts as strings. */
export type NoticeProblem = { readonly subject: string; readonly expected: string; readonly got: string; readonly detail?: string };

/** The `text` and, for a departure, `problem` of a notice that `lead` opens. */
export function noticeOf(lead: Shown, error: unknown): { readonly text: string; readonly problem?: NoticeProblem } {
  if (error instanceof ProblemError) {
    const parts: ProblemParts | undefined = partsOf(error.problem);
    return parts ? { text: sentence(lead), problem: parts } : { text: sentence(shown`${lead}: ${render(error.problem)}`) };
  }
  // Not ours: its words are someone else's, quoted.
  return { text: sentence(shown`${lead}: ${show.text(error instanceof Error ? error.message : String(error), 500)}`) };
}
