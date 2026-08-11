import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRouteTemplate,
  stringifyRouteTemplate,
  exactRouteMatch,
} from "../src/route-template.js";

// ---------------------------------------------------------------------------
// Dynamic route syntax coverage. The matcher supports framework-specific
// dynamic segment syntax while preserving the original route string.
// ---------------------------------------------------------------------------

const DYNAMIC_SYNTAXES: Array<{ label: string; render: (name: string) => string }> = [
  { label: "Express/Fastify/Gin :param", render: (n) => `:${n}` },
  { label: "Next.js [param]", render: (n) => `[${n}]` },
  { label: "FastAPI {param}", render: (n) => `{${n}}` },
  { label: "Gin *wildcard", render: (n) => `*${n}` },
  { label: "driftguard internal __DYN__", render: () => "__DYN__" },
];

test("route-template: each dynamic syntax parses to a dynamic segment with the correct name", () => {
  for (const { label, render } of DYNAMIC_SYNTAXES) {
    const raw = `/api/v1/user/${render("userId")}`;
    const t = parseRouteTemplate(raw);
    assert.equal(t.segments.length, 4, label);
    const last = t.segments[3]!;
    assert.equal(last.kind, "dynamic", label);
    if (label.includes("__DYN__")) {
      // The internal placeholder deliberately can't recover a name.
      assert.equal((last as { name: string }).name, "?", label);
    } else {
      assert.equal((last as { name: string }).name, "userId", label);
    }
  }
});

test("route-template: [...slug] and [[...slug]] catch-all forms both parse to dynamic 'slug'", () => {
  for (const raw of ["/docs/[...slug]", "/docs/[[...slug]]"]) {
    const t = parseRouteTemplate(raw);
    const last = t.segments[t.segments.length - 1]!;
    assert.equal(last.kind, "dynamic");
    assert.equal((last as { name: string }).name, "slug", raw);
  }
});

test("route-template: every pair of dynamic syntaxes is mutually exact-matching, regardless of param name", () => {
  // Cross product of all syntaxes (excluding the nameless __DYN__ case,
  // covered separately below) at the same segment position — this is the
  // actual client/server symmetry claim: a client written against Express
  // (:id) must resolve against a FastAPI server ({id}) or Next.js server
  // ([id]) just as readily as against another Express server.
  const named = DYNAMIC_SYNTAXES.filter((s) => !s.label.includes("__DYN__"));
  for (const clientSyntax of named) {
    for (const serverSyntax of named) {
      const client = parseRouteTemplate(`/api/v1/widgets/${clientSyntax.render("id")}`);
      const server = parseRouteTemplate(`/api/v1/widgets/${serverSyntax.render("widgetId")}`);
      assert.equal(
        exactRouteMatch(client, server),
        true,
        `${clientSyntax.label} (client) vs ${serverSyntax.label} (server) should match despite differing param names`,
      );
      // Symmetry: swapping which side is "client" and which is "server"
      // must give the identical result, since exactRouteMatch has no
      // directional bias in its implementation.
      assert.equal(
        exactRouteMatch(server, client),
        exactRouteMatch(client, server),
        `${serverSyntax.label} vs ${clientSyntax.label} should be symmetric`,
      );
    }
  }
});

test("route-template: __DYN__ placeholder matches every other dynamic syntax too", () => {
  const placeholder = parseRouteTemplate("/api/v1/widgets/__DYN__");
  for (const { label, render } of DYNAMIC_SYNTAXES) {
    const other = parseRouteTemplate(`/api/v1/widgets/${render("id")}`);
    assert.equal(exactRouteMatch(placeholder, other), true, label);
  }
});

test("route-template: mixed multi-segment routes with different syntax per segment still match", () => {
  // Realistic drift scenario: a monorepo where the Next.js client hits a
  // Gin backend, and the two frameworks use entirely different dynamic
  // syntax on different segments of the *same* logical route.
  const client = parseRouteTemplate("/api/orgs/[orgId]/users/:userId");
  const server = parseRouteTemplate("/api/orgs/{org_id}/users/*rest");
  assert.equal(exactRouteMatch(client, server), true);
});

test("route-template: a dynamic segment never matches a static segment at the same position, across all syntaxes", () => {
  for (const { label, render } of DYNAMIC_SYNTAXES) {
    const dynamic = parseRouteTemplate(`/api/v1/widgets/${render("id")}`);
    const static_ = parseRouteTemplate("/api/v1/widgets/list");
    assert.equal(exactRouteMatch(dynamic, static_), false, label);
    assert.equal(exactRouteMatch(static_, dynamic), false, `${label} (reversed)`);
  }
});

test("route-template: differing segment counts never match, regardless of dynamic syntax used", () => {
  const short = parseRouteTemplate("/api/v1/widgets/:id");
  const long = parseRouteTemplate("/api/v1/widgets/{id}/reviews");
  assert.equal(exactRouteMatch(short, long), false);
});

test("route-template: stringify round-trips every dynamic syntax to the canonical ':name' form", () => {
  for (const { label, render } of DYNAMIC_SYNTAXES) {
    const t = parseRouteTemplate(`/api/v1/widgets/${render("id")}`);
    const canonical = stringifyRouteTemplate(t);
    if (label.includes("__DYN__")) {
      assert.equal(canonical, "/api/v1/widgets/:?", label);
    } else {
      assert.equal(canonical, "/api/v1/widgets/:id", label);
    }
  }
});

test("route-template: gin *wildcard with no name falls back to 'wildcard'", () => {
  const t = parseRouteTemplate("/static/*");
  const last = t.segments[t.segments.length - 1]!;
  assert.equal(last.kind, "dynamic");
  assert.equal((last as { name: string }).name, "wildcard");
});

test("route-template: query strings are stripped identically regardless of dynamic syntax used before them", () => {
  for (const { render } of DYNAMIC_SYNTAXES) {
    const t = parseRouteTemplate(`/api/v1/widgets/${render("id")}?expand=true&sort=asc`);
    assert.equal(t.segments.length, 4);
    assert.equal(t.raw.includes("?"), true, "raw retains the original string");
    assert.equal(
      t.segments.every((s) => !("value" in s) || !s.value.includes("?")),
      true,
    );
  }
});
