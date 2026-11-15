/** "On air" mark: three bars moving like a level meter. Pure CSS (no audio analysis). */
export function OnAir() {
  return (
    <span className="bfm-eq" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  )
}
