// src/pages/GameFiPage.tsx
import React, { useState } from 'react'
import { useTheme } from '~/hooks/useTheme'
import {
  HiOutlineStar,
  HiOutlineLightningBolt,
  HiOutlineCurrencyDollar,
  HiOutlineChartBar,
  HiOutlineFire,
  HiOutlineArrowUp,
  HiOutlineClock
} from 'react-icons/hi'

type TabType = 'dashboard' | 'my-games' | 'discover' | 'tournaments' | 'leaderboards'

const GameFiPage: React.FC = () => {
  const { isDark } = useTheme()
  const [activeTab, setActiveTab] = useState<TabType>('dashboard')

  // Pestañas para mobile (solo Dashboard y My Games)
  const mobileTabs: { id: TabType; label: string }[] = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'my-games', label: 'My Games' },
  ]

  // Pestañas para desktop (todas)
  const desktopTabs: { id: TabType; label: string }[] = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'my-games', label: 'My Games' },
    { id: 'discover', label: 'Discover' },
    { id: 'tournaments', label: 'Tournaments' },
    { id: 'leaderboards', label: 'Leaderboards' },
  ]

  const stats = [
    { label: 'Games Active', value: '12', icon: HiOutlineFire, color: 'text-red-500' },
    { label: 'Gaming XP', value: '8,450', icon: HiOutlineLightningBolt, color: 'text-yellow-500' },
    { label: 'Tokens Earned', value: '2,345 CAW', icon: HiOutlineCurrencyDollar, color: 'text-green-500' },
    { label: 'Global Rank', value: '#1,234', icon: HiOutlineChartBar, color: 'text-blue-500' },
  ]

  const trendingGames = [
    {
      name: 'A Hunters Dream',
      genre: 'RPG',
      players: '1.2M',
      image: 'https://picsum.photos/400/300?random=1',
      gradient: 'from-purple-500 to-indigo-500',
      link: 'https://a-hunters-dream.vercel.app/'
    },
    {
      name: 'Pudgy Penguins',
      genre: 'Battle Royale',
      players: '850K',
      image: 'https://picsum.photos/400/300?random=2',
      gradient: 'from-pink-500 to-red-500'
    },
    {
      name: 'Gods Unchained',
      genre: 'Strategy',
      players: '500K',
      image: 'https://picsum.photos/400/300?random=3',
      gradient: 'from-blue-500 to-cyan-500'
    },
  ]

  const recentActivity = [
    {
      id: 1,
      description: 'Completed daily quest in Crypto Quest',
      time: '10m ago',
      icon: HiOutlineStar
    },
    {
      id: 2,
      description: 'Earned 50 CAW tokens from Pixel Arena',
      time: '30m ago',
      icon: HiOutlineCurrencyDollar
    },
    {
      id: 3,
      description: 'Reached level 15 in Galaxy Raiders',
      time: '1h ago',
      icon: HiOutlineArrowUp
    },
    {
      id: 4,
      description: 'Joined a new tournament: Battle of the Blocks',
      time: '5h ago',
      icon: HiOutlineStar
    },
    {
      id: 5,
      description: 'Staked 100 CAW for exclusive in-game items',
      time: '5h ago',
      icon: HiOutlineCurrencyDollar
    }
  ]

  return (
      <div className="max-w-2xl mx-auto px-6 py-4">
        {/* Header */}
        <div className="mb-6">
                <h1 className={`text-2xl font-bold transition-colors duration-300 ${
        isDark ? 'text-white' : 'text-black'
      }`}>
        GameFi
      </h1>
          <p className={`text-sm transition-colors duration-300 ${
            isDark ? 'text-gray-400' : 'text-gray-600'
          }`}>
            Play games, earn rewards, and compete with the community
          </p>
        </div>

        {/* Top Navigation */}
        <div className="mb-6">
          <div className="flex justify-center sm:justify-start space-x-6 border-b border-white/10">
            {/* Pestañas para mobile (solo Dashboard y My Games) - Centradas */}
            {mobileTabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`py-2 px-3 text-base font-medium transition-all duration-200 cursor-pointer sm:hidden ${
                  activeTab === tab.id
                    ? isDark
                      ? 'text-white border-b-2 border-white'
                      : 'text-black border-b-2 border-black'
                    : isDark
                      ? 'text-gray-400 hover:text-white hover:bg-white/5'
                      : 'text-gray-600 hover:text-black hover:bg-gray-100'
                }`}
              >
                {tab.label}
              </button>
            ))}
            
            {/* Pestañas para desktop (todas) - Alineadas a la izquierda */}
            {desktopTabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`py-2 px-3 text-base font-medium transition-all duration-200 cursor-pointer hidden sm:block ${
                  activeTab === tab.id
                    ? isDark
                      ? 'text-white border-b-2 border-white'
                      : 'text-black border-b-2 border-black'
                    : isDark
                      ? 'text-gray-400 hover:text-white hover:bg-white/5'
                      : 'text-gray-600 hover:text-black hover:bg-gray-100'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Content based on activeTab */}
        {activeTab === 'dashboard' && (
          <div>
            {/* Your Gaming Stats */}
            <h2 className={`text-lg font-semibold mb-4 ${isDark ? 'text-white' : 'text-black'}`}>Your Gaming Stats</h2>
            <div className="grid grid-cols-2 gap-4 mb-6">
              {stats.map((stat, index) => (
                <div
                  key={index}
                  className={`p-3 rounded-lg border transition-all duration-300 ${
                    isDark ? 'bg-white/5 border-white/10' : 'bg-gray-100 border-gray-200'
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className={`text-xs font-medium ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{stat.label}</span>
                    <stat.icon className={`w-4 h-4 ${stat.color}`} />
                  </div>
                  <p className={`text-lg font-bold ${isDark ? 'text-white' : 'text-black'}`}>{stat.value}</p>
                </div>
              ))}
            </div>

            {/* Trending Games */}
            <h2 className={`text-lg font-semibold mb-4 ${isDark ? 'text-white' : 'text-black'}`}>Trending Games</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
              {trendingGames.map((game, index) => (
                <div
                  key={index}
                  className={`relative rounded-lg overflow-hidden border transition-all duration-300 cursor-pointer ${
                    isDark ? 'border-gray-700' : 'border-gray-200'
                  }`}
                >
                  <img src={game.image} alt={game.name} className="w-full h-40 object-cover" />
                  <div className={`absolute inset-0 bg-gradient-to-t ${game.gradient} opacity-70`}></div>
                  <div className="absolute bottom-0 left-0 right-0 p-4 text-white">
                    <h3 className="text-lg font-bold mb-1">{game.name}</h3>
                    <p className="text-xs text-gray-200 mb-2">{game.genre} • {game.players} Players</p>
                    {game.link ? (
                      <a
                        href={game.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="bg-yellow-500 hover:bg-yellow-600 text-black font-semibold py-1.5 px-3 rounded-full text-sm transition-colors duration-300 inline-block cursor-pointer"
                      >
                        LAUNCH GAME
                      </a>
                    ) : (
                      <button className="bg-yellow-500 hover:bg-yellow-600 text-black font-semibold py-1.5 px-3 rounded-full text-sm transition-colors duration-300 cursor-pointer">
                        LAUNCH GAME
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Recent Gaming Activity */}
            <h2 className={`text-lg font-semibold mb-4 ${isDark ? 'text-white' : 'text-black'}`}>Recent Gaming Activity</h2>
            <div>
              {recentActivity.map((activity, index) => (
                <div
                  key={activity.id}
                  className={`flex items-center p-4 transition-all duration-300 hover:bg-gray-500/5 cursor-pointer ${
                    index < recentActivity.length - 1 ? `border-b ${isDark ? 'border-gray-800' : 'border-gray-200'}` : ''
                  }`}
                >
                  <activity.icon className={`w-4 h-4 mr-3 ${isDark ? 'text-yellow-500' : 'text-yellow-600'}`} />
                  <div className="flex-1">
                    <p className={`text-sm ${isDark ? 'text-white' : 'text-black'}`}>{activity.description}</p>
                    <span className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{activity.time}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Other tabs content can go here */}
        {activeTab === 'my-games' && <div className={`p-3 ${isDark ? 'text-white' : 'text-black'}`}>My Games content...</div>}
        {activeTab === 'discover' && <div className={`p-3 ${isDark ? 'text-white' : 'text-black'}`}>Discover content...</div>}
        {activeTab === 'tournaments' && <div className={`p-3 ${isDark ? 'text-white' : 'text-black'}`}>Tournaments content...</div>}
        {activeTab === 'leaderboards' && <div className={`p-3 ${isDark ? 'text-white' : 'text-black'}`}>Leaderboards content...</div>}
      </div>
  )
}

export default GameFiPage