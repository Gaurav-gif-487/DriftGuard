import { useQuery } from "react-query";

export interface Profile {
  id: number;
  displayName: string;
  verified: boolean;
}

export function useProfile(userId: string) {
  return useQuery<Profile>(["profile", userId], () =>
    fetch(`/api/v1/profile/${userId}`).then((r) => r.json()),
  );
}
