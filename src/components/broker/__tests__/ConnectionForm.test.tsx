import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConnectionForm } from "../ConnectionForm";

describe("ConnectionForm", () => {
  it("defaults a new connection to read-only", () => {
    // The spec's most important default: local Pulsar accepts every write,
    // so a connection must not be writable unless the user opts in.
    render(<ConnectionForm onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole("switch", { name: /read.?only/i })).toBeChecked();
  });

  it("requires both an admin URL and a broker URL", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<ConnectionForm onSave={onSave} onCancel={vi.fn()} />);

    await user.type(screen.getByLabelText(/name/i), "Local");
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(onSave).not.toHaveBeenCalled();
    // The binary URL is not optional: timeline and replay depend on it.
    expect(screen.getByText(/broker url is required/i)).toBeInTheDocument();
  });

  it("rejects a broker URL that is not a pulsar:// address", async () => {
    const user = userEvent.setup();
    render(<ConnectionForm onSave={vi.fn()} onCancel={vi.fn()} />);
    await user.type(screen.getByLabelText(/broker url/i), "http://localhost:6650");
    await user.click(screen.getByRole("button", { name: /save/i }));
    expect(screen.getByText(/must start with pulsar/i)).toBeInTheDocument();
  });

  it("shows a token field only when auth type needs one", async () => {
    const user = userEvent.setup();
    render(<ConnectionForm onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByLabelText(/token/i)).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(/auth/i), "jwt");
    expect(screen.getByLabelText(/token/i)).toBeInTheDocument();
  });

  it("passes the token to onSave once and never echoes it back", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<ConnectionForm onSave={onSave} onCancel={vi.fn()} />);

    await user.type(screen.getByLabelText(/name/i), "Secure");
    await user.type(screen.getByLabelText(/admin url/i), "http://localhost:8081");
    await user.type(screen.getByLabelText(/broker url/i), "pulsar://localhost:6651");
    await user.selectOptions(screen.getByLabelText(/auth/i), "jwt");
    await user.type(screen.getByLabelText(/token/i), "super-secret");
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(onSave).toHaveBeenCalledOnce();
    const [draft] = onSave.mock.calls[0];
    expect(draft.secret).toBe("super-secret");
    // The token must never be persisted into the rendered draft that round-trips.
    expect(JSON.stringify({ ...draft, secret: undefined })).not.toContain("super-secret");
  });

  it("editing an existing connection does not prefill the token", () => {
    // The plaintext is in the keychain and is never read back into the webview.
    render(
      <ConnectionForm
        onSave={vi.fn()}
        onCancel={vi.fn()}
        initial={{
          name: "Secure", adminUrl: "http://localhost:8081", brokerUrl: "pulsar://localhost:6651",
          authType: "jwt", secretHandleId: "handle-1", kind: "pulsar", color: "blue",
          defaultTenant: "public", defaultNamespace: "default",
          readOnly: true, tlsVerify: true, timeoutMs: 10000,
        }}
      />,
    );
    expect(screen.getByLabelText(/token/i)).toHaveValue("");
    expect(screen.getByText(/stored in keychain/i)).toBeInTheDocument();
  });
});
