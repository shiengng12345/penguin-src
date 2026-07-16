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
