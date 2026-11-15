// The station's accent colour (buttons, the on-air mark, the greeting). Set
// in the admin; travels with the program, remembered on the phone so even the
// greeting is in it before anything loads.
const KEY = 'bfm_accent'
export const DEFAULT_ACCENT = '#1f2bff'
const valid = (c: unknown): c is string => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)

export function applyAccent(color: string | null | undefined) {
  const c = valid(color) ? color : DEFAULT_ACCENT
  document.documentElement.style.setProperty('--accent', c)
  try {
    localStorage.setItem(KEY, c)
  } catch {
    // storage unavailable - not important
  }
}

export function applySavedAccent() {
  try {
    const c = localStorage.getItem(KEY)
    if (valid(c)) document.documentElement.style.setProperty('--accent', c)
  } catch {
    // ignore
  }
}
