export default function Logo({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <path d="M6 19c3-4 7-4 10 0s7 4 10 0" stroke="var(--on-accent)" strokeWidth="3" fill="none" strokeLinecap="round" />
    </svg>
  );
}
