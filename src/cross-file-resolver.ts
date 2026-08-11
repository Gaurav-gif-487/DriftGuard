import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { buildTypeTable, type TypeTable } from "./ts-type-resolver.js";

/**
 * One-level cross-file / monorepo-shared-package type resolution.
 *
 * Deliberately scoped to a single hop: if `frontend/api/userClient.ts` does
 * `import { User } from "../../shared/contracts/user"`, we follow that one
 * relative import, parse `shared/contracts/user.ts` (which is very often
 * *outside* the scanned `--client`/`--server` root in a monorepo layout —
 * that's the whole point), and pull `User`'s declaration out of it.
 *
 * If *that* file in turn imports the type it re-exports from yet another
 * file, we don't chase the second hop — the reference degrades to a
 * `{kind:"reference", name}` placeholder, same as today. This mirrors the
 * project's existing bias: partial static resolution that fails safe into
 * "unverifiable" is preferable to either crashing or silently walking an
 * unbounded (and, with barrel files, potentially cyclic) import graph.
 *
 * Real-repo testing turned up a second, equally common shape of the same
 * problem: `import { User } from "@shared/user"`, resolved not through
 * node_modules but through a `compilerOptions.paths` alias in the nearest
 * tsconfig.json (very common — a bare `@shared/*` reads better than a pile
 * of `../..`). That's handled below too, still within the one-hop scope:
 * an alias is resolved to a file exactly like a relative specifier is,
 * just via a different lookup for the starting path. Finding *that*
 * alias, in turn, follows the nearest tsconfig's own `extends` chain
 * (relative specifiers only) when the config itself doesn't declare
 * `paths` — a very common monorepo layout is a single shared root
 * `tsconfig.base.json` declaring `paths` once, with every package's own
 * tsconfig just extending it.
 */

interface ImportOrigin {
  /** The module specifier exactly as written, e.g. "../../shared/types"
   *  or "@shared/user". */
  specifier: string;
  /** The name as exported from that module (handles `import { X as Y }`). */
  importedName: string;
}

/** Maps a locally-used identifier to where it was imported from. Relative
 *  specifiers (`./`, `../`) are always recorded. Bare specifiers
 *  (`@company/contracts`, `lodash`) are recorded too, but only ever resolve
 *  to a file if they match a `paths` alias in the nearest tsconfig — a
 *  genuine node_modules package import still isn't followed (see the
 *  README's zero-registry-access note). */
function buildImportMap(sourceFile: ts.SourceFile): Map<string, ImportOrigin> {
  const map = new Map<string, ImportOrigin>();
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const specifier = stmt.moduleSpecifier.text;

    const clause = stmt.importClause;
    if (!clause || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) {
      continue;
    }
    for (const el of clause.namedBindings.elements) {
      const localName = el.name.text;
      const importedName = (el.propertyName ?? el.name).text;
      map.set(localName, { specifier, importedName });
    }
  }
  return map;
}

const CANDIDATE_SUFFIXES = ["", ".ts", ".tsx", ".d.ts", "/index.ts", "/index.tsx"];

/** Probes the usual TS extension/index-file candidates for a base path
 *  that's already been resolved to an absolute location on disk (either a
 *  relative-import target or a tsconfig `paths` alias target). */
function resolveFileCandidates(base: string): string | null {
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = base + suffix;
    // A bare specifier can land on an existing *directory* (e.g. a barrel
    // package folder) before its /index.ts suffix is tried — existsSync is
    // true for directories too, so without this check we'd "resolve" to an
    // unreadable directory and silently give up instead of falling through
    // to the index-file candidate.
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

interface TsconfigAliases {
  /** Absolute directory that `paths` targets are resolved relative to
   *  (the tsconfig's own directory + its `baseUrl`, defaulting to "."). */
  baseDir: string;
  /** Raw `compilerOptions.paths` map, e.g. `{ "@shared/*": ["../shared/*"] }`. */
  paths: Record<string, string[]>;
}

/** Strips `//` and `/* *‍/` comments so JSONC-flavored tsconfig files (which
 *  real ones almost always are) survive `JSON.parse`. Deliberately naive —
 *  doesn't account for comment-like text inside string values — but this
 *  is best-effort alias discovery, not a build tool: a misparse just means
 *  the alias isn't found, same as any other unresolvable reference. */
function stripJsonComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/,(\s*[}\]])/g, "$1");
}

interface RawTsconfig {
  compilerOptions?: { paths?: Record<string, string[]>; baseUrl?: string };
  extends?: string;
}

function readRawTsconfig(configPath: string): RawTsconfig | null {
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    return JSON.parse(stripJsonComments(raw)) as RawTsconfig;
  } catch {
    return null;
  }
}

