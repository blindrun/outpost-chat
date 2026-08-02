// Mirrors src/util/uploadCategories.ts on the server — keep the keys,
// extensions, and permission names in sync. Used to build the attach-file
// <input accept> list and to label the per-role permission checkboxes in
// Instance Settings.
export const UPLOAD_CATEGORIES = {
  documents: {
    label: "Documents",
    permission: "UPLOAD_DOCUMENTS",
    extensions: [".pdf", ".txt", ".md", ".csv", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".rtf"],
  },
  archives: {
    label: "Archives",
    permission: "UPLOAD_ARCHIVES",
    extensions: [".zip", ".tar", ".gz", ".tgz", ".7z", ".rar"],
  },
  code: {
    label: "Code & scripts",
    permission: "UPLOAD_CODE",
    extensions: [
      ".sh", ".py", ".js", ".ts", ".tsx", ".jsx", ".rb", ".go", ".rs", ".java", ".c", ".cpp", ".h",
      ".php", ".sql", ".json", ".yaml", ".yml", ".toml", ".ini", ".env.example", ".xml", ".html", ".css",
    ],
  },
  videos: {
    label: "Videos",
    permission: "UPLOAD_VIDEOS",
    extensions: [".mp4", ".webm", ".mov", ".m4v", ".ogv"],
  },
} as const;

export type UploadCategory = keyof typeof UPLOAD_CATEGORIES;
export const UPLOAD_CATEGORY_KEYS = Object.keys(UPLOAD_CATEGORIES) as UploadCategory[];

// Builds the file input's `accept` list: images plus whatever categories
// the current user's roles grant them permission to upload.
export function buildAcceptAttribute(myCategories: UploadCategory[]): string {
  const extensions = myCategories.flatMap((cat) => UPLOAD_CATEGORIES[cat]?.extensions ?? []);
  return ["image/*", ...extensions].join(",");
}

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".bmp"];

export function isImageAttachment(url: string): boolean {
  const clean = url.split(/[?#]/)[0].toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => clean.endsWith(ext));
}

export function isVideoAttachment(url: string): boolean {
  const clean = url.split(/[?#]/)[0].toLowerCase();
  return (UPLOAD_CATEGORIES.videos.extensions as readonly string[]).some((ext) => clean.endsWith(ext));
}

// The stored upload key is `${userId}/${uuid}-${originalFilename}` — strip
// that prefix back off to show the name the user actually attached.
export function attachmentFilename(url: string): string {
  const last = decodeURIComponent(url.split("/").pop() ?? "attachment");
  return last.replace(/^[0-9a-f-]{36}-/i, "");
}
