import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConnectionTable } from "../ConnectionTable";
import type { BrokerConnection } from "@penguin/broker-contracts";

const base: BrokerConnection = {
  id: "c1", kind: "pulsar", name: "Local", color: "green",
  adminUrl: "http://localhost:8080", brokerUrl: "pulsar://localhost:6650",
  authType: "none", secretHandleId: null,
  defaultTenant: "public", defaultNamespace: "default",
  readOnly: true, tlsVerify: true, timeoutMs: 10000,
  lastStatus: "ok", lastCheckedAt: 1, brokerVersion: "4.2.4",
  capabilities: null, createdAt: 1, updatedAt: 1,
};

const handlers = { onTest: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(), onSetActive: vi.fn() };

describe("ConnectionTable", () => {
  it("shows the measured broker version, not a configured one", () => {
    render(<ConnectionTable connections={[base]} activeId={null} state="ready" {...handlers} />);
    expect(screen.getByText("4.2.4")).toBeInTheDocument();
  });

  it("renders status as text, not colour alone", () => {
    render(<ConnectionTable connections={[base]} activeId={null} state="ready" {...handlers} />);
    expect(screen.getByText(/\bok\b/i)).toBeInTheDocument();
  });

  it("shows unknown before a connection has been tested", () => {
    const untested = { ...base, lastStatus: "unknown" as const, brokerVersion: null };
    render(<ConnectionTable connections={[untested]} activeId={null} state="ready" {...handlers} />);
    expect(screen.getByText(/unknown/i)).toBeInTheDocument();
    // Never render a version we have not measured.
    expect(screen.queryByText("4.2.4")).not.toBeInTheDocument();
  });

  it("marks the active connection", () => {
    render(<ConnectionTable connections={[base]} activeId="c1" state="ready" {...handlers} />);
    expect(screen.getByRole("row", { name: /local/i })).toHaveAttribute("aria-current", "true");
  });

  it("shows a read-only badge so a writable connection is visibly different", () => {
    render(<ConnectionTable connections={[base]} activeId={null} state="ready" {...handlers} />);
    expect(screen.getByText(/read.?only/i)).toBeInTheDocument();
  });

  it("shows the empty state when there are no connections", () => {
    render(<ConnectionTable connections={[]} activeId={null} state="empty" {...handlers} />);
    expect(screen.getByRole("status")).toHaveTextContent(/no/i);
  });
});
