import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DeliveryNotice } from "../DeliveryNotice";

describe("DeliveryNotice", () => {
  it("says delivery, not completion", () => {
    render(<DeliveryNotice variant="block" />);
    const text = screen.getByRole("note").textContent ?? "";
    expect(text).toMatch(/deliver/i);
    // The words that would make this notice a lie.
    expect(text).not.toMatch(/\b(completed|succeeded|processed successfully)\b/i);
  });

  it("names what is actually unknown, not just who received the message", () => {
    // A vague disclaimer teaches nothing. This one has to say that what the
    // consumer did with the message is not visible here.
    //
    // This assertion deliberately does NOT match on "consumer": that word
    // already appears in the first clause ("delivered to a consumer"), so a
    // test looking for it would still pass if the entire caveat sentence
    // were deleted — which is the one edit this test exists to catch. It
    // matches the epistemic claim instead.
    render(<DeliveryNotice variant="block" />);
    const text = screen.getByRole("note").textContent ?? "";
    expect(text).toMatch(/\bnot visible\b|\bnot known\b|\bunknown\b/i);
    expect(text).toMatch(/\bprocess(ed|es|ing)?\b/i);
  });

  it("shows the same sentence in both variants, so neither can drift", () => {
    // The whole reason this is one component is that the wording cannot fork.
    // Both branches read one constant today; this holds that in place.
    const { unmount } = render(<DeliveryNotice variant="block" />);
    const block = screen.getByRole("note").textContent ?? "";
    unmount();
    render(<DeliveryNotice variant="inline" />);
    const inline = screen.getByRole("note").textContent ?? "";
    expect(inline).toBe(block);
    expect(inline).toMatch(/\bnot visible\b|\bnot known\b|\bunknown\b/i);
  });

  it("renders inline without a heading so it can sit beside a number", () => {
    render(<DeliveryNotice variant="inline" />);
    expect(screen.getByRole("note")).toBeInTheDocument();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });
});
