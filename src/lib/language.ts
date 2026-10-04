export const LANGUAGE_LABEL: Record<string, string> = { en: 'English', ceb: 'Bisaya' }

export function languageLabel(code: string) {
  return LANGUAGE_LABEL[code] ?? code
}

/**
 * Lists the published languages of a module. Missing translations are labelled
 * rather than silently substituted, so a student is never shown an English page
 * while believing it is the Bisaya one.
 */
export function describeLanguages(codes: string[]) {
  return codes.map((code) => languageLabel(code)).join(' and ')
}