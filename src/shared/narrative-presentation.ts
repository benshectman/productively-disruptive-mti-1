// Presentation vocabulary only: these expansions are supported by the content
// packet and candidate career records. Never infer expansions for product names.
export const headlineAcronymExpansions: Record<string, string> = {
  "J&J": "Johnson & Johnson",
  XD: "Experience Design",
  UX: "User Experience",
  XDMO: "Experience Design Management Office",
  CBT: "Corporate Business Technology",
  JJT: "Johnson & Johnson Technology"
};

export const HEADLINE_MAX_CHARACTERS = 64;
export const HEADLINE_MIN_WORDS = 3;
export const HEADLINE_MAX_WORDS = 9;

export function expandPresentationAcronyms(text: string): string {
  let expanded = text;
  for (const [acronym, expansion] of Object.entries(headlineAcronymExpansions)) {
    if (!expanded.toLowerCase().includes(expansion.toLowerCase())) {
      expanded = expanded.replace(new RegExp(`\\b${acronym}\\b`, "g"), expansion);
    }
  }
  return expanded;
}

export function allowedHeadlineAcronyms(lead: string): string[] {
  return Object.entries(headlineAcronymExpansions)
    .filter(([, expansion]) => lead.toLowerCase().includes(expansion.toLowerCase()))
    .map(([acronym]) => acronym);
}

export function headlineAcronymsAreExplained(headline: string, lead: string): boolean {
  const allowed = new Set(allowedHeadlineAcronyms(lead));
  const acronyms = headline.match(/\b[A-Z][A-Z&]+\b/g) || [];
  return acronyms.every((acronym) => allowed.has(acronym));
}
