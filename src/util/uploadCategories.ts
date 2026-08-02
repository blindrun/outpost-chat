import { PERMISSIONS, Permission } from "./permissions.js";

// Curated, role-gated categories for message-attachment uploads. Images are
// handled separately in uploads.ts and always allowed to everyone — these
// are the additional categories a role can be granted (see the matching
// UPLOAD_* permission) via PATCH /roles/:roleId. Deliberately excludes
// native executables (.exe, .dll, .apk, .msi, .bat, .jar, ...) even from
// "code" — no permission grants access to those, since there's no
// server-side execution risk to guard against beyond hosting at all, which
// is out of scope for a curated default.
export const UPLOAD_CATEGORIES = {
  documents: {
    label: "Documents",
    permission: PERMISSIONS.UPLOAD_DOCUMENTS,
    extensions: [".pdf", ".txt", ".md", ".csv", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".rtf"],
  },
  archives: {
    label: "Archives",
    permission: PERMISSIONS.UPLOAD_ARCHIVES,
    extensions: [".zip", ".tar", ".gz", ".tgz", ".7z", ".rar"],
  },
  code: {
    label: "Code & scripts",
    permission: PERMISSIONS.UPLOAD_CODE,
    extensions: [
      ".sh", ".py", ".js", ".ts", ".tsx", ".jsx", ".rb", ".go", ".rs", ".java", ".c", ".cpp", ".h",
      ".php", ".sql", ".json", ".yaml", ".yml", ".toml", ".ini", ".env.example", ".xml", ".html", ".css",
    ],
  },
  videos: {
    label: "Videos",
    permission: PERMISSIONS.UPLOAD_VIDEOS,
    extensions: [".mp4", ".webm", ".mov", ".m4v", ".ogv"],
  },
} as const;

export type UploadCategory = keyof typeof UPLOAD_CATEGORIES;
export const UPLOAD_CATEGORY_KEYS = Object.keys(UPLOAD_CATEGORIES) as UploadCategory[];

function extensionOf(filename: string): string {
  const idx = filename.lastIndexOf(".");
  return idx === -1 ? "" : filename.slice(idx).toLowerCase();
}

// Extension-based, not MIME-based — browsers report wildly inconsistent
// (or empty) mimetypes for non-image files depending on OS file
// associations, so the curated allowlist has to key off the filename.
// Returns null for extensions that aren't in any curated category (which
// includes all native executables) — nothing ever grants access to those.
export function categoryForFilename(filename: string): UploadCategory | null {
  const ext = extensionOf(filename);
  if (!ext) return null;
  for (const key of UPLOAD_CATEGORY_KEYS) {
    if ((UPLOAD_CATEGORIES[key].extensions as readonly string[]).includes(ext)) return key;
  }
  return null;
}

export function permissionForCategory(cat: UploadCategory): Permission {
  return UPLOAD_CATEGORIES[cat].permission;
}
