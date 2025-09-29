import { Toaster } from "react-hot-toast";
import { Modals } from "~/components/modals/Modals";
import Sidebar from "~/components/Sidebar";
import Trending from "~/components/Trending";
import SearchBar from "~/components/SearchBar";
import { useTheme } from "~/hooks/useTheme";
import { useState } from "react";
import { HiOutlineMenu, HiOutlineX } from "react-icons/hi";
import cawLogo from '~/assets/images/caw-logo.png';

interface MainLayoutProps {
  children: React.ReactNode;
}

const MainLayout = ({ children }: MainLayoutProps) => {
  const { isDark } = useTheme()
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)
  
  return (
    <div className={`min-h-screen w-full max-w-[1050px] flex m-auto transition-all duration-300 ${
      isDark ? 'bg-black' : 'bg-white'
    }`}>
      {/* Mobile Header */}
      <div className={`md:hidden fixed top-0 left-0 right-0 z-50 flex items-center justify-center p-4 border-b w-screen overflow-hidden transition-all duration-300 ${
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
        
        <div className="flex items-center justify-center w-full">
          <img 
            src={cawLogo} 
            alt="CAW Logo" 
            className="w-10 h-10 object-contain"
          />
        </div>
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
            isDark ? 'bg-black border-r border-white/5' : 'bg-white border-r border-gray-200'
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
      <main className={`w-full max-w-lg mr-2 md:ml-22 md:max-w-none transition-all duration-300 ${
        isDark ? 'bg-black text-white' : 'bg-white text-black'
      } ${isMobileMenuOpen ? 'md:pt-0 pt-16' : 'pt-16 md:pt-0'} pb-20 md:pb-0`}>
        <div className="p-3 md:pr-3">
          {children}
        </div>
      </main>
      <Toaster
        position="top-center"
        reverseOrder
        containerStyle={{ marginTop: "40px" }}
        toastOptions={{ removeDelay: 0 }}
      />
      <div className="hidden md:block w-[280px]">
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
    </div>
  );
};

export default MainLayout;
