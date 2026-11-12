import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import '@fontsource/inter-tight/cyrillic-400.css'
import '@fontsource/inter-tight/cyrillic-500.css'
import '@fontsource/inter-tight/cyrillic-600.css'
import '@fontsource/inter-tight/latin-400.css'
import '@fontsource/inter-tight/latin-500.css'
import '@fontsource/inter-tight/latin-600.css'
import './styles/theme.css'
import './styles/redesign.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
