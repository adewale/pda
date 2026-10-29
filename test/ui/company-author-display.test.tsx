import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { DirectConversations } from "../../src/poppy-ui";
import type { DirectUpdate } from "../../src/poppy/wire";
import type { PoppyView } from "../../src/use-pi-session";

function view(messages: NonNullable<DirectUpdate["messages"]>): PoppyView {
  return { cards: [], accounts: [], signOuts: [], activity: null, protocol: { companies: null, logs: {} }, direct: {
    cnv_1: { conversationId: "cnv_1", company: "Shop", status: "idle", responder: "human", messages }
  } };
}

it("shows a Company author's name with the Company attribution in a Direct Conversation", () => {
  render(<DirectConversations view={view([{ id: "m1", role: "company", sender: "human", authorName: "Jamie Rivera", text: "I can help with your order." }])} send={vi.fn(() => true)} />);
  expect(screen.getByText("Jamie Rivera, a person at Shop")).toBeTruthy();
  expect(screen.getByText("I can help with your order.")).toBeTruthy();
});

it("renders a Company's author name as text rather than an image, link or HTML", () => {
  const name = '<img src="https://external.example/avatar.png" onerror="alert(1)">';
  const send = vi.fn(() => true);
  const { container } = render(<DirectConversations view={view([{ id: "m1", role: "company", sender: "agent", authorName: name, text: "An update" }])} send={send} />);
  expect(container.textContent).toContain(`${name}, Shop's agent`);
  expect(container.querySelector("img, a")).toBeNull();
  expect(send).not.toHaveBeenCalled();
});
