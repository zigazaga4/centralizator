export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 text-ink-600">
      <svg className="h-5 w-5 animate-spin text-coral-500" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity=".25" strokeWidth="3" />
        <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
      {label && <span className="text-sm">{label}</span>}
    </div>
  );
}
