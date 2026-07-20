export type ChannelProtocol = "kafka" | "rabbitmq" | "sqs" | "sns" | "redis" | "websocket" | "cron" | "unknown";
export type ChannelBindingStatus = "verified" | "candidate";
export interface ExtractedChannelBinding {
  protocol: ChannelProtocol;
  role: "producer" | "consumer";
  name: string;
  status: ChannelBindingStatus;
  startLine: number;
  enclosingQualifiedName: string | null;
  source: string;
}
function protocolFor(text: string): ChannelProtocol {
  if (/cron|scheduled|setInterval|schedule/i.test(text)) return "cron";
  if (/rabbit|amqp/i.test(text)) return "rabbitmq";
  if (/sqs/i.test(text)) return "sqs";
  if (/sns/i.test(text)) return "sns";
  if (/redis|ioredis/i.test(text)) return "redis";
  if (/socket|websocket|emit/i.test(text)) return "websocket";
  return "kafka";
}
export function extractChannelBindings(source: string, symbols: Array<{ qualifiedName: string; startLine: number; endLine: number }>): ExtractedChannelBinding[] {
  const out: ExtractedChannelBinding[] = [];
  const seen = new Set<string>();
  const add = (binding: ExtractedChannelBinding) => { const key = `${binding.role}:${binding.protocol}:${binding.name}:${binding.startLine}`; if (!seen.has(key)) { seen.add(key); out.push(binding); } };
  const enclosing = (line: number): string | null => symbols.filter((item) => item.startLine <= line && line <= item.endLine).sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0]?.qualifiedName ?? null;
  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    const line = raw.replace(/\/\/.*$/, "");
    const startLine = index + 1;
    const literal = /(?:emit|publish|send|produce|dispatch|subscribe|consume|on)\s*\(\s*(['"])([^'"]+)\1/i.exec(line);
    const template = /(?:emit|publish|send|produce|dispatch|subscribe|consume|on)\s*\(\s*`([^`]*)`/i.exec(line);
    const dynamic = /(?:emit|publish|send|produce|dispatch|subscribe|consume|on)\s*\(\s*([^,\s)]+)/i.exec(line);
    const decorator = /@(?:MessagePattern|EventPattern|SubscribeMessage|KafkaListener|RabbitListener|SqsListener|JmsListener|Process|Cron|Scheduled)\s*\(\s*(?:(?:topics?|queues?|destination|pattern|name)\s*=\s*)?(['"])([^'"]+)\1/.exec(line);
    const matchedDecorator = decorator;
    if (matchedDecorator) {
      const cron = /Cron|Scheduled/i.test(line);
      add({ protocol: protocolFor(line), role: cron ? "producer" : "consumer", name: matchedDecorator[2], status: "verified", startLine, enclosingQualifiedName: enclosing(startLine), source: "decorator" });
    }
    if (literal) {
      const consumer = /subscribe|consume|\.on\s*\(/i.test(line);
      add({ protocol: protocolFor(line), role: consumer ? "consumer" : "producer", name: literal[2], status: "verified", startLine, enclosingQualifiedName: enclosing(startLine), source: "string_literal" });
    } else if (template) {
      const consumer = /subscribe|consume|\.on\s*\(/i.test(line);
      add({ protocol: protocolFor(line), role: consumer ? "consumer" : "producer", name: template[1], status: "candidate", startLine, enclosingQualifiedName: enclosing(startLine), source: "template_pattern" });
    } else if (dynamic && !/^['"`]/.test(dynamic[1])) {
      const consumer = /subscribe|consume|\.on\s*\(/i.test(line);
      add({ protocol: protocolFor(line), role: consumer ? "consumer" : "producer", name: dynamic[1], status: "candidate", startLine, enclosingQualifiedName: enclosing(startLine), source: "dynamic_pattern" });
    }
  }
  return out;
}
