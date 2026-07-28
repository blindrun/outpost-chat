import { Theme } from "./api";

const THEMES: { value: Theme; label: string; blurb: string; swatch: string }[] = [
  { value: "business", label: "Signal Fire", blurb: "Warm ember on deep slate", swatch: "#ff8a52" },
  { value: "cyberpunk", label: "Cyberpunk", blurb: "Neon magenta on near-black", swatch: "#ff2079" },
  { value: "hacker", label: "Hacker", blurb: "Matrix green terminal", swatch: "#00ff41" },
  { value: "esports", label: "Esports", blurb: "High-energy orange/black", swatch: "#ff6b00" },
];

export function ThemePicker({ value, onChange }: { value: Theme; onChange: (theme: Theme) => void }) {
  return (
    <div className="theme-picker">
      {THEMES.map((t) => (
        <button
          type="button"
          key={t.value}
          className={`theme-card ${value === t.value ? "active" : ""}`}
          onClick={() => onChange(t.value)}
        >
          <span className="theme-swatch" style={{ background: t.swatch }} />
          <span className="theme-card-label">{t.label}</span>
          <span className="theme-card-blurb">{t.blurb}</span>
        </button>
      ))}
    </div>
  );
}
