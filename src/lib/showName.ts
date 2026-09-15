import { supabase } from './supabase'

export const DEFAULT_SHOW_NAME = 'LOCAL SELECTS'

/** The small tagline under the header on the radio screen — an
    admin-editable label (e.g. for calling out a themed mix), stored on the
    same radio_state singleton row the old virtual-timeline design used. */
export async function fetchShowName(): Promise<string> {
  const { data } = await supabase.from('radio_state').select('show_name').eq('id', true).maybeSingle()
  return data?.show_name?.trim() || DEFAULT_SHOW_NAME
}

export async function updateShowName(name: string): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('radio_state')
    .update({ show_name: name.trim() || DEFAULT_SHOW_NAME })
    .eq('id', true)
  return { error: error?.message ?? null }
}
