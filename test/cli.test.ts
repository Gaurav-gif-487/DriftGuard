import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../src/cli.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const cliEntry = path.join(packageRoot, "dist", "cli.js");

/** Runs the real built CLI as a subprocess. This exercises the actual
 *  packaged entry point (dist/cli.js, same as bin/driftguard.mjs
 *  loads) rather than calling main() in-process, so there's no risk of
 *  cross-test stdout/stderr interference and no divergence from what a
 *  user's shell actually sees. Requires `npm run build` to have run. */
async function runCli(
  args: string[],
  opts: { cwd?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("node", [cliEntry, ...args], {
      cwd: opts.cwd ?? packageRoot,
    });
    return { code: 0, stdout, stderr };
  } catch (err: any) {
    const rawCode = typeof err.exitCode === "number" ? err.exitCode : (typeof err.code === "number" ? err.code : (typeof err.status === "number" ? err.status : 1));
    const code = rawCode !== 0 ? (rawCode & 0xff) || 1 : 0;
    return { code, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

// ---------------------------------------------------------------------------
// parseArgs (pure function, no subprocess needed)
// ---------------------------------------------------------------------------

test("cli: parseArgs defaults threshold to 0.6 and format to text when unspecified", () => {
  const args = parseArgs(["--client=a", "--server=b"]);
  assert.equal(args.threshold, 0.6);
  assert.equal(args.format, "text");
});

test("cli: parseArgs stores a NaN threshold as-is (validation happens in main(), not here) — documents the boundary between parsing and validation so it doesn't silently move", () => {
  const args = parseArgs(["--client=a", "--server=b", "--threshold=not-a-number"]);
  assert.ok(Number.isNaN(args.threshold));
});

test("cli: parseArgs records a usage error on an unrecognized --format value instead of silently falling back to text (a bad --format in CI used to produce a human report nobody parsed, with no warning)", () => {
  const args = parseArgs(["--client=a", "--server=b", "--format=yaml"]);
  assert.equal(args.format, "text");
  assert.equal(args.errors.length, 1);
  assert.match(args.errors[0]!, /unknown --format value "yaml"/);
});

test("cli: parseArgs accepts the space-separated flag form (--client ./web), which was previously dropped on the floor and produced a bare help dump", () => {
  const args = parseArgs(["--client", "./web", "--server", "./api", "--threshold", "0.8", "--format", "json"]);
  assert.equal(args.client, "./web");
  assert.equal(args.server, "./api");
  assert.equal(args.threshold, 0.8);
  assert.equal(args.format, "json");
  assert.deepEqual(args.errors, []);
});

test("cli: parseArgs reports unknown flags and stray positional arguments rather than ignoring them", () => {
  const args = parseArgs(["--client=a", "--server=b", "--verbose", "extra.txt"]);
  assert.equal(args.errors.length, 2);
  assert.match(args.errors.join("\n"), /unknown flag "--verbose"/);
  assert.match(args.errors.join("\n"), /unexpected argument "extra.txt"/);
});

test("cli: parseArgs reports a value flag given with no value (--client at end of argv) instead of consuming the next flag as its value", () => {
  const args = parseArgs(["--server=b", "--client", "--strict"]);
  assert.equal(args.client, "");
  assert.equal(args.strict, true);
  assert.match(args.errors.join("\n"), /--client requires a value/);
});

// ---------------------------------------------------------------------------
// Real CLI invocations — threshold validation
//
// route-matcher.ts's acceptance check is `score >= threshold`, which is
// false for every score when threshold is NaN — so an unvalidated bad
// --threshold doesn't error, it just silently disables all fuzzy dynamic-
// route resolution. These tests pin the fix: the CLI must reject bad
// thresholds explicitly rather than let that happen quietly.
// ---------------------------------------------------------------------------

test("cli: rejects a non-numeric --threshold with exit code 1 and an explanatory message, instead of silently disabling fuzzy matching", async () => {
  const { code, stderr } = await runCli(["--client=fixtures/frontend", "--server=fixtures/backend", "--threshold=abc"]);
  assert.equal(code, 1);
  assert.match(stderr, /--threshold must be a number between 0 and 1/);
});

test("cli: rejects an out-of-range --threshold (>1)", async () => {
  const { code, stderr } = await runCli(["--client=fixtures/frontend", "--server=fixtures/backend", "--threshold=1.5"]);
  assert.equal(code, 1);
  assert.match(stderr, /--threshold must be a number between 0 and 1/);
});

test("cli: rejects a negative --threshold", async () => {
  const { code, stderr } = await runCli(["--client=fixtures/frontend", "--server=fixtures/backend", "--threshold=-0.1"]);
  assert.equal(code, 1);
  assert.match(stderr, /--threshold must be a number between 0 and 1/);
});

test("cli: accepts boundary threshold values 0 and 1 (non-regression: the range check must be inclusive)", async () => {
  const r0 = await runCli(["--client=fixtures/frontend", "--server=fixtures/backend", "--threshold=0", "--format=json"]);
  const r1 = await runCli(["--client=fixtures/frontend", "--server=fixtures/backend", "--threshold=1", "--format=json"]);
  assert.doesNotMatch(r0.stderr, /--threshold must be/);
  assert.doesNotMatch(r1.stderr, /--threshold must be/);
});

// ---------------------------------------------------------------------------
// Real CLI invocations — directory validation and help (non-regression)
// ---------------------------------------------------------------------------

test("cli: prints help and exits 1 when --client/--server are missing", async () => {
  const { code, stdout } = await runCli([]);
  assert.equal(code, 1);
  assert.match(stdout, /USAGE/);
});

test("cli: exits 0 and prints help for --help without requiring --client/--server", async () => {
  const { code, stdout } = await runCli(["--help"]);
  assert.equal(code, 0);
  assert.match(stdout, /USAGE/);
});

test("cli: exits 1 with a clear message when --client points at a nonexistent directory", async () => {
  const { code, stderr } = await runCli(["--client=/nonexistent/does-not-exist", "--server=fixtures/backend"]);
  assert.equal(code, 1);
  assert.match(stderr, /client directory not found/);
});

// ---------------------------------------------------------------------------
// SARIF/markdown baseDir correctness
//
// location.file is always an absolute path rooted under the resolved
// --client directory (walkFiles / client-parser.ts). Before the fix,
// buildSarifReport/buildMarkdownComment were called with no baseDir, so
// they fell back to process.cwd() — correct only when the CLI happens to
// be invoked from the client repo root. These run the CLI from an
// unrelated cwd (os.tmpdir()) to prove the URIs stay clean regardless of
// invocation location, which is the actual bug scenario (CI working-
// directory, globally-installed CLI, subdirectory invocation, etc).
// ---------------------------------------------------------------------------

test("cli: SARIF artifactLocation.uri is repo-relative with no path traversal, even when invoked from a cwd unrelated to --client", async () => {
  const clientAbs = path.join(packageRoot, "fixtures", "frontend");
  const serverAbs = path.join(packageRoot, "fixtures", "backend");
  const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), "cli-cwd-test-"));
  try {
    const { stdout } = await runCli([`--client=${clientAbs}`, `--server=${serverAbs}`, "--format=sarif"], {
      cwd: scratchCwd,
    });
    const report = JSON.parse(stdout);
    const uris: string[] = report.runs[0].results.map(
      (r: any) => r.locations[0].physicalLocation.artifactLocation.uri,
    );
    assert.ok(uris.length > 0, "expected at least one SARIF result from the seeded fixtures");
    for (const uri of uris) {
      assert.ok(!uri.startsWith("/"), `expected repo-relative URI, got absolute-looking: ${uri}`);
      assert.ok(!uri.includes(".."), `expected no path traversal in URI (bug scenario), got: ${uri}`);
    }
  } finally {
    fs.rmSync(scratchCwd, { recursive: true, force: true });
  }
});

