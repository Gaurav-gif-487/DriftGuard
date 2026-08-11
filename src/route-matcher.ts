import type {
  ClientCallSite,
  PathSegment,
  RouteMatch,
  RouteMatchExplanation,
  RouteTemplate,
  SegmentEvidence,
  ServerHandler,
  UnresolvedExplanation,
} from "./types.js";
import { exactRouteMatch } from "./route-template.js";

/**
 * Route classification strategy.
 *
 * The classifier interface isolates dynamic-route scoring from the matching
 * pipeline. The default implementation is deterministic and dependency-free.
 * A learned classifier can implement the same interface without changing
 * callers.
 */
export interface RouteClassifier {
  /** Returns a confidence in [0, 1] that `client` resolves to `server`. */
  score(client: RouteTemplate, server: RouteTemplate): number;
  /** Optional: segment-by-segment evidence behind `score`'s result, for
   *  surfacing *why* a fuzzy match (or near-miss) got the confidence it
   *  did. Optional because a future learned classifier (e.g. the ONNX seam
   *  described above) may not have a natural per-segment breakdown to
   *  offer — callers must treat its absence as "no explanation available",
   *  not as an error. */
  explain?(client: RouteTemplate, server: RouteTemplate): RouteMatchExplanation;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        (dp[i - 1]![j] as number) + 1,
        (dp[i]![j - 1] as number) + 1,
        (dp[i - 1]![j - 1] as number) + cost,
      );
    }
  }
  return dp[a.length]![b.length] as number;
}

function tokenSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length, 1);
  return Math.max(0, 1 - levenshtein(a, b) / maxLen);
}

function segmentScore(a: PathSegment, b: PathSegment): number {
  if (a.kind === "dynamic" || b.kind === "dynamic") {
    // A dynamic segment on either side plausibly matches anything in that
    // slot; only mildly discounted vs. a confirmed static match so a chain
    // of exact static segments still dominates the score.
    return 0.85;
  }
  return tokenSimilarity(a.value, b.value);
}

function renderSegment(seg: PathSegment): string {
  return seg.kind === "static" ? seg.value : `:${seg.name}`;
}

function segmentKind(a: PathSegment, b: PathSegment): SegmentEvidence["kind"] {
  if (a.kind === "dynamic" || b.kind === "dynamic") return "dynamic-compatible";
  return a.value === b.value ? "static-exact" : "static-fuzzy";
}

interface Alignment {
  segments: SegmentEvidence[];
  alignmentScore: number;
  lengthAgreement: number;
  finalScore: number;
}

/** The single source of truth for how a client/server route pair is
 *  scored. `score()` and `explain()` both delegate here so they can never
 *  drift apart — a per-segment explanation is only trustworthy if it's
 *  computed by literally the same walk that produced the number it's
 *  explaining, not a second, hand-synced copy of the loop. */
function align(client: RouteTemplate, server: RouteTemplate): Alignment {
  const maxLen = Math.max(client.segments.length, server.segments.length);
  if (maxLen === 0) return { segments: [], alignmentScore: 1, lengthAgreement: 1, finalScore: 1 };

  const minLen = Math.min(client.segments.length, server.segments.length);
  const segments: SegmentEvidence[] = [];
  let total = 0;

  for (let i = 0; i < minLen; i++) {
    const c = client.segments[i] as PathSegment;
    const s = server.segments[i] as PathSegment;
    const segScore = segmentScore(c, s);
    total += segScore;
    segments.push({
      index: i,
      client: renderSegment(c),
      server: renderSegment(s),
      kind: segmentKind(c, s),
      score: Math.round(segScore * 1000) / 1000,
    });
  }
  // Trailing segments present on only the longer side count as 0 toward
  // alignmentScore (divided by maxLen above) but are still worth showing —
  // they're exactly why two routes of different depth score lower.
  for (let i = minLen; i < maxLen; i++) {
    const c = client.segments[i];
    const s = server.segments[i];
    segments.push({
      index: i,
      client: c ? renderSegment(c) : "∅",
      server: s ? renderSegment(s) : "∅",
      kind: "unaligned",
      score: 0,
    });
  }

  const alignmentScore = total / maxLen; // unmatched trailing segments count as 0
  const lengthAgreement = minLen / maxLen; // penalize differing path depth
  const finalScore = alignmentScore * (0.7 + 0.3 * lengthAgreement);
  return { segments, alignmentScore, lengthAgreement, finalScore };
}

export class HeuristicRouteClassifier implements RouteClassifier {
  score(client: RouteTemplate, server: RouteTemplate): number {
    return align(client, server).finalScore;
  }

