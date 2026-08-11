import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseServerSource, parseTsServerHandlers } from "../src/server-parser.js";
import { parsePythonServerSource, parsePythonServerHandlers } from "../src/python-parser.js";
import { parseGoServerSource, parseGoServerHandlers } from "../src/go-parser.js";

test("server-parser: Express res.json(objectLiteral) infers schema from the literal shape", () => {
  const src = `
    import express from "express";
    const router = express.Router();
    router.get("/api/v1/users/:id", (req, res) => {
      res.json({ id: 1, name: "Ada", email: "ada@example.com" });
    });
  `;
  const [handler] = parseServerSource("/virtual/routes/users.ts", src);
  assert.equal(handler!.method, "GET");
  assert.equal(handler!.framework, "express");
  assert.deepEqual(Object.keys(handler!.responseSchema!.fields).sort(), ["email", "id", "name"]);
  assert.equal(handler!.responseSchema!.fields.id!.type.kind, "primitive");
});

test("server-parser: Fastify handler with explicit Promise<T> return type", () => {
  const src = `
    import Fastify from "fastify";
    const fastify = Fastify();
    interface Profile { id: number; verified: boolean; }
    fastify.get("/api/v1/profile/:id", async (req, reply): Promise<Profile> => {
      return { id: 1, verified: true };
    });
  `;
  const [handler] = parseServerSource("/virtual/routes/profile.ts", src);
  assert.equal(handler!.framework, "fastify");
  assert.deepEqual(Object.keys(handler!.responseSchema!.fields).sort(), ["id", "verified"]);
});

test("server-parser: Fastify shorthand return-object-literal (no annotation)", () => {
  const src = `
    import Fastify from "fastify";
    const fastify = Fastify();
    fastify.get("/api/v1/ping", async (req, reply) => {
      return { ok: true };
    });
  `;
  const [handler] = parseServerSource("/virtual/routes/ping.ts", src);
  assert.deepEqual(Object.keys(handler!.responseSchema!.fields), ["ok"]);
});

test("server-parser: Next.js App Router route.ts derives path + method from filesystem", () => {
  const src = `
    import { NextResponse } from "next/server";
    export async function GET(req) {
      return NextResponse.json({ id: 1, name: "Ada" });
    }
  `;
  const handlers = parseServerSource("/repo/app/api/users/[id]/route.ts", src);
  assert.equal(handlers.length, 1);
  assert.equal(handlers[0]!.method, "GET");
  assert.equal(handlers[0]!.framework, "nextjs");
  assert.equal(handlers[0]!.route.raw, "/api/users/:id");
});

test("server-parser: Next.js Pages Router splits handlers by req.method branch", () => {
  const src = `
    export default function handler(req, res) {
      if (req.method === "POST") {
        res.json({ created: true });
        return;
      }
      res.json({ items: [] });
    }
  `;
  const handlers = parseServerSource("/repo/pages/api/items.ts", src);
  const methods = handlers.map((h) => h.method).sort();
  assert.deepEqual(methods, ["POST"]);
  assert.equal(handlers[0]!.route.raw, "/api/items");
});

test("server-parser: Next.js Pages Router falls back to GET with no method branching", () => {
  const src = `
    export default function handler(req, res) {
      res.json({ items: [] });
    }
  `;
  const [handler] = parseServerSource("/repo/pages/api/items/[id].ts", src);
  assert.equal(handler!.method, "GET");
  assert.equal(handler!.route.raw, "/api/items/:id");
});

test("server-parser: Next.js Pages Router regression — res.json(identifier) resolves via the variable's type annotation, matching Express/Fastify/App Router (previously only inline object literals resolved; the identifier case silently produced a null/unverifiable schema)", () => {
  const src = `
    interface ItemDTO { id: number; name: string; }
    export default function handler(req, res) {
      const payload: ItemDTO = { id: 1, name: "Widget" };
      res.json(payload);
    }
  `;
  const [handler] = parseServerSource("/repo/pages/api/items.ts", src);
  assert.ok(handler!.responseSchema, "expected a resolved schema, not null/unverifiable");
  assert.deepEqual(Object.keys(handler!.responseSchema!.fields).sort(), ["id", "name"]);
});

