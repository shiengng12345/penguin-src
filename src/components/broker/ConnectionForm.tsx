// ConnectionForm — the only place a broker token is ever typed.
//
// THE PROPERTY THIS FILE EXISTS TO PROTECT: the plaintext of a token crosses
// the JS/Rust boundary exactly once, on its way to the OS keychain via
// `broker_upsert_connection`'s `secret` parameter, and never comes back.
// Concretely:
//  - a brand-new connection defaults to `readOnly: true` — this project
//    measured that the broker accepts every write from anyone,
//    unauthenticated, so the read-only flag is the only thing standing
//    between a careless click and an irreversible change.
//  - the Token field only renders for an `authType` that actually uses one
//    ("jwt" / "oauth2"); it starts (and on every re-render of an existing
//    connection, stays) empty — `secret` is local component state, never
//    seeded from `initial.secretHandleId`, because the plaintext lives only
//    in the keychain and this component has no way to read it back.
//  - `onSave` receives the token as a separate `secret` field on the draft;
//    every other field on that draft is safe to log, persist, or round-trip
//    through app_kv.
import { useState, type FormEvent, type ReactNode } from "react";
import type { BrokerConnectionDraft } from "@penguin/broker-contracts";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";

const AUTH_TYPES: { value: BrokerConnectionDraft["authType"]; label: string }[] = [
  { value: "none", label: "None" },
  { value: "jwt", label: "JWT" },
  { value: "oauth2", label: "OAuth2" },
  { value: "tls", label: "mTLS" },
];

// V-C… auth types that require a bearer credential rather than a certificate
// or nothing at all.
const TOKEN_AUTH_TYPES = new Set<BrokerConnectionDraft["authType"]>(["jwt", "oauth2"]);

// The binary URL is not optional: timeline and replay both depend on the
// binary transport, and a connection without it is half-built.
const PULSAR_URL_PATTERN = /^pulsar(\+ssl)?:\/\//i;

export interface ConnectionFormProps {
  initial?: BrokerConnectionDraft;
  onSave: (draft: BrokerConnectionDraft) => void;
  onCancel: () => void;
}

interface FormErrors {
  adminUrl?: string;
  brokerUrl?: string;
}