  explain(client: RouteTemplate, server: RouteTemplate): RouteMatchExplanation {
    const { segments, alignmentScore, lengthAgreement } = align(client, server);
    return { segments, alignmentScore, lengthAgreement };
  }
}

export interface MatchOptions {
  /** Minimum classifier score to accept a fuzzy (non-exact) route match. */
  confidenceThreshold?: number;
  /** Minimum score gap required between the best and second-best fuzzy
   * candidate. A smaller gap is treated as ambiguous and left unresolved. */
  ambiguityMargin?: number;
  classifier?: RouteClassifier;
}

export interface MatchResult {
  matches: RouteMatch[];
  /** Client call-sites that could not be confidently resolved to any
   *  server handler — these are reported as `unresolved-route` findings
   *  rather than silently dropped, since an orphaned client call is itself
   *  often a sign of drift (the endpoint moved or was removed). */
  unresolved: ClientCallSite[];
  /** Why each entry in `unresolved` ended up there, keyed by
   *  `ClientCallSite.id`, plus the closest candidate(s) when fuzzy scoring
   *  actually ran. Additive/optional to consume — existing code that only
   *  reads `unresolved` is unaffected. */
  unresolvedExplanations: Record<string, UnresolvedExplanation>;
}

const DEFAULT_THRESHOLD = 0.6;
const DEFAULT_AMBIGUITY_MARGIN = 0.05;

/**
 * Resolves every client call-site to the server handler it actually talks
 * to. Static routes are resolved by exact segment matching, matching the
 * spec's "standard static routes: exact string matching" requirement
 * precisely — no scoring, no ambiguity. Only when a client path was built
 * dynamically (template literal / concatenation) and no exact match exists
 * does the classifier get consulted.
 */
