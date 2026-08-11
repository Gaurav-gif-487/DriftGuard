import Fastify from "fastify";
const fastify = Fastify();

// DRIFTED relative to the client's `Settings` interface in
// fixtures/frontend/src/api/settingsClient.ts:
//   - `bio` became optional (client still treats it as required)
//   - `nickname` became nullable (client never expects null)
//   - the `status` enum gained a `"pending_review"` variant the client's
//     contract doesn't declare (server ⊆ client is violated: the server can
//     now emit a value the client has no case for). Losing the `"banned"`
//     variant, by contrast, would NOT be drift under the same directional
//     rule, since every value the server can still emit remains one the
//     client already handles.
interface SettingsResponse {
  bio?: string;
  nickname: string | null;
  status: "active" | "inactive" | "pending_review";
}

fastify.get("/api/v1/settings/:id", async (req, reply): Promise<SettingsResponse> => {
  return { bio: "Building things.", nickname: null, status: "active" };
});

export default fastify;
