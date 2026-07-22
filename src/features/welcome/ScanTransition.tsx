import type { CSSProperties } from "react";
import { MockQrCode } from "./MockQrCode";

export interface ScanTransitionGeometry {
  fromLeft: number;
  fromTop: number;
  fromSize: number;
  travelX: number;
  travelY: number;
  targetScale: number;
}
interface ScanTransitionProps {
  geometry: ScanTransitionGeometry;
}

type ScanTransitionStyle = CSSProperties &
  Record<
    "--scan-x" | "--scan-y" | "--scan-size" | "--scan-target-scale",
    string
  >;

export function ScanTransition({ geometry }: ScanTransitionProps) {
  const style: ScanTransitionStyle = {
    top: geometry.fromTop,
    left: geometry.fromLeft,
    "--scan-x": `${geometry.travelX}px`,
    "--scan-y": `${geometry.travelY}px`,
    "--scan-size": `${geometry.fromSize}px`,
    "--scan-target-scale": `${geometry.targetScale}`,
  };

  return (
    <div className="scan-transition" style={style} aria-hidden="true">
      <MockQrCode className="scan-transition__qr" />
      <span className="scan-transition__core" />
    </div>
  );
}