test("server-parser: Next.js Pages Router regression — res.json(identifier) also resolves per-branch when split by req.method", () => {
  const src = `
    interface CreatedDTO { created: boolean; id: number; }
    export default function handler(req, res) {
      if (req.method === "POST") {
        const result: CreatedDTO = { created: true, id: 1 };
        res.json(result);
        return;
      }
      res.json({ items: [] });
    }
  `;
  const handlers = parseServerSource("/repo/pages/api/items.ts", src);
  const post = handlers.find((h) => h.method === "POST");
  assert.ok(post);
  assert.ok(post!.responseSchema, "expected the POST branch's identifier to resolve, not null");
  assert.deepEqual(Object.keys(post!.responseSchema!.fields).sort(), ["created", "id"]);
});

test("server-parser: Next.js Pages Router — res: NextApiResponse<T> generic wins over the res.json(...) call-site inference, mirroring FastAPI response_model precedence", () => {
  const src = `
    interface UserOut { id: number; name: string; }
    export default function handler(req: NextApiRequest, res: NextApiResponse<UserOut>) {
      res.json({ id: 1, name: "x", internal_secret: "leaked" });
    }
  `;
  const [handler] = parseServerSource("/repo/pages/api/users.ts", src);
  assert.ok(handler!.responseSchema, "expected the declared generic to resolve");
  assert.deepEqual(Object.keys(handler!.responseSchema!.fields).sort(), ["id", "name"]);
});

test("server-parser: Next.js Pages Router — NextApiResponse<T> generic applies per method branch", () => {
  const src = `
    interface CreatedDTO { created: boolean; id: number; }
    export default function handler(req: NextApiRequest, res: NextApiResponse<CreatedDTO>) {
      if (req.method === "POST") {
        res.json({ created: true, id: 1, extra: "dropped" });
        return;
      }
      res.json({ created: false, id: 2, extra: "also dropped" });
    }
  `;
  const handlers = parseServerSource("/repo/pages/api/items.ts", src);
  for (const h of handlers) {
    assert.ok(h.responseSchema);
    assert.deepEqual(Object.keys(h.responseSchema!.fields).sort(), ["created", "id"]);
  }
});

test("server-parser: Next.js Pages Router — bare NextApiResponse (no generic) falls back to call-site inference (non-regression)", () => {
  const src = `
    export default function handler(req, res: NextApiResponse) {
      res.json({ items: [] });
    }
  `;
  const [handler] = parseServerSource("/repo/pages/api/items.ts", src);
  assert.ok(handler!.responseSchema);
  assert.deepEqual(Object.keys(handler!.responseSchema!.fields), ["items"]);
});

test("server-parser: Next.js Pages Router — NextApiResponse<any> falls back to call-site inference (non-regression)", () => {
  const src = `
    export default function handler(req, res: NextApiResponse<any>) {
      res.json({ items: [] });
    }
  `;
  const [handler] = parseServerSource("/repo/pages/api/items.ts", src);
  assert.ok(handler!.responseSchema);
  assert.deepEqual(Object.keys(handler!.responseSchema!.fields), ["items"]);
});

test("server-parser: res.json(identifier) resolves via the variable's type annotation", () => {
  const src = `
    import express from "express";
    interface UserDTO { id: number; name: string; }
    const router = express.Router();
    router.get("/api/v1/users/:id", (req, res) => {
      const payload: UserDTO = { id: 1, name: "Ada" };
      res.json(payload);
    });
  `;
  const [handler] = parseServerSource("/virtual/routes/users.ts", src);
  assert.deepEqual(Object.keys(handler!.responseSchema!.fields).sort(), ["id", "name"]);
});

