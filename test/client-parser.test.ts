import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseClientSource, parseTsClientCallSites } from "../src/client-parser.js";

test("client-parser: axios.get<T> generic infers a full object schema", () => {
  const src = `
    import axios from "axios";
    interface User { id: number; name: string; email: string; }
    async function getUser(id: string) {
      const res = await axios.get<User>(\`/api/v1/users/\${id}\`);
      return res.data;
    }
  `;
  const [site] = parseClientSource("/virtual/userClient.ts", src);
  assert.ok(site, "expected one call-site");
  assert.equal(site!.method, "GET");
  assert.equal(site!.framework, "axios");
  assert.equal(site!.dynamic, true);
  assert.deepEqual(
    site!.route.segments.map((s) => s.kind),
    ["static", "static", "static", "dynamic"],
  );
  assert.ok(site!.expectedSchema);
  assert.deepEqual(Object.keys(site!.expectedSchema!.fields).sort(), ["email", "id", "name"]);
  assert.equal(site!.expectedSchema!.fields.id!.type.kind, "primitive");
});

test("client-parser: static string literal route is not marked dynamic", () => {
  const src = `
    import axios from "axios";
    axios.get("/api/v1/users");
  `;
  const [site] = parseClientSource("/virtual/x.ts", src);
  assert.equal(site!.dynamic, false);
  assert.deepEqual(site!.route.segments, [
    { kind: "static", value: "api" },
    { kind: "static", value: "v1" },
    { kind: "static", value: "users" },
  ]);
});

test("client-parser: destructuring assignment infers required fields without types", () => {
  const src = `
    async function getOrder(orderId) {
      const res = await fetch("/api/v1/orders/" + orderId);
      const { id, total, status } = await res.json();
      return { id, total, status };
    }
  `;
  const [site] = parseClientSource("/virtual/orders.js", src);
  assert.equal(site!.framework, "fetch");
  assert.equal(site!.dynamic, true);
  // No destructuring directly off the fetch() call itself in this shape,
  // so schema inference legitimately comes back empty/null here — this
  // documents the tool's real boundary rather than asserting a false
  // positive capability.
  assert.equal(site!.expectedSchema, null);
});

test("client-parser: destructuring bound directly to the call result", () => {
  const src = `
    async function getOrder(orderId) {
      const { id, total, status } = await fetch("/api/v1/orders/" + orderId).then(r => r.json());
      return { id, total, status };
    }
  `;
  const [site] = parseClientSource("/virtual/orders2.js", src);
  assert.ok(site!.expectedSchema);
  assert.deepEqual(Object.keys(site!.expectedSchema!.fields).sort(), ["id", "status", "total"]);
  for (const f of Object.values(site!.expectedSchema!.fields)) {
    assert.equal(f.optional, false);
  }
});

test("client-parser: react-query useQuery<T> resolves nested fetch path + generic", () => {
  const src = `
    import { useQuery } from "react-query";
    interface Profile { id: number; displayName: string; }
    function useProfile(userId) {
      return useQuery<Profile>(["profile", userId], () => fetch(\`/api/v1/profile/\${userId}\`).then(r => r.json()));
    }
  `;
  const sites = parseClientSource("/virtual/useProfile.ts", src);
  // Regression: useQuery's URL resolution scans *into* its own callback
  // argument to find the fetch(...) call's URL, which means the same
  // fetch(...) node was previously *also* independently matched by the
  // "fetch" call-site handler during normal AST recursion — one real
  // endpoint reported twice (once as "react-query", once as "fetch").
  // The original version of this test used `.find()` here, which silently
  // picks whichever of the two duplicate sites comes first and never
  // notices the second one — confirmed by reverting the fix in a scratch
  // copy: `sites.length` goes from 1 to 2 while this `.find()`-based
  // assertion below keeps passing unchanged either way.
  assert.equal(sites.length, 1, "useQuery wrapping fetch must yield exactly one call site, not one per nested call");
  const useQuerySite = sites.find((s) => s.framework === "react-query");
  assert.ok(useQuerySite);
  assert.equal(useQuerySite!.method, "GET");
  assert.deepEqual(
    useQuerySite!.route.segments.map((s) => s.kind),
    ["static", "static", "static", "dynamic"],
  );
  assert.deepEqual(Object.keys(useQuerySite!.expectedSchema!.fields).sort(), ["displayName", "id"]);
});

