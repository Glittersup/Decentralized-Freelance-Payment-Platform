import type { SVGProps } from "react";

export interface LogoProps {
  /** Size of the logo icon in pixels. Defaults to 28. */
  size?: number;
  /** Whether to render the brand name text alongside the icon. Defaults to true. */
  showText?: boolean;
  /** Optional extra CSS class on the container. */
  className?: string;
}

export function LogoIcon({
  size = 28,
  ...props
}: { size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 48 48"
      width={size}
      height={size}
      fill="none"
      aria-hidden="true"
      className="logo-icon"
      {...props}
    >
      <defs>
        <linearGradient id="logoBgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#38bdf8" />
          <stop offset="50%" stopColor="#2563eb" />
          <stop offset="100%" stopColor="#7c3aed" />
        </linearGradient>
        <linearGradient id="logoStarGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="100%" stopColor="#e0e7ff" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="12" fill="url(#logoBgGrad)" />
      <path
        d="M 12 28 C 12 35, 36 37, 36 29"
        stroke="#ffffff"
        strokeOpacity="0.4"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M 36 20 C 36 13, 12 11, 12 19"
        stroke="#ffffff"
        strokeOpacity="0.4"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="12" cy="23.5" r="3" fill="#bae6fd" stroke="#0284c7" strokeWidth="1.5" />
      <circle cx="36" cy="24.5" r="3" fill="#ddd6fe" stroke="#7c3aed" strokeWidth="1.5" />
      <path
        d="M 24 10 C 24 18, 25 21, 35 24 C 25 27, 24 30, 24 38 C 24 30, 23 27, 13 24 C 23 21, 24 18, 24 10 Z"
        fill="url(#logoStarGrad)"
      />
      <circle cx="24" cy="24" r="2" fill="#2563eb" />
    </svg>
  );
}

export default function Logo({ size = 28, showText = true, className = "" }: LogoProps) {
  return (
    <span className={`brand-logo ${className}`.trim()}>
      <LogoIcon size={size} />
      {showText && <span className="brand-name">StellarFreelance</span>}
    </span>
  );
}
