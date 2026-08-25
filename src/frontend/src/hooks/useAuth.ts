import { useInternetIdentity } from "@caffeineai/core-infrastructure";
import type { Principal } from "@icp-sdk/core/principal";

export interface AuthState {
  isAuthenticated: boolean;
  principal: Principal | null;
  principalText: string | null;
  login: () => void;
  logout: () => void;
  isLoading: boolean;
  displayName: string;
}

export function useAuth(): AuthState {
  const { identity, login, clear, loginStatus, isLoggingIn, isLoginSuccess } =
    useInternetIdentity();

  const isLoading = isLoggingIn;
  const isAuthenticated =
    (isLoginSuccess || loginStatus === "idle") && identity != null;
  const principal = identity?.getPrincipal() ?? null;
  const principalText = principal?.toText() ?? null;

  return {
    isAuthenticated,
    principal,
    principalText,
    login,
    logout: clear,
    isLoading,
    displayName: "",
  };
}
