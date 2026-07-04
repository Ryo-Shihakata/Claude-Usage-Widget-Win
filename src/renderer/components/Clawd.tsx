/** clawd マスコット（コーラルのカニ風・自作SVG）。公式アセットではなく雰囲気重視。 */
export function Clawd({ size = 18 }: { size?: number }): JSX.Element {
  const coral = '#d97757'
  return (
    <svg
      width={size}
      height={size * 0.72}
      viewBox="0 0 28 20"
      role="img"
      aria-label="clawd"
      style={{ display: 'block' }}
    >
      {/* legs */}
      <g stroke={coral} strokeWidth="1.4" strokeLinecap="round">
        <line x1="8" y1="14" x2="4" y2="18" />
        <line x1="11" y1="15" x2="9" y2="19" />
        <line x1="17" y1="15" x2="19" y2="19" />
        <line x1="20" y1="14" x2="24" y2="18" />
      </g>
      {/* arms + claws */}
      <g stroke={coral} strokeWidth="1.6" strokeLinecap="round">
        <line x1="7" y1="11" x2="3.5" y2="9" />
        <line x1="21" y1="11" x2="24.5" y2="9" />
      </g>
      <circle cx="3" cy="8.4" r="2.6" fill={coral} />
      <circle cx="25" cy="8.4" r="2.6" fill={coral} />
      {/* body */}
      <ellipse cx="14" cy="12" rx="8" ry="5.5" fill={coral} />
      {/* eye stalks */}
      <g stroke={coral} strokeWidth="1.4" strokeLinecap="round">
        <line x1="11" y1="7.5" x2="11" y2="4.4" />
        <line x1="17" y1="7.5" x2="17" y2="4.4" />
      </g>
      {/* eyes */}
      <circle cx="11" cy="3.6" r="1.9" fill="#ece7de" />
      <circle cx="17" cy="3.6" r="1.9" fill="#ece7de" />
      <circle cx="11" cy="3.6" r="0.85" fill="#26241f" />
      <circle cx="17" cy="3.6" r="0.85" fill="#26241f" />
    </svg>
  )
}
