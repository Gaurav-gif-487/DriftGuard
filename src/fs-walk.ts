import fs, { type Dirent } from "node:fs";
import path from "node:path";

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "__pycache__",
  ".venv",
  "venv",
]);

/** Recursively collects file paths under `rootDir` whose extension is in
 *  `extensions` (e.g. `[".ts", ".tsx"]`), skipping common vendor/build dirs. */
export function walkFiles(rootDir: string, extensions: string[]): string[] {
  const results: string[] = [];
  if (!fs.existsSync(rootDir)) return results;

  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          stack.push(path.join(dir, entry.name));
        }
        continue;
      }
      const ext = path.extname(entry.name);
      if (extensions.includes(ext)) {
        results.push(path.join(dir, entry.name));
      }
    }
  }
  return results.sort();
}
