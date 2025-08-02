// src/pages/ProfilePage.tsx
import React, { useState } from 'react'
import { useParams }    from 'react-router-dom'
import MainLayout       from '~/layouts/MainLayout'
import { Tabs, TabItem } from '~/components/Tabs'
import Feed             from '~/components/Feed'

type ProfileTab = 'profile' | 'profile-likes'

export const Profile: React.FC = () => {
  const { username } = useParams<{ username: string }>()
  const [activeTab, setActiveTab] = useState<ProfileTab>('profile')

  // define our two tabs
  const profileTabs: TabItem<ProfileTab>[] = [
    { id: 'profile',       label: 'Posts'  },
    { id: 'profile-likes', label: 'Likes'  },
  ]

  return (
    <MainLayout>
      <div className="max-w-2xl mx-auto">
        <h1 className="text-2xl font-bold mb-4">@{username}</h1>

        <Tabs<ProfileTab>
          tabs={profileTabs}
          active={activeTab}
          onChange={setActiveTab}
        />

        <Feed
          filter={activeTab}
          username={username}
        />
      </div>
    </MainLayout>
  )
}

