// tests/connect-rpc-client.test.mjs
// Real repro: FPMS-CCMS's src/api/grpcClient.ts uses @connectrpc/connect's
// createClient() convention, which neither frontend-grpc-client.ts (dispatcher
// object-literal / `_net`-forward wrappers) nor grpc-js-client.ts (old-FPMS
// serviceRegistry) recognize — so it had ZERO invokes edges despite ~10k
// local calls, and never linked to the backend repos it actually calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  verifiedConnectRpcGettersFromSource,
  extractConnectRpcCallsFromSource,
} from "../packages/knowledge-indexer/dist/connect-rpc-client.js";

const GRPC_CLIENT_SERVICE_SRC = `
class GrpcClientService {
  private client;
  private promotionClient;
  private notAClient;
  constructor() {
    this.transport = createGrpcWebTransport({ baseUrl });
    this.client = createClient(BackendConnect.BackendService, this.transport);
    this.promotionClient = createClient(CcmsPromotionConnect.CCMSPromotionService, this.transport);
    this.notAClient = someOtherFactory();
  }
  getClient() {
    return this.client;
  }
  getPromotionClient() {
    return this.promotionClient;
  }
  getRenamedThing() {
    return this.notAClient;
  }
  getClientWithExtra() {
    console.log('side effect');
    return this.client;
  }
}
`;

test("verifiedConnectRpcGetters: only methods that sole-return a createClient()-backed field", async () => {
  const s = await verifiedConnectRpcGettersFromSource("tsx", GRPC_CLIENT_SERVICE_SRC);
  assert.ok(s.has("getClient"));
  assert.ok(s.has("getPromotionClient"));
  assert.ok(!s.has("getRenamedThing"), "field not backed by createClient() must not verify");
  assert.ok(!s.has("getClientWithExtra"), "extra statements beyond the sole return must not verify");
});

test("verifiedConnectRpcGetters: file with no createClient() usage (backend repo) → empty set", async () => {
  const s = await verifiedConnectRpcGettersFromSource("tsx", `
    class UserController {
      getFoo() { return this.foo; }
    }
  `);
  assert.equal(s.size, 0);
});

test("extractConnectRpcCalls: finds `x.getXClient().method(...)` call sites, ignores unrelated chains", async () => {
  const getters = await verifiedConnectRpcGettersFromSource("tsx", GRPC_CLIENT_SERVICE_SRC);
  const callSite = `
    async function fetchPromotions(req) {
      const res = await grpcClientService.getPromotionClient().listPromotions(req);
      const other = grpcClientService.getRenamedThing().someMethod(req); // getter not verified → ignored
      const unrelated = someOtherObject.getFoo().bar(req); // getter not verified at all → ignored
      return res;
    }
  `;
  const calls = await extractConnectRpcCallsFromSource("tsx", callSite, getters);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].functionName, "listPromotions");
});

test("extractConnectRpcCalls: a getter call with arguments is NOT a zero-arg getter — ignored", async () => {
  const getters = new Set(["getClient"]);
  const calls = await extractConnectRpcCallsFromSource(
    "tsx",
    `x.getClient(someArg).method(req);`,
    getters,
  );
  assert.equal(calls.length, 0);
});

test("extractConnectRpcCalls: empty verifiedGetters set → no calls extracted at all", async () => {
  const calls = await extractConnectRpcCallsFromSource(
    "tsx",
    `grpcClientService.getPromotionClient().listPromotions(req);`,
    new Set(),
  );
  assert.equal(calls.length, 0);
});

