import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DataTable, type DataTableColumn } from "../data-table";

interface Row { id: string; name: string; partitions: number }

const columns: DataTableColumn<Row>[] = [
  { key: "name", header: "Name", render: (r) => r.name, sortable: true },
  { key: "partitions", header: "Partitions", render: (r) => String(r.partitions) },
];

const rows: Row[] = [
  { id: "a", name: "orders", partitions: 0 },
  { id: "b", name: "events", partitions: 3 },
];

function setup(overrides = {}) {
  const props = {
    columns, rows, total: 2, offset: 0, limit: 25,
    rowKey: (r: Row) => r.id,
    state: "ready" as const,
    onPageChange: vi.fn(),
    ...overrides,
  };
  render(<DataTable {...props} />);
  return props;
}

describe("DataTable states", () => {
  it("shows a loading state instead of an empty table", () => {
    setup({ state: "loading", rows: [], total: 0 });
    expect(screen.getByRole("status")).toHaveTextContent(/loading/i);
  });

  it("distinguishes empty from error", () => {
    setup({ state: "empty", rows: [], total: 0 });
    expect(screen.getByRole("status")).toHaveTextContent(/no .*(rows|results)/i);
  });

  it("shows the error message when state is error", () => {
    setup({ state: "error", rows: [], total: 0, errorMessage: "Namespace does not exist" });
    expect(screen.getByRole("alert")).toHaveTextContent("Namespace does not exist");
  });

  it("marks stale data without hiding it", () => {
    setup({ state: "stale" });
    expect(screen.getByText("orders")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/stale|cached/i);
  });

  it("marks partial data without hiding it", () => {
    setup({ state: "partial" });
    expect(screen.getByText("orders")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/partial/i);
  });
});

describe("DataTable behaviour", () => {
  it("renders one row per item", () => {
    setup();
    expect(screen.getByText("orders")).toBeInTheDocument();
    expect(screen.getByText("events")).toBeInTheDocument();
  });

  it("expands a row to reveal its detail", async () => {
    const user = userEvent.setup();
    render(
      <DataTable
        columns={columns} rows={rows} total={2} offset={0} limit={25}
        rowKey={(r) => r.id} state="ready" onPageChange={vi.fn()}
        expandedContent={(r) => <div>{r.partitions} partitions for {r.name}</div>}
      />,
    );
    expect(screen.queryByText("3 partitions for events")).not.toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: /expand/i })[1]);
    expect(screen.getByText("3 partitions for events")).toBeInTheDocument();
  });

  it("reports page changes rather than paging itself", async () => {
    const user = userEvent.setup();
    const props = setup({ total: 100, offset: 0, limit: 25 });
    await user.click(screen.getByRole("button", { name: /next page/i }));
    expect(props.onPageChange).toHaveBeenCalledWith(25);
  });

  it("disables previous on the first page", () => {
    setup({ total: 100, offset: 0, limit: 25 });
    expect(screen.getByRole("button", { name: /previous page/i })).toBeDisabled();
  });

  it("reports sort changes", async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();
    setup({ onSortChange });
    await user.click(screen.getByRole("button", { name: /sort by name/i }));
    expect(onSortChange).toHaveBeenCalledWith("name", "asc");
  });

  it("does not convey state by colour alone", () => {
    // Accessibility: every state must carry text, not just a coloured dot.
    setup({ state: "stale" });
    expect(screen.getByRole("status").textContent?.trim()).not.toBe("");
  });

  it("a real non-zero measurement is used as-is, not replaced by the test fallback", () => {
    // jsdom reports 0 for every element's offsetWidth/offsetHeight — the
    // exact degenerate case data-table.tsx's `observeElementRectWithFallback`
    // exists to paper over. This test proves the *passthrough* branch (the
    // one every real browser actually takes) is what runs when the
    // measurement genuinely isn't 0 — not the fallback's fixed ~800x420 rect
    // — by stubbing a real, small size onto the scroll container (the only
    // element in this tree with `overflow-y: auto` inline) and asserting on
    // the one thing that can only follow from *that* size: how far down the
    // (virtualised) row list actually renders.
    //
    // Every other element is stubbed to a constant, non-zero height too.
    // Without that, `virtualizer.measureElement`'s per-row auto-remeasure
    // (real production behaviour, used for variable-height expansion panels)
    // reads each row's own jsdom-default 0 height and progressively
    // "corrects" cached row sizes toward 0, which snowballs into rendering
    // far more rows than either the real or the fallback viewport implies.
    // Holding row height constant removes that confound so this test isolates
    // exactly the thing under test: which viewport rect the scroll container
    // measurement produced.
    const heightSpy = vi
      .spyOn(HTMLElement.prototype, "offsetHeight", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.style.overflowY === "auto" ? 88 : 44;
      });
    const widthSpy = vi
      .spyOn(HTMLElement.prototype, "offsetWidth", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.style.overflowY === "auto" ? 400 : 200;
      });

    const manyRows: Row[] = Array.from({ length: 30 }, (_, i) => ({
      id: `row-${i}`,
      name: `name-${i}`,
      partitions: i,
    }));

    render(
      <DataTable
        columns={columns}
        rows={manyRows}
        total={manyRows.length}
        offset={0}
        limit={manyRows.length}
        rowKey={(r) => r.id}
        state="ready"
        onPageChange={vi.fn()}
      />,
    );

    heightSpy.mockRestore();
    widthSpy.mockRestore();

    // An 88px real viewport (~2 rows) plus overscan(8) reaches row 9 but not
    // row 10 or 17. If the fallback's fixed ~420px viewport (~10 rows, same
    // overscan) were used instead of this stub, row 17 would also render —
    // so finding row 9 but neither row 10 nor row 17 proves this render used
    // the real, stubbed measurement rather than the substitute. (Verified by
    // temporarily forcing the fallback branch unconditionally: this
    // assertion fails as expected, catching exactly that regression.)
    expect(screen.getByText("name-9")).toBeInTheDocument();
    expect(screen.queryByText("name-10")).not.toBeInTheDocument();
    expect(screen.queryByText("name-17")).not.toBeInTheDocument();
  });
});
