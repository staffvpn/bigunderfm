import { useEffect, useState } from 'react'
import { initTelegramApp } from './lib/telegram'
import { authenticate } from './lib/auth'
import { RadioScreen } from './screens/RadioScreen'
import { AdminLibrary } from './screens/AdminLibrary'
import { AdminRadioControls } from './screens/AdminRadioControls'

type Tab = 'radio' | 'library' | 'controls'

export default function App() {
  const [isAdmin, setIsAdmin] = useState(false)
  const [tab, setTab] = useState<Tab>('radio')
  const [ready, setReady] = useState(false)

  useEffect(() => {
    initTelegramApp()
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
      {tab === 'radio' && <RadioScreen />}
      {tab === 'library' && isAdmin && <AdminLibrary />}
      {tab === 'controls' && isAdmin && <AdminRadioControls />}

      {isAdmin && (
        <nav className="app__admin-nav">
          <button className={tab === 'radio' ? 'is-active' : ''} onClick={() => setTab('radio')}>
            Эфир
          </button>
          <button className={tab === 'library' ? 'is-active' : ''} onClick={() => setTab('library')}>
            Библиотека
          </button>
          <button className={tab === 'controls' ? 'is-active' : ''} onClick={() => setTab('controls')}>
            Управление
          </button>
        </nav>
      )}
    </div>
  )
}