test("server-parser: res.json(identifier) resolves via the variable's object-literal initializer when untyped", () => {
  const src = `
    import express from "express";
    const router = express.Router();
    router.get("/api/v1/ping", (req, res) => {
      const body = { ok: true, ts: Date.now() };
      res.json(body);
    });
  `;
  const [handler] = parseServerSource("/virtual/routes/ping.ts", src);
  assert.deepEqual(Object.keys(handler!.responseSchema!.fields).sort(), ["ok", "ts"]);
});

test("server-parser: res.json(identifier) with an unresolvable initializer degrades to null (unverifiable), not a crash", () => {
  const src = `
    import express from "express";
    import { buildPayload } from "./helpers";
    const router = express.Router();
    router.get("/api/v1/unknown", (req, res) => {
      const body = buildPayload();
      res.json(body);
    });
  `;
  const [handler] = parseServerSource("/virtual/routes/unknown.ts", src);
  assert.equal(handler!.responseSchema, null);
});

test("python-parser: FastAPI handler resolves Pydantic BaseModel return type", async () => {
  const src = `
from fastapi import FastAPI
from pydantic import BaseModel
from typing import Optional, List

app = FastAPI()

class Item(BaseModel):
    id: int
    name: str
    tags: List[str]
    description: Optional[str] = None

@app.get("/api/v1/inventory/{item_id}")
def get_item(item_id: int) -> Item:
    return {"id": item_id, "name": "Widget", "tags": ["new"]}
`;
  const [handler] = await parsePythonServerSource("/virtual/inventory.py", src);
  assert.equal(handler!.method, "GET");
  assert.equal(handler!.framework, "fastapi");
  assert.equal(handler!.route.raw, "/api/v1/inventory/{item_id}");
  assert.deepEqual(
    handler!.route.segments.map((s) => s.kind),
    ["static", "static", "static", "dynamic"],
  );
  const fields = handler!.responseSchema!.fields;
  assert.equal(fields.id!.type.kind, "primitive");
  assert.equal(fields.tags!.type.kind, "array");
  assert.equal(fields.description!.optional, true);
  assert.equal(fields.description!.nullable, true);
});

test("python-parser: falls back to dict-literal return when there's no model annotation", async () => {
  const src = `
@app.get("/api/v1/health")
def health():
    return {"status": "ok", "uptime": 42}
`;
  const [handler] = await parsePythonServerSource("/virtual/health.py", src);
  assert.deepEqual(Object.keys(handler!.responseSchema!.fields).sort(), ["status", "uptime"]);
  assert.equal(handler!.responseSchema!.fields.uptime!.type.kind, "primitive");
});

test("python-parser: response_model= wins over both the return annotation and the dict literal FastAPI actually returns", async () => {
  // The single most idiomatic FastAPI pattern for filtering sensitive
  // fields: the handler (or its DB layer) returns more than the client
  // should see, and response_model is exactly the mechanism that strips
  // it before serialization. Inferring the schema from the return
  // statement instead of response_model would report a field to clients
  // that FastAPI never actually sends -- the opposite of what a
  // driftguard checker exists to catch.
  const src = `
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()

class UserOut(BaseModel):
    id: int
    name: str

@app.get("/users/{id}", response_model=UserOut)
def get_user(id: int):
    return {"id": id, "name": "x", "internal_secret": "leaked"}
`;
  const [handler] = await parsePythonServerSource("/virtual/users.py", src);
  const fields = handler!.responseSchema!.fields;
  assert.deepEqual(Object.keys(fields).sort(), ["id", "name"], "internal_secret must not leak into the contract");
  assert.equal(fields.id!.type.kind, "primitive");
  assert.equal(fields.id!.type.kind === "primitive" ? fields.id!.type.name : null, "number");
});

test("python-parser: response_model= still wins even when the handler also has a return-type annotation that disagrees with it", async () => {
  // response_model overrides the return annotation too, not just the bare
  // dict-literal fallback -- FastAPI's own precedence, which the parser
  // must mirror rather than trusting whichever signal happens to sit
  // syntactically closer to the return statement.
  const src = `
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()

class Internal(BaseModel):
    id: int
    password_hash: str

class UserOut(BaseModel):
    id: int
    name: str

@app.get("/users/{id}", response_model=UserOut)
def get_user(id: int) -> Internal:
    return {"id": id, "name": "x", "password_hash": "abc"}
`;
  const [handler] = await parsePythonServerSource("/virtual/users2.py", src);
  const fields = handler!.responseSchema!.fields;
  assert.deepEqual(Object.keys(fields).sort(), ["id", "name"]);
});

