import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import { parseTsClientCallSites } from "../src/client-parser.js";
import { parseTsServerHandlers } from "../src/server-parser.js";

import os from "node:os";

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
}

/**
 * Sets up a monorepo-shaped tree:
 *
 *   <root>/shared/contracts/user.ts   <- outside both scanned roots
 *   <root>/frontend/src/...           <- scanned as --client
 *   <root>/backend/src/...            <- scanned as --server
 *
 * i.e. exactly the layout the README's "known limitation" bullet calls out:
 * a type imported from a shared package that lives one level outside the
 * scanned root.
 */
function makeMonorepo(): { root: string; frontend: string; backend: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "driftguard-monorepo-"));
  const frontend = path.join(root, "frontend");
  const backend = path.join(root, "backend");

  writeTree(root, {
    "shared/contracts/user.ts": `
      export interface User {
        id: number;
        name: string;
        email: string;
        role: "admin" | "member";
      }
    `,
    "frontend/src/api/userClient.ts": `
      import axios from "axios";
      import { User } from "../../../shared/contracts/user";

      export async function getUser(id: string) {
        const res = await axios.get<User>(\`/api/v1/users/\${id}\`);
        return res.data;
      }
    `,
    "backend/src/routes/users.ts": `
      import { User } from "../../../shared/contracts/user";
      import express from "express";
      const router = express.Router();

      router.get("/api/v1/users/:id", (req, res): User => {
        return { id: 1, name: "a", email: "a@x.com", role: "admin" };
      });
    `,
  });

  return { root, frontend, backend };
}

