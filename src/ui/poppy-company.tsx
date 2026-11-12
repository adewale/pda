/** The card that asks to contact a Company the User hasn't selected (decision 50). */
import { createContext, useContext } from "react";
import { type Card } from "../poppy/wire";
import { type Send, useSend } from "./connection";
import { CardFrame } from "./poppy-card-frame";
import { Action } from "./controls";
import { AttachmentThumb } from "./attachments";
import { humanSize } from "../attachments";
import { StorefrontIcon } from "@phosphor-icons/react";

/**
 * Allows a Company from the composer: a message of the User's that selects
 * `domain`, and these photos for upload to it, as if they had typed it there.
 * Absent where there is no composer, such as a page without the chat.
 */
export const AllowCompanyContext = createContext<((domain: string, photos: readonly string[]) => boolean) | null>(null);

export function CompanyAccessCard({ card, send: sendFrame }: { card: Extract<Card, { kind: "company_access" }>; send: Send }) {
  const allow = useContext(AllowCompanyContext);
  const { send, disabled, note } = useSend(sendFrame);
  const photos = card.photos;
  // The name is the Company's own choice; the domain is what the User decides on.
  const named = card.company !== card.domain;
  return (
    <CardFrame
      domain={card.domain}
      icon={<StorefrontIcon size={16} />}
      title={`Let your agent contact ${card.domain}?`}
      note={note}
      actions={
        <>
          <Action type="button" variant="secondary" disabled={disabled} onClick={() => send({ type: "poppy.card.dismiss", id: card.id })}>
            Not now
          </Action>
          <Action type="button" variant="primary" disabled={disabled || !allow} onClick={() => allow?.(card.domain, photos.map((photo) => photo.id))}>
            {photos.length ? `Allow, with ${photos.length === 1 ? "this photo" : `these ${photos.length} photos`}` : "Allow"}
          </Action>
        </>
      }
    >
      <p className="text-base text-pretty">
        Your agent wants to work with <bdi dir="ltr" className="font-medium">{card.domain}</bdi> for your request
        {named ? <>, which calls itself <bdi className="font-medium">{card.company}</bdi></> : null}. Check it's the company you meant.
      </p>
      <p className="mt-1 text-[13px] text-pretty text-kumo-subtle">
        Allowing it adds it to Companies your agent can contact, as typing it in the box below would
        {photos.length ? ", and lets your agent send it the photos shown for this request" : ""}. Anything it charges still needs your approval.
      </p>
      {photos.length ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {photos.map((photo) => (
            <AttachmentThumb key={photo.id} id={photo.id} name={photo.name} detail={humanSize(photo.size)} size="card" />
          ))}
        </div>
      ) : null}
      {!allow ? <p className="mt-1 text-[13px] text-kumo-subtle">Add {card.domain} to Companies in the chat to allow it.</p> : null}
    </CardFrame>
  );
}
