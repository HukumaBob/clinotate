import createClient from "openapi-fetch";
import type { paths } from "./generated/schema";

let authToken: string | null = null;

export function setAuthToken(token: string | null): void {
  authToken = token;
}

export const apiClient = createClient<paths>({
  baseUrl: "http://localhost:8000",
  headers: {
    get Authorization() {
      return authToken ? `Bearer ${authToken}` : undefined;
    },
  },
});
