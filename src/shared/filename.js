/**
 * Shared between the browser (summary and transcript export filenames) and
 * the server (the Content-Disposition filename on the caption routes), so
 * one slug rule governs every download this app produces. Plain string
 * work only, so it is safe to import from both a browser module and, via
 * allowJs, TypeScript server code.
 */
export function sanitiseFilename(title, fallbackId) {
  const slug = String(title ?? "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallbackId;
}