test("python-parser: APIRouter(prefix=...) is prepended to every route registered on that router", async () => {
  // Regression: `router = APIRouter(prefix="/api/v1")` followed by
  // `@router.get("/users/{id}")` used to report the bare "/users/{id}",
  // silently dropping the "/api/v1" prefix every real request actually
  // needs. Any client call to the real endpoint would never match this
  // handler, reporting spurious drift on every route in any FastAPI app
  // that uses APIRouter for organization -- the standard convention for
  // anything beyond a single-file toy app.
  const src = `
from fastapi import APIRouter

router = APIRouter(prefix="/api/v1")

@router.get("/users/{id}")
def get_user(id: int):
    return {"id": id}
`;
  const [handler] = await parsePythonServerSource("/virtual/users_router.py", src);
  assert.equal(handler!.route.raw, "/api/v1/users/{id}");
});

test("python-parser: a plain FastAPI() app (no APIRouter/prefix) is unaffected by prefix resolution", async () => {
  const src = `
from fastapi import FastAPI

app = FastAPI()

@app.get("/users/{id}")
def get_user(id: int):
    return {"id": id}
`;
  const [handler] = await parsePythonServerSource("/virtual/users_app.py", src);
  assert.equal(handler!.route.raw, "/users/{id}");
});

test("go-parser: Gin handler resolves struct-with-json-tags via c.JSON", async () => {
  const src = `
package main

import "github.com/gin-gonic/gin"

type OrderStatus struct {
	ID     string \`json:"id"\`
	Status string \`json:"status"\`
}

func getOrderStatus(c *gin.Context) {
	c.JSON(200, OrderStatus{ID: "1", Status: "shipped"})
}

func main() {
	router := gin.Default()
	router.GET("/api/v2/order-status/:id", getOrderStatus)
}
`;
  const [handler] = await parseGoServerSource("/virtual/order_service.go", src);
  assert.equal(handler!.method, "GET");
  assert.equal(handler!.framework, "gin");
  assert.deepEqual(Object.keys(handler!.responseSchema!.fields).sort(), ["id", "status"]);
});

test("go-parser: middleware-chained route registration resolves the real handler (last arg), not the first middleware", async () => {
  // `router.GET(path, ...middleware, handler)` is Gin's standard signature
  // -- any number of middleware functions between the path and the actual
  // handler, which is always the *last* argument. Regression: this used to
  // unconditionally take the second argument as the handler, so any
  // middleware-guarded route (auth, logging, rate-limiting -- i.e. most
  // real routes) silently resolved to the wrong function name and lost
  // its response schema entirely.
  const src = `
package main

type UserOut struct {
	ID   int    \`json:"id"\`
	Name string \`json:"name"\`
}

func authMiddleware(c *gin.Context) {}
func loggingMiddleware(c *gin.Context) {}

func getUser(c *gin.Context) {
	c.JSON(200, UserOut{ID: 1, Name: "x"})
}

func setup(router *gin.Engine) {
	router.GET("/users/:id", authMiddleware, loggingMiddleware, getUser)
}
`;
  const [handler] = await parseGoServerSource("/virtual/users_mw.go", src);
  assert.ok(handler, "route with middleware chain should still be recognized");
  assert.equal(handler!.route.raw, "/users/:id");
  assert.ok(handler!.responseSchema, "handler's response schema must resolve, not the middleware's (null)");
  assert.deepEqual(Object.keys(handler!.responseSchema!.fields).sort(), ["id", "name"]);
});

