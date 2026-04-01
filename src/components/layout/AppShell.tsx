import { useEffect } from 'react'
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

export function AppShell() {
  useKeyboardShortcuts()
  const showMemberPanel = useUiStore((s) => s.showMemberPanel)
  const showPinnedPanel = useUiStore((s) => s.showPinnedPanel)
  const showSettingsModal = useUiStore((s) => s.showSettingsModal)
  const activeThreadRootId = useUiStore((s) => s.activeThreadRootId)
  const showThreadsListPanel = useUiStore((s) => s.showThreadsListPanel)
  const activeRoomId = useRoomStore((s) => s.activeRoomId)

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

  return (
    <div className="h-screen w-screen flex overflow-hidden">
      <SpaceSidebar />
      <RoomSidebar />
      <ChatArea />
      {showPinnedPanel && activeRoomId && <PinnedMessagesPanel />}
      {showThreadsListPanel && activeRoomId && <ThreadsListPanel />}
      {activeThreadRootId && activeRoomId && <ThreadPanel />}
      {showMemberPanel && activeRoomId && <MemberPanel />}
      {showSettingsModal && <SettingsModal />}
      <VerificationModal />
    </div>
  )
}
