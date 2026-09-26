import { api } from './api'

export interface EventItem {
  id: string
  title: string
  description: string
  eventAt: string // ISO
  imageUrl: string | null
}

/** Listeners' feed: only events that haven't happened yet, soonest first. */
export async function fetchEvents(): Promise<EventItem[]> {
  try {
    const data = await api<{ events: EventItem[] }>('/api/events')
    return data.events
  } catch (err) {
    console.error('fetchEvents failed', err)
    return []
  }
}

/** Admin view: every event, past included, for editing/cleanup. */
export async function fetchAdminEvents(): Promise<EventItem[]> {
  try {
    const data = await api<{ events: EventItem[] }>('/api/admin/events')
    return data.events
  } catch (err) {
    console.error('fetchAdminEvents failed', err)
    return []
  }
}

export async function createEvent(form: FormData): Promise<{ id: string }> {
  return api('/api/admin/events', { method: 'POST', body: form })
}

export async function updateEvent(id: string, form: FormData): Promise<void> {
  await api(`/api/admin/events/${id}`, { method: 'PATCH', body: form })
}

export async function deleteEvent(id: string): Promise<void> {
  await api(`/api/admin/events/${id}`, { method: 'DELETE' })
}

/** "Напомнить" button — any signed-in listener, not admin-only. Requires a
    Telegram session (the app always has one when actually opened inside
    Telegram); ApiError with status 401 means it wasn't. */
export async function remindMe(eventId: string): Promise<{ messaged: boolean }> {
  return api(`/api/events/${eventId}/remind`, { method: 'POST' })
}
