import { useEffect, useRef, useState } from 'react'
import { SpaceSidebar } from './SpaceSidebar'
import { RoomSidebar } from './RoomSidebar'
import { MemberPanel } from './MemberPanel'
import { SettingsModal } from './SettingsModal'
import { ChatArea } from '../chat/ChatArea'
import { PinnedMessagesPanel } from '../chat/PinnedMessagesPanel'
import { ThreadPanel } from '../chat/ThreadPanel'
import { ThreadsListPanel } from '../chat/ThreadsListPanel'
import { VerificationModal } from '../verification/VerificationModal'
import { useUiStore } from '../../stores/uiStore'
import { useRoomStore } from '../../stores/roomStore'
import { loadRoomMembers, reapplyStoredOwnStatusToStore, leaveVoiceRoom, getPinnedEventIds } from '../../lib/matrix'
import { useMessageStore } from '../../stores/messageStore'
import { cleanupVoiceStreams } from '../../lib/voice'
import { useVoiceStore } from '../../stores/voiceStore'
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts'

function useOverlayAnimation(open: boolean, durationMs = 180) {
  const [mounted, setMounted] = useState(open)
  const [visible, setVisible] = useState(open)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    if (open) {
      setMounted(true)
      requestAnimationFrame(() => setVisible(true))
    } else if (mounted) {
      setVisible(false)
      timer = setTimeout(() => setMounted(false), durationMs)
    }
    return () => {
      if (timer) clearTimeout(timer)
    }
  }, [open, mounted, durationMs])

  return { mounted, visible }
}

