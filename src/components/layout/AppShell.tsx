import { useEffect } from 'react'
import { SpaceSidebar } from './SpaceSidebar'
import { RoomSidebar } from './RoomSidebar'
import { MemberPanel } from './MemberPanel'
import { ChatArea } from '../chat/ChatArea'
import { useUiStore } from '../../stores/uiStore'
import { useRoomStore } from '../../stores/roomStore'
import { loadRoomMembers } from '../../lib/matrix'

export function AppShell() {
  const showMemberPanel = useUiStore((s) => s.showMemberPanel)
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
    </div>
  )
}