test("cli: markdown report file references are repo-relative with no path traversal, even when invoked from a cwd unrelated to --client", async () => {
  const clientAbs = path.join(packageRoot, "fixtures", "frontend");
  const serverAbs = path.join(packageRoot, "fixtures", "backend");
  const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), "cli-cwd-test-"));
  try {
    const { stdout } = await runCli([`--client=${clientAbs}`, `--server=${serverAbs}`, "--format=markdown"], {
      cwd: scratchCwd,
    });
    const codeSpans = [...stdout.matchAll(/Location: `([^`]+)`/g)].map((m) => m[1]!);
    assert.ok(codeSpans.length > 0, "expected at least one file reference from the seeded fixtures");
    for (const span of codeSpans) {
      const filePart = span.split(":")[0]!;
      assert.ok(!filePart.startsWith("/"), `expected repo-relative path, got absolute-looking: ${filePart}`);
      assert.ok(!filePart.includes(".."), `expected no path traversal (bug scenario), got: ${filePart}`);
    }
  } finally {
    fs.rmSync(scratchCwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Real CLI invocations — usage errors and output paths
// ---------------------------------------------------------------------------

test("cli: an unknown flag exits 1 with a specific message, not a silent help dump", async () => {
  const res = await runCli(["--demo", "--verbose"]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /unknown flag "--verbose"/);
  assert.match(res.stderr, /--help for usage/);
});

test("cli: the space-separated flag form runs a real analysis end-to-end (regression: it used to print help and exit 1)", async () => {
  const res = await runCli([
    "--client",
    path.join(packageRoot, "fixtures", "frontend"),
    "--server",
    path.join(packageRoot, "fixtures", "backend"),
  ]);
  assert.equal(res.code, 1); // fixtures contain seeded errors
  assert.match(res.stdout, /error\(s\)/);
  assert.doesNotMatch(res.stdout, /USAGE/);
});

test("cli: text output renders client-relative POSIX locations, not absolute machine paths, regardless of invocation cwd", async () => {
  const res = await runCli(["--demo"], { cwd: os.tmpdir() });
  assert.match(res.stdout, /at src\/api\/userClient\.ts:\d+:\d+/);
  assert.doesNotMatch(res.stdout, /at \/.*fixtures/);
});

// ---------------------------------------------------------------------------
// `validate` subcommand — exposes ContractGraph.validate() from the CLI.
// Needs a real git repo (gitRoot() shells out to `git rev-parse
// --show-toplevel`), so this builds a throwaway one rather than running
// against the package checkout.
// ---------------------------------------------------------------------------

function gitRepoWith(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "driftguard-validate-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
  return root;
}

test("cli: validate exits 0 with a clean-graph message when the graph has no structural issues", async () => {
  const root = gitRepoWith({
    "client/src/userClient.ts": `import axios from "axios";
export async function getUser() {
  const res = await axios.get("/api/v1/users");
  return res.data;
}
`,
    "server/src/users.ts": `import express from "express";
const router = express.Router();
router.get("/api/v1/users", (req, res) => {
  res.json({ id: 1, name: "Ada" });
});
export default router;
`,
  });
  try {
    const res = await runCli(["validate", "--client=client", "--server=server"], { cwd: root });
    assert.equal(res.code, 0);
    assert.match(res.stdout, /structurally valid/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cli: validate exits 1 and reports a DUPLICATE_NODE_ID warning as invalid --strict, but 0 without --strict since it's warning-severity", async () => {
  const root = gitRepoWith({
    "client/src/userClient.ts": `import axios from "axios";
export async function getUser() {
  const res = await axios.get("/api/v1/dup");
  return res.data;
}
`,
    "server/src/dup.ts": `import express from "express";
const router = express.Router();
router.get("/api/v1/dup", (req, res) => {
  res.json({ version: 1 });
});
router.get("/api/v1/dup", (req, res) => {
  res.json({ version: 2 });
});
export default router;
`,
  });
  try {
    const plain = await runCli(["validate", "--client=client", "--server=server"], { cwd: root });
    assert.equal(plain.code, 0); // warnings alone don't fail without --strict
    assert.match(plain.stdout, /DUPLICATE_NODE_ID/);

    const strict = await runCli(["validate", "--client=client", "--server=server", "--strict"], { cwd: root });
    assert.equal(strict.code, 1);
    assert.match(strict.stdout, /DUPLICATE_NODE_ID/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cli: validate --format=json emits the raw GraphValidationResult shape", async () => {
  const root = gitRepoWith({
    "client/src/userClient.ts": `import axios from "axios";
export async function getUser() {
  const res = await axios.get("/api/v1/users");
  return res.data;
}
`,
    "server/src/users.ts": `import express from "express";
const router = express.Router();
router.get("/api/v1/users", (req, res) => {
  res.json({ id: 1 });
});
export default router;
`,
  });
  try {
    const res = await runCli(["validate", "--client=client", "--server=server", "--format=json"], { cwd: root });
    assert.equal(res.code, 0);
    const parsed = JSON.parse(res.stdout);
    assert.deepEqual(Object.keys(parsed).sort(), ["errors", "valid", "warnings"]);
    assert.equal(parsed.valid, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cli: validate without --client/--server and no config file reports a clear usage error, not a stack trace", async () => {
  const root = gitRepoWith({ "readme.md": "empty repo, no config" });
  try {
    const res = await runCli(["validate"], { cwd: root });
    assert.equal(res.code, 2);
    assert.match(res.stderr, /validate requires --client\/--server or client\/server paths in driftguard\.config\.json/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// --server scope-mismatch diagnostic. Found running driftguard against a
// real repo (fastapi/full-stack-fastapi-template) where --server pointed at
// just the routes/ subdirectory: every one of the app's real endpoints came
// back unresolved, all for the identical structural reason, purely because
// the outer '/api/v1' prefix is applied one file above what was scanned.
// Deliberately conservative (total failure + minimum sample + uniform
// reason), so these tests cover both the fire and no-fire sides.
// ---------------------------------------------------------------------------

function writeScopeMismatchFixture(root: string, opts: { unresolvedCount: number; addOneResolved?: boolean }) {
  fs.mkdirSync(path.join(root, "client"), { recursive: true });
  fs.mkdirSync(path.join(root, "server"), { recursive: true });

  const names = ["widgets", "gadgets", "gizmos", "sprockets", "cogs"].slice(0, opts.unresolvedCount);
  const clientLines = names.map((n) => `fetch("/api/v1/${n}");`);
  fs.writeFileSync(path.join(root, "client", "api.ts"), clientLines.join("\n") + "\n");

  // The shared '/api/v1' prefix is intentionally outside the scanned root.
  const serverLines = names.map(
    (n) => `app.get("/${n}", (req, res) => { res.json({ id: "1" }); });`,
  );
  if (opts.addOneResolved) {
    // One route that DOES match exactly, unprefixed, to prove the
    // diagnostic correctly stays silent once there's a real mix.
    fs.writeFileSync(path.join(root, "client", "api.ts"), clientLines.join("\n") + `\nfetch("/health");\n`);
    serverLines.push(`app.get("/health", (req, res) => { res.json({ ok: true }); });`);
  }
  fs.writeFileSync(
    path.join(root, "server", "routes.ts"),
    `import express from "express";\nconst app = express();\n${serverLines.join("\n")}\n`,
  );
}

test("cli: --server scope-mismatch hint fires when all client calls fail for the identical no-exact-match reason", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-scope-mismatch-"));
  try {
    writeScopeMismatchFixture(root, { unresolvedCount: 5 });
    const res = await runCli([`--client=${path.join(root, "client")}`, `--server=${path.join(root, "server")}`]);
    assert.match(res.stdout, /doesn't cover the file\(s\) that mount a shared path prefix/);
    assert.match(res.stdout, /leading '\/api' segment/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cli: --server scope-mismatch hint stays silent once there's a real mix of resolved and unresolved routes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-scope-mismatch-mixed-"));
  try {
    writeScopeMismatchFixture(root, { unresolvedCount: 5, addOneResolved: true });
    const res = await runCli([`--client=${path.join(root, "client")}`, `--server=${path.join(root, "server")}`]);
    assert.doesNotMatch(res.stdout, /doesn't cover the file\(s\) that mount a shared path prefix/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cli: --server scope-mismatch hint stays silent below the minimum sample size, even with total failure", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-scope-mismatch-small-"));
  try {
    writeScopeMismatchFixture(root, { unresolvedCount: 2 });
    const res = await runCli([`--client=${path.join(root, "client")}`, `--server=${path.join(root, "server")}`]);
    assert.doesNotMatch(res.stdout, /doesn't cover the file\(s\) that mount a shared path prefix/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
