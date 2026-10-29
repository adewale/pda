import { one } from "../rows";
import { cardsTable, type Sql } from "./store";
import type { Card } from "./wire";

export type CardWriteOptions = { readonly repair?: boolean };

/** Recovery repairs content; it does not undo dismissal or make history recent again. */
export function writeCard(sql: Sql, card: Card, now: number, options: CardWriteOptions = {}): boolean {
  const previous = one(sql, cardsTable.pick("card", "updated_at"), "SELECT card, updated_at FROM poppy_cards WHERE id = ?", card.id);
  const content = JSON.stringify(card);
  if (options.repair && previous?.card === content) return false;
  sql.exec("INSERT OR REPLACE INTO poppy_cards (id, card, open, updated_at) VALUES (?, ?, ?, ?)",
    card.id, content, card.open ? 1 : 0, options.repair && previous ? previous.updated_at : now);
  return true;
}