// --- AST-robustness regression tests -----------------------------------
// These specifically exercise formatting the old regex/line-based
// extractors could not handle: multi-line signatures, nested route
// groups, pointer/omitempty fields, and struct literals split across
// lines. A real AST walk handles all of these because it never depends on
// where a token happens to land within a line.

test("python-parser: multi-line decorator arguments and a wrapped return-type annotation still resolve", async () => {
  const src = `
class UserOut(BaseModel):
    id: int
    email: str

@app.get(
    "/api/v1/users/{id}",
    response_model=UserOut,
)
def get_user(
    id: int,
) -> UserOut:
    return UserOut(id=id, email="a@b.com")
`;
  const [handler] = await parsePythonServerSource("/virtual/users.py", src);
  assert.equal(handler!.method, "GET");
  assert.deepEqual(Object.keys(handler!.responseSchema!.fields).sort(), ["email", "id"]);
});

test("python-parser: nested Optional[List[Model]] resolves through two levels of generics", async () => {
  const src = `
class Tag(BaseModel):
    label: str

class Post(BaseModel):
    id: int
    tags: Optional[List[Tag]]

@app.get("/api/v1/posts/{id}")
def get_post(id: int) -> Post:
    return Post(id=id, tags=None)
`;
  const [handler] = await parsePythonServerSource("/virtual/posts.py", src);
  const tagsField = handler!.responseSchema!.fields.tags!;
  assert.equal(tagsField.optional, true);
  assert.equal(tagsField.nullable, true);
  assert.equal(tagsField.type.kind, "array");
  assert.equal((tagsField.type as { kind: "array"; element: { kind: string } }).element.kind, "object");
});

test("go-parser: two-level nested router groups still resolve the route", async () => {
  const src = `
package main

type Health struct {
	OK bool \`json:"ok"\`
}

func checkHealth(c *gin.Context) {
	c.JSON(200, Health{OK: true})
}

func main() {
	router := gin.Default()
	router2 := router.Group("/api")
	router2.GET("/v1/health", checkHealth)
}
`;
  const [handler] = await parseGoServerSource("/virtual/health.go", src);
  // Was "/v1/health" -- the "/api" prefix from router.Group("/api") was
  // silently dropped. Any client call to the real "/api/v1/health" would
  // never have matched this handler, reporting spurious drift on every
  // group-prefixed route (i.e. most routes in any non-trivial Gin app).
  assert.equal(handler!.route.raw, "/api/v1/health");
  assert.deepEqual(Object.keys(handler!.responseSchema!.fields), ["ok"]);
});

test("go-parser: group prefixes accumulate through multiple levels of nesting, with arbitrary (non-'router\\\\d*') variable names", async () => {
  const src = `
package main

type User struct {
	ID int \`json:"id"\`
}

func getUser(c *gin.Context) {
	c.JSON(200, User{ID: 1})
}

func main() {
	router := gin.Default()
	v1 := router.Group("/api/v1")
	admin := v1.Group("/admin")
	admin.GET("/users/:id", getUser)
}
`;
  const [handler] = await parseGoServerSource("/virtual/admin.go", src);
  assert.ok(handler, "route registered on a group variable named neither 'router' nor 'routerN' must still be recognized");
  assert.equal(handler!.route.raw, "/api/v1/admin/users/:id");
});

test("go-parser: pointer fields are optional+nullable and omitempty tags mark optional even without a pointer", async () => {
  const src = `
package main

type Profile struct {
	Name string \`json:"name"\`
	Bio  *string \`json:"bio"\`
	Age  int    \`json:"age,omitempty"\`
}

func getProfile(c *gin.Context) {
	c.JSON(200, Profile{Name: "x"})
}

func main() {
	router := gin.Default()
	router.GET("/api/v1/profile", getProfile)
}
`;
  const [handler] = await parseGoServerSource("/virtual/profile.go", src);
  const fields = handler!.responseSchema!.fields;
  assert.equal(fields.name!.optional, false);
  assert.equal(fields.bio!.optional, true);
  assert.equal(fields.bio!.nullable, true);
  assert.equal(fields.age!.optional, true);
});

