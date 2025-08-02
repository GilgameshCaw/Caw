import React, { useState } from 'react'
import { useSignAndSubmitAction } from '../api/actions'
import { useTokenDataStore } from "~/store/tokenDataStore";
import { useAccount, useChains, useSwitchChain, useConnections } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import type { ActionParams } from '~/api/actions'
import { baseSepolia } from "wagmi/chains";
import type { CawItem } from '~/types'

interface PostFormProps {
  /** if provided, we’re replying to this caw */
  replyTo?: CawItem;
  quote?: CawItem;
  /** called after a successful sign+submit */
  onSuccess?: () => void;
}

const PostForm: React.FC<PostFormProps> = ({ replyTo, quote, onSuccess }) => {

  const { isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const connections = useConnections();

  const [text, setText] = useState('')
  const activeTokenId = useTokenDataStore(state => state.activeTokenId);
  const signAndSubmit = useSignAndSubmitAction()

  const { switchChain } = useSwitchChain();
  const chains = useChains();
  const handleSwitchChain = () => switchChain({ chainId: baseSepolia.id });
  const wrongChain = connections[0]?.chainId != baseSepolia.id;
  console.log("CHAIN:", connections[0]?.chainId);

  return (
    <div className="p-4 ">
      <textarea
        className="w-full bg-black placeholder-gray-500 resize-none"
        rows={3}
        placeholder={
          replyTo
            ? `Reply to @${replyTo.user.username}`
            : (
              quote ? "Add a comment" : "What's happening?"
            )
        }
        value={text}
        onChange={e => setText(e.target.value)}
      />
      <div className="flex justify-end mt-2">
        { !isConnected ? (
          <button className="btn btn-md w-full" onClick={openConnectModal}>
            Connect Wallet
          </button>
        ) : wrongChain ? (
          <button className="btn btn-md w-full" onClick={handleSwitchChain}>
            Switch Network
          </button>
        ) : (
          <button
            className="px-4 py-1 bg-blue-500 rounded disabled:opacity-50"
            disabled={!text}
            onClick={async () => {
              const params: ActionParams = {
                actionType: 'caw',
                senderId:   activeTokenId!,
                text,
                ...(replyTo && {
                  receiverId:      replyTo.user.tokenId,
                  receiverCawonce: replyTo.cawonce,
                })
              }
              await signAndSubmit(params)
              setText('')
              onSuccess?.()
            }}
          >
            {replyTo ? 'Reply' : 'Post'}
          </button>
        ) }
      </div>
    </div>
  )
}

export default PostForm

