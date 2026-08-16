import { useEffect, useState } from "react";

interface NetworkInformationLike {
  saveData?: boolean;
}

export type PerformanceTier = "low" | "standard" | "high";

function readPerformanceTier(): PerformanceTier {
  const network = (
    navigator as Navigator & { connection?: NetworkInformationLike }
  ).connection;
  const compactViewport = window.matchMedia("(max-width: 720px)").matches;

  if (
    navigator.hardwareConcurrency <= 4
    || Boolean(network?.saveData)
    || compactViewport
  ) {
    return "low";
  }

  const deviceMemory = (
    navigator as Navigator & { deviceMemory?: number }
  ).deviceMemory;

  if (
    navigator.hardwareConcurrency >= 10
    || (
      navigator.hardwareConcurrency >= 8
      && (deviceMemory ?? 8) >= 8
      && window.innerWidth >= 1_280
    )
  ) {
    return "high";
  }

  return "standard";
}

export function usePerformanceTier() {
  const [tier, setTier] = useState<PerformanceTier>(readPerformanceTier);

  useEffect(() => {
    const compactViewport = window.matchMedia("(max-width: 720px)");
    const update = () => setTier(readPerformanceTier());

    compactViewport.addEventListener("change", update);
    window.addEventListener("resize", update);

    return () => {
      compactViewport.removeEventListener("change", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  return tier;
}

export function useLowPerformanceMode() {
  return usePerformanceTier() === "low";
}