test("go-parser: struct literal fields split across multiple lines still resolve via c.JSON", async () => {
  const src = `
package main

type Order struct {
	ID    string \`json:"id"\`
	Total int    \`json:"total"\`
}

func getOrder(c *gin.Context) {
	c.JSON(
		200,
		Order{
			ID:    "1",
			Total: 42,
		},
	)
}

func main() {
	router := gin.Default()
	router.GET("/api/v1/orders/:id", getOrder)
}
`;
  const [handler] = await parseGoServerSource("/virtual/order.go", src);
  assert.deepEqual(Object.keys(handler!.responseSchema!.fields).sort(), ["id", "total"]);
});

// See the matching test in test/client-parser.test.ts for the full
// explanation of what this reproduces and why it's caught (a plain,
// confirmed-catchable JS RangeError from the TS parser stack-overflowing
// on pathological input), not a hypothetical.
test("server-parser: parseTsServerHandlers survives a pathologically malformed file (stack-overflowing the parser) without losing other files' results", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "driftguard-server-pathological-"));
  try {
    fs.mkdirSync(path.join(root, "src", "routes"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "routes", "broken.ts"), "{".repeat(5000));
    fs.writeFileSync(
      path.join(root, "src", "routes", "good.ts"),
      `
        import express from "express";
        const router = express.Router();
        interface WidgetResponse { id: number; }
        router.get("/api/v1/widgets/:id", (req, res) => {
          const body: WidgetResponse = { id: 1 };
          res.json(body);
        });
        export default router;
      `,
    );
    let handlers: ReturnType<typeof parseTsServerHandlers> = [];
    assert.doesNotThrow(() => {
      handlers = parseTsServerHandlers(root);
    }, "a pathological file must not crash the whole scan");
    assert.equal(handlers.length, 1, "the valid file's handler should still be extracted");
    assert.equal(handlers[0]!.route.raw, "/api/v1/widgets/:id");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("python-parser: parsePythonServerHandlers survives a pathologically malformed file (stack-overflowing on deeply nested Optional[...]) without losing other files' results", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "driftguard-py-pathological-"));
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    const depth = 20000;
    const nestedType = "Optional[".repeat(depth) + "int" + "]".repeat(depth);
    fs.writeFileSync(
      path.join(root, "src", "broken.py"),
      `
        from fastapi import FastAPI
        from typing import Optional
        app = FastAPI()

        @app.get("/api/v1/deep")
        def get_deep() -> ${nestedType}:
            return {}
      `,
    );
    fs.writeFileSync(
      path.join(root, "src", "good.py"),
      `
        from fastapi import FastAPI
        from pydantic import BaseModel
        app = FastAPI()

        class Widget(BaseModel):
            id: int

        @app.get("/api/v1/widgets/{widget_id}")
        def get_widget(widget_id: int) -> Widget:
            return {"id": widget_id}
      `,
    );
    let handlers: Awaited<ReturnType<typeof parsePythonServerHandlers>> = [];
    await assert.doesNotReject(async () => {
      handlers = await parsePythonServerHandlers(root);
    }, "a pathological file must not crash the whole scan");
    assert.equal(handlers.length, 1, "the valid file's handler should still be extracted");
    assert.equal(handlers[0]!.route.raw, "/api/v1/widgets/{widget_id}");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("go-parser: parseGoServerHandlers survives a pathologically malformed file (stack-overflowing on a deeply nested pointer type) without losing other files' results", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "driftguard-go-pathological-"));
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    const depth = 20000;
    fs.writeFileSync(
      path.join(root, "src", "broken.go"),
      `
        package main

        import "github.com/gin-gonic/gin"

        type Deep struct {
        	Value ${"*".repeat(depth)}int \`json:"value"\`
        }

        func getDeep(c *gin.Context) {
        	c.JSON(200, Deep{})
        }
      `,
    );
    fs.writeFileSync(
      path.join(root, "src", "good.go"),
      `
        package main

        import "github.com/gin-gonic/gin"

        type Widget struct {
        	ID int \`json:"id"\`
        }

        func getWidget(c *gin.Context) {
        	c.JSON(200, Widget{ID: 1})
        }

        func main() {
        	router := gin.Default()
        	router.GET("/api/v1/widgets/:id", getWidget)
        	router.Run()
        }
      `,
    );
    let handlers: Awaited<ReturnType<typeof parseGoServerHandlers>> = [];
    await assert.doesNotReject(async () => {
      handlers = await parseGoServerHandlers(root);
    }, "a pathological file must not crash the whole scan");
    assert.equal(handlers.length, 1, "the valid file's handler should still be extracted");
    assert.equal(handlers[0]!.route.raw, "/api/v1/widgets/:id");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- package-qualified handler regression -------------------------------
