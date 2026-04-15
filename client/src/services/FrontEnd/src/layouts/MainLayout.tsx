import { Toaster } from "react-hot-toast";
import { Modals } from "~/components/modals/Modals";
import Sidebar from "~/components/Sidebar";
import Trending from "~/components/Trending";
import SearchBar from "~/components/SearchBar";
import BugReportModal from "~/components/modals/BugReportModal";
import { useTheme } from "~/hooks/useTheme";
import Tooltip from "~/components/Tooltip";
import { useState, lazy, Suspense } from "react";
import { HiOutlineMenu, HiOutlineX } from "react-icons/hi";
import { Link, useLocation } from "react-router-dom";
import { useActiveToken } from "~/store/tokenDataStore";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";
import cawLogo from '~/assets/images/caw-logo.png';

const BoidsBg = lazy(() => import('~/components/BoidsBg'))

interface MainLayoutProps {
  children: React.ReactNode;
}

const MainLayout = ({ children }: MainLayoutProps) => {
  const { isDark } = useTheme()
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)
  const [showBugReport, setShowBugReport] = useState(false)
  const location = useLocation()
  const activeToken = useActiveToken()
  const { isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()

  // Captive mode: no username and on a public page like /help/*
  const isCaptive = !activeToken?.username
  const hideSidebars = isCaptive && (location.pathname.startsWith('/help') || location.pathname.startsWith('/usernames') || location.pathname.startsWith('/faucet'))

  return (
    <>
    {/* Fixed backdrop so scrolling doesn't reveal the root gradient */}
    {!isDark && (
      <div className="fixed inset-0 z-0 flex justify-center pointer-events-none">
        <div className="w-full max-w-[1050px] bg-white shadow-[0_0_40px_rgba(0,0,0,0.08)]" />
      </div>
    )}
    <div className={`min-h-screen w-full max-w-[1050px] flex m-auto transition-colors duration-300 relative z-[1] ${
      hideSidebars ? '' : isDark ? 'bg-black' : 'bg-white shadow-[0_0_40px_rgba(0,0,0,0.08)]'
    }`}>
      {/* Mobile Header */}
      {!hideSidebars && (
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
      )}

      {/* Mobile Sidebar Overlay */}
      {!hideSidebars && (
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
      )}

      {/* Desktop Sidebar */}
      {!hideSidebars && (
        <div className="hidden md:block w-[200px]">
          <div className={`fixed border-r h-full w-[200px] z-30 transition-colors duration-300 ${
            isDark ? 'border-white/20' : 'border-gray-300'
          }`}>
            <Sidebar />
          </div>
        </div>
      )}

      {/* Main Content */}
      <main className={`flex-1 min-w-0 transition-colors duration-300 flex flex-col ${
        isDark ? 'bg-black text-white' : 'bg-white text-black'
      } ${hideSidebars ? 'pt-0 relative overflow-hidden' : isMobileMenuOpen ? 'md:pt-0 pt-16' : 'pt-16 md:pt-0'}`}>
        {hideSidebars && (
          <Suspense fallback={null}>
            <BoidsBg isDark={isDark} />
          </Suspense>
        )}
        <div className={`flex-1 min-h-0 ${hideSidebars ? 'pb-24 relative z-10' : ''}`}>
          {children}
        </div>
      </main>
      <Toaster
        position="top-center"
        reverseOrder
        containerStyle={{ marginTop: "40px" }}
        toastOptions={{ removeDelay: 0 }}
      />
      {!hideSidebars && (
        <div className="hidden lg:block w-[280px]">
          <div className={`fixed border-l h-full w-[280px] z-30 transition-colors duration-300 ${
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
      )}
      <Modals />

      {/* Captive banner — fixed bottom bar for unauthenticated users on public pages */}
      {hideSidebars && (
        <div className={`fixed bottom-0 left-0 right-0 z-50 border-t backdrop-blur-[2px] ${
          isDark ? 'bg-black/10 border-white/10' : 'bg-white/10 border-gray-200'
        }`}>
          <div className="max-w-3xl mx-auto flex items-center justify-between px-5 py-3">
            <Link to="/welcome" className="flex items-center gap-2.5">
              <img src={cawLogo} alt="CAW" className="w-12 h-12 object-contain" />
              <span
                className="text-4xl"
                style={{
                  fontFamily: 'Fraunces',
                  color: '#ebc046',
                  letterSpacing: '5px',
                  textShadow: '0 1px 2px rgba(0, 0, 0, 0.6), 0 0 4px rgba(0, 0, 0, 0.3)',
                }}
              >
                CAW
              </span>
            </Link>
            {location.pathname.startsWith('/usernames') ? (
              <Link
                to="/help/faq"
                className={`px-6 py-2.5 font-semibold text-base rounded-full border transition-all ${
                  isDark
                    ? 'border-white/20 text-white/80 hover:bg-white/10'
                    : 'border-gray-300 text-gray-700 hover:bg-gray-100'
                }`}
              >
                Learn More
              </Link>
            ) : !isConnected ? (
              <button
                onClick={openConnectModal}
                className="px-6 py-2.5 bg-yellow-500 text-black font-bold text-base rounded-full hover:bg-yellow-400 transition-all shadow-lg cursor-pointer"
              >
                Sign In
              </button>
            ) : (
              <Link
                to="/usernames/new"
                className="px-6 py-2.5 bg-yellow-500 text-black font-bold text-base rounded-full hover:bg-yellow-400 transition-all shadow-lg"
              >
                Create Your Profile
              </Link>
            )}
          </div>
        </div>
      )}

      {/* Floating feedback button */}
      <div className={`fixed z-40 left-[5px] bottom-[5px]`}>
      <Tooltip text="Feedback" position="top">
        <button
          onClick={() => setShowBugReport(true)}
          className={`w-9 h-9 rounded-full flex items-center justify-center shadow-lg transition-all cursor-pointer opacity-60 hover:opacity-100 ${
            isDark
              ? 'bg-zinc-800 hover:bg-zinc-700 text-white/70'
              : 'bg-gray-200 hover:bg-gray-300 text-gray-500'
          }`}
        >
        <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          {/* Head */}
          <circle cx="12" cy="7.5" r="2.5" fill="currentColor" />
          {/* Antennae */}
          <path d="M10.5 5.5L9 2.5" />
          <path d="M13.5 5.5L15 2.5" />
          {/* Body */}
          <ellipse cx="12" cy="15.5" rx="6" ry="6.5" fill="currentColor" opacity="0.15" />
          <ellipse cx="12" cy="15.5" rx="6" ry="6.5" />
          {/* Wing split */}
          <line x1="12" y1="9" x2="12" y2="22" />
          {/* Spots */}
          <circle cx="9.5" cy="13" r="1.2" fill="currentColor" />
          <circle cx="14.5" cy="13" r="1.2" fill="currentColor" />
          <circle cx="10" cy="17.5" r="1.2" fill="currentColor" />
          <circle cx="14" cy="17.5" r="1.2" fill="currentColor" />
          {/* Legs */}
          <path d="M6.5 12.5L4 11" />
          <path d="M6 15.5L3.5 16" />
          <path d="M6.5 18.5L4.5 20.5" />
          <path d="M17.5 12.5L20 11" />
          <path d="M18 15.5L20.5 16" />
          <path d="M17.5 18.5L19.5 20.5" />
        </svg>
        </button>
      </Tooltip>
      </div>
      <BugReportModal isOpen={showBugReport} onClose={() => setShowBugReport(false)} />
    </div>
    </>
  );
};

export default MainLayout;
