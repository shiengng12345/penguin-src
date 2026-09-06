export const GRPC_IDENTITY_VERSION = 2 as const;

export interface GrpcIdentityInput {
  packageName?: string | null;
  service: string;
  method: string;
}

interface NormalizedGrpcIdentity {
  packageName: string | null;
  service: string;
  method: string;
  qualifiedService: string;
}

function cleanSegment(value: string | null | undefined): string {
  return String(value ?? "").trim().replace(/^\.+|\.+$/g, "");
}

function normalizedGrpcIdentity(input: GrpcIdentityInput): NormalizedGrpcIdentity {
  let packageName = cleanSegment(input.packageName) || null;
  let service = cleanSegment(input.service)
    .replace(/^grpc::/i, "")
    .replace(/^gRPC\s+/i, "");
  const method = cleanSegment(input.method);
  if (!service || !method) throw new Error("gRPC identity requires non-empty service and method");

  if (packageName && service.toLowerCase().startsWith(`${packageName.toLowerCase()}.`)) {
    service = service.slice(packageName.length + 1);
  } else if (!packageName && service.includes(".")) {
    const split = service.lastIndexOf(".");
    packageName = cleanSegment(service.slice(0, split)) || null;
    service = cleanSegment(service.slice(split + 1));
  }
  if (!service) throw new Error("gRPC identity requires a non-empty service");

  return {
    packageName,
    service,
    method,
    qualifiedService: packageName ? `${packageName}.${service}` : service,
  };
}

export function canonicalGrpcIdentity(input: GrpcIdentityInput): string {
  const normalized = normalizedGrpcIdentity(input);
  return `grpc::${normalized.qualifiedService}.${normalized.method.toLowerCase()}`;
}

export function grpcIdentityAliases(input: GrpcIdentityInput): string[] {
  const normalized = normalizedGrpcIdentity(input);
  const aliases = new Set<string>();
  const unqualified = `${normalized.service}.${normalized.method}`;
  aliases.add(`grpc::${normalized.service}.${normalized.method.toLowerCase()}`);
  aliases.add(`gRPC ${unqualified}`);
  aliases.add(unqualified);

  if (normalized.packageName) {
    const qualified = `${normalized.qualifiedService}.${normalized.method}`;
    aliases.add(`gRPC ${qualified}`);
    aliases.add(qualified);
    aliases.add(`/${normalized.qualifiedService}/${normalized.method}`);
  } else {
    aliases.add(`/${normalized.service}/${normalized.method}`);
  }

  aliases.delete(canonicalGrpcIdentity(input));
  return [...aliases];
}