/** Resolves an `extends` specifier to an actual tsconfig file on disk.
 *  Only relative specifiers (`./`, `../`) are followed — a bare specifier
 *  would mean pulling a shareable-config *package* out of node_modules,
 *  which this project deliberately never touches (see the README's
 *  zero-registry-access note; the same reasoning that keeps this tool from
 *  resolving `import` specifiers into node_modules applies here). `tsc`
 *  itself defaults a missing `.json` extension on an `extends` target. */
function resolveExtends(fromConfigPath: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromConfigPath), specifier);
  const candidate = base.endsWith(".json") ? base : `${base}.json`;
  return fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? candidate : null;
}

/** Reads `paths`/`baseUrl` out of `configPath`, following `extends` chains
 *  when the config itself doesn't declare `paths` — a very common
 *  monorepo shape (Turborepo/Nx-style: one shared root tsconfig.base.json
 *  declares `paths`, and every package's own tsconfig.json just does
 *  `{ "extends": "../../tsconfig.base.json" }` without repeating them).
 *  Per `tsc`'s own semantics, `baseUrl` is resolved relative to whichever
 *  config file actually declares it — not necessarily the leaf config a
 *  source file's nearest-tsconfig search landed on — so the returned
 *  `baseDir` is anchored to that declaring file. Depth-capped against a
 *  pathological (or accidentally cyclic) `extends` chain. */
function readAliasesFollowingExtends(configPath: string, depth = 0): TsconfigAliases | null {
  if (depth > 10) return null;
  const parsed = readRawTsconfig(configPath);
  if (!parsed) return null;

  const paths = parsed.compilerOptions?.paths;
  if (paths && Object.keys(paths).length > 0) {
    const configDir = path.dirname(configPath);
    const baseDir = parsed.compilerOptions?.baseUrl
      ? path.resolve(configDir, parsed.compilerOptions.baseUrl)
      : configDir;
    return { baseDir, paths };
  }

  if (parsed.extends) {
    const parentPath = resolveExtends(configPath, parsed.extends);
    if (parentPath) return readAliasesFollowingExtends(parentPath, depth + 1);
  }
  return null;
}

/** Walks upward from `startDir` looking for the nearest tsconfig.json and
 *  extracts its `paths` alias map, following an `extends` chain from that
 *  nearest config if it doesn't declare `paths` directly. Returns `null`
 *  if no tsconfig is found, or the nearest one (and everything it
 *  transitively extends) declares no `paths`. */
function findTsconfigAliases(startDir: string): TsconfigAliases | null {
  let dir = startDir;
  for (let i = 0; i < 20; i++) {
    const candidate = path.join(dir, "tsconfig.json");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      // The nearest tsconfig.json is the project boundary — its own
      // paths, or whatever it transitively extends, are what apply here.
      // We deliberately don't keep walking further up the *directory*
      // tree past this point even if extends resolution comes up empty:
      // a sibling/ancestor project's unrelated tsconfig shouldn't apply.
      return readAliasesFollowingExtends(candidate);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Resolves a bare specifier against a `paths` alias map, honoring the
 *  single-`*`-wildcard form TS supports (`"@shared/*": ["../shared/*"]`)
 *  as well as exact, non-wildcard entries. Tries every candidate target
 *  pattern for a matching alias key, in declaration order, same as `tsc`. */
function resolveViaPathAlias(specifier: string, aliases: TsconfigAliases): string | null {
  for (const [pattern, targets] of Object.entries(aliases.paths)) {
    const starIndex = pattern.indexOf("*");
    if (starIndex === -1) {
      if (pattern !== specifier) continue;
      for (const target of targets) {
        const resolved = resolveFileCandidates(path.resolve(aliases.baseDir, target));
        if (resolved) return resolved;
      }
      continue;
    }
    const prefix = pattern.slice(0, starIndex);
    const suffix = pattern.slice(starIndex + 1);
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
    const matched = specifier.slice(prefix.length, specifier.length - suffix.length);
    for (const target of targets) {
      const substituted = target.replace("*", matched);
      const resolved = resolveFileCandidates(path.resolve(aliases.baseDir, substituted));
      if (resolved) return resolved;
    }
  }
  return null;
}

/** Resolves a module specifier written in `fromFile` to an actual file on
 *  disk — either a relative import, walked straight from `fromFile`'s
 *  directory, or a bare specifier matched against the nearest tsconfig's
 *  `paths` aliases. Explicitly allowed to land outside the scanned root —
 *  that's how a sibling `shared/` package in a monorepo gets picked up. */
function resolveModuleFile(fromFile: string, specifier: string): string | null {
  if (specifier.startsWith(".")) {
    return resolveFileCandidates(path.resolve(path.dirname(fromFile), specifier));
  }
  const aliases = findTsconfigAliases(path.dirname(fromFile));
  if (!aliases) return null;
  return resolveViaPathAlias(specifier, aliases);
}

/** Parses a file purely for its top-level type declarations. Never throws:
 *  an unreadable/unparsable external file just means resolution misses,
 *  same as any other unresolvable reference. */
function parseExternalTypeTable(filePath: string): TypeTable | null {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const scriptKind = filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKind);
  return buildTypeTable(sourceFile);
}

/** Parses a file purely to find its own top-level `const` declarations, so
 *  a cross-file value lookup (see `resolveImportedConstInitializer`) never
 *  has to reparse or re-walk the whole file per name. Cheap: only visits
 *  top-level `VariableStatement`s, not the full tree, since `const`
 *  bindings we're willing to treat as provably-constant are module-scope
 *  by construction (a `const` nested inside a function isn't importable). */
function parseExternalConstTable(filePath: string): Map<string, ts.Expression> | null {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const scriptKind = filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKind);
  const table = new Map<string, ts.Expression>();
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    if (!(stmt.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.initializer) {
        table.set(decl.name.text, decl.initializer);
      }
    }
  }
  return table;
}

