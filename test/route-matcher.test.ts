import test from "node:test";
import assert from "node:assert";
import { matchRoutes, HeuristicRouteClassifier } from "../src/route-matcher.js";
import { parseRouteTemplate } from "../src/route-template.js";
import type { ClientCallSite, ServerHandler } from "../src/types.js";

let idCounter = 0;
function client(method: "GET" | "POST" | "DELETE", rawPath: string, dynamic = false): ClientCallSite {
  idCounter++;
  return {
    id: `c${idCounter}`,
    method,
    route: parseRouteTemplate(rawPath),
    dynamic,
    expectedSchema: null,
    framework: "unknown",
    location: { file: "client.ts", line: 1, column: 1 },
  };
}
function server(method: "GET" | "POST" | "DELETE", rawPath: string): ServerHandler {
  idCounter++;
  return {
    id: `s${idCounter}`,
    method,
    route: parseRouteTemplate(rawPath),
    responseSchema: null,
    framework: "express",
    location: { file: "server.ts", line: 1, column: 1 },
  };
}

test("route-matcher: exact static match gets confidence 1.0", () => {
  const c = client("GET", "/api/v1/health");
  const s = server("GET", "/api/v1/health");
  const { matches, unresolved } = matchRoutes([c], [s]);
  assert.equal(matches.length, 1);
  assert.equal(unresolved.length, 0);
  assert.equal(matches[0]!.confidence, 1.0);
  assert.equal(matches[0]!.strategy, "exact");
});

test("route-matcher: dynamic segment matches regardless of param name", () => {
  const c = client("GET", "/api/v1/users/__DYN__", true);
  const s = server("GET", "/api/v1/users/:id");
  const { matches } = matchRoutes([c], [s]);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.strategy, "exact");
});

test("route-matcher: exact matching correctly ignores same-method candidates of a different segment depth (segment-count index doesn't hide/misroute cross-depth pairs)", () => {
  const c = client("GET", "/api/v1/users/__DYN__", true);
  const wrongDepth1 = server("GET", "/api/v1/users"); // shallower — must not match
  const wrongDepth2 = server("GET", "/api/v1/users/:id/posts/:postId"); // deeper — must not match
  const right = server("GET", "/api/v1/users/:id");
  const { matches, unresolved } = matchRoutes([c], [wrongDepth1, wrongDepth2, right]);
  assert.equal(matches.length, 1);
  assert.equal(unresolved.length, 0);
  assert.equal(matches[0]!.server, right);
});

test("route-matcher: multiple-exact-matches ambiguity still fires when the tied candidates share both method AND segment depth (segment-count index doesn't accidentally split them into separate buckets)", () => {
  const c = client("GET", "/api/v1/users/__DYN__", true);
  const s1 = server("GET", "/api/v1/users/:id");
  const s2 = server("GET", "/api/v1/users/:userId");
  const decoy = server("GET", "/api/v1/users"); // different depth, must not interfere
  const { matches, unresolved, unresolvedExplanations } = matchRoutes([c], [s1, s2, decoy]);
  assert.equal(matches.length, 0);
  assert.equal(unresolved.length, 1);
  assert.equal(unresolvedExplanations[c.id]!.reason, "multiple-exact-matches");
  assert.equal(unresolvedExplanations[c.id]!.candidates?.length, 2);
});

test("route-matcher: fuzzy matching still considers same-method candidates of a different segment depth (unlike the exact-match phase, depth-crossing fuzzy comparisons are intentional)", () => {
  const c = client("GET", "/api/v1/user/__DYN__", true); // typo'd singular "user", one segment shorter than any real route below
  const s = server("GET", "/api/v1/users/:id/profile"); // different depth AND a typo'd static segment away
  const { matches } = matchRoutes([c], [s], { confidenceThreshold: 0.3, ambiguityMargin: 0 });
  assert.equal(matches.length, 1, "a cross-depth candidate must still be reachable by fuzzy scoring");
  assert.equal(matches[0]!.strategy, "fuzzy-sequence");
});

test("route-matcher: method mismatch never matches, even with identical paths", () => {
  const c = client("POST", "/api/v1/users");
  const s = server("GET", "/api/v1/users");
  const { matches, unresolved } = matchRoutes([c], [s]);
  assert.equal(matches.length, 0);
  assert.equal(unresolved.length, 1);
});

test("route-matcher: renamed static segment resolves via fuzzy sequence matching", () => {
  const c = client("GET", "/api/v2/orderstatus/__DYN__", true);
  const s = server("GET", "/api/v2/order-status/:id");
  const { matches } = matchRoutes([c], [s]);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.strategy, "fuzzy-sequence");
  assert.ok(matches[0]!.confidence > 0.6 && matches[0]!.confidence < 1.0);
});

test("route-matcher: unrelated paths of the same length stay below threshold", () => {
  const c = client("DELETE", "/api/v1/legacy/stats");
  const s = server("GET", "/api/v1/users/:id"); // different method AND different path
  const { unresolved } = matchRoutes([c], [s]);
  assert.equal(unresolved.length, 1);
});