test("extractConnectRpcCalls: real-world two-step form — module-level `const client = x.getter();` then `client.method(...)` elsewhere", async () => {
  // Real repro: FPMS-CCMS never uses the chained form. Every service file
  // does `const client = grpcClientService.getPromotionClient();` at module
  // scope, then calls `client.insertOrUpdateMarketingBaseConfig(...)` from
  // inside exported functions further down the file — the getter call and
  // the method call are two separate statements, not one chained expression.
  const getters = await verifiedConnectRpcGettersFromSource("tsx", GRPC_CLIENT_SERVICE_SRC);
  const callSite = `
    const client = grpcClientService.getPromotionClient();
    const other = someOtherObject.getRenamedThing(); // not a verified getter → not tracked

    export const getMarketingBaseConfig = async () => {
      return await grpcClientService.handleApiRequest(
        'getMarketingBaseConfig',
        () => client.getMarketingBaseConfig({}, { headers: grpcClientService.getCommonHeaders() }),
      );
    };

    export const insertOrUpdateMarketingBaseConfig = async (id, cfg) => {
      return client.insertOrUpdateMarketingBaseConfig({ id, cfg });
    };
  `;
  const calls = await extractConnectRpcCallsFromSource("tsx", callSite, getters);
  const names = calls.map((c) => c.functionName);
  assert.ok(names.includes("getMarketingBaseConfig"));
  assert.ok(names.includes("insertOrUpdateMarketingBaseConfig"));
  assert.ok(!names.includes("handleApiRequest"), "grpcClientService itself is not a tracked client var");
});

test("extractConnectRpcCalls: a same-named local var in an UNRELATED nested function must not be mistaken for the module-level client", async () => {
  // Real bug caught independently by both codex and deepcode review: tracking
  // "const client = x.getter()" file-wide (not scope-aware) means an entirely
  // unrelated `const client = ...` declared inside some other function --
  // shadowing the name but bound to something totally different -- gets
  // treated as the same connect-rpc client. `client` is the EXACT variable
  // name the real FPMS-CCMS convention uses everywhere, so this is a highly
  // plausible real collision, not just a contrived example.
  const getters = await verifiedConnectRpcGettersFromSource("tsx", GRPC_CLIENT_SERVICE_SRC);
  const callSite = `
    const client = grpcClientService.getPromotionClient(); // real module-level client

    function renderRow(data) {
      const client = data.row; // unrelated local shadow, NOT a connect-rpc client
      client.delete(); // must NOT be extracted as a connect-rpc call
    }

    export const listPromotions = async () => client.listPromotions({});
  `;
  const calls = await extractConnectRpcCallsFromSource("tsx", callSite, getters);
  const names = calls.map((c) => c.functionName);
  assert.ok(names.includes("listPromotions"), "the real module-level client call must still be found");
  assert.ok(!names.includes("delete"), "a same-named local var in an unrelated nested scope must not be tracked");
});

test("extractConnectRpcCalls: real-world FUNCTION-scoped binding — `const x = getter();` declared inside a function, not at module top level, must still be found", async () => {
  // Real repro from FPMS-CCMS's platformService.ts: the client binding isn't
  // always a module-level const shared across the whole file (basicConfigService.ts's
  // shape) — some files bind it fresh INSIDE a single exported function:
  //   export async function fetchPlatforms() {
  //     const adminClient = grpcClientService.getAdminClient();
  //     ... adminClient.getPlatforms(...) ...
  //   }
  // A fix that only tracks module-top-level bindings misses this entirely.
  const getters = await verifiedConnectRpcGettersFromSource("tsx", GRPC_CLIENT_SERVICE_SRC);
  const callSite = `
    export async function fetchPlatforms() {
      const adminClient = grpcClientService.getClient();
      return grpcClientService.handleApiRequest('getPlatforms', () =>
        adminClient.getPlatforms({}, { headers: grpcClientService.getCommonHeaders() }),
      );
    }
  `;
  const calls = await extractConnectRpcCallsFromSource("tsx", callSite, getters);
  const names = calls.map((c) => c.functionName);
  assert.ok(names.includes("getPlatforms"), "a function-scoped (not module-level) client binding must still be found");
});

test("extractConnectRpcCalls: preserves verified client identity through TypeScript `as` casts", async () => {
  const getters = await verifiedConnectRpcGettersFromSource("tsx", GRPC_CLIENT_SERVICE_SRC);
  const calls = await extractConnectRpcCallsFromSource(
    "tsx",
    `
      const client = grpcClientService.getClient();
      export const getComponentV2 = async () => (client as any).getComponentV2({});
      export const getNavTagList = async () => (client as unknown as any).getNavTagList({});
    `,
    getters,
  );
  assert.deepEqual(calls.map((call) => call.functionName), ["getComponentV2", "getNavTagList"]);
});
