import type { RefObject } from "react";

interface BrandMarkProps {
  markRef?: RefObject<HTMLDivElement | null>;
  portalRef?: RefObject<HTMLSpanElement | null>;
}

export function BrandMark({ markRef, portalRef }: BrandMarkProps) {
  return (
    <div className="brand-mark" ref={markRef} aria-hidden="true">
      <svg className="brand-mark__ring" viewBox="0 0 180 180">
        <circle
          cx="90"
          cy="90"
          r="67"
          pathLength="100"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <span className="brand-mark__square" ref={portalRef} />
      <span className="brand-mark__echo" />
    </div>
  );
}
