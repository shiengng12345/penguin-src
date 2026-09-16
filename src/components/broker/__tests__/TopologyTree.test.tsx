import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TopologyTree } from "../TopologyTree";

const tenants = [{ name: "public" }, { name: "pulsar" }];
const namespaces = [
  { tenant: "public", name: "default", full: "public/default" },
  { tenant: "public", name: "functions", full: "public/functions" },
];

function setup(overrides = {}) {
  const props = {
    tenants,
    namespaces,
    selectedTenant: "public",
    selectedNamespace: null as string | null,
    onSelectTenant: vi.fn(),
    onSelectNamespace: vi.fn(),
    state: "ready" as const,
    ...overrides,
  };
  render(<TopologyTree {...props} />);
  return props;
}

describe("TopologyTree", () => {
  it("renders tenants and the selected tenant's namespaces", () => {
    setup();
    expect(screen.getByText("public")).toBeInTheDocument();
    expect(screen.getByText("pulsar")).toBeInTheDocument();
    expect(screen.getByText("default")).toBeInTheDocument();
  });

  it("marks the selected tenant with aria-selected, not colour alone", () => {
    setup();
    const selected = screen.getByRole("treeitem", { name: /public/ });
    expect(selected).toHaveAttribute("aria-selected", "true");
  });

  it("reports a tenant selection rather than navigating itself", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByRole("treeitem", { name: /pulsar/ }));
    expect(props.onSelectTenant).toHaveBeenCalledWith("pulsar");
  });

  it("is keyboard reachable", async () => {
    // An operator mid-incident should not need the mouse.
    const user = userEvent.setup();
    const props = setup();
    await user.tab();
    await user.keyboard("{Enter}");
    expect(props.onSelectTenant).toHaveBeenCalled();
  });

  it("shows a loading state instead of an empty tree", () => {
    setup({ state: "loading", tenants: [], namespaces: [] });
    expect(screen.getByRole("status")).toHaveTextContent(/loading/i);
  });

  it("distinguishes an empty tenant list from a failure", () => {
    setup({ state: "empty", tenants: [], namespaces: [] });
    expect(screen.getByRole("status")).toHaveTextContent(/no tenants/i);
  });

  it("renders stale data with a notice rather than hiding it", () => {
    setup({ state: "stale" });
    expect(screen.getByText("public")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/stale|cached/i);
  });
});
