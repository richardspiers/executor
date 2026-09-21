/**
 * Map a compact base64 or base64url payload onto the padded standard
 * alphabet `atob` accepts. Gmail `format: byte` fields (and other
 * Google Discovery `base64url` strings) use `-`/`_` and omit padding.
 */
export const normalizeBase64 = (value: string, encoding: "base64" | "base64url"): string => {
  const compact = value.replace(/\s/g, "");
  const alphabet =
    encoding === "base64url" ? compact.replace(/-/g, "+").replace(/_/g, "/") : compact;
  const remainder = alphabet.length % 4;
  return remainder === 0 ? alphabet : `${alphabet}${"=".repeat(4 - remainder)}`;
};
