// Flo, the mascot: a small otter holding a notepad (the same drawing as
// flowplan-docs/components/docs/flo-otter.tsx). The colours are custom
// properties (app/globals.css, .otter), so it follows the light and dark scheme.
export function FloOtter({ size = 96 }: { size?: number }) {
  const c = {
    fur: "var(--flo-fur)",
    furDark: "var(--flo-fur-dark)",
    cream: "var(--flo-cream)",
    ink: "var(--flo-ink)",
    paper: "var(--flo-paper)",
    line: "var(--flo-line)",
    accent: "var(--flo-accent)",
    cheek: "var(--flo-cheek)",
  };
  return (
    <svg className="otter" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      {/* body and head */}
      <ellipse cx="32" cy="60" rx="18" ry="13" fill={c.fur} />
      <circle cx="17" cy="15" r="5.5" fill={c.fur} />
      <circle cx="47" cy="15" r="5.5" fill={c.fur} />
      <circle cx="17" cy="15" r="2.8" fill={c.furDark} />
      <circle cx="47" cy="15" r="2.8" fill={c.furDark} />
      <ellipse cx="32" cy="27" rx="18" ry="16" fill={c.fur} />
      {/* face */}
      <ellipse cx="32" cy="33" rx="12" ry="8.5" fill={c.cream} />
      <circle cx="20.5" cy="31.5" r="2.3" fill={c.cheek} />
      <circle cx="43.5" cy="31.5" r="2.3" fill={c.cheek} />
      <circle cx="24.5" cy="25" r="2.6" fill={c.ink} />
      <circle cx="39.5" cy="25" r="2.6" fill={c.ink} />
      <circle cx="25.4" cy="24.1" r=".9" fill={c.paper} />
      <circle cx="40.4" cy="24.1" r=".9" fill={c.paper} />
      <path d="M28.5 29.6c0-1.4 1.6-2.2 3.5-2.2s3.5.8 3.5 2.2c0 1.3-1.8 2.6-3.5 2.6s-3.5-1.3-3.5-2.6Z" fill={c.ink} />
      <path d="M29 34.4c1.2 1.4 2.2 1.5 3 .3.8 1.2 1.8 1.1 3-.3" fill="none" stroke={c.ink} strokeWidth="1.3" strokeLinecap="round" />
      <path d="M22 32.6l-6.5-1.2M22 35.2l-6.2 1.8M42 32.6l6.5-1.2M42 35.2l6.2 1.8" stroke={c.ink} strokeWidth=".9" strokeLinecap="round" opacity=".45" />
      {/* notepad, pencil and paws */}
      <rect x="19" y="41" width="26" height="22" rx="2.5" fill={c.paper} stroke={c.line} strokeWidth="1.2" />
      <rect x="19" y="41" width="26" height="4.5" rx="2" fill={c.accent} />
      <path d="M23.5 50.5h17M23.5 54.5h13M23.5 58.5h15" stroke={c.line} strokeWidth="1.6" strokeLinecap="round" />
      <path d="M47.5 47 53 38.5" stroke={c.accent} strokeWidth="2.6" strokeLinecap="round" />
      <ellipse cx="19.5" cy="50" rx="4.2" ry="3.5" fill={c.furDark} />
      <ellipse cx="45" cy="49" rx="4.2" ry="3.5" fill={c.furDark} />
    </svg>
  );
}
