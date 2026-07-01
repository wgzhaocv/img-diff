// ブランドマーク: 重なる 2 つのフレーム（＝画像を見比べる／重複を重ねる）。
// 塗り分けは teal 系トークン（fill-accent / stroke-primary）で style に追従。
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden className={className}>
      <rect
        x="3"
        y="3"
        width="13"
        height="13"
        rx="3"
        className="fill-accent stroke-primary"
        strokeWidth="1.75"
      />
      <rect
        x="8"
        y="8"
        width="13"
        height="13"
        rx="3"
        className="fill-card stroke-primary"
        strokeWidth="1.75"
      />
    </svg>
  );
}