test("cross-file resolver: client-side generic resolves a type imported from a monorepo sibling shared/ package", () => {
  const { root, frontend } = makeMonorepo();
  try {
    const [site] = parseTsClientCallSites(frontend);
    assert.ok(site, "expected one call-site");
    assert.ok(site!.expectedSchema, "expected the User import to resolve to a real schema");
    assert.equal(site!.expectedSchema!.kind, "object");
    assert.deepEqual(
      Object.keys(site!.expectedSchema!.fields).sort(),
      ["email", "id", "name", "role"],
    );
    assert.equal(site!.expectedSchema!.fields.id!.type.kind, "primitive");
    assert.equal(site!.expectedSchema!.fields.role!.type.kind, "enum");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cross-file resolver: server-side return-type annotation resolves the same shared type", () => {
  const { root, backend } = makeMonorepo();
  try {
    const [handler] = parseTsServerHandlers(backend);
    assert.ok(handler, "expected one server handler");
    assert.ok(handler!.responseSchema, "expected the User import to resolve to a real schema");
    assert.deepEqual(
      Object.keys(handler!.responseSchema!.fields).sort(),
      ["email", "id", "name", "role"],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cross-file resolver: a bare (non-relative) package import still degrades to a reference placeholder", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "driftguard-barepkg-"));
  try {
    writeTree(root, {
      "src/api/client.ts": `
        import axios from "axios";
        import { Widget } from "@acme/contracts";

        export async function getWidget(id: string) {
          const res = await axios.get<Widget>(\`/api/widgets/\${id}\`);
          return res.data;
        }
      `,
    });
    const [site] = parseTsClientCallSites(root);
    assert.ok(site);
    // No node_modules resolution is attempted (by design, see README) — the
    // generic still degrades gracefully rather than throwing or fabricating
    // fields, exactly like an unresolved reference does today.
    assert.equal(site!.expectedSchema, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cross-file resolver: a second hop (shared file itself importing from a third file) is not chased", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "driftguard-secondhop-"));
  try {
    writeTree(root, {
      "base/id.ts": `export interface Id { id: number; }`,
      "shared/user.ts": `
        import { Id } from "../base/id";
        export interface User extends Id {
          name: string;
        }
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
    const [site] = parseTsClientCallSites(path.join(root, "frontend"));
    assert.ok(site);
    assert.ok(site!.expectedSchema, "the one-hop shared type itself should still resolve");
    // `User`'s own field resolves; the `extends Id` base (which itself lives
    // behind a second import hop from shared/user.ts) is a deliberate
    // boundary, so `id` isn't merged in. This documents the one-hop scope
    // rather than silently pretending full recursion happened.
    assert.deepEqual(Object.keys(site!.expectedSchema!.fields).sort(), ["name"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Shared types can be imported through a tsconfig `paths` alias
// (`@shared/*`) rather than a raw relative path. This remains a one-hop
// resolution through a different specifier-to-file lookup.
test("cross-file resolver: a tsconfig `paths` alias (@shared/*) resolves the same as a relative import", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "driftguard-alias-"));
  try {
    writeTree(root, {
      "shared/user.ts": `export interface User { id: number; name: string; }`,
      "frontend/tsconfig.json": JSON.stringify({
        compilerOptions: { paths: { "@shared/*": ["../shared/*"] } },
      }),
      "frontend/src/client.ts": `
        import axios from "axios";
        import { User } from "@shared/user";
        export async function getUser(id: string) {
          const res = await axios.get<User>(\`/api/users/\${id}\`);
          return res.data;
        }
      `,
    });
    const [site] = parseTsClientCallSites(path.join(root, "frontend"));
    assert.ok(site?.expectedSchema, "the @shared/* alias should resolve to the real User fields");
    assert.deepEqual(Object.keys(site!.expectedSchema!.fields).sort(), ["id", "name"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cross-file resolver: an alias with no matching tsconfig entry (and no matching file) still degrades gracefully", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "driftguard-alias-miss-"));
  try {
    writeTree(root, {
      "frontend/tsconfig.json": JSON.stringify({
        compilerOptions: { paths: { "@shared/*": ["../shared/*"] } },
      }),
      "frontend/src/client.ts": `
        import axios from "axios";
        import { Widget } from "@shared/widget";
        export async function getWidget(id: string) {
          const res = await axios.get<Widget>(\`/api/widgets/\${id}\`);
          return res.data;
        }
      `,
    });
    // No shared/widget.ts exists at all, so the alias resolves the specifier
    // but the file lookup itself misses.
    assert.doesNotThrow(() => parseTsClientCallSites(path.join(root, "frontend")));
    const [site] = parseTsClientCallSites(path.join(root, "frontend"));
    assert.equal(site?.expectedSchema, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Regression: found by hand-tracing resolveModuleFile/findTsconfigAliases
// end to end, then reproduced with a real fixture on disk before fixing.
// A very common Turborepo/Nx-style monorepo shape defines `paths` once in
// a shared root tsconfig.base.json, and every package's own tsconfig.json
// just does `{ "extends": "../../tsconfig.base.json" }` without repeating
// them. The nearest-tsconfig search correctly finds the package's own
// tsconfig.json, but before this fix it only ever read that file's own
// `compilerOptions.paths` — never followed `extends` — so it silently
// treated a monorepo with this (extremely common) layout as having no
// aliases at all, and every `@shared/*`-style import in it degraded to an
// unresolvable reference despite the tool otherwise supporting exactly
// this alias syntax.
test("cross-file resolver: a tsconfig `paths` alias declared only in a base config (via `extends`) still resolves — not just when declared directly", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "driftguard-alias-extends-"));
  try {
    writeTree(root, {
      "tsconfig.base.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@shared/*": ["packages/shared/*"] } },
      }),
      "packages/shared/contracts/user.ts": `export interface User { id: number; email: string; }`,
      "packages/frontend/tsconfig.json": JSON.stringify({
        extends: "../../tsconfig.base.json",
        compilerOptions: { outDir: "dist" },
      }),
      "packages/frontend/src/api/client.ts": `
        import axios from "axios";
        import { User } from "@shared/contracts/user";
        export async function getUser(id: string) {
          const res = await axios.get<User>(\`/api/v1/users/\${id}\`);
          return res.data;
        }
      `,
    });
    const [site] = parseTsClientCallSites(path.join(root, "packages/frontend"));
    assert.ok(
      site?.expectedSchema,
      "the @shared/* alias, declared only in the extended base config, should still resolve",
    );
    assert.deepEqual(Object.keys(site!.expectedSchema!.fields).sort(), ["email", "id"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cross-file resolver: a package's own tsconfig `paths` still take priority over an extended base config's paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "driftguard-alias-extends-override-"));
  try {
    writeTree(root, {
      "tsconfig.base.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@shared/*": ["packages/wrong-target/*"] } },
      }),
      "packages/shared/contracts/user.ts": `export interface User { id: number; email: string; }`,
      "packages/frontend/tsconfig.json": JSON.stringify({
        extends: "../../tsconfig.base.json",
        compilerOptions: { baseUrl: "../..", paths: { "@shared/*": ["packages/shared/*"] } },
      }),
      "packages/frontend/src/api/client.ts": `
        import axios from "axios";
        import { User } from "@shared/contracts/user";
        export async function getUser(id: string) {
          const res = await axios.get<User>(\`/api/v1/users/\${id}\`);
          return res.data;
        }
      `,
    });
    const [site] = parseTsClientCallSites(path.join(root, "packages/frontend"));
    assert.ok(site?.expectedSchema, "the package's own paths should be used, resolving successfully");
    assert.deepEqual(Object.keys(site!.expectedSchema!.fields).sort(), ["email", "id"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
