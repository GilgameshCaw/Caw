import MainLayout from '~/layouts/MainLayout'
import { useTheme } from '~/hooks/useTheme'
import { useState } from 'react'

// Settings page component with clean, modern design
export const SettingsPage: React.FC = () => {
  const { isDark, toggleTheme } = useTheme()
  const [searchQuery, setSearchQuery] = useState('')

  // Settings menu items in the specified order
  const settingsItems = [
    {
      id: 'account',
      title: 'Account',
      description: 'Manage your account settings',
      hasArrow: true,
      onClick: () => console.log('Account clicked')
    },
    {
      id: 'notifications',
      title: 'Notifications',
      description: 'Configure notification preferences',
      hasArrow: true,
      onClick: () => console.log('Notifications clicked')
    },
    {
      id: 'themes',
      title: 'Themes',
      description: 'Customize appearance and themes',
      hasArrow: true,
      onClick: () => {
        toggleTheme()
        console.log('Theme toggled')
      }
    },
    {
      id: 'languages',
      title: 'Languages',
      description: 'Select your preferred language',
      hasArrow: true,
      onClick: () => console.log('Languages clicked')
    },
    {
      id: 'resources',
      title: 'Resources',
      description: 'Additional resources and tools',
      hasArrow: true,
      onClick: () => console.log('Resources clicked')
    },
    {
      id: 'help',
      title: 'Help',
      description: 'Get help and support',
      hasArrow: true,
      onClick: () => console.log('Help clicked')
    }
  ]

  // Filter settings based on search query
  const filteredItems = settingsItems.filter(item =>
    item.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
    item.description.toLowerCase().includes(searchQuery.toLowerCase())
  )

  return (
    <MainLayout>
      <div className="max-w-2xl mx-auto px-6 py-4 bg-black">
        {/* Settings Header */}
        <div className="mb-6">
          <h1 className={`text-2xl font-bold mb-2 transition-colors duration-300 ${
            isDark ? 'text-white' : 'text-black'
          }`}>
            Settings
          </h1>
        </div>

        {/* Search Bar */}
        <div className="mb-6">
          <div className={`relative rounded-2xl border transition-all duration-300 bg-black ${
            isDark 
              ? 'border-gray-600 focus-within:border-gray-400' 
              : 'border-gray-300 focus-within:border-gray-500'
          }`}>
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <svg 
                className={`w-5 h-5 transition-colors duration-300 ${
                  isDark ? 'text-gray-400' : 'text-gray-500'
                }`} 
                fill="none" 
                stroke="currentColor" 
                viewBox="0 0 24 24"
              >
                <path 
                  strokeLinecap="round" 
                  strokeLinejoin="round" 
                  strokeWidth={2} 
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" 
                />
              </svg>
            </div>
            <input
              type="text"
              placeholder="Search Settings"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className={`w-full pl-10 pr-4 py-3 rounded-2xl border-0 bg-transparent transition-colors duration-300 focus:outline-none focus:ring-0 focus:bg-transparent ${
                isDark 
                  ? 'text-white placeholder-gray-400' 
                  : 'text-black placeholder-gray-500'
              }`}
            />
          </div>
        </div>

        {/* Settings Menu */}
        <div className="space-y-0">
          {filteredItems.map((item, index) => (
            <div
              key={item.id}
              onClick={item.onClick}
              className={`group cursor-pointer py-4 px-0 transition-all duration-200 hover:bg-gray-500/20`}
            >
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <h3 className={`font-normal text-base transition-colors duration-300 ${
                    isDark ? 'text-white' : 'text-black'
                  }`}>
                    {item.title}
                  </h3>
                </div>
                
                {/* Arrow icon */}
                {item.hasArrow && (
                  <div className={`ml-4 transition-colors duration-300 ${
                    isDark ? 'text-gray-400' : 'text-gray-500'
                  }`}>
                    <svg 
                      className="w-4 h-4" 
                      fill="none" 
                      stroke="currentColor" 
                      viewBox="0 0 24 24"
                    >
                      <path 
                        strokeLinecap="round" 
                        strokeLinejoin="round" 
                        strokeWidth={2} 
                        d="M9 5l7 7-7 7" 
                      />
                    </svg>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* No results message */}
        {filteredItems.length === 0 && searchQuery && (
          <div className={`text-center py-8 transition-colors duration-300 ${
            isDark ? 'text-gray-400' : 'text-gray-600'
          }`}>
            <p>No settings found matching "{searchQuery}"</p>
          </div>
        )}
      </div>
    </MainLayout>
  )
}
