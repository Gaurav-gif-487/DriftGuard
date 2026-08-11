import express from "express";
const router = express.Router();

// DRIFTED: `email` was dropped from the response and `age` now comes back
// as a string instead of a number. Both are breaking changes relative to
// the client's `User` interface in fixtures/frontend/src/api/userClient.ts.
router.get("/api/v1/users/:id", (req, res) => {
  res.json({
    id: 1,
    name: "Ada Lovelace",
    age: "34",
    role: "admin",
  });
});

// Clean / non-drifted: matches the client's expected shape exactly.
router.get("/api/v1/users", (req, res) => {
  res.json({
    users: [{ id: 1, name: "Ada Lovelace", email: "ada@example.com", age: 34, role: "admin" }],
  });
});

export default router;
