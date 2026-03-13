import { Tabs, TabItem } from '~/components/Tabs'
import MainLayout from "~/layouts/MainLayout";
import PostForm from "~/components/PostForm";
import Feed, { type FeedRef } from "~/components/Feed";
import MobilePostModal from "~/components/MobilePostModal";
import React, { useState, useRef, useEffect } from "react";
import { useAccount } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { HiOutlinePlus } from "react-icons/hi";
import { BsWallet } from 'react-icons/bs';
import { useTheme } from '~/hooks/useTheme';
import { useSearchParams } from 'react-router-dom';

type MainTab = 'following' | 'foryou'

const TAB_LABELS: Record<MainTab, string> = {
  'following': 'Following',
  'foryou': 'For You'
}

const TAB_TO_FILTER: Record<MainTab, 'Following' | 'For you'> = {
  'following': 'Following',
  'foryou': 'For you'
}

export const Main: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams()
  const tabParam = searchParams.get('tab') as MainTab | null
  const [activeTab, setActiveTab] = useState<MainTab>(
    tabParam && (tabParam === 'following' || tabParam === 'foryou') ? tabParam : 'following'
  )

  // Sync URL when tab changes
  useEffect(() => {
    const currentTab = searchParams.get('tab')
    if (currentTab !== activeTab) {
      if (activeTab === 'following') {
        // Remove tab param for default tab
        searchParams.delete('tab')
      } else {
        searchParams.set('tab', activeTab)
      }
      setSearchParams(searchParams, { replace: true })
    }
  }, [activeTab])
  const [isMobilePostModalOpen, setIsMobilePostModalOpen] = useState(false)
  const { isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { isDark } = useTheme()
  const feedRef = useRef<FeedRef>(null)

  const mainTabs: TabItem<MainTab>[] = [
    { id: 'following', label: TAB_LABELS['following'] },
    { id: 'foryou', label: TAB_LABELS['foryou'] },
  ]

  return (
    <MainLayout>
      <div className="max-w-2xl md:max-w-none lg:max-w-2xl mx-auto px-3 sm:px-6 py-4">
        <Tabs<MainTab>
          tabs={mainTabs}
          active={activeTab}
          onChange={setActiveTab}
        />
        {/* PostForm - Always visible */}
        <div className="border-b border-white/20">
          <PostForm onSuccess={() => feedRef.current?.refresh()}/>
        </div>
        <div className="w-full">
          <Feed
            ref={feedRef}
            filter={TAB_TO_FILTER[activeTab]}
          />
        </div>
      </div>

      {/* Floating Action Button - Mobile only */}
      <div className="md:hidden fixed bottom-20 right-12 z-30 transform-none">
        <button
          onClick={isConnected ? () => setIsMobilePostModalOpen(true) : openConnectModal}
          className="w-14 h-14 bg-yellow-500 hover:bg-yellow-400 text-black rounded-full shadow-lg hover:shadow-xl transition-all duration-200 flex items-center justify-center"
        >
          {isConnected ? (
            <HiOutlinePlus className="w-6 h-6" />
          ) : (
            <BsWallet className="w-6 h-6" />
          )}
        </button>
      </div>

      {/* Mobile Post Modal */}
      <MobilePostModal
        isOpen={isMobilePostModalOpen}
        onClose={() => setIsMobilePostModalOpen(false)}
        onSuccess={() => {
          setIsMobilePostModalOpen(false)
          feedRef.current?.refresh()
        }}
      />
    </MainLayout>
  );
};