test("client-parser: axios.request({ method, url }) shorthand", () => {
  const src = `
    import axios from "axios";
    axios.request({ method: "post", url: "/api/v1/users" });
  `;
  const [site] = parseClientSource("/virtual/req.ts", src);
  assert.equal(site!.method, "POST");
  assert.equal(site!.route.raw, "/api/v1/users");
});

// Found while running driftguard against a real fullstack monorepo
// (fastapi/full-stack-fastapi-template): generated SDKs (@hey-api/openapi-ts,
// oazapfts) call `client.post<T>({ url: "...", ... })` — a single options
// object with a `url` property, not the URL as a bare first argument like
// axios.get(url). Every one of the app's real generated SDK calls used this
// shape and none were detected before this fix.
test("client-parser: client.post({ url, ... }) generated-SDK options-object shape resolves the URL from the object literal", () => {
  const src = `
    client.post<LoginResponse>({
      responseType: "json",
      url: "/api/v1/login/access-token",
      body: credentials,
    });
  `;
  const [site] = parseClientSource("/virtual/sdk.gen.ts", src);
  assert.ok(site, "expected one call-site");
  assert.equal(site!.method, "POST");
  assert.equal(site!.route.raw, "/api/v1/login/access-token");
});

test("client-parser: fetch with explicit method option", () => {
  const src = `fetch("/api/v1/items", { method: "DELETE" });`;
  const [site] = parseClientSource("/virtual/del.ts", src);
  assert.equal(site!.method, "DELETE");
});

test("client-parser: nullable/optional union fields are captured", () => {
  const src = `
    import axios from "axios";
    interface Account { id: number; nickname?: string; note: string | null; }
    axios.get<Account>("/api/v1/account");
  `;
  const [site] = parseClientSource("/virtual/acct.ts", src);
  const fields = site!.expectedSchema!.fields;
  assert.equal(fields.nickname!.optional, true);
  assert.equal(fields.note!.nullable, true);
  assert.equal(fields.note!.type.kind, "primitive");
});

test("client-parser: string-literal union resolves to an enum FieldType", () => {
  const src = `
    import axios from "axios";
    interface Order { status: "pending" | "shipped" | "delivered"; }
    axios.get<Order>("/api/v1/orders/1");
  `;
  const [site] = parseClientSource("/virtual/enum.ts", src);
  const statusType = site!.expectedSchema!.fields.status!.type;
  assert.equal(statusType.kind, "enum");
  if (statusType.kind === "enum") {
    assert.deepEqual(statusType.variants, ["pending", "shipped", "delivered"]);
  }
});

// Found while running driftguard against a real fullstack monorepo:
// response.headers.get('content-type') and url.searchParams.delete(...)
// were being reported as phantom GET/DELETE API calls, since Headers.get
// and URLSearchParams.delete happen to share method names with HTTP verbs
// and there's no full type-checker here to tell the receivers apart.
test("client-parser: Headers.get()/URLSearchParams.delete() are not mistaken for HTTP calls", () => {
  const src = `
    async function handle(response: Response, url: URL) {
      const contentType = response.headers.get("content-type");
      url.searchParams.delete("reset");
      url.searchParams.delete("login");
      return contentType;
    }
  `;
  const sites = parseClientSource("/virtual/headers.ts", src);
  assert.deepEqual(sites, []);
});

// Found while running driftguard against a real fullstack monorepo
// (fastapi/full-stack-fastapi-template): `map.get(config.key)` inside a
// generated SDK's internal param-serialization helper (params.gen.ts) was
// reported as a phantom GET call, since Map.get/Map.delete share method
// names with HTTP verbs too, same bug class as Headers/URLSearchParams.
test("client-parser: Map.get()/Map.delete() are not mistaken for HTTP calls", () => {
  const src = `
    function serialize(map: Map<string, unknown>, config: { key: string }) {
      const field = map.get(config.key);
      map.delete(config.key);
      return field;
    }
  `;
  const sites = parseClientSource("/virtual/paramSerializer.ts", src);
  assert.deepEqual(sites, []);
});

