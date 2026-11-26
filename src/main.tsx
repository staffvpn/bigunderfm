import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import '@fontsource/onest/cyrillic-400.css'
import '@fontsource/onest/cyrillic-500.css'
import '@fontsource/onest/cyrillic-600.css'
import '@fontsource/onest/cyrillic-700.css'
import '@fontsource/onest/cyrillic-800.css'
import '@fontsource/onest/cyrillic-900.css'
import './styles/fonts.css'
import '@fontsource/inter-tight/cyrillic-400.css'
import '@fontsource/inter-tight/cyrillic-500.css'
import '@fontsource/inter-tight/cyrillic-600.css'
import '@fontsource/inter-tight/latin-400.css'
import '@fontsource/inter-tight/latin-500.css'
import '@fontsource/inter-tight/latin-600.css'
import '@fontsource/inter-tight/cyrillic-700.css'
import '@fontsource/inter-tight/latin-700.css'
import '@fontsource/inter-tight/cyrillic-800.css'
import '@fontsource/inter-tight/latin-800.css'
import './styles/theme.css'
import './styles/redesign.css'
import { applySavedAccent } from './lib/accent'

applySavedAccent()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
