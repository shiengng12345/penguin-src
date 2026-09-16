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

  // Fix round 1, item 4: every prior "stale" test only checked the generic
  // banner text, which STATUS_TEXT alone satisfies — deleting the
  // interpolation that appends the actual warning wouldn't fail any of
  // them. This one asserts the specific warning content itself lands on
  // the screen.
  it("renders the specific warning text, not just the generic stale banner", () => {
    setup({
      state: "stale",
      warnings: ["Cached tenant list is 400000 ms old, past its freshness window; showing the last known list."],
    });
    expect(screen.getByRole("status")).toHaveTextContent(/400000 ms old/);
  });

  // Fix round 1, item 1 (rendering side): a single fetch can carry more
  // than one warning at once, and none of them may be dropped between the
  // hook and the screen.
  it("renders every warning, not just the first, when more than one applies at once", () => {
    setup({
      state: "stale",
      warnings: [
        "Cached tenant list is 400000 ms old, past its freshness window; showing the last known list.",
        'namespace "weird" did not contain the expected "tenant/namespace" separator; treating it as a bare name with no tenant',
      ],
    });
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/400000 ms old/);
    expect(status).toHaveTextContent(/did not contain the expected/);
  });

  // Fix round 1, item 3: the tree shows two independently-sourced lists
  // (tenants, namespaces); a stale *namespace* list must not be described
  // by wording that names "tenants" specifically.
  it("describes the stale banner without misnaming which list is stale", () => {
    setup({
      state: "stale",
      warnings: ["Cached namespace list is 90000 ms old, past its freshness window; showing the last known list."],
    });
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/90000 ms old/);
    // The fixed prefix must not claim it's specifically the tenant list
    // that's stale when a namespace warning is what's actually showing.
    expect(status.textContent).not.toMatch(/cached tenants/i);
  });

  it("marks the tree partial without hiding the data that did succeed", () => {
    setup({ state: "partial", warnings: ["namespace list unavailable"] });
    expect(screen.getByText("public")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/partial/i);
    expect(screen.getByRole("status")).toHaveTextContent(/namespace list unavailable/);
  });
});
