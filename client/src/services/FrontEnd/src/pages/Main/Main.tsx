import { Tabs, TabItem } from '~/components/Tabs'
import MainLayout from "~/layouts/MainLayout";
import PostForm from "~/components/PostForm";
import Feed from "~/components/Feed";
import MobilePostModal from "~/components/MobilePostModal";
import MobileSubMenu from "~/components/MobileSubMenu";
import MobileBottomNavbar from "~/components/MobileBottomNavbar";
import LiveVoiceRooms from "~/components/LiveVoiceRooms";
import React, { useState, useEffect } from "react";
import VoiceRoomActive from "~/pages/VoiceRoomActive";
import VoiceRoom from "~/pages/VoiceRoom";
import { useAccount } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { HiOutlinePlus } from "react-icons/hi";
import { BsWallet } from 'react-icons/bs';
import { useTheme } from '~/hooks/useTheme';

type MainTab = 'Following' | 'For you'

export const Main: React.FC = () => {
  const [activeTab, setActiveTab] = useState<MainTab>('Following')
  const [activeBottomTab, setActiveBottomTab] = useState('home')
  const [isMobilePostModalOpen, setIsMobilePostModalOpen] = useState(false)
  const [isSubMenuOpen, setIsSubMenuOpen] = useState(false)
  const [isVoiceRoomCreate, setIsVoiceRoomCreate] = useState(false)
  const [isVoiceRoomActive, setIsVoiceRoomActive] = useState(false)
  const [isVoiceRoomMinimized, setIsVoiceRoomMinimized] = useState(false)
  const [voiceRoomTopic, setVoiceRoomTopic] = useState('')
  const [voiceRoomRecording, setVoiceRoomRecording] = useState(false)
  const [isScrolling, setIsScrolling] = useState(false)
  const { isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { isDark } = useTheme()

  // Handle scroll detection for transparency effect
  useEffect(() => {
    let scrollTimer: NodeJS.Timeout

    const handleScroll = () => {
      setIsScrolling(true)
      clearTimeout(scrollTimer)
      scrollTimer = setTimeout(() => {
        setIsScrolling(false)
      }, 150)
    }

    window.addEventListener('scroll', handleScroll)
    return () => {
      window.removeEventListener('scroll', handleScroll)
      clearTimeout(scrollTimer)
    }
  }, [])

  const mainTabs: TabItem<MainTab>[] = [
    { id: 'Following', label: 'Following' },
    { id: 'For you', label: 'For You' },
  ]

  const handleStartVoiceRoom = (topic: string, isRecording: boolean) => {
    setVoiceRoomTopic(topic)
    setVoiceRoomRecording(isRecording)
    setIsVoiceRoomCreate(false)
    setIsVoiceRoomActive(true)
  }

  const handleCloseVoiceRoom = () => {
    setIsVoiceRoomActive(false)
    setIsVoiceRoomMinimized(false)
    setVoiceRoomTopic('')
    setVoiceRoomRecording(false)
  }

  const handleJoinLiveRoom = (roomId: string) => {
    // For now, just open the voice room active with mock data
    // In the future, this would fetch the actual room data
    setVoiceRoomTopic('Live Voice Room')
    setVoiceRoomRecording(true)
    setIsVoiceRoomActive(true)
  }

  const handleBottomTabChange = (tab: string) => {
    setActiveBottomTab(tab)
    // Navigation logic for each tab
  }

  return (
    <>
      <MainLayout>
        <div className="max-w-2xl mx-auto px-3 sm:px-6 py-4">
          <Tabs<MainTab>
            tabs={mainTabs}
            active={activeTab}
            onChange={setActiveTab}
          />
          
          {/* Live Voice Rooms - Mobile only, below tabs */}
          <LiveVoiceRooms onJoinRoom={handleJoinLiveRoom} />
          
          {/* PostForm - Hidden on mobile */}
          <div className="hidden md:block border-b border-white/20">
            <PostForm/>
          </div>
          <div className="w-full">
            <Feed
              filter={activeTab}
            />
          </div>
        </div>

        {/* Floating Action Button - Mobile only */}
        <div className="md:hidden fixed bottom-24 right-12 z-30 transform-none">
          <button
            onClick={isConnected ? () => setIsSubMenuOpen(true) : openConnectModal}
            className={`w-14 h-14 bg-yellow-500 hover:bg-yellow-400 text-black rounded-full shadow-lg hover:shadow-xl transition-all duration-200 flex items-center justify-center ${
              isScrolling ? 'opacity-60' : 'opacity-100'
            }`}
          >
            {isConnected ? (
              <HiOutlinePlus className="w-6 h-6" />
            ) : (
              <BsWallet className="w-6 h-6" />
            )}
          </button>
        </div>

        {/* Mobile Submenu */}
        <MobileSubMenu
          isOpen={isSubMenuOpen}
          onClose={() => setIsSubMenuOpen(false)}
          onPostClick={() => setIsMobilePostModalOpen(true)}
          onVoiceRoomClick={() => setIsVoiceRoomCreate(true)}
        />

        {/* Mobile Post Modal */}
        <MobilePostModal 
          isOpen={isMobilePostModalOpen}
          onClose={() => setIsMobilePostModalOpen(false)}
        />

        {/* Mobile Bottom Navbar */}
        <MobileBottomNavbar 
          activeTab={activeBottomTab}
          onTabChange={handleBottomTabChange}
          isVisible={!isMobilePostModalOpen}
        />
      </MainLayout>

      {/* Voice Room Create Modal - Outside MainLayout */}
      {isVoiceRoomCreate && (
        <>
          {/* Background Overlay - Full screen */}
          <div className="md:hidden fixed inset-0 bg-gray-800/75 z-[60]"></div>
          <VoiceRoom 
            onStartRoom={handleStartVoiceRoom}
          />
        </>
      )}

      {/* Voice Room Active Modal - Outside MainLayout */}
      {isVoiceRoomActive && (
        <>
          {/* Background Overlay - Full screen (only when not minimized) */}
          {!isVoiceRoomMinimized && (
            <div className="md:hidden fixed inset-0 bg-gray-800/75 z-[60]"></div>
          )}
          <VoiceRoomActive 
            onClose={handleCloseVoiceRoom} 
            onMinimizeChange={setIsVoiceRoomMinimized}
            topic={voiceRoomTopic}
            isRecording={voiceRoomRecording}
          />
        </>
      )}
    </>
  );
};