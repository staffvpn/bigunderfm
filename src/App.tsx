import { useEffect, useState } from 'react'
import { initTelegramApp } from './lib/telegram'
import { authenticate } from './lib/auth'
import { joinAppPresence } from './lib/presence'
import { RadioScreen } from './screens/RadioScreen'
import { AdminLibrary } from './screens/AdminLibrary'
import { AdminRadioControls } from './screens/AdminRadioControls'
import { GridScreen } from './screens/GridScreen'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Splash } from './components/Splash'

type Tab = 'radio' | 'grid' | 'library' | 'controls'

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

  if (!ready) return <Splash ready={false} />

  return (
    <div className="app">
      <Splash ready />
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
          <div className="bfm-admin">
            <header className="bfm__head">
              BIGUNDER FM
              <br />
              Admin
            </header>
            <AdminLibrary />
          </div>
        </ErrorBoundary>
      )}
      {tab === 'controls' && isAdmin && (
        <ErrorBoundary label="Управление">
          <div className="bfm-admin">
            <header className="bfm__head">
              BIGUNDER FM
              <br />
              Admin
            </header>
            <AdminRadioControls />
          </div>
        </ErrorBoundary>
      )}
      {tab === 'grid' && (
        <ErrorBoundary label="Сетка">
          <GridScreen />
        </ErrorBoundary>
      )}

      <nav className="app__admin-nav">
        <button className={tab === 'radio' ? 'is-active' : ''} onClick={() => setTab('radio')}>
          Эфир
        </button>
        <button className={tab === 'grid' ? 'is-active' : ''} onClick={() => setTab('grid')}>
          Сетка
        </button>
        {isAdmin && (
          <button className={tab === 'library' ? 'is-active' : ''} onClick={() => setTab('library')}>
            Библиотека
          </button>
        )}
        {isAdmin && (
          <button className={tab === 'controls' ? 'is-active' : ''} onClick={() => setTab('controls')}>
            Админ
          </button>
        )}
      </nav>
    </div>
  )
}
