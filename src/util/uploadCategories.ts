// Curated, owner-toggleable categories for message-attachment uploads.
// Images are handled separately in uploads.ts and always allowed — these
// are the additional categories an instance owner can opt into via
// PATCH /instance/settings. Deliberately excludes native executables
// (.exe, .dll, .apk, .msi, .bat, .jar, ...) even from "code", since
// there's no server-side execution risk to guard against beyond hosting —
// the risk is a self-hoster wanting those hosted at all, which is out of
// scope for a curated default.
export const UPLOAD_CATEGORIES = {
  documents: {
    label: "Documents",
    extensions: [".pdf", ".txt", ".md", ".csv", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".rtf"],
  },
  archives: {
    label: "Archives",
    extensions: [".zip", ".tar", ".gz", ".tgz", ".7z", ".rar"],
  },
  code: {
    label: "Code & scripts",
    extensions: [
      ".sh", ".py", ".js", ".ts", ".tsx", ".jsx", ".rb", ".go", ".rs", ".java", ".c", ".cpp", ".h",
      ".php", ".sql", ".json", ".yaml", ".yml", ".toml", ".ini", ".env.example", ".xml", ".html", ".css",
    ],
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
export function isAllowedByCategories(filename: string, enabledCategories: string[]): boolean {
  const ext = extensionOf(filename);
  if (!ext) return false;
  return enabledCategories.some((cat) => {
    const def = UPLOAD_CATEGORIES[cat as UploadCategory];
    return def ? (def.extensions as readonly string[]).includes(ext) : false;
  });
}
