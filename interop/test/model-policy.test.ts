import { describe, expect, it } from "vitest";
import { feedbackHasPersonalData, messageHasCredential, requestsVerification } from "../../src/poppy/model-policy";

describe("bounded model message and feedback safeguards", () => {
  it.each([
    ["The verification code is 482913", undefined],
    ["482913", undefined],
    [undefined, { verification_code: "482913" }],
    [undefined, { nested: { password: "hunter2" } }]
  ] as const)("recognizes a credential in text or a named structured field: %s", (text, data) => {
    expect(messageHasCredential(text, data)).toBe(true);
  });

  it("keeps ordinary task details usable", () => {
    expect(messageHasCredential("Please deliver my order to this address.", { order_id: "ord_7Hk2", postal_code: "SW1A 1AA", address: "10 Example Street" })).toBe(false);
    expect(messageHasCredential("My order number is 482913", undefined)).toBe(false);
    expect(messageHasCredential("I need help resetting my password", undefined)).toBe(false);
  });

  it("only treats an explicit latest Company verification request as a verification request", () => {
    const request = { role: "company", text: "To verify your identity, provide your email and verification code." };
    expect(requestsVerification([request])).toBe(true);
    expect(requestsVerification([{ ...request, role: "user" }])).toBe(false);
    expect(requestsVerification([request, { role: "company", text: "Where should we deliver the parcel?" }])).toBe(false);
    expect(requestsVerification([{ role: "company", text: "Please provide your delivery address." }])).toBe(false);
  });

  it.each([
    "Contact alice@example.com about the task",
    "Call +44 7700 900123 about the task",
    "My phone number: 07700 900123",
    "Cannot change order ord_7Hk2",
    "Cannot change order number: 482913",
    "My name is Alice Example",
    "The verification code is 482913"
  ])("refuses a recognizable feedback identifier without exposing it: %s", description => {
    expect(feedbackHasPersonalData("Complete the task", description)).toBe(true);
  });

  it("accepts a general feedback report without pretending to classify every personal statement", () => {
    expect(feedbackHasPersonalData("Pay with a gift card", "The checkout has no field for a gift card.")).toBe(false);
    // A name without a label has no reliable format. Keep this limit explicit.
    expect(feedbackHasPersonalData("Complete the task", "Alice could not finish.")).toBe(false);
  });
});
