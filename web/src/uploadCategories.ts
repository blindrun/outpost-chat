// Mirrors src/util/uploadCategories.ts on the server — keep the keys and
// extensions in sync. Used to build the attach-file <input accept> list and
// to label the owner-facing toggles in instance settings.
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

// Builds the file input's `accept` list: images plus whatever extra
// categories this instance has opted into.
export function buildAcceptAttribute(enabledCategories: string[]): string {
  const extensions = enabledCategories.flatMap(
    (cat) => UPLOAD_CATEGORIES[cat as UploadCategory]?.extensions ?? [],
  );
  return ["image/*", ...extensions].join(",");
}

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".bmp"];

export function isImageAttachment(url: string): boolean {
  const clean = url.split(/[?#]/)[0].toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => clean.endsWith(ext));
}

// The stored upload key is `${userId}/${uuid}-${originalFilename}` — strip
// that prefix back off to show the name the user actually attached.
export function attachmentFilename(url: string): string {
  const last = decodeURIComponent(url.split("/").pop() ?? "attachment");
  return last.replace(/^[0-9a-f-]{36}-/i, "");
}