// Regression: package-qualified Go handlers must be resolved instead of silently
// Gin project's handlers are split into their own package -- the standard
// layout for anything beyond a single-file toy -- registration reads
// `routes.AddOrder`, a `selector_expression`, not a bare `identifier`.
// `matchRouteCall` only ever accepted the latter, so every route in a
// realistically-structured project silently resolved to zero handlers.

test("go-parser: package-qualified handler (routes.AddOrder) is recognized, matching real multi-package Gin layouts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "driftguard-go-pkg-handler-"));
  try {
    fs.mkdirSync(path.join(root, "routes"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "routes", "orders.go"),
      `
package routes

import "github.com/gin-gonic/gin"

type Order struct {
	ID     string \`json:"id"\`
	Status string \`json:"status"\`
}

func AddOrder(c *gin.Context) {
	c.JSON(200, Order{ID: "1", Status: "pending"})
}

func GetOrders(c *gin.Context) {
	c.JSON(200, Order{ID: "1", Status: "pending"})
}
`,
    );
    fs.writeFileSync(
      path.join(root, "main.go"),
      `
package main

import (
	"github.com/gin-gonic/gin"
	"example.com/app/routes"
)

func main() {
	router := gin.Default()
	router.POST("/orders", routes.AddOrder)
	router.GET("/orders", routes.GetOrders)
	router.Run()
}
`,
    );
    const handlers = await parseGoServerHandlers(root);
    assert.equal(handlers.length, 2, "both package-qualified routes must be extracted, not silently zeroed");
    const byMethod = new Map(handlers.map((h) => [h.method, h]));
    assert.equal(byMethod.get("POST")!.route.raw, "/orders");
    assert.equal(byMethod.get("GET")!.route.raw, "/orders");
    // Cross-file schema resolution is a separate, larger piece of work this
    // fix does not attempt -- staying `null` here is the documented,
    // conservative fallback, not a silent failure.
    assert.equal(byMethod.get("POST")!.responseSchema, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("go-parser: package-qualified handler resolves its response schema when the bare function name is defined in the same file", async () => {
  // handlerName is looked up by bare function name (the selector's
  // `field`), matching how the identifier case already works. When that
  // name happens to be declared in the same file/tree -- not the common
  // cross-file layout, but syntactically nothing prevents it -- schema
  // resolution still succeeds, proving the fix doesn't needlessly widen to
  // *always* null just because the call site used a selector.
  const src = `
package main

import "github.com/gin-gonic/gin"

type Widget struct {
	ID int \`json:"id"\`
}

func GetWidget(c *gin.Context) {
	c.JSON(200, Widget{ID: 1})
}

func main() {
	router := gin.Default()
	router.GET("/widgets/:id", handlers.GetWidget)
}
`;
  const parsedHandlers = await parseGoServerSource("/virtual/widgets_selector.go", src);
  assert.equal(parsedHandlers.length, 1, "selector-expression handler must be recognized");
  assert.equal(parsedHandlers[0]!.route.raw, "/widgets/:id");
  assert.equal(parsedHandlers[0]!.method, "GET");
  assert.ok(parsedHandlers[0]!.responseSchema, "bare function name match should still resolve the schema");
  assert.deepEqual(Object.keys(parsedHandlers[0]!.responseSchema!.fields).sort(), ["id"]);
});
