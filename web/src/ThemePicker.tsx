import { Theme } from "./api";

const THEMES: { value: Theme; label: string; blurb: string; swatch: string }[] = [
  { value: "business", label: "Signal Fire", blurb: "Warm ember on deep slate", swatch: "#ff8a52" },
  { value: "cyberpunk", label: "Cyberpunk", blurb: "Neon magenta on near-black", swatch: "#ff2079" },
  { value: "hacker", label: "Hacker", blurb: "Matrix green terminal", swatch: "#00ff41" },
  { value: "esports", label: "Esports", blurb: "High-energy orange/black", swatch: "#ff6b00" },
];

export function ThemePicker({ value, onChange }: { value: Theme; onChange: (theme: Theme) => void }) {
  const active = THEMES.find((t) => t.value === value);
  return (
    <div className="theme-picker">
      <select value={value} onChange={(e) => onChange(e.target.value as Theme)}>
        {THEMES.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label} — {t.blurb}
          </option>
        ))}
      </select>
      {active && <span className="theme-swatch" style={{ background: active.swatch }} />}
    </div>
  );
}
