import { useEffect, useState } from "react";

const STORAGE_KEY = "showEstimatedValues";

export function useValueDisplayPreference() {
  const [showEstimatedValues, setShowEstimatedValues] = useState<boolean>(
    () => localStorage.getItem(STORAGE_KEY) !== "off",
  );

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, showEstimatedValues ? "on" : "off");
  }, [showEstimatedValues]);

  return { showEstimatedValues, setShowEstimatedValues };
}
