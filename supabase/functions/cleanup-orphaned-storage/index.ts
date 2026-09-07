import { createClient } from 'jsr:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

/**
 * Maintenance-only endpoint: removes Storage objects in `tracks`/`covers`
 * that no longer have any referencing row (uploads that partially failed
 * before the AdminLibrary.tsx rollback fix existed, or ever slip through
 * some future failure mode this doesn't anticipate). Not wired into any
 * UI — invoked directly (e.g. via curl) when checking for drift.
 *
 * No admin-auth gate: the only thing this can ever delete is a file with
 * zero DB references, so there's no active track it could ever touch
 * even if called by someone who found the URL.
 */
async function findOrphans(bucket: 'tracks' | 'covers', column: 'file_path' | 'cover_path') {
  const { data: objects, error: listError } = await adminClient.storage.from(bucket).list('', { limit: 1000 })
  if (listError) throw listError

  const { data: rows, error: rowsError } = await adminClient.from('tracks').select(column)
  if (rowsError) throw rowsError

  const referenced = new Set((rows ?? []).map((r: Record<string, unknown>) => r[column]).filter(Boolean))
  return (objects ?? []).map((o) => o.name).filter((name) => !referenced.has(name))
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('ok', { status: 200 })
  }

  try {
    const trackOrphans = await findOrphans('tracks', 'file_path')
    const coverOrphans = await findOrphans('covers', 'cover_path')

    if (trackOrphans.length > 0) {
      await adminClient.storage.from('tracks').remove(trackOrphans)
    }
    if (coverOrphans.length > 0) {
      await adminClient.storage.from('covers').remove(coverOrphans)
    }

    return new Response(JSON.stringify({ removed: { tracks: trackOrphans, covers: coverOrphans } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
