import {
  getDefaultHeadersForProtocol,
  useAppStore,
  visibleProtocolForTab,
  type RequestTab,
  type SavedRequest,
} from "@/lib/store";
import { inferRestBodyMode, toRestMethod } from "@/lib/rest";

function getContentType(metadata: SavedRequest["metadata"]): string {
  return metadata.find((m) => m.key.trim().toLowerCase() === "content-type")?.value ?? "";
}

export function openSavedRequest(entry: SavedRequest): void {
  const targetProtocol = visibleProtocolForTab(entry.protocol);
  useAppStore.getState().addTab(targetProtocol);
  const isRest = entry.protocol === "rest";
  const patch: Partial<RequestTab> = {
    protocolTab: targetProtocol,
    targetUrl: entry.url,
    metadata:
      entry.metadata.length > 0
        ? entry.metadata
        : getDefaultHeadersForProtocol(targetProtocol),
    requestBody: entry.requestBody,
    selectedPackage: isRest ? null : entry.packageName || null,
    selectedService: isRest ? null : entry.serviceName || null,
    selectedMethod: isRest ? null : entry.selectedMethod ?? null,
    transport: targetProtocol === "grpc-web" ? (entry.transport ?? "grpc-web") : undefined,
    response: entry.response,
    origin: "saved",
  };
  if (isRest) {
    patch.restMethod = toRestMethod(entry.restMethod ?? entry.methodFullName, "GET");
    patch.restBodyMode =
      entry.restBodyMode ?? inferRestBodyMode(entry.requestBody, getContentType(entry.metadata));
    patch.pathOverride = null;
  }
  useAppStore.getState().updateActiveTab(patch);
  if (entry.packageName && entry.serviceName) {
    document.dispatchEvent(
      new CustomEvent("penguin:focus-method", {
        detail: {
          packageName: entry.packageName,
          serviceName: entry.serviceName,
        },
      }),
    );
  }
}
