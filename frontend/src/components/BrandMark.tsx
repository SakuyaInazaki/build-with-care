export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M11 7H8.5A1.5 1.5 0 0 0 7 8.5V11M21 7h2.5A1.5 1.5 0 0 1 25 8.5V11M11 25H8.5A1.5 1.5 0 0 1 7 23.5V21M21 25h2.5a1.5 1.5 0 0 0 1.5-1.5V21"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m11 16.5 3.2 3.2 7.3-7.2"
        stroke="currentColor"
        strokeWidth="2.15"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