/**
 * Resolves a name that's missing from a file's own type table by following
 * that file's import declarations one hop out. Caches parsed external type
 * tables by absolute path so a shared-package file imported from many
 * client/server files is only ever parsed once per run.
 */
export class CrossFileResolver {
  private readonly externalTables = new Map<string, TypeTable | null>();
  private readonly importMaps = new Map<string, Map<string, ImportOrigin>>();
  private readonly externalConstTables = new Map<string, Map<string, ts.Expression> | null>();

  private importMapFor(filePath: string, sourceFile: ts.SourceFile): Map<string, ImportOrigin> {
    let map = this.importMaps.get(filePath);
    if (!map) {
      map = buildImportMap(sourceFile);
      this.importMaps.set(filePath, map);
    }
    return map;
  }

  private tableFor(filePath: string): TypeTable | null {
    if (this.externalTables.has(filePath)) {
      return this.externalTables.get(filePath) ?? null;
    }
    const table = parseExternalTypeTable(filePath);
    this.externalTables.set(filePath, table);
    return table;
  }

  /** Looks up `name` as an import in `sourceFile` (whose path is
   *  `filePath`) and, if found, resolves and returns the declaration from
   *  the file it was imported from. Returns `null` if `name` isn't
   *  importable to a followable specifier (relative, or a bare specifier
   *  matching a tsconfig `paths` alias), or the target file can't be
   *  found/parsed, or it doesn't actually export that name. */
  resolveImportedType(
    name: string,
    filePath: string,
    sourceFile: ts.SourceFile,
  ): { decl: ts.InterfaceDeclaration | ts.TypeAliasDeclaration; table: TypeTable } | null {
    const origin = this.importMapFor(filePath, sourceFile).get(name);
    if (!origin) return null;

    const resolvedPath = resolveModuleFile(filePath, origin.specifier);
    if (!resolvedPath) return null;

    const externalTable = this.tableFor(resolvedPath);
    if (!externalTable) return null;

    const decl = externalTable.get(origin.importedName);
    if (!decl) return null;

    return { decl, table: externalTable };
  }

  private constTableFor(filePath: string): Map<string, ts.Expression> | null {
    if (this.externalConstTables.has(filePath)) {
      return this.externalConstTables.get(filePath) ?? null;
    }
    const table = parseExternalConstTable(filePath);
    this.externalConstTables.set(filePath, table);
    return table;
  }

  /** Looks up `name` as an import in `sourceFile` and, if it resolves to a
   *  followable specifier, returns the *initializer expression* of that
   *  name's top-level `const` declaration in the file it came from — e.g.
   *  for `import { config } from "./config"` where `config.ts` has
   *  `export const config = { apiBase: "..." }`, this returns the object
   *  literal `{ apiBase: "..." }` node itself.
   *
   *  Same one-hop scope as `resolveImportedType`: if the target file's
   *  `const` is itself just re-exporting a value imported from a third
   *  file, we don't chase that second hop — the caller treats it as
   *  unresolvable, same fail-safe bias as everywhere else in this file.
   *  Returns `null` for anything not a plain `const` (a `let`/`var`, or a
   *  named export we can't find), since only `const` is provably stable
   *  enough to treat as a fact rather than a guess. */
  resolveImportedConstInitializer(name: string, filePath: string, sourceFile: ts.SourceFile): ts.Expression | null {
    const origin = this.importMapFor(filePath, sourceFile).get(name);
    if (!origin) return null;

    const resolvedPath = resolveModuleFile(filePath, origin.specifier);
    if (!resolvedPath) return null;

    const constTable = this.constTableFor(resolvedPath);
    if (!constTable) return null;

    return constTable.get(origin.importedName) ?? null;
  }
}
