import { useEffect, useState } from "react";

const STORAGE_KEY = "showNewsOnCards";

export function useNewsDisplayPreference() {
  const [showNewsOnCards, setShowNewsOnCards] = useState<boolean>(
    () => localStorage.getItem(STORAGE_KEY) !== "off",
  );

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, showNewsOnCards ? "on" : "off");
  }, [showNewsOnCards]);

  return { showNewsOnCards, setShowNewsOnCards };
}
