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

  it("names what is actually unknown", () => {
    // A vague disclaimer teaches nothing. This one has to say that what the
    // consumer did with the message is not visible here.
    render(<DeliveryNotice variant="block" />);
    expect(screen.getByRole("note").textContent ?? "").toMatch(/consumer|business/i);
  });

  it("renders inline without a heading so it can sit beside a number", () => {
    render(<DeliveryNotice variant="inline" />);
    expect(screen.getByRole("note")).toBeInTheDocument();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });
});
