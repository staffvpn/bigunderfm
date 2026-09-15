interface TelegramWebApp {
  initData: string
  initDataUnsafe: Record<string, unknown>
  ready: () => void
  expand: () => void
  colorScheme: 'light' | 'dark'
}

declare global {
  interface Window {
    Telegram?: { WebApp: TelegramWebApp }
  }
}

export function getTelegramWebApp(): TelegramWebApp | null {
  return window.Telegram?.WebApp ?? null
}

export function getInitData(): string {
  const webApp = getTelegramWebApp()
  return webApp?.initData ?? ''
}

export function initTelegramApp(): void {
  const webApp = getTelegramWebApp()
  if (webApp) {
    webApp.ready()
    webApp.expand()
  }
}

/**
 * The caller's own Telegram numeric id, read straight from
 * initDataUnsafe — as the name says, unsigned/unverified, so this is only
 * ever safe to use for cosmetic UI decisions (e.g. "show this one extra
 * button to this one admin"), never as an actual access check. Real admin
 * authorization always goes through telegram-auth (which verifies the
 * signed initData server-side) and RLS from there — this can't grant
 * access to anything that isn't already independently allowed.
 */
export function getTelegramUserId(): number | null {
  const webApp = getTelegramWebApp()
  const user = webApp?.initDataUnsafe?.user as { id?: number } | undefined
  return typeof user?.id === 'number' ? user.id : null
}
