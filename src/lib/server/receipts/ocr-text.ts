/**
 * Presentation projection of the immutable `ocr_json`: the line text a
 * reviewer reads, in the engine's reading order. Parsing and column
 * reconstruction belong to a later ticket; this never rewrites the stored
 * payload, so a better projection can always be derived from it later.
 */
export function ocrTextFromJson(ocrJson: string | null): string | null {
  if (!ocrJson) return null;
  try {
    const parsed = JSON.parse(ocrJson) as {
      pages?: { lines?: { text?: unknown }[] }[];
    };
    const text = (parsed.pages ?? []).flatMap((page) =>
      (page.lines ?? [])
        .filter((line) => typeof line.text === 'string')
        .map((line) => line.text as string),
    );
    return text.length > 0 ? text.join('\n') : null;
  } catch {
    return null;
  }
}
