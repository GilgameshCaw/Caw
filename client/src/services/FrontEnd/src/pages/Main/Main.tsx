import { Tabs, TabItem } from '~/components/Tabs'
import MainLayout from "~/layouts/MainLayout";
import PostForm from "~/components/PostForm";
import Feed, { type FeedRef } from "~/components/Feed";
import MobilePostModal from "~/components/MobilePostModal";
import React, { useState, useRef } from "react";
import { useAccount } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { HiOutlinePlus } from "react-icons/hi";
import { BsWallet } from 'react-icons/bs';
import { useTheme } from '~/hooks/useTheme';

type MainTab = 'Following' | 'For you'

export const Main: React.FC = () => {
  const [activeTab, setActiveTab] = useState<MainTab>('Following')
  const [isMobilePostModalOpen, setIsMobilePostModalOpen] = useState(false)
  const { isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { isDark } = useTheme()
  const feedRef = useRef<FeedRef>(null)

  const mainTabs: TabItem<MainTab>[] = [
    { id: 'Following', label: 'Following' },
    { id: 'For you', label: 'For You' },
  ]

  return (
    <MainLayout>
      <div className="max-w-2xl mx-auto px-3 sm:px-6 py-4">
        <Tabs<MainTab>
          tabs={mainTabs}
          active={activeTab}
          onChange={setActiveTab}
        />
        {/* PostForm - Hidden on mobile */}
        <div className="hidden md:block border-b border-white/20">
          <PostForm onSuccess={() => feedRef.current?.refresh()}/>
        </div>
        <div className="w-full">
          <Feed
            ref={feedRef}
            filter={activeTab}
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