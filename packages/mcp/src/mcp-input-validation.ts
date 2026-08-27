export interface ServiceNameLike {
  name: string;
  fullName: string;
}

export function serviceNameMatches(service: ServiceNameLike, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  return service.name.toLowerCase() === normalized || service.fullName.toLowerCase() === normalized;
}

export function validateCompareEnvironmentNames(names: string[]): void {
  if (names.length < 2) throw new Error("compare_environments requires at least two environment names");
}

export function serviceCallability(fullName: string): { routable: boolean; reason?: string } {
  if (fullName === "grpc.health.v1.Health") {
    return { routable: false, reason: "gateway does not route grpc.health.v1.Health" };
  }
  return { routable: true };
}

// call_method requires a target: either an explicit url or an environmentName
// to resolve one from. Neither present is a caller error, not a runtime one.
export function requireCallTarget(url: string | undefined, environmentName: string | undefined): void {
  if (!url && !environmentName) {
    throw new Error("call_method requires either `url` or `environmentName`.");
  }
}

// Map environment variables to the conventional HTTP headers backend services
// expect. Penguin's desktop UI lets users override default headers in the
// desktop Settings panel — those overrides are stored in the app database and
// aren't visible here, so we only emit headers derivable from config-declared
// variables.
export function buildDefaultHeaders(variables: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const tag = variables.X_ENV_TAG?.trim();
  if (tag) out["x-env-tag"] = tag;
  const token = variables.TOKEN?.trim();
  if (token) out["authorization"] = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
  return out;
}

// Stamp the correlation id onto a header map, always overriding whatever was
// already there under that key — used both to build the outgoing request
// metadata and to echo the same id back onto the returned response headers,
// so the AI never has to guess or re-derive it.
export function attachRequestId(
  headers: Record<string, string> | undefined,
  headerName: string,
  requestId: string,
): Record<string, string> {
  return { ...headers, [headerName]: requestId };
}
