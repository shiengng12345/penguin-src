import assert from "node:assert/strict";
import { test } from "node:test";
import { extractChannelBindings, extractSymbols } from "../packages/knowledge-indexer/dist/index.js";

test("channel bindings verify literal producer/consumer names and keep templates candidate", () => {
  const rows = extractChannelBindings([
    "class Orders {",
    "  publish() { this.client.emit('order.created', payload); }",
    "  subscribe() { this.client.subscribe('order.created', handler); }",
    "  dynamic(topic) { this.client.emit(`order.${topic}`, payload); }",
    "}",
  ].join("\n"), [{ qualifiedName: "Orders.publish", startLine: 1, endLine: 4 }, { qualifiedName: "Orders.subscribe", startLine: 1, endLine: 4 }, { qualifiedName: "Orders.dynamic", startLine: 1, endLine: 4 }]);
  assert.ok(rows.some((row) => row.role === "producer" && row.name === "order.created" && row.status === "verified"));
  assert.ok(rows.some((row) => row.role === "consumer" && row.name === "order.created" && row.status === "verified"));
  assert.ok(rows.some((row) => row.name === "order.${topic}" && row.status === "candidate"));
});

test("framework producer/consumer fixtures share exact and ambiguous channel lanes", async () => {
  const spring = await extractSymbols({ lang: "java", source: '@KafkaListener(topics = "payments")\nvoid consume() {}\nvoid send() { kafkaTemplate.send("payments", payload); }' });
  assert.ok(spring.channels.some((channel) => channel.role === "consumer" && channel.name === "payments" && channel.status === "verified"));
  assert.ok(spring.channels.some((channel) => channel.role === "producer" && channel.name === "payments" && channel.status === "verified"));
  const go = await extractSymbols({ lang: "go", source: 'func consume() { client.Subscribe("payments", handler) }\nfunc send() { client.Publish(fmt.Sprintf("payments-%s", id), payload) }' });
  assert.ok(go.channels.some((channel) => channel.role === "consumer" && channel.name === "payments"));
  assert.ok(go.channels.some((channel) => channel.role === "producer" && channel.status === "candidate"));
});

test("framework fixture matrix covers Nest, Spring, queues, pubsub, websocket and cron", () => {
  const source = [
    '@MessagePattern("nest.queue")',
    '@KafkaListener(topics = "spring.topic")',
    '@RabbitListener("rabbit.queue")',
    '@SqsListener("sqs.queue")',
    '@Process("bull.queue")',
    '@Cron("0 * * * *")',
    'client.emit("ws.event", payload);',
    'redis.publish("redis.topic", payload);',
    'sns.publish("sns.topic", payload);',
    'client.send("generic.topic", payload);',
    'client.subscribe(`dynamic.${tenant}`, handler);',
  ].join("\n");
  const rows = extractChannelBindings(source, []);
  for (const name of ["nest.queue", "spring.topic", "rabbit.queue", "sqs.queue", "bull.queue", "ws.event", "redis.topic", "sns.topic", "generic.topic"]) assert.ok(rows.some((row) => row.name === name), `fixture ${name}`);
  assert.ok(rows.some((row) => row.name === "dynamic.${tenant}" && row.status === "candidate"));
  assert.ok(rows.some((row) => row.protocol === "cron" && row.role === "producer"));
  assert.ok(rows.some((row) => row.role === "consumer"));
  assert.ok(rows.some((row) => row.role === "producer"));
});