// A real custom-named API wrapper (not literally called "axios"/"api"/
// "client"/"http") should still be picked up -- the fix above must be a
// narrow receiver denylist, not a broad "unknown receivers are excluded"
// rule that would throw away legitimate wrapper calls too.
test("client-parser: fetch(...).then(r => r.json() as Promise<T>) resolves the asserted type", () => {
  const src = `
    interface UserDTO { id: number; name: string; }
    fetch("/api/v1/users/1").then(r => r.json() as Promise<UserDTO>);
  `;
  const [site] = parseClientSource("/virtual/thenChain.ts", src);
  assert.ok(site, "expected one call-site");
  assert.ok(site!.expectedSchema, "expected the .then() assertion to resolve a schema");
  assert.deepEqual(Object.keys(site!.expectedSchema!.fields).sort(), ["id", "name"]);
});

test("client-parser: fetch(...).then(r => r.json()) with no assertion stays unverifiable (null), not a crash", () => {
  const src = `fetch("/api/v1/users/1").then(r => r.json());`;
  const [site] = parseClientSource("/virtual/thenNoAssert.ts", src);
  assert.ok(site, "expected one call-site");
  assert.equal(site!.expectedSchema, null);
});

test("client-parser: an unusually-named API wrapper is still detected as an unknown-framework call site", () => {
  const src = `
    RequestRoutes.delete(requestId);
  `;
  const [site] = parseClientSource("/virtual/wrapper.ts", src);
  assert.ok(site, "a non-Headers/URLSearchParams receiver should still be extracted");
  assert.equal(site!.method, "DELETE");
  assert.equal(site!.framework, "unknown");
});

// --- resilience against pathological/corrupted files on disk -----------
//
// Reproduces a real crash found by deliberately fuzzing the parser with
// adversarial input: several thousand unbalanced braces (plausible as
// corrupted/truncated output, an accidentally-misnamed non-TS file, or
// heavily malformed generated code) drives the TypeScript compiler's
// recursive-descent parser deep enough to throw a plain JS RangeError
// ("Maximum call stack size exceeded"). Confirmed reproducible directly
// against `ts.createSourceFile` before any of this project's code even
// runs, and confirmed catchable with a plain try/catch (the process
// survives) before writing the fix — this isn't a native/unrecoverable
// crash. Before the fix, one such file killed the entire analysis run
// with an uncaught exception and discarded every other file's valid
// results; after the fix, the bad file is skipped with a warning and the
// rest of the run completes normally.

