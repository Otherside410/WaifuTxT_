import { useEffect } from 'react'
import { SpaceSidebar } from './SpaceSidebar'
import { RoomSidebar } from './RoomSidebar'
import { MemberPanel } from './MemberPanel'
import { SettingsModal } from './SettingsModal'
import { ChatArea } from '../chat/ChatArea'
import { VerificationModal } from '../verification/VerificationModal'
import { useUiStore } from '../../stores/uiStore'
import { useRoomStore } from '../../stores/roomStore'
import { loadRoomMembers, reapplyStoredOwnStatusToStore } from '../../lib/matrix'
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts'

export function AppShell() {
  useKeyboardShortcuts()
  const showMemberPanel = useUiStore((s) => s.showMemberPanel)
  const showSettingsModal = useUiStore((s) => s.showSettingsModal)
  const activeRoomId = useRoomStore((s) => s.activeRoomId)

  useEffect(() => {
    if (activeRoomId) {
      loadRoomMembers(activeRoomId)
    }
  }, [activeRoomId])

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') reapplyStoredOwnStatusToStore()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  return (
    <div className="h-screen w-screen flex overflow-hidden">
      <SpaceSidebar />
      <RoomSidebar />
      <ChatArea />
      {showMemberPanel && activeRoomId && <MemberPanel />}
      {showSettingsModal && <SettingsModal />}
      <VerificationModal />
    </div>
  )
}
