// src/components/modals/MessageModal.tsx
import React, { useState } from 'react'
import { useSignAndSubmitAction } from '~/api/actions'
import ModalHeader from './ModalHeader'
import { useTokenDataStore } from "~/store/tokenDataStore"
import { useAccount } from "wagmi"
import ModalWrapper from './ModalWrapper'

interface MessageModalProps {
  isOpen: boolean
  recipient: {
    id: string
    username: string
    tokenId?: number
  }
  onClose: () => void
}

export const MessageModal: React.FC<MessageModalProps> = ({ isOpen, recipient, onClose }) => {
  const [message, setMessage] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const { isConnected } = useAccount()
  const activeTokenId = useTokenDataStore(state => state.activeTokenId)
  const signAndSubmit = useSignAndSubmitAction()

  const handleSendMessage = async () => {
    if (!message.trim() || !activeTokenId || isLoading) return

    setIsLoading(true)
    try {
      await signAndSubmit({
        actionType: 'caw',
        senderId: activeTokenId,
        receiverId: Number(recipient.id),
        receiverCawonce: recipient.tokenId ?? 0,
        text: message.trim()
      })
      setMessage('')
      onClose()
    } catch (err) {
      console.error('Message failed', err)
    } finally {
      setIsLoading(false)
    }
  }

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSendMessage()
    }
  }

  return (
    <ModalWrapper
      isOpen={isOpen}
      onClose={onClose}
      maxWidth="max-w-md"
      backdropClass="bg-black/50"
      className="p-6"
    >
      <ModalHeader title="Send message" onClose={onClose} border={false} size="lg" forceDark className="mb-6 px-0" />

      {/* Recipient Info */}
      <div className="flex items-center space-x-3 mb-6">
        <div className="w-10 h-10 rounded-full bg-gray-600 flex items-center justify-center">
          <img
            src="/images/logo.jpeg"
            alt={recipient.username}
            className="w-10 h-10 rounded-full object-cover"
          />
        </div>
        <div>
          <div className="text-white font-medium">{recipient.username}</div>
          <div className="text-gray-400 text-sm">@{recipient.username}</div>
        </div>
      </div>

      {/* Message Input */}
      <div className="space-y-3">
        <label className="text-white text-sm font-medium">
          Message:
        </label>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyPress={handleKeyPress}
          className="w-full resize-none rounded-lg border transition-all duration-300 focus:outline-none py-3 px-4 text-white placeholder-white/50 focus:border-white/30 focus:bg-black bg-black border-white/20"
          rows={4}
          placeholder="What's happening?"
          disabled={isLoading}
        />
      </div>

      {/* Send Button */}
      <div className="mt-6">
        <button
          onClick={handleSendMessage}
          disabled={isLoading || !isConnected}
          className="w-full py-2 px-6 rounded-full font-semibold bg-yellow-500 hover:bg-yellow-600 text-black transition-all duration-200"
        >
          {isLoading ? 'Sending...' : 'Send'}
        </button>
      </div>
    </ModalWrapper>
  )
}

export default MessageModal
