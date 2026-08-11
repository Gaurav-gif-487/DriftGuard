import axios from "axios";

export interface User {
  id: number;
  name: string;
  email: string;
  age: number;
  role: "admin" | "member" | "guest";
}

export async function getUser(id: string) {
  const res = await axios.get<User>(`/api/v1/users/${id}`);
  return res.data;
}

export async function listUsers() {
  const res = await axios.get<{ users: User[] }>("/api/v1/users");
  return res.data;
}

/** No matching server route in this fixture repo at all — DELETE is never
 *  registered anywhere in fixtures/backend, so this demonstrates the
 *  `unresolved-route` finding. */
export async function purgeLegacyStats() {
  const res = await axios.delete<{ success: boolean }>("/api/v1/legacy/stats");
  return res.data;
}
