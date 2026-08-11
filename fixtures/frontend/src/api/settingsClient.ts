import axios from "axios";

export interface Settings {
  bio: string;
  nickname: string;
  status: "active" | "inactive" | "banned";
}

export async function getSettings(id: string) {
  const res = await axios.get<Settings>(`/api/v1/settings/${id}`);
  return res.data;
}
