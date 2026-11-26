/**
 * Long values and departures in the app, laid out as the validator's results
 * page lays them out (src/validator/html.ts, decision 55), from the same
 * splitter (src/rich-text.ts): a URL as a value, in code, its host in bold,
 * breaking between segments, a long segment shortened with the whole in the
 * tooltip; and a departure as its subject, then Expected and Got, then what
 * follows.
 */
import { Fragment, type ReactNode } from "react";
import { pieces, shortSegment, urlParts } from "../rich-text";
import type { NoticeProblem } from "../poppy/diagnostic-notice";

/** Break opportunities after each slash, question mark, ampersand and equals sign. */
function breakable(text: string): ReactNode[] {
  // Split after each mark by hand: a lookbehind regex isn't in every browser the page supports.
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if ("/?&=".includes(text[i]!)) {
      parts.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) parts.push(text.slice(start));
  return parts.map((part, index) => (
    <Fragment key={index}>
      {index > 0 ? <wbr /> : null}
      {part}
    </Fragment>
  ));
}

/** A URL as a value. A URL that isn't one of ours to split is still breakable. */
export function UrlValue({ url, className }: { url: string; className?: string }) {
  const parts = urlParts(url);
  const style = `font-mono [overflow-wrap:anywhere] ${className ?? ""}`.trim();
  if (!parts) return <code className={style}>{breakable(url)}</code>;
  const shortened = parts.segments.some((segment) => shortSegment(segment) !== segment);
  return (
    <code className={style} title={shortened ? url : undefined} data-url={url}>
      {parts.scheme}
      <b className="font-semibold">{parts.host}</b>
      {parts.segments.map((segment, index) => (
        <Fragment key={index}>
          /<wbr />
          {shortSegment(segment)}
        </Fragment>
      ))}
      {parts.suffix ? (
        <>
          <wbr />
          {breakable(parts.suffix)}
        </>
      ) : null}
    </code>
  );
}

/** Text with each URL in it set as a value. */
export function RichText({ text }: { text: string }) {
  return (
    <>
      {pieces(text).map((piece, index) => (piece.kind === "url" ? <UrlValue key={index} url={piece.url} /> : <Fragment key={index}>{piece.text}</Fragment>))}
    </>
  );
}

/** A departure: its subject, then what was expected and what was got, apart, then what follows. */
export function ProblemView({ problem }: { problem: NoticeProblem }) {
  return (
    <div className="mt-1 [overflow-wrap:anywhere]" data-problem>
      <p className="font-medium text-kumo-default">
        <RichText text={problem.subject} />
      </p>
      <dl className="mt-0.5 grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-3 gap-y-0.5">
        <dt className="font-medium text-kumo-subtle">Expected</dt>
        <dd className="min-w-0">
          <RichText text={problem.expected} />
        </dd>
        <dt className="font-medium text-kumo-subtle">Got</dt>
        <dd className="min-w-0">
          <RichText text={problem.got} />
        </dd>
      </dl>
      {problem.detail ? (
        <p className="mt-0.5">
          <RichText text={problem.detail} />
        </p>
      ) : null}
    </div>
  );
}
