import Fastify from "fastify";
const fastify = Fastify();

interface Profile {
  id: number;
  displayName: string;
  verified: boolean;
}

fastify.get("/api/v1/profile/:id", async (req, reply): Promise<Profile> => {
  return { id: 7, displayName: "Ada Lovelace", verified: true };
});

export default fastify;
