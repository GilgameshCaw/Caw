import React, { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import PostForm from "~/components/PostForm";
import MainLayout from '~/layouts/MainLayout'
import FeedItem from '~/components/FeedItem'
import { apiFetch } from '~/api/client'
import type { CawItem } from '~/types'

export const CawPage: React.FC = () => {
  const { id } = useParams<{ id: string }>()
  const [caw, setCaw]           = useState<CawItem | null>(null)
  const [comments, setComments] = useState<CawItem[]>([])

  useEffect(() => {
    (async () => {
      const { caw: fetched, comments: fetchedComments } =
        await apiFetch<{ caw: CawItem; comments: CawItem[] }>(`/api/caws/${id}`)
      setCaw(fetched)
      setComments(fetchedComments)
    })()
  }, [id])

  if (!caw) return <MainLayout><div>Loading…</div></MainLayout>

  return (
    <MainLayout>
      <FeedItem item={{
        id:            caw.id,
        user:          caw.user,
        content:       caw.content,
        timestamp:     caw.timestamp,
        likeCount:     caw.likeCount,
        hasLiked:      caw.hasLiked,
        hasRecawed:    caw.hasRecawed,
        commentCount:  caw.commentCount,
        recawCount:    caw.recawCount,
        cawonce:       caw.cawonce,
        userId:        caw.user.tokenId,
        originalCaw:   caw.originalCaw,
      }} />

      <div className="border-b border-gray-800">
        <PostForm
          replyTo={caw}
      />
      </div>
      <div className="mt-6">
        {comments.map(comm => {
    console.log("CAW", comm);

          return <FeedItem
            key={comm.id}
            item={{
              id:           comm.id,
              user:         comm.user,
              content:      comm.content,
              timestamp:    comm.timestamp,
              likeCount:    comm.likeCount,
              hasLiked:     comm.hasLiked,
              hasRecawed:   comm.hasRecawed,
              commentCount: comm.commentCount,
              recawCount:   comm.recawCount,
              cawonce:      comm.cawonce,
              userId:       comm.user.tokenId,
              originalCaw:  comm.originalCaw,
            }}
          />
        })}
      </div>
    </MainLayout>
  )
}

