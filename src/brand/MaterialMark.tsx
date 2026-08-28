/**
 * The MATERIAL mark: 3×3 module grid, signal module at `position` (0–8,
 * row-major). Same geometry as the app icon, drawn inline so the signal can
 * live wherever the project seed puts it. Decorative — the brand name next
 * to it carries the text.
 */
export function MaterialMark({ position, size = 14 }: { position: number; size?: number }) {
  const cells = Array.from({ length: 9 }, (_, i) => i);
  // Unit geometry mirroring the icon: 3 cells + 2 gaps ≈ icon's inner grid.
  const cell = 28;
  const gap = 9;
  const span = cell * 3 + gap * 2;
  return (
    <svg
      className="material-mark"
      width={size}
      height={size}
      viewBox={`0 0 ${span} ${span}`}
      aria-hidden="true"
      focusable="false"
    >
      {cells.map((i) => (
        <rect
          key={i}
          x={(i % 3) * (cell + gap)}
          y={Math.floor(i / 3) * (cell + gap)}
          width={cell}
          height={cell}
          className={i === position ? 'material-mark-signal' : 'material-mark-module'}
        />
      ))}
    </svg>
  );
}
