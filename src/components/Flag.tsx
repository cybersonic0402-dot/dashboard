import * as React from "react";

// Maps our internal market codes to ISO 3166-1 alpha-2 (lowercase).
const CODE_MAP: Record<string, string> = {
  NL: "nl",
  UK: "gb",
  GB: "gb",
  US: "us",
  EU: "eu",
  DE: "de",
  FR: "fr",
};

export function Flag({
  code,
  size = 14,
  className = "",
  title,
}: {
  code?: string | null;
  size?: number;
  className?: string;
  title?: string;
}) {
  if (!code) return null;
  const iso = CODE_MAP[code.toUpperCase()] ?? code.toLowerCase();
  const w = size;
  const h = Math.round(size * 0.75);
  const [errored, setErrored] = React.useState(false);

  if (errored) {
    return (
      <span
        title={title ?? code}
        className={`inline-flex items-center justify-center rounded-[2px] bg-neutral-200 text-[8px] font-semibold uppercase text-neutral-600 ${className}`}
        style={{ width: w, height: h, lineHeight: 1 }}
      >
        {iso}
      </span>
    );
  }

  return (
    <img
      src={`https://flagcdn.com/${iso}.svg`}
      width={w}
      height={h}
      alt={title ?? code}
      title={title ?? code}
      onError={() => setErrored(true)}
      className={`inline-block rounded-[2px] object-cover align-[-2px] ${className}`}
      style={{ width: w, height: h }}
      loading="lazy"
    />
  );
}
