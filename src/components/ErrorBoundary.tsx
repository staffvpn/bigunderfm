import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
  /** Shown in the fallback message, e.g. "Библиотека" — helps whoever sees
      it (or reports it back) say which tab broke without guessing. */
  label: string
}

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * A crash anywhere in a tab's render used to blank the entire app to a
 * plain dark background with nothing on it — no error, no button, nothing
 * — because React unmounts the whole tree on an uncaught render error and
 * nothing here ever rendered a fallback. That is indistinguishable from
 * "broken" with zero way to recover short of force-closing Telegram. Each
 * tab gets its own boundary so a crash in one (say, Библиотека) can't take
 * the other two down with it, and the fallback offers a reload instead of
 * a dead end.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`ErrorBoundary(${this.props.label}) caught:`, error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="error-boundary">
          <p className="error-boundary__title">{this.props.label}: что-то сломалось</p>
          <p className="error-boundary__detail">{this.state.error.message}</p>
          <button onClick={() => location.reload()}>Обновить</button>
        </div>
      )
    }
    return this.props.children
  }
}
