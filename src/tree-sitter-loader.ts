import Parser from "web-tree-sitter";
import path from "node:path";
import { createRequire } from "node:module";

/**
 * Lazily initializes web-tree-sitter (a WASM build of tree-sitter, chosen
 * over the native `tree-sitter` npm package specifically because it needs
 * no node-gyp/native-compilation step on install — a real AST for
 * Python/Go without asking every consumer's machine or CI runner to have a
 * C toolchain) and loads the Python/Go grammar `.wasm` files bundled by
 * `tree-sitter-wasms`. Both the runtime and the grammars are cached as
 * module-level singletons so repeated calls across many files in a scan
 * only pay the WASM instantiation cost once.
 */

const require = createRequire(import.meta.url);

export type SupportedGrammar = "python" | "go";

let initPromise: Promise<void> | null = null;
const languageCache = new Map<SupportedGrammar, Promise<Parser.Language>>();
let languageLoadQueue: Promise<void> = Promise.resolve();

async function ensureInitialized(): Promise<void> {
  if (!initPromise) {
    initPromise = Parser.init();
  }
  await initPromise;
}

/** Resolves the `.wasm` grammar path via normal node_modules resolution
 *  (not a path relative to this file), so it works identically whether
 *  this module is run from `src/` (via tsx) or `dist/` (after `tsc`). */
function grammarWasmPath(grammar: SupportedGrammar): string {
  const pkgJsonPath = require.resolve("tree-sitter-wasms/package.json");
  return path.join(path.dirname(pkgJsonPath), "out", `tree-sitter-${grammar}.wasm`);
}

export async function getLanguage(grammar: SupportedGrammar): Promise<Parser.Language> {
  await ensureInitialized();
  let cached = languageCache.get(grammar);
  if (!cached) {
    cached = languageLoadQueue.then(() => Parser.Language.load(grammarWasmPath(grammar)));
    languageLoadQueue = cached.then(
      () => undefined,
      () => undefined,
    );
    languageCache.set(grammar, cached);
  }
  return cached;
}

/** Returns a fresh `Parser` instance bound to the requested grammar. A new
 *  `Parser` per call is cheap (it's the `Language` WASM load that's
 *  expensive and cached above) and avoids any shared-mutable-state
 *  surprises between files parsed concurrently via `Promise.all`. */
export async function getParser(grammar: SupportedGrammar): Promise<Parser> {
  const language = await getLanguage(grammar);
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}
