// src/components/FeedItem.tsx
import React, { useState, useRef, useEffect } from 'react'
import { useSignAndSubmitAction } from '~/api/actions'
import Recaw from '~/assets/images/recaw.svg?react';
import Pencil from '~/assets/images/pencil.svg?react';
import Heart from '~/assets/images/heart.svg?react';
import Comment from '~/assets/images/comment.svg?react';
import { useTokenDataStore } from '~/store/tokenDataStore'
import { useModalStore } from '~/store/modalStore'
import { Link } from 'react-router-dom'
import { User, CawItem } from '~/types'

const FeedItem: React.FC<{ item: CawItem }> = ({ item }) => {
  const activeTokenId     = useTokenDataStore(s => s.activeTokenId)
  const openModal        = useModalStore(s => s.openModal)
  const [busyLike, setBusyLike]     = useState(false)
  const [busyRecaw, setBusyRecaw]   = useState(false)
  const signAndSubmit     = useSignAndSubmitAction()
  const [showRecawMenu, setShowRecawMenu]   = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)


  // close menu on any outside click
  useEffect(() => {
    if (!showRecawMenu) return
    function onClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {

        e.stopPropagation();
        e.preventDefault();
        setShowRecawMenu(false)
      }
    }
    // document.addEventListener('mousedown', onClickOutside)
    // return () => document.removeEventListener('mousedown', onClickOutside)
    document.addEventListener('click', onClickOutside, true)
    return () => document.removeEventListener('click', onClickOutside, true)
  }, [showRecawMenu])


  let useItem = item;
  let headline;
  if (item.content === "" && item.parent) {
    headline = 'Recawed by ' + item.user.username
    useItem = item.parent;
  }

  const handleLike = async (event) => {
    if (!activeTokenId || busyLike) return
    event.preventDefault()
    setBusyLike(true)
    try {
      await signAndSubmit({
        actionType:      useItem.hasLiked ? 'unlike' : 'like',
        senderId:        activeTokenId,
        receiverId:      useItem.user.tokenId,
        receiverCawonce: useItem.cawonce ?? 0,
      })
      // maybe optimistically update UI here…
    } catch (err) {
      console.error('Like failed', err)
    } finally {
      setBusyLike(false)
    }
  }

  const handleRecaw = async (event) => {
    if (!activeTokenId || busyRecaw) return
    event.preventDefault()
    setBusyRecaw(true)
    console.log("useItem: ", useItem);
    try {
      await signAndSubmit({
        actionType:      'recaw',
        senderId:        activeTokenId,
        receiverId:      Number(useItem.userId ?? 0),
        receiverCawonce: useItem.cawonce ?? 0,
      })
    } catch (err) {
      console.error('Recaw failed', err)
    } finally {
      setBusyRecaw(false)
    }
  }

  const handleReply = (e: React.MouseEvent) => {
    e.preventDefault()                // so Link wrapping doesn’t fire
    openModal('comment', item)     // pass the Caw as payload
  }

  console.log("FEED ITEM", item)

  return (
    <Link to={`/caws/${item.id}`} className="block">
      {item.parent &&
        <Link to={`/caws/${item.parent.id}`} className="block text-xs underline">
        Replying to @{item.parent.user.username}
      </Link>}
      <div className="p-4 border-b border-gray-800">
        { !headline ? null :
          <div className="text-xs mb-3 ">{headline}</div>
        }
        <div className={`${headline ? "border border-gray-800 p-4" : 0}`}>
          <div className="font-bold">@{useItem.user.username}</div>
          <p className="my-2">
            {useItem.content}
          </p>

          <div className="flex space-x-6 text-gray-500 relative">
            <button
              className='cursor-pointer flex gap-[5px]'
              onClick={handleReply}
              title="Reply"
            >
              <Comment className='fill-white w-[18px]' /> ({useItem.commentCount})
            </button>

            <div className="relative ">
              <button
                  onClick={e => { e.preventDefault(); setShowRecawMenu(show => !show) }}
                  title="ReCaw"
                  className="cursor-pointer flex gap-[5px]"
                >
                <Recaw className={`w-[18px] fill-${useItem.hasRecawed ? '[#00ff00]' : 'white'}`} />
                ({useItem.recawCount})
              </button>

              {showRecawMenu && (
                <div
                  ref={menuRef}
                  className="absolute z-10 text-white text-bold bg-black rounded-lg p-2 space-y-1 shadow"
                  style={{ left: '-3px', top: '0' }}
                >
                  <button
                    className="flex items-center gap-2 px-3 py-1 cursor-pointer rounded"
                    onClick={e => { e.preventDefault(); setShowRecawMenu(false); handleRecaw(e) }}
                  >
                    <Recaw className="fill-white w-4 h-4"/> Repost
                  </button>
                  <button
                    className="flex items-center gap-2 px-3 py-1 cursor-pointer rounded"
                    onClick={e => { e.preventDefault(); setShowRecawMenu(false); openModal('quote', item) }}
                  >
                    <Pencil className="fill-white w-4 h-4"/> Quote
                  </button>
                </div>
              )}
            </div>

            <button
              className='cursor-pointer flex gap-[5px]'
              onClick={handleLike}
              disabled={busyLike}
              title="Like"
            >
            <Heart className={`fill-[#ff0000] fill-${useItem.hasLiked ? '[#ff0000]' : 'white'} w-[18px]`} /> ({useItem.likeCount})
            </button>
          </div>
        </div>
      </div>
    </Link>
  )
}

export default FeedItem

