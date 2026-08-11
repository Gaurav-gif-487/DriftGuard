import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildContractGraph } from '../src/graph/GraphBuilder.js';

/**
 * Adversarial fixtures for route identity, matching, and parser boundaries.
 *
 * These cases are routed through the production parsers via
 * `buildContractGraph` against on-disk fixtures. They cover failure modes
 * that require the complete parser and graph pipeline.
 *
 * Covers the four patterns named in the "Still open" list:
 *   - object spread in a response literal
 *   - computed property names in a response literal
 *   - duplicate routes (same method+path declared twice)
 *   - cross-language boundaries (same route across TS/Python/Go)
 */

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cd-adversarial-'));
}

function writeClientServer(root: string, clientSrc: string, serverFiles: Record<string, string>) {
  const clientDir = path.join(root, 'client');
  const serverDir = path.join(root, 'server');
  fs.mkdirSync(clientDir, { recursive: true });
  fs.mkdirSync(serverDir, { recursive: true });
  fs.writeFileSync(path.join(clientDir, 'client.ts'), clientSrc);
  for (const [name, content] of Object.entries(serverFiles)) {
    fs.writeFileSync(path.join(serverDir, name), content);
  }
  return { clientDir, serverDir };
}

// --- Object spread -----------------------------------------------------

