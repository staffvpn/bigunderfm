import { createClient } from 'jsr:@supabase/supabase-js@2'

// Simple shared-secret check rather than an env-var secret — this
// function has no way to receive new Supabase secrets set up remotely in
// this environment, and the blast radius of someone guessing this string
// is low: it's read-only (DB size, Storage listing) and can only ever
// trigger a Telegram DM, deduplicated per threshold in quota_alerts_sent
// below, so repeated calls can't spam admins even if the secret leaked.
const CRON_SECRET = '61ee6b637cc68c380cd0b4813d016ba8e671ef6a4aa2c8d9'

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`

const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

// Same free-tier caps referenced in src/lib/storageUsage.ts and the
// Postgres docs (500 MB triggers read-only mode). Escalating thresholds
// so a warning fires again as it gets more urgent, not just once ever.
const THRESHOLDS = [70, 85, 95]
const DB_SIZE_LIMIT_BYTES = 500 * 1024 * 1024
const STORAGE_LIMIT_BYTES = 1024 * 1024 * 1024
const BUCKETS = ['tracks', 'covers'] as const

async function sendMessage(chatId: number, text: string): Promise<void> {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  })
}

async function bucketSizeBytes(bucket: string): Promise<number> {
  let total = 0
  let offset = 0
  const pageSize = 1000
  for (;;) {
    const { data, error } = await adminClient.storage.from(bucket).list('', { limit: pageSize, offset })
    if (error || !data) break
    for (const obj of data) total += obj.metadata?.size ?? 0
    if (data.length < pageSize) break
    offset += pageSize
  }
  return total
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} ГБ`
  return `${mb.toFixed(0)} МБ`
}

/**
 * Checks one metric against its escalating thresholds and, for the
 * highest one just crossed that hasn't already been alerted on, DMs
 * every admin and records it in quota_alerts_sent so the same threshold
 * never fires twice.
 */
async function checkMetric(metric: string, usedBytes: number, limitBytes: number, label: string): Promise<void> {
  const percent = (usedBytes / limitBytes) * 100

  const { data: alreadySent } = await adminClient.from('quota_alerts_sent').select('threshold').eq('metric', metric)
  const sentThresholds = new Set((alreadySent ?? []).map((r) => r.threshold))

  const crossed = THRESHOLDS.filter((t) => percent >= t && !sentThresholds.has(t))
  if (crossed.length === 0) return
  const highest = Math.max(...crossed)

  const { data: admins } = await adminClient.from('admins').select('telegram_user_id')
  const text =
    `⚠️ ${label}: ${formatBytes(usedBytes)} из ${formatBytes(limitBytes)} (${Math.round(percent)}%).\n\n` +
    (highest >= 95
      ? 'Почти на пределе — в ближайшее время может перестать работать (Supabase переводит проект в ограниченный режим при исчерпании лимита).'
      : 'Стоит заранее подумать про платный тариф или разгрузить хранилище.')

  for (const admin of admins ?? []) {
    await sendMessage(Number(admin.telegram_user_id), text)
  }

  // Mark every threshold up to and including the highest crossed as sent
  // — if usage jumped straight from 60% to 90% between checks, this
  // still only sends ONE message (for 90%, the most relevant one) but
  // correctly suppresses the now-moot 70% alert from ever firing later.
  for (const t of crossed) {
    await adminClient.from('quota_alerts_sent').insert({ metric, threshold: t })
  }
}

Deno.serve(async (req) => {
  if (req.headers.get('Authorization') !== `Bearer ${CRON_SECRET}`) {
    return new Response('unauthorized', { status: 401 })
  }

  try {
    const { data: dbSizeBytes } = await adminClient.rpc('get_db_size_bytes')
    if (typeof dbSizeBytes === 'number') {
      await checkMetric('db_size', dbSizeBytes, DB_SIZE_LIMIT_BYTES, 'База данных Supabase')
    }

    const storageSizes = await Promise.all(BUCKETS.map(bucketSizeBytes))
    const storageBytes = storageSizes.reduce((a, b) => a + b, 0)
    await checkMetric('storage_size', storageBytes, STORAGE_LIMIT_BYTES, 'Хранилище файлов Supabase')

    return new Response('ok', { status: 200 })
  } catch (err) {
    console.error(err)
    return new Response('error', { status: 500 })
  }
})
