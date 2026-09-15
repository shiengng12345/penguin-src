import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("test harness", () => {
  it("renders a component and finds it by role", () => {
    render(<button type="button">Ping</button>);
    expect(screen.getByRole("button", { name: "Ping" })).toBeInTheDocument();
  });
});
