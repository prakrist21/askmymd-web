import { useCallback, useEffect, useRef, useState } from "react";

const MIN_FRACTION = 0.2; // Neither pane may drop below 20%.
const MAX_FRACTION = 1 - MIN_FRACTION;

interface ResizableSplitProps {
  left: React.ReactNode;
  right: React.ReactNode;
  isDark: boolean;
}

/**
 * Two panes separated by a draggable divider. The split position is stored as
 * a fraction of the container width, clamped so neither pane collapses below
 * the minimum width (dragging to an extreme stops at 20% / 80%).
 */
export default function ResizableSplit({ left, right, isDark }: ResizableSplitProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [fraction, setFraction] = useState(0.5);
  const [isDragging, setIsDragging] = useState(false);

  const clamp = useCallback((value: number) =>
    Math.min(MAX_FRACTION, Math.max(MIN_FRACTION, value)), []);

  const updateFromPointer = useCallback(
    (clientX: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      setFraction(clamp((clientX - rect.left) / rect.width));
    },
    [clamp]
  );

  // While dragging, track the pointer anywhere on the page so fast cursor
  // movements that leave the divider don't break the drag.
  useEffect(() => {
    if (!isDragging) return;
    function handleMove(event: PointerEvent) {
      event.preventDefault();
      updateFromPointer(event.clientX);
    }
    function handleUp() {
      setIsDragging(false);
    }
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
  }, [isDragging, updateFromPointer]);

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1">
      <div
        className="min-h-0 min-w-0 overflow-hidden"
        style={{ width: `${fraction * 100}%` }}
      >
        {left}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize editor and preview panes"
        tabIndex={0}
        onPointerDown={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") setFraction((f) => clamp(f - 0.02));
          if (e.key === "ArrowRight") setFraction((f) => clamp(f + 0.02));
        }}
        className={`group relative w-1.5 shrink-0 cursor-col-resize transition-colors focus:outline-none ${isDark ? "bg-slate-800 hover:bg-emerald-500/60" : "bg-gray-200 hover:bg-emerald-500/40"} ${
          isDragging ? "bg-emerald-500" : ""
        }`}
      />
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{right}</div>
    </div>
  );
}
