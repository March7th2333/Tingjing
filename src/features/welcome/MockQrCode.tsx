import { useCallback, useEffect, useRef } from "react";
import type { RefObject } from "react";
import { useLanguage } from "../../i18n/LanguageContext";

const qrSize = 25;
const finderOrigins = [
  [0, 0],
  [qrSize - 7, 0],
  [0, qrSize - 7],
] as const;

function isInFinder(row: number, column: number) {
  return finderOrigins.some(
    ([originX, originY]) =>
      column >= originX &&
      column < originX + 7 &&
      row >= originY &&
      row < originY + 7,
  );
}

function finderValue(row: number, column: number) {
  for (const [originX, originY] of finderOrigins) {
    const x = column - originX;
    const y = row - originY;

    if (x >= 0 && x < 7 && y >= 0 && y < 7) {
      const onOuter = x === 0 || x === 6 || y === 0 || y === 6;
      const onCenter = x >= 2 && x <= 4 && y >= 2 && y <= 4;
      return onOuter || onCenter;
    }
  }

  return false;
}

function createQrPattern() {
  let seed = 0x74_69_6e_67;

  return Array.from({ length: qrSize }, (_, row) =>
    Array.from({ length: qrSize }, (_, column) => {
      if (isInFinder(row, column)) {
        return finderValue(row, column);
      }

      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      return ((seed >>> 9) + row * 3 + column * 5) % 7 < 3;
    }),
  );
}

const pattern = createQrPattern();

interface MockQrCodeProps {
  canvasRef?: RefObject<HTMLCanvasElement | null>;
  className?: string;
}

export function MockQrCode({
  canvasRef: externalCanvasRef,
  className = "",
}: MockQrCodeProps) {
  const { t } = useLanguage();
  const internalCanvasRef = useRef<HTMLCanvasElement>(null);
  const setCanvasRef = useCallback(
    (node: HTMLCanvasElement | null) => {
      internalCanvasRef.current = node;

      if (externalCanvasRef) {
        externalCanvasRef.current = node;
      }
    },
    [externalCanvasRef],
  );

  useEffect(() => {
    const canvas = internalCanvasRef.current;
    const context = canvas?.getContext("2d");

    if (!canvas || !context) {
      return;
    }

    const cellSize = 5;
    const quietZone = 4;
    const totalCells = qrSize + quietZone * 2;
    canvas.width = totalCells * cellSize;
    canvas.height = totalCells * cellSize;

    context.fillStyle = "#e6e6e6";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#202020";

    pattern.forEach((row, rowIndex) => {
      row.forEach((isDark, columnIndex) => {
        if (isDark) {
          context.fillRect(
            (columnIndex + quietZone) * cellSize,
            (rowIndex + quietZone) * cellSize,
            cellSize,
            cellSize,
          );
        }
      });
    });
  }, []);

  return (
    <canvas
      className={`mock-qr ${className}`.trim()}
      ref={setCanvasRef}
      role="img"
      aria-label={t("welcome.qr.mock")}
    />
  );
}
