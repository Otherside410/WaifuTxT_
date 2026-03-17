import { useEffect } from 'react'
import { SpaceSidebar } from './SpaceSidebar'
import { RoomSidebar } from './RoomSidebar'
import { MemberPanel } from './MemberPanel'
import { SettingsModal } from './SettingsModal'
import { ChatArea } from '../chat/ChatArea'
import { VerificationModal } from '../verification/VerificationModal'
import { useUiStore } from '../../stores/uiStore'
import { useRoomStore } from '../../stores/roomStore'
import { loadRoomMembers } from '../../lib/matrix'
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
