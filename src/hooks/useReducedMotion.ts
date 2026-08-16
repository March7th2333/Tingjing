import { useEffect, useState } from "react";

const query = "(prefers-reduced-motion: reduce)";

export function useReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(() =>
    window.matchMedia(query).matches,
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia(query);
    const handleChange = (event: MediaQueryListEvent) => {
      setPrefersReducedMotion(event.matches);
    };

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  return prefersReducedMotion;
}
