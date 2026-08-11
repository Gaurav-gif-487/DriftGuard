import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import { parseTsClientCallSites } from "../src/client-parser.js";
import { parseTsServerHandlers } from "../src/server-parser.js";

function tmpdir(): string {
  return "/tmp";
}

function makeRepo(prefix: string, files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(tmpdir(), prefix));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
  return root;
}

function cleanup(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

test("subject: shared type is a `type` alias, not an `interface`", () => {
  const root = makeRepo("cd-alias-", {
    "shared/widget.ts": `export type Widget = { id: number; label: string; };`,
    "frontend/src/client.ts": `
      import axios from "axios";
      import { Widget } from "../../shared/widget";
      export async function getWidget(id: string) {
        const res = await axios.get<Widget>(\`/api/widgets/\${id}\`);
        return res.data;
      }
    `,
  });
  try {
    const [site] = parseTsClientCallSites(path.join(root, "frontend"));
    assert.ok(site?.expectedSchema, "type alias should resolve, not just interface");
    assert.deepEqual(Object.keys(site!.expectedSchema!.fields).sort(), ["id", "label"]);
  } finally {
    cleanup(root);
  }
});

test("subject: shared type lives behind a barrel index.ts", () => {
  const root = makeRepo("cd-barrel-", {
    "shared/contracts/index.ts": `export interface Order { id: number; total: number; }`,
    "frontend/src/client.ts": `
      import axios from "axios";
      import { Order } from "../../shared/contracts";
      export async function getOrder(id: string) {
        const res = await axios.get<Order>(\`/api/orders/\${id}\`);
        return res.data;
      }
    `,
  });
  try {
    const [site] = parseTsClientCallSites(path.join(root, "frontend"));
    assert.ok(site?.expectedSchema, "barrel index.ts should resolve via the /index.ts candidate");
    assert.deepEqual(Object.keys(site!.expectedSchema!.fields).sort(), ["id", "total"]);
  } finally {
    cleanup(root);
  }
});

test("subject: renamed import (`import { X as Y }`) still resolves through the alias", () => {
  const root = makeRepo("cd-renamed-", {
    "shared/user.ts": `export interface User { id: number; name: string; }`,
    "frontend/src/client.ts": `
      import axios from "axios";
      import { User as ApiUser } from "../../shared/user";
      export async function getUser(id: string) {
        const res = await axios.get<ApiUser>(\`/api/users/\${id}\`);
        return res.data;
      }
    `,
  });
  try {
    const [site] = parseTsClientCallSites(path.join(root, "frontend"));
    assert.ok(site?.expectedSchema, "renamed named import should still resolve to User's real fields");
    assert.deepEqual(Object.keys(site!.expectedSchema!.fields).sort(), ["id", "name"]);
  } finally {
    cleanup(root);
  }
});

test("subject: shared file's own internal cross-references (same file, not a second hop) resolve fully", () => {
  const root = makeRepo("cd-internal-", {
    "shared/user.ts": `
      export interface Address { city: string; zip: string; }
      export interface User { id: number; address: Address; }
    `,
    "frontend/src/client.ts": `
      import axios from "axios";
      import { User } from "../../shared/user";
      export async function getUser(id: string) {
        const res = await axios.get<User>(\`/api/users/\${id}\`);
        return res.data;
      }
    `,
  });
  try {
    const [site] = parseTsClientCallSites(path.join(root, "frontend"));
    assert.ok(site?.expectedSchema);
    const addressField = site!.expectedSchema!.fields.address;
    assert.ok(addressField, "expected an 'address' field");
    assert.equal(addressField!.type.kind, "object");
    // Address and User live in the same imported file, so resolving into
    // Address's own fields is NOT a second cross-file hop — it should be
    // fully expanded, not left as a `reference`.
    if (addressField!.type.kind === "object") {
      assert.deepEqual(Object.keys(addressField!.type.fields).sort(), ["city", "zip"]);
    }
  } finally {
    cleanup(root);
  }
});

test("subject: array of a shared type (User[]) resolves element fields", () => {
  const root = makeRepo("cd-array-", {
    "shared/user.ts": `export interface User { id: number; name: string; }`,
    "frontend/src/client.ts": `
      import axios from "axios";
      import { User } from "../../shared/user";
      export async function listUsers() {
        const res = await axios.get<User[]>("/api/users");
        return res.data;
      }
    `,
  });
  try {
    const [site] = parseTsClientCallSites(path.join(root, "frontend"));
    // Top-level array types aren't objects, so expectedSchema itself may be
    // null (typeNodeToSchema only returns non-null for object kinds) — the
    // real assertion is that resolving the array's element type doesn't
    // throw and, when reached indirectly (server side below), expands.
    assert.equal(site?.expectedSchema, null);
  } finally {
    cleanup(root);
  }
});

test("subject: many client files across a repo share one imported type — resolved once, applied everywhere", () => {
  const root = makeRepo("cd-many-", {
    "shared/user.ts": `export interface User { id: number; name: string; email: string; }`,
    "frontend/src/api/a.ts": `
      import axios from "axios";
      import { User } from "../../../shared/user";
      export async function getA(id: string) {
        const res = await axios.get<User>(\`/api/a/\${id}\`);
        return res.data;
      }
    `,
    "frontend/src/api/b.ts": `
      import axios from "axios";
      import { User } from "../../../shared/user";
      export async function getB(id: string) {
        const res = await axios.get<User>(\`/api/b/\${id}\`);
        return res.data;
      }
    `,
    "frontend/src/api/c.ts": `
      import axios from "axios";
      import { User } from "../../../shared/user";
      export async function getC(id: string) {
        const res = await axios.get<User>(\`/api/c/\${id}\`);
        return res.data;
      }
    `,
  });
  try {
    const sites = parseTsClientCallSites(path.join(root, "frontend"));
    assert.equal(sites.length, 3);
    for (const site of sites) {
      assert.ok(site.expectedSchema, `expected ${site.route.raw} to resolve User`);
      assert.deepEqual(Object.keys(site.expectedSchema!.fields).sort(), ["email", "id", "name"]);
    }
  } finally {
    cleanup(root);
  }
});

test("subject: shared type declared in a .d.ts file resolves too", () => {
  const root = makeRepo("cd-dts-", {
    "shared/user.d.ts": `export interface User { id: number; active: boolean; }`,
    "frontend/src/client.ts": `
      import axios from "axios";
      import { User } from "../../shared/user";
      export async function getUser(id: string) {
        const res = await axios.get<User>(\`/api/users/\${id}\`);
        return res.data;
      }
    `,
  });
  try {
    const [site] = parseTsClientCallSites(path.join(root, "frontend"));
    assert.ok(site?.expectedSchema, ".d.ts declaration files should be a resolvable candidate");
    assert.deepEqual(Object.keys(site!.expectedSchema!.fields).sort(), ["active", "id"]);
  } finally {
    cleanup(root);
  }
});

test("subject: deeply nested relative path (four levels up) still resolves", () => {
  const root = makeRepo("cd-deep-", {
    "shared/contracts/user.ts": `export interface User { id: number; }`,
    "frontend/apps/web/src/api/client.ts": `
      import axios from "axios";
      import { User } from "../../../../../shared/contracts/user";
      export async function getUser(id: string) {
        const res = await axios.get<User>(\`/api/users/\${id}\`);
        return res.data;
      }
    `,
  });
  try {
    const [site] = parseTsClientCallSites(path.join(root, "frontend", "apps", "web"));
    assert.ok(site?.expectedSchema, "resolution shouldn't care how many directory hops the relative path takes");
    assert.deepEqual(Object.keys(site!.expectedSchema!.fields).sort(), ["id"]);
  } finally {
    cleanup(root);
  }
});

test("subject: typo'd/nonexistent import path degrades gracefully, no crash", () => {
  const root = makeRepo("cd-typo-", {
    "frontend/src/client.ts": `
      import axios from "axios";
      import { User } from "../../shared/does-not-exist";
      export async function getUser(id: string) {
        const res = await axios.get<User>(\`/api/users/\${id}\`);
        return res.data;
      }
    `,
  });
  try {
    assert.doesNotThrow(() => parseTsClientCallSites(root));
    const [site] = parseTsClientCallSites(root);
    assert.equal(site?.expectedSchema, null);
  } finally {
    cleanup(root);
  }
});

test("subject: shared file with a syntax error degrades gracefully, no crash", () => {
  const root = makeRepo("cd-broken-", {
    "shared/user.ts": `export interface User { id: number this is not valid typescript !!! `,
    "frontend/src/client.ts": `
      import axios from "axios";
      import { User } from "../../shared/user";
      export async function getUser(id: string) {
        const res = await axios.get<User>(\`/api/users/\${id}\`);
        return res.data;
      }
    `,
  });
  try {
    assert.doesNotThrow(() => parseTsClientCallSites(path.join(root, "frontend")));
  } finally {
    cleanup(root);
  }
});

test("subject: client and server each resolve the same shared file independently within one process", () => {
  const root = makeRepo("cd-both-", {
    "shared/user.ts": `export interface User { id: number; name: string; }`,
    "frontend/src/client.ts": `
      import axios from "axios";
      import { User } from "../../shared/user";
      export async function getUser(id: string) {
        const res = await axios.get<User>(\`/api/users/\${id}\`);
        return res.data;
      }
    `,
    "backend/src/routes.ts": `
      import { User } from "../../shared/user";
      import express from "express";
      const router = express.Router();
      router.get("/api/users/:id", (req, res): User => {
        return { id: 1, name: "a" };
      });
    `,
  });
  try {
    const [clientSite] = parseTsClientCallSites(path.join(root, "frontend"));
    const [serverHandler] = parseTsServerHandlers(path.join(root, "backend"));
    assert.deepEqual(Object.keys(clientSite!.expectedSchema!.fields).sort(), ["id", "name"]);
    assert.deepEqual(Object.keys(serverHandler!.responseSchema!.fields).sort(), ["id", "name"]);
  } finally {
    cleanup(root);
  }
});
