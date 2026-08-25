import { useActor } from "@caffeineai/core-infrastructure";
import { createActor } from "../backend";
import type { backendInterface } from "../backend.d.ts";

export interface BackendHook {
  actor: backendInterface | null;
  isFetching: boolean;
}

export function useBackend(): BackendHook {
  const { actor, isFetching } = useActor(createActor);
  return { actor: actor as backendInterface | null, isFetching };
}