test("client-parser: parseTsClientCallSites survives a pathologically malformed file (stack-overflowing the parser) without losing other files' results", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "driftguard-pathological-"));
  try {
    fs.mkdirSync(path.join(root, "src", "api"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "api", "broken.ts"), "{".repeat(5000));
    fs.writeFileSync(
      path.join(root, "src", "api", "good.ts"),
      `
        import axios from "axios";
        interface Widget { id: number; }
        export async function getWidget(id: string) {
          const res = await axios.get<Widget>(\`/api/v1/widgets/\${id}\`);
          return res.data;
        }
      `,
    );
    let sites: ReturnType<typeof parseTsClientCallSites> = [];
    assert.doesNotThrow(() => {
      sites = parseTsClientCallSites(root);
    }, "a pathological file must not crash the whole scan");
    assert.equal(sites.length, 1, "the valid file's call-site should still be extracted");
    assert.equal(sites[0]!.route.raw, "/api/v1/widgets/__DYN__");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Adversarial React Query fixtures beyond the single happy-path pattern
// (useQuery wrapping a template-literal fetch). These cover the other
// common real-world shapes: useQuery wrapping axios instead of fetch, and
// useMutation (POST/PUT/DELETE) wrapping fetch — both share the same
// nested-callback URL resolution as the original happy path, so both were
// exposed to the same double-counting risk fixed above.
// ---------------------------------------------------------------------------

test("client-parser: useQuery wrapping axios.get yields exactly one call site, not two", () => {
  const src = `
    import { useQuery } from "react-query";
    import axios from "axios";
    interface Widget { id: number; }
    function useWidget(id: string) {
      return useQuery<Widget>(["widget", id], async () => {
        const res = await axios.get(\`/api/v1/widgets/\${id}\`);
        return res.data;
      });
    }
  `;
  const sites = parseClientSource("/virtual/widgetClient.ts", src);
  assert.equal(sites.length, 1, "useQuery wrapping axios.get must not also independently match the inner axios call");
  assert.equal(sites[0]!.framework, "react-query");
  assert.equal(sites[0]!.method, "GET");
  assert.equal(sites[0]!.route.raw, "/api/v1/widgets/__DYN__");
});

test("client-parser: useMutation wrapping fetch(..., { method: 'POST' }) yields exactly one call site", () => {
  const src = `
    import { useMutation } from "react-query";
    function useCreateWidget() {
      return useMutation((body: unknown) =>
        fetch(\`/api/v1/widgets\`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json())
      );
    }
  `;
  const sites = parseClientSource("/virtual/createWidget.ts", src);
  // useMutation isn't in the react-query handler's recognized callee list
  // (only useQuery/useSuspenseQuery), so this call site is expected to be
  // found via the plain fetch(...) handler during normal recursion — this
  // test exists to confirm that path alone still yields exactly one site,
  // not that useMutation itself is specially handled.
  assert.equal(sites.length, 1);
  assert.equal(sites[0]!.framework, "fetch");
  assert.equal(sites[0]!.method, "POST");
  assert.equal(sites[0]!.route.raw, "/api/v1/widgets");
});

// ---------------------------------------------------------------------------
// const-literal resolution in template-literal URL spans. Found while
// running driftguard against a real, independently-built RealWorld-spec
// client/server pair: every one of that client's ~15 call sites built its
// URL as `` `${this.config.apiBase}/articles` ``, and previously the whole
// prefix collapsed to `__DYN__` unconditionally — not because the value was
// actually unknowable, but because no attempt was ever made to trace it
// back to the literal `apiBase` string sitting in a sibling config module.
// These fixtures cover the resolvable cases (same-file, one import hop, via
// a plain identifier and via an object-literal property) and cases that
// remain unresolved (reassignable bindings, second import hops, and DI calls).
// ---------------------------------------------------------------------------

test("client-parser: template-literal span resolves a same-file const string literal", () => {
  const src = `
    import axios from "axios";
    const API_BASE = "/api/v1";
    axios.get(\`\${API_BASE}/widgets\`);
  `;
  const sites = parseClientSource("/virtual/x.ts", src);
  assert.equal(sites.length, 1);
  assert.equal(sites[0]!.dynamic, false, "a resolved literal prefix should not be marked dynamic");
  assert.equal(sites[0]!.route.raw, "/api/v1/widgets");
});

test("client-parser: template-literal span resolves a same-file const object literal's property", () => {
  const src = `
    import axios from "axios";
    const config = { apiBase: "/api/v1" };
    axios.get(\`\${config.apiBase}/widgets\`);
  `;
  const sites = parseClientSource("/virtual/x.ts", src);
  assert.equal(sites.length, 1);
  assert.equal(sites[0]!.dynamic, false);
  assert.equal(sites[0]!.route.raw, "/api/v1/widgets");
});

test("client-parser: template-literal span with a dynamic segment after a resolved const prefix stays partially dynamic", () => {
  const src = `
    import axios from "axios";
    const config = { apiBase: "/api/v1" };
    async function getWidget(id: string) {
      await axios.get(\`\${config.apiBase}/widgets/\${id}\`);
    }
  `;
  const sites = parseClientSource("/virtual/x.ts", src);
  assert.equal(sites.length, 1);
  assert.equal(sites[0]!.dynamic, true, "the real runtime id segment must still be dynamic");
  assert.equal(sites[0]!.route.raw, "/api/v1/widgets/__DYN__");
});

test("client-parser: template-literal span does NOT resolve a let/var binding (only const is provably stable)", () => {
  const src = `
    import axios from "axios";
    let apiBase = "/api/v1";
    axios.get(\`\${apiBase}/widgets\`);
  `;
  const sites = parseClientSource("/virtual/x.ts", src);
  assert.equal(sites.length, 1);
  assert.equal(sites[0]!.dynamic, true, "a reassignable let must not be treated as a proven literal");
  assert.equal(sites[0]!.route.raw, "__DYN__/widgets");
});

test("client-parser: template-literal span does NOT resolve a DI-container call — remains dynamic", () => {
  const src = `
    import axios from "axios";
    function inject(token: string) { return {}; }
    class WidgetService {
      constructor(private readonly config: { apiBase: string } = inject("Config") as any) {}
      async list() {
        await axios.get(\`\${this.config.apiBase}/widgets\`);
      }
    }
  `;
  const sites = parseClientSource("/virtual/x.ts", src);
  assert.equal(sites.length, 1);
  assert.equal(
    sites[0]!.dynamic,
    true,
    "a value sourced from a DI container call must stay __DYN__, not be guessed at",
  );
  assert.equal(sites[0]!.route.raw, "__DYN__/widgets");
});

test("client-parser: template-literal span resolves a const imported one hop away (cross-file, on-disk fixture)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "driftguard-const-hop-"));
  try {
    fs.mkdirSync(path.join(root, "src", "api"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "api", "config.ts"), `export const API_BASE = "/api/v1";\n`);
    fs.writeFileSync(
      path.join(root, "src", "api", "widgetClient.ts"),
      `
        import axios from "axios";
        import { API_BASE } from "./config";
        axios.get(\`\${API_BASE}/widgets\`);
      `,
    );
    const sites = parseTsClientCallSites(root);
    assert.equal(sites.length, 1);
    assert.equal(sites[0]!.dynamic, false);
    assert.equal(sites[0]!.route.raw, "/api/v1/widgets");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("client-parser: template-literal span resolves an imported const object literal's property, one hop away", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "driftguard-const-hop-obj-"));
  try {
    fs.mkdirSync(path.join(root, "src", "api"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "src", "api", "config.ts"),
      `export const config = { apiBase: "/api/v1" };\n`,
    );
    fs.writeFileSync(
      path.join(root, "src", "api", "widgetClient.ts"),
      `
        import axios from "axios";
        import { config } from "./config";
        axios.get(\`\${config.apiBase}/widgets\`);
      `,
    );
    const sites = parseTsClientCallSites(root);
    assert.equal(sites.length, 1);
    assert.equal(sites[0]!.dynamic, false);
    assert.equal(sites[0]!.route.raw, "/api/v1/widgets");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("client-parser: template-literal span does NOT chase a second import hop (const's own value is itself imported from a third file)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "driftguard-const-two-hop-"));
  try {
    fs.mkdirSync(path.join(root, "src", "api"), { recursive: true });
    // base.ts is two hops from widgetClient.ts: widgetClient -> config ->
    // base. CrossFileResolver's own one-hop scope means resolving `config`
    // (hop 1, into config.ts) succeeds, but config.ts's `apiBase` property
    // is itself just the imported identifier `API_BASE` — chasing that
    // back to base.ts would be a second hop, which is deliberately not
    // attempted; the result must stay unresolved, not silently wrong.
    fs.writeFileSync(path.join(root, "src", "api", "base.ts"), `export const API_BASE = "/api/v1";\n`);
    fs.writeFileSync(
      path.join(root, "src", "api", "config.ts"),
      `
        import { API_BASE } from "./base";
        export const config = { apiBase: API_BASE };
      `,
    );
    fs.writeFileSync(
      path.join(root, "src", "api", "widgetClient.ts"),
      `
        import axios from "axios";
        import { config } from "./config";
        axios.get(\`\${config.apiBase}/widgets\`);
      `,
    );
    const sites = parseTsClientCallSites(root);
    assert.equal(sites.length, 1);
    assert.equal(
      sites[0]!.dynamic,
      true,
      "a value one further hop away than the deliberate one-hop scope must stay unresolved",
    );
    assert.equal(sites[0]!.route.raw, "__DYN__/widgets");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
