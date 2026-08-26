/**
 * Centralized display-name resolver.
 *
 * Resolve a user's human-facing display name with a fixed priority:
 *   displayName → fullName → username.
 *
 * - Preserves Vietnamese Unicode (plain string ops, no transliteration).
 * - Pure & dependency-free so both Next.js routes and the Cloud Run worker
 *   (plain Node) can import it.
 * - Never hardcodes any specific person.
 */

export type DisplayNameSource = {
  displayName?: string | null;
  fullName?: string | null;
  username?: string | null;
};

export function resolveDisplayName(source: DisplayNameSource): string {
  const candidates = [source.displayName, source.fullName, source.username];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return "";
}
