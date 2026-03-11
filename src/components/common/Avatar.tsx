interface AvatarProps {
  src: string | null
  name: string
  size?: number
  className?: string
  status?: 'online' | 'offline' | 'unavailable' | null
}

function getInitials(name: string): string {
  return name
    .split(/[\s@:_]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() || '')
    .join('')
}

function hashColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
  }
  const colors = ['#ff2d78', '#4dabf7', '#3ddc84', '#ffb347', '#a855f7', '#06b6d4', '#f43f5e']
  return colors[Math.abs(hash) % colors.length]
}

export function Avatar({ src, name, size = 40, className = '', status }: AvatarProps) {
  const initials = getInitials(name)
  const bgColor = hashColor(name)

  return (
    <div className={`relative shrink-0 ${className}`} style={{ width: size, height: size }}>
      {src ? (
        <img
          src={src}
          alt={name}
          className="w-full h-full rounded-full object-cover"
          onError={(e) => {
            ;(e.target as HTMLImageElement).style.display = 'none'
            ;(e.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden')
          }}
        />
      ) : null}
      <div
        className={`w-full h-full rounded-full flex items-center justify-center text-white font-semibold ${src ? 'hidden' : ''}`}
        style={{ backgroundColor: bgColor, fontSize: size * 0.4 }}
      >
        {initials}
      </div>
      {status && (
        <div
          className={`absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-bg-secondary ${
            status === 'online' ? 'bg-success' : status === 'unavailable' ? 'bg-warning' : 'bg-text-muted'
          }`}
        />
      )}
    </div>
  )
}