export function ConnectionForm({ initial, onSave, onCancel }: ConnectionFormProps) {
  const [name, setName] = useState(initial?.name ?? "");
  const [color, setColor] = useState(initial?.color ?? "blue");
  const [adminUrl, setAdminUrl] = useState(initial?.adminUrl ?? "");
  const [brokerUrl, setBrokerUrl] = useState(initial?.brokerUrl ?? "");
  const [authType, setAuthType] = useState<BrokerConnectionDraft["authType"]>(initial?.authType ?? "none");
  // Deliberately never initialised from `initial` — see file header note.
  const [secret, setSecret] = useState("");
  const [defaultTenant, setDefaultTenant] = useState(initial?.defaultTenant ?? "public");
  const [defaultNamespace, setDefaultNamespace] = useState(initial?.defaultNamespace ?? "default");
  // Defaults to true even when editing an already-writable connection would
  // pass `false` through `initial` — that path only runs once `initial` is
  // actually supplied, so an existing writable connection stays writable,
  // but a brand-new one always starts locked down.
  const [readOnly, setReadOnly] = useState(initial?.readOnly ?? true);
  const [tlsVerify, setTlsVerify] = useState(initial?.tlsVerify ?? true);
  const [timeoutMs, setTimeoutMs] = useState(initial?.timeoutMs ?? 10_000);
  const [errors, setErrors] = useState<FormErrors>({});

  const needsToken = TOKEN_AUTH_TYPES.has(authType);
  const hasStoredSecret = Boolean(initial?.secretHandleId);

  function validate(): FormErrors {
    const next: FormErrors = {};
    if (!adminUrl.trim()) {
      next.adminUrl = "Admin URL is required.";
    }
    if (!brokerUrl.trim()) {
      next.brokerUrl = "Broker URL is required.";
    } else if (!PULSAR_URL_PATTERN.test(brokerUrl.trim())) {
      next.brokerUrl = "Broker URL must start with pulsar:// or pulsar+ssl://.";
    }
    return next;
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const nextErrors = validate();
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    const draft: BrokerConnectionDraft = {
      kind: "pulsar",
      name: name.trim(),
      color,
      adminUrl: adminUrl.trim(),
      brokerUrl: brokerUrl.trim(),
      authType,
      // The backend owns the handle id; the form only ever forwards the one
      // it was given (editing) or leaves it unset (a brand-new connection
      // gets one only after its first secret write).
      secretHandleId: initial?.secretHandleId ?? null,
      defaultTenant: defaultTenant.trim() || "public",
      defaultNamespace: defaultNamespace.trim() || "default",
      readOnly,
      tlsVerify,
      timeoutMs,
      secret: needsToken && secret.trim() ? secret : undefined,
    };
    onSave(draft);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <Field label="Name" htmlFor="conn-name">
        <Input id="conn-name" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>

      <Field label="Admin URL" htmlFor="conn-admin-url" error={errors.adminUrl}>
        <Input
          id="conn-admin-url"
          placeholder="http://localhost:8080"
          value={adminUrl}
          onChange={(e) => setAdminUrl(e.target.value)}
        />
      </Field>

      <Field label="Broker URL" htmlFor="conn-broker-url" error={errors.brokerUrl}>
        <Input
          id="conn-broker-url"
          placeholder="pulsar://localhost:6650"
          value={brokerUrl}
          onChange={(e) => setBrokerUrl(e.target.value)}
        />
      </Field>

      <Field label="Auth type" htmlFor="conn-auth">
        <select
          id="conn-auth"
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
          value={authType}
          onChange={(e) => setAuthType(e.target.value as BrokerConnectionDraft["authType"])}
        >
          {AUTH_TYPES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>

      {needsToken && (
        <Field label="Token" htmlFor="conn-token">
          <Input
            id="conn-token"
            type="password"
            autoComplete="off"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={hasStoredSecret ? "Leave blank to keep the stored token" : undefined}
          />
          {hasStoredSecret && (
            <p className="text-xs text-muted-foreground">
              A token is already stored in keychain. Leave blank to keep it.
            </p>
          )}
        </Field>
      )}

      <div className="grid grid-cols-2 gap-4">
        <Field label="Default tenant" htmlFor="conn-tenant">
          <Input id="conn-tenant" value={defaultTenant} onChange={(e) => setDefaultTenant(e.target.value)} />
        </Field>
        <Field label="Default NS" htmlFor="conn-namespace">
          <Input
            id="conn-namespace"
            placeholder="namespace"
            value={defaultNamespace}
            onChange={(e) => setDefaultNamespace(e.target.value)}
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Color" htmlFor="conn-color">
          <Input id="conn-color" value={color} onChange={(e) => setColor(e.target.value)} />
        </Field>
        <Field label="Timeout (ms)" htmlFor="conn-timeout">
          <Input
            id="conn-timeout"
            type="number"
            min={0}
            value={timeoutMs}
            onChange={(e) => setTimeoutMs(Number(e.target.value) || 0)}
          />
        </Field>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">Read-only</p>
          <p className="text-xs text-muted-foreground">
            Local Pulsar accepts every write, unauthenticated — leave this on unless the
            connection needs to produce or mutate anything.
          </p>
        </div>
        <Switch checked={readOnly} onCheckedChange={setReadOnly} aria-label="Read-only" />
      </div>

      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Verify TLS certificate</p>
        <Switch checked={tlsVerify} onCheckedChange={setTlsVerify} aria-label="Verify TLS certificate" />
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit">Save</Button>
      </div>
    </form>
  );
}

function Field({
  label,
  htmlFor,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
