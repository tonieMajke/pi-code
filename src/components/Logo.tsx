/** App mark — same geometry as branding/pi-code-icon.svg (pie eating the cursor). */
export function Logo({ size = 20, className = "" }: { size?: number; className?: string }) {
  return (
    <svg className={`logo ${className}`} width={size} height={size} viewBox="0 0 100 100" aria-label="Pi" role="img">
      <rect width="100" height="100" rx="22" fill="#262624" />
      <path d="M50 50 L77.2 37.3 A30 30 0 1 0 77.2 62.7 Z" fill="#d97757" />
      <rect x="66" y="44" width="9" height="12" rx="1.2" fill="#faf9f5" />
    </svg>
  );
}