export function matchRoutes(
  clients: ClientCallSite[],
  servers: ServerHandler[],
  options: MatchOptions = {},
): MatchResult {
  const classifier = options.classifier ?? new HeuristicRouteClassifier();
  const threshold = options.confidenceThreshold ?? DEFAULT_THRESHOLD;

  const matches: RouteMatch[] = [];
  const unresolved: ClientCallSite[] = [];
  const unresolvedExplanations: Record<string, UnresolvedExplanation> = {};

  // Profiled at scale (see scripts/profile-scale.mjs): re-filtering the
  // *entire* server list by method on every client iteration makes this
  // function O(clients * servers) even before any route comparison happens.
  // On a synthetic 10k-file corpus that showed up as clearly super-linear
  // growth (2.4s at 4k files -> 8.5s at 8k), confirming the profiling note
  // This path is intentionally conservative when no structural evidence is available.
  // it. Routes are indexed by HTTP method, so a one-time method index
  // method index turns the repeated O(servers) scan into an O(1) lookup
  // plus O(candidates-for-that-method) work, which is the actual
  // irreducible cost of the comparison itself.
  const serversByMethod = new Map<string, ServerHandler[]>();
  // Secondary index, nested under method: bucket by segment count too.
  // exactRouteMatch (route-template.ts) rejects any pair whose segment
  // counts differ before comparing a single segment, so scanning
  // same-method servers of every *other* length is pure wasted work for
  // the exact-match phase specifically — it can never produce a match.
  // Real APIs mix route depths (`/users`, `/users/:id`,
  // `/users/:id/posts/:postId`, ...), so on a corpus that puts everything
  // on one HTTP method; keep the matcher conservative when route evidence is incomplete.
  // the method index), this turns the exact-match scan from
  // O(same-method-candidates) into O(same-method-and-same-depth-candidates)
  // per client — a real reduction whenever depths vary, with zero change
  // in which matches are found (exactRouteMatch's own length check made
  // the excluded candidates unmatchable regardless). Fuzzy matching below
  // deliberately keeps scanning across all same-method candidates
  // regardless of depth, since it intentionally scores cross-length pairs
  // (that's what `lengthAgreement` in align() is for) — narrowing by depth
  // there would silently change which candidates get considered, not just
  // how fast they're found.
  const serversByMethodAndLength = new Map<string, Map<number, ServerHandler[]>>();
  for (const server of servers) {
    const bucket = serversByMethod.get(server.method);
    if (bucket) {
      bucket.push(server);
    } else {
      serversByMethod.set(server.method, [server]);
    }

    let byLength = serversByMethodAndLength.get(server.method);
    if (!byLength) {
      byLength = new Map();
      serversByMethodAndLength.set(server.method, byLength);
    }
    const length = server.route.segments.length;
    const lengthBucket = byLength.get(length);
    if (lengthBucket) {
      lengthBucket.push(server);
    } else {
      byLength.set(length, [server]);
    }
  }

  for (const client of clients) {
    const sameMethod = serversByMethod.get(client.method) ?? [];

    if (sameMethod.length === 0) {
      unresolved.push(client);
      unresolvedExplanations[client.id] = { reason: "no-same-method-candidates" };
      continue;
    }

    // A client path whose every segment is a runtime value (e.g. a base URL
    // held in a variable, `fetch(url)`) carries zero literal evidence. Scoring
    // it against server routes is meaningless: segmentScore() awards 0.85 to
    // any dynamic-vs-anything pair, so *every* same-depth handler ties at the
    // same number and the finding degrades into a misleading "top two
    // candidates were too close to call — /items/ vs /users/". Observed on a
    // real repo (fastapi/full-stack-fastapi-template, generated client code).
    // Report it for what it is instead of implying two plausible candidates.
    // This runs *before* exact matching too: a single-segment `__DYN__` client
    // path is structurally "exact" against every one-segment dynamic handler
    // (`/:slug`, `/:username`), which on the RealWorld React+Gin pair produced
    // an "ambiguous between 2 structurally identical server handlers" note that
    // mischaracterized the cause — the handlers aren't the problem, the
    // evidence-free client path is.
    const hasStaticEvidence = client.route.segments.some((seg) => seg.kind === "static");
    if (!hasStaticEvidence) {
      unresolved.push(client);
      unresolvedExplanations[client.id] = { reason: "opaque-dynamic-route" };
      continue;
    }

    // exactRouteMatch treats any dynamic-vs-dynamic segment pair as
    // compatible regardless of param name (":id" matches ":userId"). That's
    // correct for a single candidate, but when *multiple* same-method server
    // handlers are structurally identical up to param naming, picking
    // whichever happens to come first is a silent, arbitrary guess — the
    // exact route is genuinely ambiguous between them and must not shadow
    // the ambiguity handling that already exists for fuzzy matches below.
    const sameMethodAndLength =
      serversByMethodAndLength.get(client.method)?.get(client.route.segments.length) ?? [];
    const exactMatches = sameMethodAndLength.filter((s) => exactRouteMatch(client.route, s.route));
    if (exactMatches.length === 1) {
      matches.push({ client, server: exactMatches[0] as ServerHandler, confidence: 1.0, strategy: "exact" });
      continue;
    }
    if (exactMatches.length > 1) {
      unresolved.push(client);
      unresolvedExplanations[client.id] = {
        reason: "multiple-exact-matches",
        candidates: exactMatches.map((server) => ({ server, confidence: 1.0 })),
      };
      continue;
    }

    // Fuzzy matching is only safe when the client route was actually
    // reconstructed from a dynamic expression. For a fully static client
    // route, failure to find an exact route is meaningful evidence that the
    // endpoint is missing/renamed; fuzzy matching here would create false
    // positives such as /users matching /user-settings.
    if (!client.dynamic) {
      unresolved.push(client);
      unresolvedExplanations[client.id] = { reason: "no-dynamic-route" };
      continue;
    }

    const scored = sameMethod
      .map((server, index) => ({ server, score: classifier.score(client.route, server.route), index }))
      // Preserve input order for exact score ties. This makes output stable
      // across runs while the ambiguity check below prevents unsafe ties from
      // being silently accepted.
      .sort((a, b) => b.score - a.score || a.index - b.index);

    const best = scored[0];
    const second = scored[1];
    const ambiguityMargin = options.ambiguityMargin ?? DEFAULT_AMBIGUITY_MARGIN;
    const ambiguous =
      best !== undefined &&
      second !== undefined &&
      best.score - second.score < ambiguityMargin;

    if (
      best !== undefined &&
      best.score >= threshold &&
      !ambiguous
    ) {
      matches.push({
        client,
        server: best.server,
        confidence: Math.round(best.score * 1000) / 1000,
        strategy: "fuzzy-sequence",
        explanation: classifier.explain?.(client.route, best.server.route),
      });
    } else {
      unresolved.push(client);
      const topCandidates = scored.slice(0, 2).map(({ server, score }) => ({
        server,
        confidence: Math.round(score * 1000) / 1000,
      }));
      unresolvedExplanations[client.id] = {
        reason: ambiguous && best !== undefined && best.score >= threshold ? "ambiguous" : "below-threshold",
        candidates: topCandidates,
      };
    }
  }

  return { matches, unresolved, unresolvedExplanations };
}
