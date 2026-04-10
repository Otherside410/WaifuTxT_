import { useEffect, useRef, useState } from 'react'
import { EmojiPicker, DEFAULT_QUICK_REACTIONS, addRecentEmoji } from '../common/EmojiPicker'

interface MessageContextMenuProps {
  open: boolean
  onClose: () => void
  // Reactions
  canReact: boolean
  onReact: (emoji: string) => void
  // Actions
  canReply: boolean
  onReply: () => void
  canThread: boolean
  onThread: () => void
  canEdit: boolean
  onEdit: () => void
  canPin: boolean
  isPinned: boolean
  isPinning: boolean
  onTogglePin: () => void
  canCopy: boolean
  copied: boolean
  onCopy: () => void
  canDelete: boolean
  onDelete: () => void
}

export function MessageContextMenu({
  open,
  onClose,
  canReact,
  onReact,
  canReply,
  onReply,
  canThread,
  onThread,
  canEdit,
  onEdit,
  canPin,
  isPinned,
  isPinning,
  onTogglePin,
  canCopy,
  copied,
  onCopy,
  canDelete,
  onDelete,
}: MessageContextMenuProps) {
  const [mounted, setMounted] = useState(false)
  const [visible, setVisible] = useState(false)
  const [showFullPicker, setShowFullPicker] = useState(false)
  const sheetRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) {
      setShowFullPicker(false)
      setMounted(true)
      requestAnimationFrame(() => setVisible(true))
    } else {
      setVisible(false)
      setShowFullPicker(false)
      const t = setTimeout(() => setMounted(false), 220)
      return () => clearTimeout(t)
    }
  }, [open])

  if (!mounted) return null

  const handleAction = (fn: () => void) => {
    fn()
    onClose()
  }

  return (
    <div
      className={`fixed inset-0 z-50 flex flex-col justify-end transition-opacity duration-200 ${
        visible ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" />

      {/* Sheet */}
      <div
        ref={sheetRef}
        className={`relative w-full max-w-lg mx-auto rounded-t-2xl bg-bg-secondary border-t border-border shadow-2xl transition-transform duration-220 ease-out pb-safe ${
          visible ? 'translate-y-0' : 'translate-y-full'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 rounded-full bg-border" />
        </div>

        {/* Quick reactions */}
        {canReact && !showFullPicker && (
          <div className="flex items-center justify-center gap-2 px-4 py-3 border-b border-border">
            {DEFAULT_QUICK_REACTIONS.map((r) => (
              <button
                key={r.emoji}
                onClick={() => { addRecentEmoji(r.emoji); onReact(r.emoji); onClose() }}
                className="text-2xl leading-none w-11 h-11 flex items-center justify-center rounded-full hover:bg-bg-hover active:scale-90 transition-all"
              >
                {r.emoji}
              </button>
            ))}
            <button
              onClick={() => setShowFullPicker(true)}
              className="w-11 h-11 flex items-center justify-center rounded-full bg-bg-tertiary hover:bg-bg-hover active:scale-90 transition-all text-text-muted"
              title="Plus d'émojis"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
            </button>
          </div>
        )}

        {/* Full emoji picker */}
        {canReact && showFullPicker && (
          <div className="border-b border-border">
            <div className="flex items-center px-4 py-2 gap-2">
              <button
                onClick={() => setShowFullPicker(false)}
                className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                </svg>
              </button>
              <span className="text-sm font-medium text-text-secondary">Choisir une réaction</span>
            </div>
            <EmojiPicker
              onSelect={(emoji) => {
                addRecentEmoji(emoji)
                onReact(emoji)
                onClose()
              }}
            />
          </div>
        )}

        {/* Actions list */}
        {!showFullPicker && (
          <div className="py-2">
            {canReply && (
              <ActionItem
                icon={<ReplyIcon />}
                label="Répondre"
                onClick={() => handleAction(onReply)}
              />
            )}
            {canThread && (
              <ActionItem
                icon={<ThreadIcon />}
                label="Fil de discussion"
                onClick={() => handleAction(onThread)}
              />
            )}
            {canEdit && (
              <ActionItem
                icon={<EditIcon />}
                label="Modifier"
                onClick={() => handleAction(onEdit)}
              />
            )}
            {canCopy && (
              <ActionItem
                icon={copied ? <CheckIcon /> : <CopyIcon />}
                label={copied ? 'Copié !' : 'Copier le texte'}
                onClick={() => handleAction(onCopy)}
                accent={copied ? 'success' : undefined}
              />
            )}
            {canPin && (
              <ActionItem
                icon={<PinIcon />}
                label={isPinned ? 'Désépingler' : 'Épingler'}
                onClick={() => { if (!isPinning) handleAction(onTogglePin) }}
                accent={isPinned ? 'pink' : undefined}
                disabled={isPinning}
              />
            )}
            {canDelete && (
              <ActionItem
                icon={<TrashIcon />}
                label="Supprimer"
                onClick={() => handleAction(onDelete)}
                accent="danger"
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ActionItem({
  icon,
  label,
  onClick,
  accent,
  disabled,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  accent?: 'pink' | 'danger' | 'success'
  disabled?: boolean
}) {
  const colorClass =
    accent === 'danger'
      ? 'text-danger'
      : accent === 'pink'
      ? 'text-accent-pink'
      : accent === 'success'
      ? 'text-success'
      : 'text-text-primary'

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-full flex items-center gap-3 px-5 py-3 active:bg-bg-hover transition-colors disabled:opacity-40 ${colorClass}`}
    >
      <span className="w-5 h-5 shrink-0">{icon}</span>
      <span className="text-[15px] font-medium">{label}</span>
    </button>
  )
}

function ReplyIcon() {
  return (
    <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" className="w-5 h-5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5l-7.5-7.5 7.5-7.5M3 12h12a6 6 0 016 6v1.5" />
    </svg>
  )
}

function ThreadIcon() {
  return (
    <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" className="w-5 h-5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h8M8 8h5M8 16h6" />
      <rect x="3" y="3" width="18" height="18" rx="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function EditIcon() {
  return (
    <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" className="w-5 h-5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 3.487a2.1 2.1 0 113 2.974l-10.5 10.5-4.2 1.2 1.2-4.2 10.5-10.474z" />
    </svg>
  )
}

function CopyIcon() {
  return (
    <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" className="w-5 h-5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" className="w-5 h-5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
    </svg>
  )
}

function PinIcon() {
  return (
    <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" className="w-5 h-5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" className="w-5 h-5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
    </svg>
  )
}