test("route-matcher: fully opaque single-segment dynamic path is left unresolved, not force-matched", () => {
  const c = client("GET", "/__DYN__", true);
  const s = server("GET", "/api/v1/users/:id");
  const { matches, unresolved } = matchRoutes([c], [s], { confidenceThreshold: 0.6 });
  assert.equal(matches.length, 0);
  assert.equal(unresolved.length, 1);
});

test("HeuristicRouteClassifier: identical all-static templates score 1.0", () => {
  const classifier = new HeuristicRouteClassifier();
  const t = parseRouteTemplate("/api/v1/orders/summary");
  assert.equal(classifier.score(t, t), 1.0);
});

test("HeuristicRouteClassifier: identical templates containing a dynamic segment score high but discounted", () => {
  // Two dynamic segments always match (route resolution can't know the
  // param name matters), but that slot intentionally never contributes a
  // full 1.0 on its own — exact matching (not the classifier) is what
  // handles the "these are actually the same route" case for dynamic
  // segments; see route-matcher.ts's exactRouteMatch, which treats any
  // dynamic/dynamic pair as compatible regardless of score.
  const classifier = new HeuristicRouteClassifier();
  const t = parseRouteTemplate("/api/v1/orders/:id");
  const score = classifier.score(t, t);
  assert.ok(score > 0.9 && score < 1.0, `expected 0.9 < score < 1.0, got ${score}`);
});

test("route-matcher: threshold is configurable", () => {
  const c = client("GET", "/api/v2/orderstatus/__DYN__", true);
  const s = server("GET", "/api/v2/order-status/:id");
  const strict = matchRoutes([c], [s], { confidenceThreshold: 0.99 });
  assert.equal(strict.matches.length, 0);
  assert.equal(strict.unresolved.length, 1);
});

test("route-matcher: static route never fuzzy-matches a different path", () => {
  const c = client("GET", "/api/users");
  const s = server("GET", "/api/user-settings");
  const { matches, unresolved } = matchRoutes([c], [s]);
  assert.equal(matches.length, 0);
  assert.equal(unresolved.length, 1);
});

test("route-matcher: ambiguous fuzzy candidates remain unresolved", () => {
  const c = client("GET", "/api/users/__DYN__", true);
  const s1 = server("GET", "/api/users/:id");
  const s2 = server("GET", "/api/users/:userId");
  const { matches, unresolved } = matchRoutes([c], [s1, s2], {
    confidenceThreshold: 0.6,
    ambiguityMargin: 0.05,
  });
  assert.equal(matches.length, 0);
  assert.equal(unresolved.length, 1);
});

test("route-matcher: two structurally-exact same-method server handlers differing only by param name are ambiguous, not a silent first-match", () => {
  // Regression test: exactRouteMatch treats dynamic segments as compatible
  // regardless of param name, so /api/users/:id and /api/users/:userId are
  // both exact matches for a client dynamic call. Before the fix, .find()
  // silently returned whichever server was declared first instead of
  // surfacing the ambiguity.
  const c = client("GET", "/api/users/__DYN__", true);
  const s1 = server("GET", "/api/users/:id");
  const s2 = server("GET", "/api/users/:userId");
  const { matches, unresolved } = matchRoutes([c], [s1, s2]);
  assert.equal(matches.length, 0);
  assert.equal(unresolved.length, 1);
});

test("route-matcher: a single structurally-exact server handler still resolves confidently even with a differently-named param", () => {
  const c = client("GET", "/api/users/__DYN__", true);
  const s = server("GET", "/api/users/:userId");
  const { matches, unresolved } = matchRoutes([c], [s]);
  assert.equal(matches.length, 1);
  assert.equal(unresolved.length, 0);
  assert.equal(matches[0]!.strategy, "exact");
  assert.equal(matches[0]!.confidence, 1.0);
});

test("route-matcher: custom ambiguity margin can accept a clear winner", () => {
  const c = client("GET", "/api/orderstatus/__DYN__", true);
  const close = server("GET", "/api/order-state/:id");
  const winner = server("GET", "/api/order-status/:id");
  const { matches, unresolved } = matchRoutes([c], [close, winner], {
    confidenceThreshold: 0.6,
    ambiguityMargin: 0.001,
  });
  assert.equal(matches.length, 1);
  assert.equal(unresolved.length, 0);
  assert.equal(matches[0]!.server.id, winner.id);
});

// --- explanation / explainability (feature: --explain) -----------------

test("route-matcher: fuzzy matches carry a segment-by-segment explanation whose finalScore-equivalent matches the reported confidence", () => {
  const c = client("GET", "/api/v1/widgetz/__DYN__", true);
  const s = server("GET", "/api/v1/widgets/:id");
  const { matches } = matchRoutes([c], [s]);
  assert.equal(matches.length, 1);
  const explanation = matches[0]!.explanation;
  assert.ok(explanation, "expected an explanation on a fuzzy-sequence match");
  assert.equal(explanation!.segments.length, 4);
  assert.equal(explanation!.segments[0]!.kind, "static-exact");
  assert.equal(explanation!.segments[2]!.kind, "static-fuzzy"); // widgetz vs widgets
  assert.equal(explanation!.segments[3]!.kind, "dynamic-compatible");
  // The explanation's own numbers must reproduce the match's confidence via
  // the same formula the classifier uses, or the explanation would be
  // lying about why the score is what it is.
  const recomputed =
    explanation!.alignmentScore * (0.7 + 0.3 * explanation!.lengthAgreement);
  assert.ok(Math.abs(recomputed - matches[0]!.confidence) < 0.001);
});

