import { useEffect, useState } from 'react'
import { initTelegramApp } from './lib/telegram'
import { authenticate } from './lib/auth'
import { joinAppPresence } from './lib/presence'
import { RadioScreen } from './screens/RadioScreen'
import { AdminLibrary } from './screens/AdminLibrary'
import { AdminRadioControls } from './screens/AdminRadioControls'
import { AdminSchedule } from './screens/AdminSchedule'
import { InfoScreen } from './screens/InfoScreen'
import { ScheduleScreen } from './screens/ScheduleScreen'
import { ErrorBoundary } from './components/ErrorBoundary'

type Tab = 'radio' | 'library' | 'controls' | 'info' | 'schedule'

export default function App() {
  const [isAdmin, setIsAdmin] = useState(false)
  const [tab, setTab] = useState<Tab>('radio')
  const [ready, setReady] = useState(false)

  useEffect(() => {
    initTelegramApp()
    // Counts this client in the admin's "Открыли приложение" number.
    joinAppPresence()
    authenticate().then((result) => {
      setIsAdmin(result.isAdmin)
      setReady(true)
    })
  }, [])

  if (!ready) {
    return (
      <div className="app-loading">
        <img src="/logo.png" alt="BIGUNDER FM" className="app-loading__logo" />
      </div>
    )
  }

  return (
    <div className="app">
      {/* Always mounted, hidden via CSS rather than conditionally rendered
          like the other tabs — RadioScreen owns the live <audio> element and
          its connection state. An admin bouncing to Библиотека/Управление
          and back (a completely normal workflow — e.g. to hit Skip) used to
          unmount it entirely, silently killing playback; they'd come back
          to a reset Play button with no indication why, which reads as
          "broken" rather than "you switched tabs". Keeping it mounted lets
          the stream keep playing in the background across every tab. */}
      <div style={{ display: tab === 'radio' ? 'contents' : 'none' }}>
        <ErrorBoundary label="Эфир">
          <RadioScreen />
        </ErrorBoundary>
      </div>
      {tab === 'library' && isAdmin && (
        <ErrorBoundary label="Библиотека">
          <AdminLibrary />
        </ErrorBoundary>
      )}
      {tab === 'schedule' && isAdmin && (
        <ErrorBoundary label="Schedule">
          <AdminSchedule />
        </ErrorBoundary>
      )}
      {tab === 'controls' && isAdmin && (
        <ErrorBoundary label="Управление">
          <AdminRadioControls />
        </ErrorBoundary>
      )}
      {tab === 'schedule' && !isAdmin && (
        <ErrorBoundary label="Schedule">
          <ScheduleScreen />
        </ErrorBoundary>
      )}
      {tab === 'info' && !isAdmin && (
        <ErrorBoundary label="Инфо">
          <InfoScreen />
        </ErrorBoundary>
      )}

      {isAdmin && (
        <nav className="app__admin-nav">
          <button className={tab === 'radio' ? 'is-active' : ''} onClick={() => setTab('radio')}>
            Live
          </button>
          <button className={tab === 'library' ? 'is-active' : ''} onClick={() => setTab('library')}>
            Library
          </button>
          <button className={tab === 'schedule' ? 'is-active' : ''} onClick={() => setTab('schedule')}>
            Schedule
          </button>
          <button className={tab === 'controls' ? 'is-active' : ''} onClick={() => setTab('controls')}>
            Admin
          </button>
        </nav>
      )}
      {/* Regular listeners never had a bottom nav at all before — Info is
          the first non-admin section, so this is new, not a variant of the
          admin one above (which stays exactly as it was). */}
      {!isAdmin && (
        <nav className="app__admin-nav">
          <button className={tab === 'radio' ? 'is-active' : ''} onClick={() => setTab('radio')}>
            Live
          </button>
          <button className={tab === 'schedule' ? 'is-active' : ''} onClick={() => setTab('schedule')}>
            Schedule
          </button>
          <button className={tab === 'info' ? 'is-active' : ''} onClick={() => setTab('info')}>
            Info
          </button>
        </nav>
      )}
    </div>
  )
}
