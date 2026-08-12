import { Theme } from "./api";

// "instance" means follow whatever the instance owner picked. Anything else
// is this person's own override on this machine.
//
// The instance theme is branding -- the owner decides what their community
// looks like -- but light vs dark is also a room, a time of day and, for some
// people, an accessibility need. Forcing every member onto the owner's choice
// gets that wrong. So the instance setting stays, as the default, and anyone
// can override it for themselves.
export type ThemeChoice = Theme | "instance";

export type Density = "comfortable" | "compact";

export interface AppearanceSettings {
  theme: ThemeChoice;
  density: Density;
}

const STORAGE_KEY = "outpost-appearance";

const DEFAULT_APPEARANCE: AppearanceSettings = {
  theme: "instance",
  density: "comfortable",
};

// Deliberately not per-instance, and deliberately not on the user record:
// this is "how do I want this screen to look", which belongs to the machine
// you're sitting at. The same reasoning as loadAudioSettings.
export function loadAppearance(): AppearanceSettings {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return { ...DEFAULT_APPEARANCE };
  try {
    return { ...DEFAULT_APPEARANCE, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

export function saveAppearance(settings: AppearanceSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

// Resolves the override against the instance's own theme. Kept here rather
// than inline in App so the login screen and the app agree on the answer.
export function resolveTheme(
  appearance: AppearanceSettings,
  instanceTheme: string | undefined,
): string | undefined {
  return appearance.theme === "instance" ? instanceTheme : appearance.theme;
}
