import { useState } from "react";
import {
  useAppStore,
  useActiveTab,
  type FieldInfo,
  type MetadataEntry,
  type ResponseState,
} from "@/lib/store";
import { useEnvironments } from "@/hooks/useEnvironments";
import { interpolate } from "@/lib/environment-store";
import { computeServicePath } from "@penguin/core";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { Copy, Check, FileText, X, ImageIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { tryFormatJson } from "@/lib/json-utils";
import { isLightAppTheme } from "@/lib/theme";
import { writeClipboard } from "@/lib/clipboard";

interface RequestDocDialogProps {
  open: boolean;
  onClose: () => void;
}

function fieldsToProtoMessage(
  typeName: string,
  fields: FieldInfo[],
  indent = 0,
  collected: string[] = []
): string {
  const pad = "  ".repeat(indent);
  const innerPad = "  ".repeat(indent +1);
  const lines: string[] = [];

  lines.push(`${pad}message ${typeName} {`);

  fields.forEach((f, i) => {
    const num = i +1;
    const label = f.repeated ? "repeated " : f.optional ? "optional " : "";

    if (f.enumValues && f.enumValues.length > 0) {
      const enumName = f.name.charAt(0).toUpperCase() +f.name.slice(1);
      lines.push(`${innerPad}${label}${enumName} ${f.name} = ${num};`);
      const enumLines: string[] = [];
      enumLines.push(`${pad}enum ${enumName} {`);
      f.enumValues.forEach((ev, ei) => {
        enumLines.push(`${innerPad}${ev} = ${ei};`);
      });
      enumLines.push(`${pad}}`);
      collected.push(enumLines.join("\n"));
    } else if (f.fields && f.fields.length > 0) {
      const nestedName = f.type || f.name.charAt(0).toUpperCase() +f.name.slice(1);
      lines.push(`${innerPad}${label}${nestedName} ${f.name} = ${num};`);
      collected.push(
        fieldsToProtoMessage(nestedName, f.fields, indent, collected)
      );
    } else {
      lines.push(`${innerPad}${label}${f.type} ${f.name} = ${num};`);
    }
  });

  lines.push(`${pad}}`);
  return lines.join("\n");
}

function buildFullProto(typeName: string, fields: FieldInfo[]): string {
  if (fields.length === 0) return "";
  const collected: string[] = [];
  const main = fieldsToProtoMessage(typeName, fields, 0, collected);
  const nested = collected.length > 0 ? "\n\n" +collected.join("\n\n") : "";
  return main +nested;
}

function formatResponseBody(resp: ResponseState): string {
  if (resp.body && resp.body !== "" && resp.body !== "{}" && resp.body !== "null") {
    return tryFormatJson(resp.body);
  }
  if (resp.error) {
    return tryFormatJson(resp.error);
  }
  return "(empty)";
}

function buildDocText(opts: {
  protocol: string;
  methodFullName: string;
  serviceName: string;
  packageName: string;
  packageVersion: string;
  url: string;
  resolvedUrl: string;
  servicePath: string;
  fullUrl: string;
  requestType: string;
  responseType: string;
  requestProto: string;
  responseProto: string;
  metadata: MetadataEntry[];
  requestBody: string;
  response: ResponseState | null;
}): string {
  const lines: string[] = [];
  const divider = "─".repeat(50);

  lines.push(`${divider}`);
  lines.push(`Protocol:  ${opts.protocol.toUpperCase()}`);
  lines.push(`Package:   ${opts.packageName}@${opts.packageVersion}`);
  lines.push(`Service:   ${opts.serviceName}`);
  lines.push(`Method:    ${opts.methodFullName}`);
  lines.push(`${divider}`);

  lines.push("");
  lines.push(`URL:       ${opts.url}`);
  if (opts.url !== opts.resolvedUrl) {
    lines.push(`Resolved:  ${opts.resolvedUrl}`);
  }
  lines.push(`Path:      ${opts.servicePath}`);
  lines.push(`Full URL:  ${opts.fullUrl}`);

  lines.push("");
  lines.push(`${divider}`);
  lines.push("HEADERS");
  lines.push(`${divider}`);
  if (opts.metadata.length > 0) {
    for (const m of opts.metadata) {
      lines.push(`${m.key}: ${m.value}`);
    }
  } else {
    lines.push("(none)");
  }

  lines.push("");
  lines.push(`${divider}`);
  lines.push(`REQUEST MESSAGE — ${opts.requestType}`);
  lines.push(`${divider}`);
  if (opts.requestProto) {
    lines.push(opts.requestProto);
  } else {
    lines.push("(no schema)");
  }

  lines.push("");
  lines.push(`${divider}`);
  lines.push("REQUEST BODY");
  lines.push(`${divider}`);
  lines.push(tryFormatJson(opts.requestBody));

  lines.push("");
  lines.push(`${divider}`);
  lines.push(`RESPONSE MESSAGE — ${opts.responseType}`);
  lines.push(`${divider}`);
  if (opts.responseProto) {
    lines.push(opts.responseProto);
  } else {
    lines.push("(no schema)");
  }

  if (opts.response) {
    lines.push("");
    lines.push(`${divider}`);
    lines.push(
      `RESPONSE — ${opts.response.status}${opts.response.statusCode > 0 ? ` ${opts.response.statusCode}` : ""} (${opts.response.duration}ms)`
    );
    lines.push(`${divider}`);

    if (Object.keys(opts.response.headers).length > 0) {
      lines.push("Response Headers:");
      for (const [k, v] of Object.entries(opts.response.headers)) {
        lines.push(`  ${k}: ${v}`);
      }
      lines.push("");
    }

    lines.push("Response Body:");
    lines.push(formatResponseBody(opts.response));
  }

  return lines.join("\n");
}

interface DocRowProps {
  label: string;
  value: string;
  mono?: boolean;
  className?: string;
}

function DocRow({ label, value, mono, className }: DocRowProps) {
  return (
    <div className={cn("flex gap-3 py-1", className)}>
      <span className="shrink-0 w-24 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground text-right">
        {label}
      </span>
      <span
        className={cn(
          "text-xs text-foreground min-w-0 break-all select-all",
          mono && "font-mono"
        )}
      >
        {value}
      </span>
    </div>
  );
}

interface DocSectionProps {
  title: string;
  children: React.ReactNode;
  extra?: React.ReactNode;
}

function DocSection({ title, children, extra }: DocSectionProps) {
  return (
    <div className="border-b border-border">
      <div className="flex items-center justify-between px-4 py-1.5 bg-muted/20">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </span>
        {extra}
      </div>
      <div className="px-4 py-2">{children}</div>
    </div>
  );
}

export function RequestDocDialog({ open, onClose }: RequestDocDialogProps) {
  const tab = useActiveTab();
  const { activeEnv } = useEnvironments();
  const [copied, setCopied] = useState(false);
  const [imgCopied, setImgCopied] = useState(false);

  const grpcWebPackages = useAppStore((s) => s.grpcWebPackages);
  const grpcPackages = useAppStore((s) => s.grpcPackages);
  const sdkPackages = useAppStore((s) => s.sdkPackages);

  if (!open || !tab || !tab.selectedMethod) return null;

  const method = tab.selectedMethod;
  const resolvedUrl = interpolate(tab.targetUrl, activeEnv);
  const servicePath = tab.pathOverride ?? computeServicePath(method.fullName);
  const fullUrl = `${resolvedUrl.replace(/\/$/, "")}${servicePath}`;

  const allPkgs =
    tab.protocolTab === "grpc-web"
      ? grpcWebPackages
      : tab.protocolTab === "grpc"
        ? grpcPackages
        : sdkPackages;
  const matchedPkg = allPkgs.find((p) => p.name === tab.selectedPackage);
  const packageVersion = matchedPkg?.version?.replace(/^\^|~/, "") ?? "unknown";

  const requestProto = buildFullProto(method.requestType, method.requestFields);
  const responseProto = buildFullProto(method.responseType, method.responseFields);

  const enabledHeaders = tab.metadata.filter((m) => m.enabled && m.key);

  const docText = buildDocText({
    protocol: tab.protocolTab,
    methodFullName: method.fullName,
    serviceName: tab.selectedService ?? "",
    packageName: tab.selectedPackage ?? "",
    packageVersion,
    url: tab.targetUrl,
    resolvedUrl,
    servicePath,
    fullUrl,
    requestType: method.requestType,
    responseType: method.responseType,
    requestProto,
    responseProto,
    metadata: enabledHeaders,
    requestBody: tab.requestBody,
    response: tab.response,
  });

  const handleCopy = () => {
    writeClipboard(docText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleCopyImage = async () => {
    const isDark =
      !isLightAppTheme(document.documentElement.getAttribute("data-theme"));

    const bg = isDark ? "#1e1e2e" : "#ffffff";
    const fg = isDark ? "#cdd6f4" : "#1e1e2e";
    const muted = isDark ? "#6c7086" : "#7c7f93";
    const accent = isDark ? "#89b4fa" : "#1e66f5";
    const sectionBg = isDark ? "#262637" : "#f0f0f5";
    const borderColor = isDark ? "#363649" : "#dcdce4";

    const scale = 2;
    const W = 700;
    const padX = 24;
    const lineH = 18;
    const sectionGap = 10;
    const font = "12px ui-monospace, 'SF Mono', Menlo, monospace";
    const fontBold = "bold 12px ui-monospace, 'SF Mono', Menlo, monospace";
    const sectionFont =
      "bold 10px ui-sans-serif, -apple-system, BlinkMacSystemFont, sans-serif";

    const sections: { title: string; lines: string[] }[] = [
      {
        title: "INFO",
        lines: [
          `Protocol:   ${tab.protocolTab.toUpperCase()}`,
          `Package:    ${tab.selectedPackage ? `${tab.selectedPackage}@${packageVersion}` : "—"}`,
          `Service:    ${serviceShort}`,
          `Method:     ${method.fullName}`,
        ],
      },
      {
        title: "URL",
        lines: [
          `Template:   ${tab.targetUrl}`,
          ...(tab.targetUrl !== resolvedUrl
            ? [`Resolved:   ${resolvedUrl}`]
            : []),
          `Path:       ${servicePath}`,
          `Full URL:   ${fullUrl}`,
        ],
      },
      {
        title: "HEADERS",
        lines:
          enabledHeaders.length > 0
            ? enabledHeaders.map((m) => `${m.key}: ${m.value}`)
            : ["(none)"],
      },
      {
        title: `REQUEST MESSAGE — ${method.requestType}`,
        lines: requestProto
          ? requestProto.split("\n")
          : ["(no schema available)"],
      },
      {
        title: "REQUEST BODY",
        lines: tryFormatJson(tab.requestBody).split("\n"),
      },
      {
        title: `RESPONSE MESSAGE — ${method.responseType}`,
        lines: responseProto
          ? responseProto.split("\n")
          : ["(no schema available)"],
      },
    ];

    if (tab.response) {
      const respLines: string[] = [];
      if (Object.keys(tab.response.headers).length > 0) {
        respLines.push("Response Headers:");
        for (const [k, v] of Object.entries(tab.response.headers)) {
          respLines.push(`  ${k}: ${v}`);
        }
        respLines.push("");
      }
      respLines.push("Response Body:");
      respLines.push(...formatResponseBody(tab.response).split("\n"));
      sections.push({
        title: `RESPONSE — ${tab.response.status}${tab.response.statusCode > 0 ? ` ${tab.response.statusCode}` : ""} (${tab.response.duration}ms)`,
        lines: respLines,
      });
    }

    const maxTextW = W - padX * 2;

    const measure = document.createElement("canvas").getContext("2d")!;
    measure.font = font;

    function wrapLine(text: string, startX: number): string[] {
      const available = maxTextW - startX +padX;
      if (measure.measureText(text).width <= available) return [text];

      const wrapped: string[] = [];
      let remaining = text;
      let firstLine = true;
      while (remaining.length > 0) {
        const w = firstLine ? available : maxTextW;
        let fit = remaining.length;
        while (fit > 0 && measure.measureText(remaining.slice(0, fit)).width > w) {
          fit--;
        }
        if (fit === 0) fit = 1;
        wrapped.push(remaining.slice(0, fit));
        remaining = remaining.slice(fit);
        firstLine = false;
      }
      return wrapped;
    }

    interface DrawLine {
      segments: { text: string; x: number; font: string; color: string }[];
    }

    const sectionDrawData: { title: string; drawLines: DrawLine[] }[] = [];

    for (const section of sections) {
      const drawLines: DrawLine[] = [];
      for (const line of section.lines) {
        const colonIdx = line.indexOf(":");
        const isKV =
          colonIdx > 0 &&
          colonIdx < 16 &&
          !line.startsWith(" ") &&
          !line.startsWith("{") &&
          !line.startsWith("[") &&
          !line.startsWith("}");

        if (isKV) {
          const label = line.substring(0, colonIdx +1);
          const value = line.substring(colonIdx +1).trimStart();
          measure.font = fontBold;
          const labelW = measure.measureText(label).width;
          const valueX = padX +labelW +4;
          measure.font = font;
          const wrappedValue = wrapLine(value, valueX);
          drawLines.push({
            segments: [
              { text: label, x: padX, font: fontBold, color: accent },
              { text: wrappedValue[0], x: valueX, font, color: fg },
            ],
          });
          for (let wi = 1; wi < wrappedValue.length; wi++) {
            drawLines.push({
              segments: [
                { text: wrappedValue[wi], x: padX +12, font, color: fg },
              ],
            });
          }
        } else {
          measure.font = font;
          const wrapped = wrapLine(line, padX);
          for (const wl of wrapped) {
            drawLines.push({
              segments: [{ text: wl, x: padX, font, color: fg }],
            });
          }
        }
      }
      sectionDrawData.push({ title: section.title, drawLines });
    }

    let totalH = 20;
    for (const s of sectionDrawData) {
      totalH += 28 +s.drawLines.length * lineH +sectionGap;
    }
    totalH += 8;

    const canvas = document.createElement("canvas");
    canvas.width = W * scale;
    canvas.height = totalH * scale;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(scale, scale);

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, totalH);

    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, W - 1, totalH - 1);

    let y = 20;

    for (const section of sectionDrawData) {
      ctx.fillStyle = sectionBg;
      ctx.fillRect(0, y, W, 24);

      ctx.strokeStyle = borderColor;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.moveTo(0, y +24);
      ctx.lineTo(W, y +24);
      ctx.stroke();

      ctx.fillStyle = muted;
      ctx.font = sectionFont;
      ctx.fillText(section.title, padX, y +16);

      y += 28;

      for (const dl of section.drawLines) {
        for (const seg of dl.segments) {
          ctx.font = seg.font;
          ctx.fillStyle = seg.color;
          ctx.fillText(seg.text, seg.x, y +13);
        }
        y += lineH;
      }

      y += sectionGap;
    }

    const dataUrl = canvas.toDataURL("image/png");
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");

    try {
      await invoke("copy_png_to_clipboard", { base64Data: base64 });
      setImgCopied(true);
      setTimeout(() => setImgCopied(false), 1500);
    } catch {
      setImgCopied(false);
    }
  };

  const serviceShort =
    tab.selectedService?.split(".").pop() ?? tab.selectedService ?? "";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        role="dialog"
        className="relative z-50 w-full max-w-2xl max-h-[85vh] rounded-lg border border-border bg-popover shadow-xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5 bg-card shrink-0">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Request Documentation</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className={cn(
                "h-7 transition-all",
                imgCopied && "bg-success text-success-foreground hover:bg-success border-success"
              )}
              onClick={handleCopyImage}
            >
              {imgCopied ? (
                <>
                  <Check className="mr-1 h-3.5 w-3.5" />
                  Copied!
                </>
              ) : (
                <>
                  <ImageIcon className="mr-1 h-3.5 w-3.5" />
                  Copy Image
                </>
              )}
            </Button>
            <Button
              size="sm"
              className={cn(
                "h-7 transition-all",
                copied && "bg-success text-success-foreground hover:bg-success"
              )}
              onClick={handleCopy}
            >
              {copied ? (
                <>
                  <Check className="mr-1 h-3.5 w-3.5" />
                  Copied!
                </>
              ) : (
                <>
                  <Copy className="mr-1 h-3.5 w-3.5" />
                  Copy Text
                </>
              )}
            </Button>
            <button
              onClick={onClose}
              className="h-7 w-7 rounded flex items-center justify-center hover:bg-accent text-muted-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto bg-popover">
          {/* Info */}
          <DocSection title="Info">
            <DocRow label="Protocol" value={tab.protocolTab.toUpperCase()} />
            <DocRow
              label="Package"
              value={tab.selectedPackage ? `${tab.selectedPackage}@${packageVersion}` : "—"}
              mono
            />
            <DocRow label="Service" value={serviceShort} mono />
            <DocRow label="Method" value={method.fullName} mono />
          </DocSection>

          {/* URL */}
          <DocSection title="URL">
            <DocRow label="Template" value={tab.targetUrl} mono />
            {tab.targetUrl !== resolvedUrl && (
              <DocRow label="Resolved" value={resolvedUrl} mono />
            )}
            <DocRow label="Path" value={servicePath} mono />
            <DocRow label="Full URL" value={fullUrl} mono />
          </DocSection>

          {/* Headers */}
          <DocSection title="Headers">
            {enabledHeaders.length > 0 ? (
              <div className="space-y-0.5">
                {enabledHeaders.map((m, i) => (
                  <div key={i} className="font-mono text-xs">
                    <span className="text-primary">{m.key}:</span>{" "}
                    <span className="text-foreground/80 break-all select-all">
                      {m.value}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <span className="text-xs text-muted-foreground">(none)</span>
            )}
          </DocSection>

          {/* Request Proto Message */}
          <DocSection title={`Request — ${method.requestType}`}>
            {requestProto ? (
              <pre className="font-mono text-[11px] leading-relaxed text-foreground/80 whitespace-pre-wrap select-all">
                {requestProto}
              </pre>
            ) : (
              <span className="text-xs text-muted-foreground">
                (no schema available)
              </span>
            )}
          </DocSection>

          {/* Request Body */}
          <DocSection title="Request Body">
            <pre className="font-mono text-[11px] leading-relaxed text-foreground/80 whitespace-pre-wrap break-all select-all">
              {tryFormatJson(tab.requestBody)}
            </pre>
          </DocSection>

          {/* Response Proto Message */}
          <DocSection title={`Response — ${method.responseType}`}>
            {responseProto ? (
              <pre className="font-mono text-[11px] leading-relaxed text-foreground/80 whitespace-pre-wrap select-all">
                {responseProto}
              </pre>
            ) : (
              <span className="text-xs text-muted-foreground">
                (no schema available)
              </span>
            )}
          </DocSection>

          {/* Response */}
          {tab.response && (
            <DocSection
              title={`Response — ${tab.response.status}${tab.response.statusCode > 0 ? ` ${tab.response.statusCode}` : ""} (${tab.response.duration}ms)`}
            >
              {Object.keys(tab.response.headers).length > 0 && (
                <div className="mb-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                    Response Headers
                  </div>
                  <div className="space-y-0.5">
                    {Object.entries(tab.response.headers).map(([k, v]) => (
                      <div key={k} className="font-mono text-[11px]">
                        <span className="text-primary">{k}:</span>{" "}
                        <span className="text-foreground/80 break-all">
                          {v}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                Response Body
              </div>
              <pre className="font-mono text-[11px] leading-relaxed text-foreground/80 whitespace-pre-wrap break-all select-all">
                {formatResponseBody(tab.response)}
              </pre>
            </DocSection>
          )}
        </div>
      </div>
    </div>
  );
}
