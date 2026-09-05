/** Allowed e-mail domains are edited as free text (comma / space / newline separated) and stored as a de-duplicated string array. */
export const parseDomains = (text: string): string[] => [...new Set(text.split(/[\s,;]+/).map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean))];
