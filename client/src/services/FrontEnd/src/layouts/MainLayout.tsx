import { Toaster } from "react-hot-toast";
import { Modals } from "~/components/modals/Modals";
import Sidebar from "~/components/Sidebar";
import Trending from "~/components/Trending";
import SearchBar from "~/components/SearchBar";
import BugReportModal from "~/components/modals/BugReportModal";
import MobilePostModal from "~/components/MobilePostModal";
import { useTheme } from "~/hooks/useTheme";
import { useState } from "react";
import { useAccount } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { HiOutlineMenu, HiOutlineX, HiOutlinePlus } from "react-icons/hi";
import { BsWallet } from "react-icons/bs";
import { Link } from "react-router-dom";
import cawLogo from '~/assets/images/caw-logo.png';

interface MainLayoutProps {
  children: React.ReactNode;
}

const MainLayout = ({ children }: MainLayoutProps) => {
  const { isDark } = useTheme()
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)
  const [showBugReport, setShowBugReport] = useState(false)
  const [isMobilePostModalOpen, setIsMobilePostModalOpen] = useState(false)
  const { isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  
  return (
    <div className={`max-h-screen min-h-screen w-full max-w-[1050px] flex m-auto transition-all duration-300 ${
      isDark ? 'bg-black' : 'bg-white'
    }`}>
      {/* Mobile Header */}
      <div className={`md:hidden fixed top-0 left-0 right-0 z-[9999] flex items-center justify-center p-4 border-b w-screen overflow-hidden transition-all duration-300 ${
        isDark ? 'bg-black border-white/10' : 'bg-white border-gray-200'
      }`}>
        <button
          onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
          className={`absolute left-4 p-2 rounded-lg transition-colors duration-200 ${
            isDark ? 'text-white hover:bg-white/10' : 'text-black hover:bg-gray-100'
          }`}
        >
          {isMobileMenuOpen ? <HiOutlineX className="w-6 h-6" /> : <HiOutlineMenu className="w-6 h-6" />}
        </button>
        
        <Link to="/home" className="flex items-center justify-center w-full">
          <img
            src={cawLogo}
            alt="CAW Logo"
            className="w-10 h-10 object-contain"
          />
        </Link>
      </div>

      {/* Mobile Sidebar Overlay */}
      <div 
        className={`md:hidden fixed inset-0 z-40 transition-all duration-300 ${
          isMobileMenuOpen ? 'bg-black/50 opacity-100' : 'bg-black/0 opacity-0 pointer-events-none'
        }`}
        onClick={() => setIsMobileMenuOpen(false)}
      >
        <div 
          className={`fixed left-0 top-0 h-full w-80 max-w-[90vw] transform transition-transform duration-300 ease-in-out ${
            isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full'
          } ${
            isDark ? 'bg-black border-r border-white/20' : 'bg-white border-r border-gray-300'
          }`}
          onClick={(e) => e.stopPropagation()}
        >
          <Sidebar />
        </div>
      </div>

      {/* Desktop Sidebar */}
      <div className="hidden md:block w-[200px]">
        <div className={`fixed border-r h-full w-[200px] transition-all duration-300 ${
          isDark ? 'border-white/20' : 'border-gray-300'
        }`}>
          <Sidebar />
        </div>
      </div>
      
      {/* Main Content */}
      <main className={`flex-1 min-w-0 transition-all duration-300 ${
        isDark ? 'bg-black text-white' : 'bg-white text-black'
      } ${isMobileMenuOpen ? 'md:pt-0 pt-16' : 'pt-16 md:pt-0'}`}>
        <div className="p-3">
          {children}
        </div>
      </main>
      <Toaster
        position="top-center"
        reverseOrder
        containerStyle={{ marginTop: "40px" }}
        toastOptions={{ removeDelay: 0 }}
      />
      <div className="hidden lg:block w-[280px]">
        <div className={`fixed border-l h-full w-[280px] transition-all duration-300 ${
          isDark ? 'border-white/20' : 'border-gray-300'
        }`}>
          <div className="p-2">
            <SearchBar />
          </div>
          <div className="mt-4">
            <Trending/>
          </div>
        </div>
      </div>
      <Modals />

      {/* Floating Action Button - Mobile only */}
      <div className="md:hidden fixed bottom-5 right-5 z-30 transform-none">
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
      <MobilePostModal
        isOpen={isMobilePostModalOpen}
        onClose={() => setIsMobilePostModalOpen(false)}
      />

      {/* Floating bug report button */}
      <button
        onClick={() => setShowBugReport(true)}
        className={`fixed bottom-5 left-5 md:right-5 md:left-auto z-40 w-9 h-9 rounded-full flex items-center justify-center shadow-lg transition-all cursor-pointer opacity-60 hover:opacity-100 ${
          isDark
            ? 'bg-zinc-800 hover:bg-zinc-700 text-white/70'
            : 'bg-gray-200 hover:bg-gray-300 text-gray-500'
        }`}
        title="Report a bug"
      >
        <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          {/* Body */}
          <ellipse cx="12" cy="15" rx="5" ry="6" />
          {/* Head */}
          <circle cx="12" cy="7" r="3" />
          {/* Antennae */}
          <path d="M10 5L8 2" />
          <path d="M14 5L16 2" />
          {/* Legs */}
          <path d="M7 13H3" />
          <path d="M7 17H4" />
          <path d="M17 13H21" />
          <path d="M17 17H20" />
        </svg>
      </button>
      <BugReportModal isOpen={showBugReport} onClose={() => setShowBugReport(false)} />
    </div>
  );
};

export default MainLayout;
