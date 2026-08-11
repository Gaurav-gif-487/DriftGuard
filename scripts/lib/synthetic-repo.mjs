// Shared synthetic client/server repo generator used by both
// scripts/profile-scale.mjs (parse+match scaling curve) and
// scripts/benchmark.mjs (per-stage graph/diff/impact benchmarks).
// Extracted so both scripts build repos the same way instead of two
// copies of the same fixture logic silently drifting apart.
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Builds a synthetic client/server repo pair with `fileCount` total files
 * (split evenly between client and server), 4 REST endpoints per server
 * file (GET/POST/PUT/DELETE, cycling through verbs the way real REST APIs
 * do rather than an all-GET worst case for the method-indexed matcher).
 *
 * @param {number} fileCount
 * @param {{ mutate?: boolean }} [opts] When `mutate` is true, every
 *   response type gets an extra `extra${i}: string` field and every other
 *   handler's `name` field is renamed to `label`, so the resulting repo
 *   pair is suitable as the "current" side of a diff/impact benchmark
 *   against a base build of the same fileCount with `mutate: false`.
 */
export function buildRepoPair(fileCount, opts = {}) {
  const { mutate = false } = opts;
  const root = mkdtempSync(path.join(tmpdir(), "cd-bench-"));
  const clientDir = path.join(root, "client");
  const serverDir = path.join(root, "server");
  mkdirSync(clientDir, { recursive: true });
  mkdirSync(serverDir, { recursive: true });

  const endpointsPerFile = 4;
  const halfCount = Math.max(1, Math.floor(fileCount / 2));
  for (let i = 0; i < halfCount; i++) {
    const nameField = mutate && i % 2 === 0 ? "label" : "name";
    const extraField = mutate ? `extra${i}: string;` : "";
    const extraInit = mutate ? `extra${i}: "x",` : "";

    const clientSrc = `
import { useQuery, useMutation } from "react-query";
export function useResource${i}(id: string) {
  return useQuery(["resource${i}", id], () =>
    fetch(\`/api/v1/resource${i}/\${id}\`).then((r) => r.json())
  );
}
export function useCreateResource${i}() {
  return useMutation((body: unknown) =>
    fetch(\`/api/v1/resource${i}\`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json())
  );
}
export function useUpdateResource${i}(id: string) {
  return useMutation((body: unknown) =>
    fetch(\`/api/v1/resource${i}/\${id}\`, { method: "PUT", body: JSON.stringify(body) }).then((r) => r.json())
  );
}
export function useDeleteResource${i}(id: string) {
  return useMutation(() =>
    fetch(\`/api/v1/resource${i}/\${id}\`, { method: "DELETE" }).then((r) => r.json())
  );
}
`.trim();
    writeFileSync(path.join(clientDir, `resource${i}.ts`), clientSrc);

    const serverSrc = `
import type { FastifyInstance } from "fastify";
interface Resource${i} { id: string; ${nameField}: string; ${extraField} }
export default function routes(app: FastifyInstance) {
  app.get("/api/v1/resource${i}/:id", async (req): Promise<Resource${i}> => {
    return { id: req.params.id, ${nameField}: "x", ${extraInit} };
  });
  app.post("/api/v1/resource${i}", async (): Promise<Resource${i}> => {
    return { id: "1", ${nameField}: "x", ${extraInit} };
  });
  app.put("/api/v1/resource${i}/:id", async (req): Promise<Resource${i}> => {
    return { id: req.params.id, ${nameField}: "x", ${extraInit} };
  });
  app.delete("/api/v1/resource${i}/:id", async (): Promise<void> => {});
}
`.trim();
    writeFileSync(path.join(serverDir, `resource${i}.ts`), serverSrc);
  }

  return { root, clientDir, serverDir, endpointPairs: halfCount * endpointsPerFile };
}
