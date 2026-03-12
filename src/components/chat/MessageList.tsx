import { useEffect, useRef, useCallback } from 'react'
import { useMessageStore } from '../../stores/messageStore'
import { useRoomStore } from '../../stores/roomStore'
import { loadRoomHistory, loadInitialMessages, sendReadReceipt } from '../../lib/matrix'
import { MessageItem } from './MessageItem'

const EMPTY_MESSAGES: import('../../types/matrix').MessageEvent[] = []

export function MessageList() {
  const activeRoomId = useRoomStore((s) => s.activeRoomId)
  const messagesMap = useMessageStore((s) => s.messages)
  const isLoadingHistory = useMessageStore((s) => s.isLoadingHistory)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const prevRoomId = useRef<string | null>(null)
  const canLoadMore = useRef(true)

  const messages = activeRoomId ? messagesMap.get(activeRoomId) ?? EMPTY_MESSAGES : EMPTY_MESSAGES

  useEffect(() => {
    if (activeRoomId && activeRoomId !== prevRoomId.current) {
      prevRoomId.current = activeRoomId
      canLoadMore.current = true
      loadInitialMessages(activeRoomId)
    }
  }, [activeRoomId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'instant' })
    if (activeRoomId) {
      sendReadReceipt(activeRoomId)
    }
  }, [messages.length, activeRoomId])

  const handleScroll = useCallback(() => {
    if (!scrollRef.current || !activeRoomId || isLoadingHistory || !canLoadMore.current) return
    if (scrollRef.current.scrollTop < 100) {
      loadRoomHistory(activeRoomId).then((hasMore) => {
        if (!hasMore) canLoadMore.current = false
      })
    }
  }, [activeRoomId, isLoadingHistory])

  if (!activeRoomId) {
    return (
      <div className="flex-1 flex items-center justify-center bg-bg-primary">
        <div className="text-center">
          <h2 className="text-3xl font-bold bg-gradient-to-r from-accent-pink to-purple-500 bg-clip-text text-transparent mb-2">
            ワイフ
          </h2>
          <h3 className="text-xl text-text-primary font-semibold mb-1">WaifuTxT</h3>
          <p className="text-text-secondary text-sm">Sélectionne un salon pour commencer</p>
        </div>
      </div>
    )
  }

  return (
    <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto">
      {isLoadingHistory && (
        <div className="flex justify-center py-4">
          <svg className="animate-spin h-5 w-5 text-accent-pink" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        </div>
      )}
      <div className="py-4">
        {messages.map((msg, i) => {
          const prev = messages[i - 1]
          const showHeader =
            !prev ||
            prev.sender !== msg.sender ||
            msg.timestamp - prev.timestamp > 5 * 60 * 1000
          return <MessageItem key={msg.eventId} message={msg} showHeader={showHeader} />
        })}
      </div>
      <div ref={bottomRef} />
    </div>
  )
}