test("route-matcher: exact matches carry no explanation (nothing to explain — the segments matched outright)", () => {
  const c = client("GET", "/api/v1/users/__DYN__", true);
  const s = server("GET", "/api/v1/users/:id");
  const { matches } = matchRoutes([c], [s]);
  assert.equal(matches[0]!.strategy, "exact");
  assert.equal(matches[0]!.explanation, undefined);
});

test("route-matcher: unresolved explanation reports 'no-same-method-candidates' when no server shares the HTTP method", () => {
  const c = client("DELETE", "/api/v1/widgets/1");
  const s = server("GET", "/api/v1/widgets/:id");
  const { unresolved, unresolvedExplanations } = matchRoutes([c], [s]);
  assert.equal(unresolved.length, 1);
  assert.equal(unresolvedExplanations[c.id]!.reason, "no-same-method-candidates");
});

test("route-matcher: unresolved explanation reports 'no-dynamic-route' for a static client path with no exact server match", () => {
  const c = client("GET", "/api/v1/widgets/all");
  const s = server("GET", "/api/v1/widgets/:id");
  const { unresolved, unresolvedExplanations } = matchRoutes([c], [s]);
  assert.equal(unresolved.length, 1);
  assert.equal(unresolvedExplanations[c.id]!.reason, "no-dynamic-route");
});

test("route-matcher: unresolved explanation reports 'multiple-exact-matches' with the ambiguous candidates listed", () => {
  const c = client("GET", "/api/users/__DYN__", true);
  const s1 = server("GET", "/api/users/:id");
  const s2 = server("GET", "/api/users/:userId");
  const { unresolved, unresolvedExplanations } = matchRoutes([c], [s1, s2]);
  assert.equal(unresolved.length, 1);
  const explanation = unresolvedExplanations[c.id]!;
  assert.equal(explanation.reason, "multiple-exact-matches");
  assert.equal(explanation.candidates?.length, 2);
});

test("route-matcher: unresolved explanation reports 'below-threshold' with the closest candidate and its score", () => {
  const c = client("GET", "/api/v1/completely-different-resource/__DYN__", true);
  const s = server("GET", "/api/v1/widgets/:id");
  const { unresolved, unresolvedExplanations } = matchRoutes([c], [s], { confidenceThreshold: 0.9 });
  assert.equal(unresolved.length, 1);
  const explanation = unresolvedExplanations[c.id]!;
  assert.equal(explanation.reason, "below-threshold");
  assert.equal(explanation.candidates?.length, 1);
  assert.equal(explanation.candidates?.[0]!.server.id, s.id);
});

test("route-matcher: unresolved explanation reports 'ambiguous' with both near-tied candidates when a margin rejects the near-tie", () => {
  const c = client("GET", "/api/orderstatus/__DYN__", true);
  const close = server("GET", "/api/order-state/:id");
  const winner = server("GET", "/api/order-status/:id");
  const { unresolved, unresolvedExplanations } = matchRoutes([c], [close, winner], {
    confidenceThreshold: 0.6,
    ambiguityMargin: 0.5, // artificially wide margin forces the otherwise-clear winner to read as ambiguous
  });
  assert.equal(unresolved.length, 1);
  const explanation = unresolvedExplanations[c.id]!;
  assert.equal(explanation.reason, "ambiguous");
  assert.equal(explanation.candidates?.length, 2);
});

test("route-matcher: a client path with no static segments is reported as opaque, not as a near-tie between arbitrary candidates (regression: real generated API clients build the whole URL at runtime and used to surface a misleading 'too close to call' between two unrelated routes)", () => {
  const c = client("GET", "__DYN__", true);
  const servers = [server("GET", "/items"), server("GET", "/users")];
  const { matches, unresolved, unresolvedExplanations } = matchRoutes([c], servers);
  assert.equal(matches.length, 0);
  assert.equal(unresolved.length, 1);
  assert.equal(unresolvedExplanations[c.id]?.reason, "opaque-dynamic-route");
  assert.equal(unresolvedExplanations[c.id]?.candidates, undefined);
});

test("route-matcher: an opaque client path is reported as opaque even when it is structurally 'exact' against several one-segment dynamic handlers (regression: RealWorld React+Gin pair blamed the server handlers for an evidence-free client URL)", () => {
  const c = client("GET", "__DYN__", true);
  const servers = [server("GET", "/:slug"), server("GET", "/:username")];
  const { matches, unresolved, unresolvedExplanations } = matchRoutes([c], servers);
  assert.equal(matches.length, 0);
  assert.equal(unresolved.length, 1);
  assert.equal(unresolvedExplanations[c.id]?.reason, "opaque-dynamic-route");
});
