import { array, integer, json, literal, object, optional, record, string, tagged, type Decoder } from "./decode";
import type { ServerMessage } from "./protocol";

/**
 * The page's decoder for the chat frames its agent sends (`src/protocol.ts`,
 * an unchanged copy of Cloudflare's example, so it can't decode them
 * itself). It checks each frame's shape and that pi's values are JSON; the
 * frame passes on as the agent sent it, since pi's view and operations are
 * applied as they are.
 */

/** `decoder`'s check, and then the value itself, unchanged. */
function checked<T>(decoder: Decoder<unknown>): Decoder<T> {
  return (value, at) => {
    decoder(value, at);
    return value as T;
  };
}

/** A transcript entry: an object with a whole-number id, its other members pi's own. */
const entry = checked(object({ id: integer }));

const view = checked(object({ entries: array(entry), before: optional(integer), docs: record(json) }));

export const piServerFrame: Decoder<ServerMessage> = tagged("type", {
  hello: checked(object({ type: literal("hello"), session: string, tools: array(object({ name: string, description: string })) })),
  view: checked(object({ type: literal("view"), session: string, view })),
  ops: checked(object({ type: literal("ops"), session: string, ops: array(json) })),
  // A page of entries (`entries`), or a command's own result.
  result: checked(object({ type: literal("result"), id: string, result: json })),
  error: checked(object({ type: literal("error"), id: optional(string), message: string }))
}) as Decoder<ServerMessage>;