test('adversarial: object spread in a real response literal does not crash and known fields are still modeled', async () => {
  const root = tmpRoot();
  try {
    const { clientDir, serverDir } = writeClientServer(
      root,
      `export async function getWidget() {
  const res = await fetch("/api/v1/widget");
  return res.json();
}
`,
      {
        'widget.ts': `import express from "express";
const router = express.Router();
const defaults = { createdAt: "now", meta: {} };
router.get("/api/v1/widget", (req, res) => {
  res.json({ id: 1, name: "Widget", ...defaults });
});
export default router;
`,
      },
    );

    const graph = await buildContractGraph(clientDir, serverDir);
    const node = graph.getNode('contract:GET:/api/v1/widget');
    assert.ok(node, 'contract node should be discovered despite the spread');
    // Documented behavior (ts-value-resolver.ts): spread sources are not
    // expanded, so only the literal, directly-assigned keys are modeled.
    assert.deepEqual(Object.keys(node!.shape!.fields).sort(), ['id', 'name']);
    assert.equal(node!.shape!.fields['id']!.type.kind, 'primitive');
    assert.equal(node!.shape!.fields['name']!.type.kind, 'primitive');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- Computed property names --------------------------------------------

test('adversarial: computed property names in a real response literal do not crash and named fields are still modeled', async () => {
  const root = tmpRoot();
  try {
    const { clientDir, serverDir } = writeClientServer(
      root,
      `export async function getRecord() {
  const res = await fetch("/api/v1/record");
  return res.json();
}
`,
      {
        'record.ts': `import express from "express";
const router = express.Router();
const dynamicKey = "computedField";
router.get("/api/v1/record", (req, res) => {
  res.json({ [dynamicKey]: "x", id: 1, name: "Ada" });
});
export default router;
`,
      },
    );

    const graph = await buildContractGraph(clientDir, serverDir);
    const node = graph.getNode('contract:GET:/api/v1/record');
    assert.ok(node, 'contract node should be discovered despite the computed property');
    // Computed property names aren't nameable at parse time (no static
    // string), so they're skipped rather than inferred; named siblings
    // are still modeled correctly.
    assert.deepEqual(Object.keys(node!.shape!.fields).sort(), ['id', 'name']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- Duplicate routes (same language) ------------------------------------

test('adversarial: two handlers declaring the exact same method+path in the same file produce a real DUPLICATE_NODE_ID warning end-to-end, not a crash', async () => {
  const root = tmpRoot();
  try {
    const { clientDir, serverDir } = writeClientServer(
      root,
      `export async function getDup() {
  const res = await fetch("/api/v1/dup");
  return res.json();
}
`,
      {
        'dup.ts': `import express from "express";
const router = express.Router();
router.get("/api/v1/dup", (req, res) => {
  res.json({ version: 1 });
});
router.get("/api/v1/dup", (req, res) => {
  res.json({ version: 2 });
});
export default router;
`,
      },
    );

    const graph = await buildContractGraph(clientDir, serverDir);
    const result = graph.validate();
    assert.ok(
      result.warnings.some((w) => w.code === 'DUPLICATE_NODE_ID' && w.nodeId === 'contract:GET:/api/v1/dup'),
      'a real duplicate route declaration should surface as a DUPLICATE_NODE_ID warning, not be silently dropped',
    );
    // Last-write-wins (unchanged, documented ContractGraph.addNode behavior):
    // the second declaration in source order overwrites the first's node.
    const node = graph.getNode('contract:GET:/api/v1/dup');
    assert.equal(node!.shape!.fields['version']!.type.kind, 'primitive');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- Cross-language boundaries --------------------------------------------

test('adversarial: identical route path+method declared in both a TS and a Go handler in the same server dir is caught as DUPLICATE_NODE_ID across languages', async () => {
  const root = tmpRoot();
  try {
    const { clientDir, serverDir } = writeClientServer(
      root,
      `export async function getShared() {
  const res = await fetch("/api/v1/shared/1");
  return res.json();
}
`,
      {
        'shared.ts': `import express from "express";
const router = express.Router();
router.get("/api/v1/shared/:id", (req, res) => {
  res.json({ id: req.params.id, source: "ts" });
});
export default router;
`,
        'shared.go': `package main

import (
	"net/http"
	"github.com/gin-gonic/gin"
)

type Shared struct {
	ID     string \`json:"id"\`
	Source string \`json:"source"\`
}

func getShared(c *gin.Context) {
	c.JSON(http.StatusOK, Shared{ID: "1", Source: "go"})
}

func main() {
	router := gin.Default()
	router.GET("/api/v1/shared/:id", getShared)
	router.Run()
}
`,
      },
    );

    const graph = await buildContractGraph(clientDir, serverDir);
    const result = graph.validate();
    // Both handlers use the identical ":id" placeholder syntax, so their
    // route.raw strings are byte-identical and collide on the same
    // contractId regardless of which language produced them -- this is a
    // realistic mid-migration scenario (old TS route not yet deleted,
    // new Go route already added) and it must not be silently dropped.
    assert.ok(
      result.warnings.some((w) => w.code === 'DUPLICATE_NODE_ID' && w.nodeId === 'contract:GET:/api/v1/shared/:id'),
      'an identical route implemented in two different languages should surface as a cross-language DUPLICATE_NODE_ID warning',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('adversarial: the same logical route expressed with different per-language param syntax (":id" vs "{id}") does NOT collide -- documented current behavior, not a crash', async () => {
  const root = tmpRoot();
  try {
    const { clientDir, serverDir } = writeClientServer(
      root,
      `export async function getItem() {
  const res = await fetch("/api/v1/item/1");
  return res.json();
}
`,
      {
        'item.ts': `import express from "express";
const router = express.Router();
router.get("/api/v1/item/:id", (req, res) => {
  res.json({ id: req.params.id, source: "ts" });
});
export default router;
`,
        'item_service.py': `from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()

class Item(BaseModel):
    id: str
    source: str

@app.get("/api/v1/item/{id}")
def get_item(id: str) -> Item:
    return {"id": id, "source": "python"}
`,
      },
    );

    const graph = await buildContractGraph(clientDir, serverDir);
    const result = graph.validate();
    // route.raw is preserved verbatim per-framework (":id" vs "{id}"), so
    // contractId (derived from route.raw) does not unify these even though
    // they are the same logical endpoint. This means no duplicate-ID
    // warning fires here -- worth pinning explicitly as known/current
    // behavior (a false negative for this specific cross-language
    // ambiguity) rather than leaving it undocumented and assuming it's
    // handled.
    assert.deepEqual(
      result.warnings.filter((w) => w.code === 'DUPLICATE_NODE_ID'),
      [],
    );
    assert.ok(graph.getNode('contract:GET:/api/v1/item/:id'), 'TS route node exists');
    assert.ok(graph.getNode('contract:GET:/api/v1/item/{id}'), 'Python route node exists as a distinct node');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
