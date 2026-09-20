export interface Env {
  DB: D1Database
  MEDIA: R2Bucket
  PRESENCE: DurableObjectNamespace
  R2_PUBLIC_BASE: string
  ICECAST_STATUS_URL: string
  SKIP_BRIDGE_URL: string
  TELEGRAM_BOT_TOKEN: string
  JWT_SECRET: string
  SKIP_BRIDGE_SECRET: string
  INTERNAL_SECRET: string
  WEBHOOK_SECRET: string
  // Optional read-only Cloudflare token (Account Analytics: Read) + account id,
  // used only by /status to show real request usage against the plan limits.
  CF_ANALYTICS_TOKEN?: string
  CF_ACCOUNT_ID?: string
}
