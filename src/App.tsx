import { useEffect, useState } from 'react'
import { initTelegramApp } from './lib/telegram'
import { authenticate } from './lib/auth'
import { joinAppPresence } from './lib/presence'
import { RadioScreen } from './screens/RadioScreen'
import { AdminLibrary } from './screens/AdminLibrary'
import { AdminRadioControls } from './screens/AdminRadioControls'
import { AdminSchedule } from './screens/AdminSchedule'
import { GridScreen } from './screens/GridScreen'
import { ErrorBoundary } from './components/ErrorBoundary'
import pendant from './assets/pendant/pendant-front.webp'

type Tab = 'radio' | 'grid' | 'library' | 'controls' | 'schedule'

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
        <img src={pendant} alt="BIGUNDER FM" className="app-loading__logo" />
      </div>
    )
  }

  return (
    <div className={isAdmin ? 'app app--admin' : 'app'}>
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
          <RadioScreen onOpenGrid={() => setTab('grid')} />
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
      {tab === 'grid' && (
        <ErrorBoundary label="Сетка">
          <GridScreen onBack={() => setTab('radio')} />
        </ErrorBoundary>
      )}

      {isAdmin && (
        <nav className="app__admin-nav">
          <button className={tab === 'radio' || tab === 'grid' ? 'is-active' : ''} onClick={() => setTab('radio')}>
            Эфир
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
    </div>
  )
}