export function AppShell() {
  useKeyboardShortcuts()
  const showMemberPanel = useUiStore((s) => s.showMemberPanel)
  const showPinnedPanel = useUiStore((s) => s.showPinnedPanel)
  const showSettingsModal = useUiStore((s) => s.showSettingsModal)
  const isMobileMenuOpen = useUiStore((s) => s.isMobileMenuOpen)
  const toggleMobileMenu = useUiStore((s) => s.toggleMobileMenu)
  const setMobileMenuOpen = useUiStore((s) => s.setMobileMenuOpen)
  const togglePinnedPanel = useUiStore((s) => s.togglePinnedPanel)
  const toggleThreadsListPanel = useUiStore((s) => s.toggleThreadsListPanel)
  const toggleMemberPanel = useUiStore((s) => s.toggleMemberPanel)
  const closeThreadPanel = useUiStore((s) => s.closeThreadPanel)
  const activeThreadRootId = useUiStore((s) => s.activeThreadRootId)
  const showThreadsListPanel = useUiStore((s) => s.showThreadsListPanel)
  const activeRoomId = useRoomStore((s) => s.activeRoomId)
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 1023px)').matches)
  const prevActiveRoomId = useRef<string | null>(activeRoomId)

  useEffect(() => {
    if (activeRoomId) {
      loadRoomMembers(activeRoomId)
      const ids = getPinnedEventIds(activeRoomId)
      useMessageStore.getState().setPinnedEventIds(activeRoomId, ids)
    }
  }, [activeRoomId])

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') reapplyStoredOwnStatusToStore()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  // Leave voice channel on tab close / navigation
  useEffect(() => {
    const onBeforeUnload = () => {
      const roomId = useVoiceStore.getState().joinedRoomId
      if (!roomId) return
      cleanupVoiceStreams()
      try { leaveVoiceRoom(roomId) } catch { /* best-effort */ }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  useEffect(() => {
    const media = window.matchMedia('(max-width: 1023px)')
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    setIsMobile(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    if (!isMobile) setMobileMenuOpen(false)
  }, [isMobile, setMobileMenuOpen])

  useEffect(() => {
    if (
      isMobile &&
      isMobileMenuOpen &&
      activeRoomId &&
      prevActiveRoomId.current !== activeRoomId
    ) {
      setMobileMenuOpen(false)
    }
    prevActiveRoomId.current = activeRoomId
  }, [activeRoomId, isMobile, isMobileMenuOpen, setMobileMenuOpen])

  const mobileMenuAnim = useOverlayAnimation(isMobile && isMobileMenuOpen)
  const pinnedAnim = useOverlayAnimation(isMobile && showPinnedPanel && !!activeRoomId)
  const threadsAnim = useOverlayAnimation(isMobile && showThreadsListPanel && !!activeRoomId)
  const threadAnim = useOverlayAnimation(isMobile && !!activeThreadRootId && !!activeRoomId)
  const membersAnim = useOverlayAnimation(isMobile && showMemberPanel && !!activeRoomId)
  const desktopPinnedAnim = useOverlayAnimation(!isMobile && showPinnedPanel && !!activeRoomId, 200)
  const desktopThreadsAnim = useOverlayAnimation(!isMobile && showThreadsListPanel && !!activeRoomId, 200)
  const desktopThreadAnim = useOverlayAnimation(!isMobile && !!activeThreadRootId && !!activeRoomId, 200)
  const desktopMembersAnim = useOverlayAnimation(!isMobile && showMemberPanel && !!activeRoomId, 200)

  return (
    <div className="h-[100dvh] w-screen flex overflow-hidden relative">
      {!isMobile && (
        <>
          <SpaceSidebar />
          <RoomSidebar />
        </>
      )}

      {isMobile && mobileMenuAnim.mounted && (
        <div
          className={`fixed inset-0 z-50 bg-black/55 transition-opacity duration-200 ${
            mobileMenuAnim.visible ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
          onClick={() => setMobileMenuOpen(false)}
        >
          <div
            className={`absolute inset-y-0 left-0 w-auto max-w-[92vw] flex transition-transform duration-200 ease-out ${
              mobileMenuAnim.visible ? 'translate-x-0' : '-translate-x-3'
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            <SpaceSidebar />
            <RoomSidebar />
          </div>
        </div>
      )}

      {isMobile && !isMobileMenuOpen && !activeRoomId && (
        <button
          onClick={toggleMobileMenu}
          className="fixed top-3 left-3 z-30 lg:hidden h-9 w-9 rounded-lg border border-border bg-bg-secondary/95 text-text-primary flex items-center justify-center"
          title="Ouvrir la navigation"
          aria-label="Ouvrir la navigation"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
          </svg>
        </button>
      )}

      <ChatArea />

      {(showPinnedPanel && activeRoomId) || desktopPinnedAnim.mounted ? (
        isMobile ? (
          pinnedAnim.mounted && (
          <div
            className={`fixed inset-0 z-40 bg-black/50 flex justify-end transition-opacity duration-200 ${
              pinnedAnim.visible ? 'opacity-100' : 'opacity-0 pointer-events-none'
            }`}
            onClick={togglePinnedPanel}
          >
            <div
              className={`w-full max-w-[430px] h-full bg-bg-primary transition-transform duration-200 ease-out ${
                pinnedAnim.visible ? 'translate-x-0' : 'translate-x-3'
              }`}
              onClick={(e) => e.stopPropagation()}
            >
              <PinnedMessagesPanel />
            </div>
          </div>)
        ) : (
          desktopPinnedAnim.mounted && (
            <div
              className={`overflow-hidden shrink-0 transition-all duration-200 ease-out ${
                desktopPinnedAnim.visible ? 'w-80 opacity-100' : 'w-0 opacity-0 pointer-events-none'
              }`}
            >
              <div className="w-80 h-full">
                <PinnedMessagesPanel />
              </div>
            </div>
          )
        )
      ) : null}

      {(showThreadsListPanel && activeRoomId) || desktopThreadsAnim.mounted ? (
        isMobile ? (
          threadsAnim.mounted && (
          <div
            className={`fixed inset-0 z-40 bg-black/50 flex justify-end transition-opacity duration-200 ${
              threadsAnim.visible ? 'opacity-100' : 'opacity-0 pointer-events-none'
            }`}
            onClick={toggleThreadsListPanel}
          >
            <div
              className={`w-full max-w-[430px] h-full bg-bg-primary transition-transform duration-200 ease-out ${
                threadsAnim.visible ? 'translate-x-0' : 'translate-x-3'
              }`}
              onClick={(e) => e.stopPropagation()}
            >
              <ThreadsListPanel />
            </div>
          </div>)
        ) : (
          desktopThreadsAnim.mounted && (
            <div
              className={`overflow-hidden shrink-0 transition-all duration-200 ease-out ${
                desktopThreadsAnim.visible ? 'w-80 opacity-100' : 'w-0 opacity-0 pointer-events-none'
              }`}
            >
              <div className="w-80 h-full">
                <ThreadsListPanel />
              </div>
            </div>
          )
        )
      ) : null}

      {(activeThreadRootId && activeRoomId) || desktopThreadAnim.mounted ? (
        isMobile ? (
          threadAnim.mounted && (
          <div
            className={`fixed inset-0 z-40 bg-black/50 flex justify-end transition-opacity duration-200 ${
              threadAnim.visible ? 'opacity-100' : 'opacity-0 pointer-events-none'
            }`}
            onClick={closeThreadPanel}
          >
            <div
              className={`w-full max-w-[430px] h-full bg-bg-primary transition-transform duration-200 ease-out ${
                threadAnim.visible ? 'translate-x-0' : 'translate-x-3'
              }`}
              onClick={(e) => e.stopPropagation()}
            >
              <ThreadPanel />
            </div>
          </div>)
        ) : (
          desktopThreadAnim.mounted && (
            <div
              className={`overflow-hidden shrink-0 transition-all duration-200 ease-out ${
                desktopThreadAnim.visible ? 'w-80 opacity-100' : 'w-0 opacity-0 pointer-events-none'
              }`}
            >
              <div className="w-80 h-full">
                <ThreadPanel />
              </div>
            </div>
          )
        )
      ) : null}

      {(showMemberPanel && activeRoomId) || desktopMembersAnim.mounted ? (
        isMobile ? (
          membersAnim.mounted && (
          <div
            className={`fixed inset-0 z-40 bg-black/50 flex justify-end transition-opacity duration-200 ${
              membersAnim.visible ? 'opacity-100' : 'opacity-0 pointer-events-none'
            }`}
            onClick={toggleMemberPanel}
          >
            <div
              className={`w-[86vw] max-w-[360px] h-full bg-bg-primary shadow-2xl transition-transform duration-200 ease-out ${
                membersAnim.visible ? 'translate-x-0' : 'translate-x-3'
              }`}
              onClick={(e) => e.stopPropagation()}
            >
              <MemberPanel />
            </div>
          </div>)
        ) : (
          desktopMembersAnim.mounted && (
            <div
              className={`overflow-hidden shrink-0 transition-all duration-200 ease-out ${
                desktopMembersAnim.visible ? 'w-60 opacity-100' : 'w-0 opacity-0 pointer-events-none'
              }`}
            >
              <div className="w-60 h-full">
                <MemberPanel />
              </div>
            </div>
          )
        )
      ) : null}

      {showSettingsModal && <SettingsModal />}
      <VerificationModal />
    </div>
  )
}
