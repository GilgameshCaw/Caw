// src/pages/GameFiPage.tsx
import React, { useState } from 'react'
import MainLayout from '~/layouts/MainLayout'
import { useTheme } from '~/hooks/useTheme'
import MobileBottomNavbar from '~/components/MobileBottomNavbar'
import {
  HiOutlineStar,
  HiOutlineLightningBolt,
  HiOutlineCurrencyDollar,
  HiOutlineChartBar,
  HiOutlineFire,
  HiOutlineArrowUp,
  HiOutlineClock,
  HiOutlinePlay,
  HiOutlineEmojiHappy,
  HiOutlineUsers,
  HiOutlineSearch,
  HiOutlineFilter,
  HiOutlineEye,
  HiOutlineCalendar,
  HiOutlineGift,
  HiOutlineBadgeCheck,
  HiOutlineX,
  HiOutlineArrowLeft,
  HiOutlineShare
} from 'react-icons/hi'
import Share from '~/assets/images/share.svg?react';

type TabType = 'dashboard' | 'my-games' | 'discover' | 'tournaments' | 'leaderboards'

const GameFiPage: React.FC = () => {
  const { isDark } = useTheme()
  const [activeTab, setActiveTab] = useState<TabType>('dashboard')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedGenre, setSelectedGenre] = useState('all')
  const [leaderboardPeriod, setLeaderboardPeriod] = useState('weekly')
  const [sortBy, setSortBy] = useState('popularity')
  const [isSortModalOpen, setIsSortModalOpen] = useState(false)
  const [selectedGameStats, setSelectedGameStats] = useState<number | null>(null)
  const [selectedTournament, setSelectedTournament] = useState<number | null>(null)
  const [activeBottomTab, setActiveBottomTab] = useState('gamefi')

  // Pestañas para mobile (todas con scroll horizontal)
  const mobileTabs: { id: TabType; label: string }[] = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'my-games', label: 'My Games' },
    { id: 'discover', label: 'Discover' },
    { id: 'tournaments', label: 'Tournaments' },
    { id: 'leaderboards', label: 'Leaderboards' },
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

  // My Games data
  const myGames = [
    {
      id: 1,
      name: 'A Hunters Dream',
      genre: 'RPG',
      level: 15,
      xp: 2450,
      maxXp: 3000,
      playTime: '24h 30m',
      lastPlayed: '2h ago',
      image: 'https://picsum.photos/400/300?random=1',
      gradient: 'from-purple-500 to-indigo-500',
      link: 'https://a-hunters-dream.vercel.app/',
      achievements: 8,
      totalAchievements: 12,
      stats: {
        totalMatches: 156,
        wins: 98,
        losses: 58,
        winRate: 62.8,
        bestStreak: 12,
        averageScore: 2450,
        totalPlayTime: '24h 30m',
        rank: 1247,
        lastMatch: '2h ago',
        gamingXP: 8450,
        achievements: [
          { name: 'First Victory', unlocked: true, date: '2024-01-10' },
          { name: 'Streak Master', unlocked: true, date: '2024-01-15' },
          { name: 'High Scorer', unlocked: true, date: '2024-01-20' },
          { name: 'Speed Runner', unlocked: false, date: null },
          { name: 'Collector', unlocked: true, date: '2024-01-22' },
          { name: 'Explorer', unlocked: true, date: '2024-01-25' },
          { name: 'Strategist', unlocked: true, date: '2024-01-28' },
          { name: 'Champion', unlocked: true, date: '2024-01-30' }
        ]
      }
    },
    {
      id: 2,
      name: 'Pixel Arena',
      genre: 'Battle Royale',
      level: 8,
      xp: 1200,
      maxXp: 2000,
      playTime: '12h 15m',
      lastPlayed: '1d ago',
      image: 'https://picsum.photos/400/300?random=2',
      gradient: 'from-pink-500 to-red-500',
      achievements: 5,
      totalAchievements: 15,
      stats: {
        totalMatches: 89,
        wins: 45,
        losses: 44,
        winRate: 50.6,
        bestStreak: 7,
        averageScore: 1200,
        totalPlayTime: '12h 15m',
        rank: 2341,
        lastMatch: '1d ago',
        gamingXP: 3200,
        achievements: [
          { name: 'First Kill', unlocked: true, date: '2024-01-12' },
          { name: 'Survivor', unlocked: true, date: '2024-01-18' },
          { name: 'Quick Draw', unlocked: true, date: '2024-01-25' },
          { name: 'Last Stand', unlocked: false, date: null },
          { name: 'Team Player', unlocked: true, date: '2024-01-28' }
        ]
      }
    },
    {
      id: 3,
      name: 'Crypto Quest',
      genre: 'Strategy',
      level: 22,
      xp: 1800,
      maxXp: 2500,
      playTime: '45h 20m',
      lastPlayed: '3h ago',
      image: 'https://picsum.photos/400/300?random=3',
      gradient: 'from-blue-500 to-cyan-500',
      achievements: 12,
      totalAchievements: 20,
      stats: {
        totalMatches: 234,
        wins: 187,
        losses: 47,
        winRate: 79.9,
        bestStreak: 18,
        averageScore: 1800,
        totalPlayTime: '45h 20m',
        rank: 567,
        lastMatch: '3h ago',
        gamingXP: 15600,
        achievements: [
          { name: 'First Strategy', unlocked: true, date: '2024-01-08' },
          { name: 'Master Planner', unlocked: true, date: '2024-01-15' },
          { name: 'Resource Manager', unlocked: true, date: '2024-01-22' },
          { name: 'Tactician', unlocked: true, date: '2024-01-28' },
          { name: 'Conqueror', unlocked: true, date: '2024-02-01' },
          { name: 'Diplomat', unlocked: true, date: '2024-02-05' },
          { name: 'Economist', unlocked: true, date: '2024-02-08' },
          { name: 'Architect', unlocked: true, date: '2024-02-12' },
          { name: 'Innovator', unlocked: true, date: '2024-02-15' },
          { name: 'Legend', unlocked: true, date: '2024-02-18' },
          { name: 'Visionary', unlocked: true, date: '2024-02-20' },
          { name: 'Sage', unlocked: true, date: '2024-02-22' }
        ]
      }
    }
  ]

  // Discover games data
  const discoverGames = [
    {
      id: 1,
      name: 'A Hunters Dream',
      genre: 'RPG',
      players: '1.2M',
      rating: 4.8,
      price: 'Free',
      image: 'https://picsum.photos/400/300?random=1',
      gradient: 'from-purple-500 to-indigo-500',
      link: 'https://a-hunters-dream.vercel.app/',
      description: 'Epic RPG adventure in a fantasy world'
    },
    {
      id: 2,
      name: 'Pudgy Penguins',
      genre: 'Battle Royale',
      players: '850K',
      rating: 4.6,
      price: 'Free',
      image: 'https://picsum.photos/400/300?random=2',
      gradient: 'from-pink-500 to-red-500',
      description: 'Cute penguins in intense battle royale action'
    },
    {
      id: 3,
      name: 'Gods Unchained',
      genre: 'Strategy',
      players: '500K',
      rating: 4.7,
      price: 'Free',
      image: 'https://picsum.photos/400/300?random=3',
      gradient: 'from-blue-500 to-cyan-500',
      description: 'Strategic card game with NFT integration'
    },
    {
      id: 4,
      name: 'Galaxy Raiders',
      genre: 'Space',
      players: '320K',
      rating: 4.5,
      price: 'Free',
      image: 'https://picsum.photos/400/300?random=4',
      gradient: 'from-green-500 to-teal-500',
      description: 'Space exploration and combat simulation'
    },
    {
      id: 5,
      name: 'Crypto Quest',
      genre: 'Strategy',
      players: '180K',
      rating: 4.9,
      price: 'Free',
      image: 'https://picsum.photos/400/300?random=5',
      gradient: 'from-yellow-500 to-orange-500',
      description: 'Blockchain-based strategy game'
    },
    {
      id: 6,
      name: 'Battle of the Blocks',
      genre: 'Action',
      players: '750K',
      rating: 4.4,
      price: 'Free',
      image: 'https://picsum.photos/400/300?random=6',
      gradient: 'from-indigo-500 to-purple-500',
      description: 'Fast-paced action with block-based combat'
    },
    {
      id: 7,
      name: 'Metaverse Warriors',
      genre: 'RPG',
      players: '2.1M',
      rating: 4.9,
      price: 'Free',
      image: 'https://picsum.photos/400/300?random=7',
      gradient: 'from-pink-500 to-rose-500',
      description: 'Epic fantasy RPG in the metaverse'
    },
    {
      id: 8,
      name: 'Crypto Racing',
      genre: 'Racing',
      players: '890K',
      rating: 4.6,
      price: 'Free',
      image: 'https://picsum.photos/400/300?random=8',
      gradient: 'from-cyan-500 to-blue-500',
      description: 'High-speed racing with NFT cars'
    },
    {
      id: 9,
      name: 'DeFi Kingdom',
      genre: 'Strategy',
      players: '1.5M',
      rating: 4.7,
      price: 'Free',
      image: 'https://picsum.photos/400/300?random=9',
      gradient: 'from-emerald-500 to-teal-500',
      description: 'Build and manage your DeFi empire'
    },
    {
      id: 10,
      name: 'NFT Collectors',
      genre: 'Puzzle',
      players: '420K',
      rating: 4.3,
      price: 'Free',
      image: 'https://picsum.photos/400/300?random=10',
      gradient: 'from-violet-500 to-purple-500',
      description: 'Match and collect rare NFTs'
    },
    {
      id: 11,
      name: 'Blockchain Heroes',
      genre: 'Action',
      players: '1.8M',
      rating: 4.8,
      price: 'Free',
      image: 'https://picsum.photos/400/300?random=11',
      gradient: 'from-orange-500 to-red-500',
      description: 'Superhero action in the blockchain world'
    },
    {
      id: 12,
      name: 'Staking Simulator',
      genre: 'Simulation',
      players: '650K',
      rating: 4.5,
      price: 'Free',
      image: 'https://picsum.photos/400/300?random=12',
      gradient: 'from-lime-500 to-green-500',
      description: 'Learn DeFi through interactive simulation'
    }
  ]

  // Tournaments data
  const tournaments = [
    {
      id: 1,
      name: 'Battle of the Blocks Championship',
      game: 'Battle of the Blocks',
      prize: '1.2B CAW',
      participants: 1250,
      maxParticipants: 2000,
      startDate: '2025-03-15',
      endDate: '2025-03-20',
      status: 'active',
      entryFee: '150M CAW',
      image: 'https://picsum.photos/400/300?random=6',
      gradient: 'from-indigo-500 to-purple-500'
    },
    {
      id: 2,
      name: 'Crypto Quest Masters',
      game: 'Crypto Quest',
      prize: '800M CAW',
      participants: 890,
      maxParticipants: 1000,
      startDate: '2025-04-18',
      endDate: '2025-04-25',
      status: 'upcoming',
      entryFee: '80M CAW',
      image: 'https://picsum.photos/400/300?random=5',
      gradient: 'from-yellow-500 to-orange-500'
    },
    {
      id: 3,
      name: 'Galaxy Raiders Tournament',
      game: 'Galaxy Raiders',
      prize: '1.8B CAW',
      participants: 450,
      maxParticipants: 500,
      startDate: '2025-05-20',
      endDate: '2025-05-22',
      status: 'upcoming',
      entryFee: '120M CAW',
      image: 'https://picsum.photos/400/300?random=4',
      gradient: 'from-green-500 to-teal-500',
      format: 'Elimination',
      duration: '3 days',
      region: 'Global',
      skillLevel: 'All Levels',
      organizer: 'Caw Gaming',
      description: 'Space adventure tournament with cosmic rewards'
    },
    {
      id: 4,
      name: 'DeFi Kingdom Royal',
      game: 'DeFi Kingdom',
      prize: '3.5B CAW',
      participants: 3200,
      maxParticipants: 5000,
      startDate: '2025-06-25',
      endDate: '2025-07-01',
      status: 'upcoming',
      entryFee: '200M CAW',
      image: 'https://picsum.photos/400/300?random=8',
      gradient: 'from-emerald-500 to-teal-500',
      format: 'Swiss',
      duration: '7 days',
      region: 'Global',
      skillLevel: 'Expert',
      organizer: 'Caw Gaming',
      description: 'High-stakes tournament for DeFi strategy masters'
    },
    {
      id: 5,
      name: 'NFT Collectors Cup',
      game: 'NFT Collectors',
      prize: '950M CAW',
      participants: 450,
      maxParticipants: 1000,
      startDate: '2026-01-20',
      endDate: '2026-01-22',
      status: 'active',
      entryFee: '90M CAW',
      image: 'https://picsum.photos/400/300?random=9',
      gradient: 'from-violet-500 to-purple-500',
      format: 'Elimination',
      duration: '3 days',
      region: 'Global',
      skillLevel: 'All Levels',
      organizer: 'Caw Gaming',
      description: 'Quick tournament for NFT collection enthusiasts'
    }
  ]

  // Leaderboards data
  const leaderboards = [
    {
      id: 1,
      rank: 1,
      username: 'CryptoKing',
      xp: 125000,
      gamesPlayed: 45,
      winRate: 89.5,
      avatar: 'https://picsum.photos/50/50?random=1',
      badge: 'Crown'
    },
    {
      id: 2,
      rank: 2,
      username: 'GameMaster',
      xp: 118000,
      gamesPlayed: 42,
      winRate: 87.2,
      avatar: 'https://picsum.photos/50/50?random=2',
      badge: 'Trophy'
    },
    {
      id: 3,
      rank: 3,
      username: 'BlockChampion',
      xp: 112000,
      gamesPlayed: 38,
      winRate: 85.8,
      avatar: 'https://picsum.photos/50/50?random=3',
      badge: 'Medal'
    },
    {
      id: 4,
      rank: 4,
      username: 'SpaceRaider',
      xp: 108000,
      gamesPlayed: 40,
      winRate: 83.1,
      avatar: 'https://picsum.photos/50/50?random=4',
      badge: 'Star'
    },
    {
      id: 5,
      rank: 5,
      username: 'QuestHero',
      xp: 105000,
      gamesPlayed: 35,
      winRate: 81.7,
      avatar: 'https://picsum.photos/50/50?random=5',
      badge: 'Star'
    }
  ]

  // Filter functions
  const filteredDiscoverGames = discoverGames.filter(game => {
    const matchesSearch = game.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                         game.description.toLowerCase().includes(searchQuery.toLowerCase())
    const matchesGenre = selectedGenre === 'all' || game.genre.toLowerCase() === selectedGenre.toLowerCase()
    return matchesSearch && matchesGenre
  })

  const genres = ['all', 'RPG', 'Battle Royale', 'Strategy', 'Space', 'Action', 'Racing', 'Puzzle', 'Simulation']
  
  const sortOptions = [
    { id: 'popularity', label: 'Popularity', icon: HiOutlineFire },
    { id: 'rating', label: 'Rating', icon: HiOutlineStar },
    { id: 'players', label: 'Players', icon: HiOutlineUsers },
    { id: 'name', label: 'Name', icon: HiOutlineSearch },
    { id: 'newest', label: 'Newest', icon: HiOutlineClock }
  ]

  const handleSortChange = (sortId: string) => {
    setSortBy(sortId)
    setIsSortModalOpen(false)
  }

  return (
    <MainLayout>
      <div className="max-w-2xl mx-auto px-6 py-4 pb-20 md:pb-4">
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
            {/* Pestañas para mobile (todas con scroll horizontal) */}
            <div className="flex overflow-x-auto scrollbar-hide space-x-4 sm:hidden pb-2 -mb-2">
            {mobileTabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                  className={`py-2 px-4 text-sm font-medium transition-all duration-200 cursor-pointer whitespace-nowrap flex-shrink-0 ${
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

        {/* My Games Tab */}
        {activeTab === 'my-games' && (
          <div>
            {selectedGameStats ? (
              // Game Stats View
              <div>
                <div className="flex items-center mb-6">
                  <button
                    onClick={() => setSelectedGameStats(null)}
                    className={`mr-4 text-white hover:text-gray-300 transition-colors duration-300 cursor-pointer`}
                  >
                    <HiOutlineArrowLeft className="w-6 h-6" />
                  </button>
                  <div>
                    <h2 className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-black'}`}>
                      {myGames.find(game => game.id === selectedGameStats)?.name} - Statistics
                    </h2>
                    <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                      Detailed performance and achievement data
                    </p>
                  </div>
                </div>

                {(() => {
                  const game = myGames.find(game => game.id === selectedGameStats);
                  if (!game?.stats) return null;
                  
                  return (
                    <div className="space-y-6">
                      {/* Performance Overview */}
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <div className={`p-4 rounded-lg border transition-all duration-300 ${
                          isDark ? 'bg-white/5 border-white/10' : 'bg-gray-50 border-gray-200'
                        }`}>
                          <div className="flex items-center justify-between mb-2">
                            <span className={`text-xs font-medium ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>Win Rate</span>
                            <HiOutlineChartBar className="w-4 h-4 text-green-500" />
                          </div>
                          <p className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-black'}`}>
                            {game.stats.winRate}%
                          </p>
                        </div>
                        <div className={`p-4 rounded-lg border transition-all duration-300 ${
                          isDark ? 'bg-white/5 border-white/10' : 'bg-gray-50 border-gray-200'
                        }`}>
                          <div className="flex items-center justify-between mb-2">
                            <span className={`text-xs font-medium ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>Gaming XP</span>
                            <HiOutlineLightningBolt className="w-4 h-4 text-yellow-500" />
                          </div>
                          <p className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-black'}`}>
                            {game.stats.gamingXP?.toLocaleString() || '0'}
                          </p>
                        </div>
                        <div className={`p-4 rounded-lg border transition-all duration-300 ${
                          isDark ? 'bg-white/5 border-white/10' : 'bg-gray-50 border-gray-200'
                        }`}>
                          <div className="flex items-center justify-between mb-2">
                            <span className={`text-xs font-medium ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>Best Streak</span>
                            <HiOutlineFire className="w-4 h-4 text-orange-500" />
                          </div>
                          <p className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-black'}`}>
                            {game.stats.bestStreak}
                          </p>
                        </div>
                        <div className={`p-4 rounded-lg border transition-all duration-300 ${
                          isDark ? 'bg-white/5 border-white/10' : 'bg-gray-50 border-gray-200'
                        }`}>
                          <div className="flex items-center justify-between mb-2">
                            <span className={`text-xs font-medium ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>Global Rank</span>
                            <HiOutlineStar className="w-4 h-4 text-yellow-500" />
                          </div>
                          <p className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-black'}`}>
                            #{game.stats.rank}
                          </p>
                        </div>
                      </div>

                      {/* Detailed Stats Table */}
                      <div className={`rounded-lg border transition-all duration-300 ${
                        isDark ? 'border-white/20' : 'border-gray-300'
                      }`}>
                        <div className={`p-4 border-b ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
                          <h3 className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-black'}`}>Performance Details</h3>
                        </div>
                        <div className="overflow-x-auto">
                          <table className="w-full">
                            <thead>
                              <tr className={`border-b ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
                                <th className={`text-left py-3 px-4 text-sm font-medium ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>Statistic</th>
                                <th className={`text-left py-3 px-4 text-sm font-medium ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>Value</th>
                                <th className={`text-left py-3 px-4 text-sm font-medium ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>Details</th>
                              </tr>
                            </thead>
                            <tbody>
                              <tr className={`border-b ${isDark ? 'border-white/5' : 'border-gray-100'}`}>
                                <td className={`py-3 px-4 ${isDark ? 'text-white' : 'text-black'}`}>Wins</td>
                                <td className={`py-3 px-4 font-semibold ${isDark ? 'text-green-400' : 'text-green-600'}`}>{game.stats.wins}</td>
                                <td className={`py-3 px-4 text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>Victories achieved</td>
                              </tr>
                              <tr className={`border-b ${isDark ? 'border-white/5' : 'border-gray-100'}`}>
                                <td className={`py-3 px-4 ${isDark ? 'text-white' : 'text-black'}`}>Losses</td>
                                <td className={`py-3 px-4 font-semibold ${isDark ? 'text-red-400' : 'text-red-600'}`}>{game.stats.losses}</td>
                                <td className={`py-3 px-4 text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>Defeats suffered</td>
                              </tr>
                              <tr className={`border-b ${isDark ? 'border-white/5' : 'border-gray-100'}`}>
                                <td className={`py-3 px-4 ${isDark ? 'text-white' : 'text-black'}`}>Gaming XP</td>
                                <td className={`py-3 px-4 font-semibold ${isDark ? 'text-yellow-400' : 'text-yellow-600'}`}>{game.stats.gamingXP?.toLocaleString() || '0'}</td>
                                <td className={`py-3 px-4 text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>Experience points earned</td>
                              </tr>
                              <tr className={`border-b ${isDark ? 'border-white/5' : 'border-gray-100'}`}>
                                <td className={`py-3 px-4 ${isDark ? 'text-white' : 'text-black'}`}>Average Score</td>
                                <td className={`py-3 px-4 font-semibold ${isDark ? 'text-yellow-400' : 'text-yellow-600'}`}>{game.stats.averageScore}</td>
                                <td className={`py-3 px-4 text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>Points per match</td>
                              </tr>
                              <tr className={`border-b ${isDark ? 'border-white/5' : 'border-gray-100'}`}>
                                <td className={`py-3 px-4 ${isDark ? 'text-white' : 'text-black'}`}>Total Play Time</td>
                                <td className={`py-3 px-4 font-semibold ${isDark ? 'text-blue-400' : 'text-blue-600'}`}>{game.stats.totalPlayTime}</td>
                                <td className={`py-3 px-4 text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>Time invested</td>
                              </tr>
                              <tr>
                                <td className={`py-3 px-4 ${isDark ? 'text-white' : 'text-black'}`}>Last Match</td>
                                <td className={`py-3 px-4 font-semibold ${isDark ? 'text-purple-400' : 'text-purple-600'}`}>{game.stats.lastMatch}</td>
                                <td className={`py-3 px-4 text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>Most recent activity</td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      </div>

                      {/* Achievements Table */}
                      <div className={`rounded-lg border transition-all duration-300 ${
                        isDark ? 'border-white/20' : 'border-gray-300'
                      }`}>
                        <div className={`p-4 border-b ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
                          <h3 className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-black'}`}>Achievements</h3>
                        </div>
                        <div className="overflow-x-auto">
                          <table className="w-full">
                            <thead>
                              <tr className={`border-b ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
                                <th className={`text-left py-3 px-4 text-sm font-medium ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>Achievement</th>
                                <th className={`text-left py-3 px-4 text-sm font-medium ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>Status</th>
                                <th className={`text-left py-3 px-4 text-sm font-medium ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>Unlocked Date</th>
                              </tr>
                            </thead>
                            <tbody>
                              {game.stats.achievements.map((achievement, index) => (
                                <tr key={index} className={`border-b ${isDark ? 'border-white/5' : 'border-gray-100'}`}>
                                  <td className={`py-3 px-4 ${isDark ? 'text-white' : 'text-black'}`}>{achievement.name}</td>
                                  <td className="py-3 px-4">
                                    <span className={`px-2 py-1 rounded-full text-xs font-semibold ${
                                      achievement.unlocked
                                        ? 'bg-green-500 text-white'
                                        : 'bg-gray-500 text-white'
                                    }`}>
                                      {achievement.unlocked ? 'Unlocked' : 'Locked'}
                                    </span>
                                  </td>
                                  <td className={`py-3 px-4 text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                                    {achievement.date || 'Not unlocked'}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </div>
            ) : (
              // Games List View
          <div>
            <h2 className={`text-lg font-semibold mb-4 ${isDark ? 'text-white' : 'text-black'}`}>My Games</h2>
            <div className="space-y-4">
              {myGames.map((game) => (
                <div
                  key={game.id}
                  className={`relative rounded-lg border transition-all duration-300 ${
                    isDark ? 'border-white/20' : 'border-gray-300'
                  }`}
                >
                  <div className="flex flex-col sm:flex-row">
                    <div className="w-full h-40 sm:w-32 sm:h-24 bg-gray-800 overflow-hidden sm:rounded-l-lg rounded-t-lg">
                      <img src={game.image} alt={game.name} className="w-full h-full object-cover" />
                    </div>
                    <div className={`absolute inset-0 bg-gradient-to-r ${game.gradient} opacity-20 rounded-lg`}></div>
                    <div className="flex-1 p-4 relative z-10">
                      <div className="flex justify-between items-start mb-3">
                        <div className="flex-1">
                          <h3 className={`text-lg font-bold ${isDark ? 'text-white' : 'text-black'}`}>{game.name}</h3>
                          <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{game.genre}</p>
                        </div>
                        <div className="text-right ml-4">
                          <p className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-black'}`}>Level {game.level}</p>
                          <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{game.playTime} played</p>
                        </div>
                      </div>
                      
                      {/* XP Progress Bar */}
                      <div className="mb-3">
                        <div className={`w-full bg-gray-200 rounded-full h-2 ${isDark ? 'bg-gray-700' : 'bg-gray-200'}`}>
                          <div 
                            className="bg-gradient-to-r from-yellow-400 to-orange-500 h-2 rounded-full transition-all duration-300"
                            style={{ width: `${(game.xp / game.maxXp) * 100}%` }}
                          ></div>
                        </div>
                        <div className="flex justify-between text-xs mt-1">
                          <span className={isDark ? 'text-gray-400' : 'text-gray-600'}>{game.xp} XP</span>
                          <span className={isDark ? 'text-gray-400' : 'text-gray-600'}>{game.maxXp} XP</span>
                        </div>
                      </div>

                      <div className="flex flex-col space-y-3">
                        <div className="flex flex-col space-y-1 text-xs">
                          <div className="flex justify-between">
                          <span className={isDark ? 'text-gray-400' : 'text-gray-600'}>
                            {game.achievements}/{game.totalAchievements} achievements
                          </span>
                          <span className={isDark ? 'text-gray-400' : 'text-gray-600'}>
                            Last played: {game.lastPlayed}
                          </span>
                          </div>
                        </div>
                        <div className="flex space-x-2">
                          <button 
                            onClick={() => setSelectedGameStats(game.id)}
                            className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors duration-300 cursor-pointer ${
                            isDark 
                              ? 'bg-white/10 text-white hover:bg-white/20' 
                              : 'bg-gray-100 text-black hover:bg-gray-200'
                            }`}
                          >
                            <HiOutlineEye className="w-4 h-4 inline mr-2" />
                            Stats
                          </button>
                          {game.link ? (
                            <a
                              href={game.link}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex-1 bg-yellow-500 hover:bg-yellow-600 text-black font-semibold py-2.5 px-4 rounded-lg text-sm transition-colors duration-300 inline-flex items-center justify-center"
                            >
                              <HiOutlinePlay className="w-4 h-4 mr-2" />
                              Play
                            </a>
                          ) : (
                            <button className="flex-1 bg-yellow-500 hover:bg-yellow-600 text-black font-semibold py-2.5 px-4 rounded-lg text-sm transition-colors duration-300 inline-flex items-center justify-center cursor-pointer">
                              <HiOutlinePlay className="w-4 h-4 mr-2" />
                              Play
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
              </div>
            )}
          </div>
        )}

        {/* Discover Tab */}
        {activeTab === 'discover' && (
          <div>
            {/* Header Section */}
            <div className="mb-8">
              <h2 className={`text-2xl font-bold mb-2 ${isDark ? 'text-white' : 'text-black'}`}>Discover Games</h2>
              <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                Explore the best blockchain games and earn rewards while playing
              </p>
            </div>
            
            {/* Search and Filter */}
            <div className="mb-8 space-y-6">
              <div className="relative">
                <HiOutlineSearch className={`absolute left-4 top-1/2 transform -translate-y-1/2 w-5 h-5 ${
                  isDark ? 'text-gray-400' : 'text-gray-500'
                }`} />
                <input
                  type="text"
                  placeholder="Search games, genres, or developers..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className={`w-full pl-12 pr-4 py-3 rounded-xl border transition-all duration-300 focus:ring-2 focus:ring-yellow-500 ${
                    isDark 
                      ? 'bg-white/5 border-white/10 text-white placeholder-gray-400 focus:bg-white/10' 
                      : 'bg-gray-50 border-gray-200 text-black placeholder-gray-500 focus:bg-white'
                  }`}
                />
              </div>
              
              {/* Filter Chips */}
              <div className="flex flex-wrap gap-3 justify-center sm:justify-start">
                {genres.map((genre) => (
                  <button
                    key={genre}
                    onClick={() => setSelectedGenre(genre)}
                    className={`px-4 py-2 rounded-full text-sm font-medium transition-all duration-300 cursor-pointer ${
                      selectedGenre === genre
                        ? 'bg-yellow-500 text-black shadow-lg'
                        : isDark
                          ? 'bg-white/10 text-gray-300 hover:bg-white/20 hover:text-white'
                          : 'bg-gray-100 text-gray-600 hover:bg-gray-200 hover:text-black'
                    }`}
                  >
                    {genre === 'all' ? 'All Games' : genre}
                  </button>
                ))}
              </div>

              {/* Stats Bar */}
              <div className={`flex items-center justify-between p-4 rounded-xl ${
                isDark ? 'bg-white/5 border border-white/10' : 'bg-gray-50 border border-gray-200'
              }`}>
                <div className="flex items-center space-x-6">
                  <div className="text-center">
                    <div className={`text-lg font-bold ${isDark ? 'text-white' : 'text-black'}`}>
                      {filteredDiscoverGames.length}
                    </div>
                    <div className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                      Games Found
                    </div>
                  </div>
                  <div className="text-center">
                    <div className={`text-lg font-bold ${isDark ? 'text-white' : 'text-black'}`}>
                      {discoverGames.reduce((acc, game) => acc + parseFloat(game.players.replace('K', '')), 0).toFixed(0)}K
                    </div>
                    <div className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                      Total Players
                    </div>
                  </div>
                </div>
                <div className="relative">
                  <button 
                    onClick={() => setIsSortModalOpen(true)}
                    className="flex items-center space-x-2 hover:opacity-80 transition-opacity duration-200 cursor-pointer"
                  >
                    <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                      Sort by: {sortOptions.find(option => option.id === sortBy)?.label}
                    </span>
                    <HiOutlineFilter className={`w-4 h-4 ${isDark ? 'text-gray-400' : 'text-gray-500'}`} />
                  </button>
                  
                  {/* Sort Dropdown */}
                  {isSortModalOpen && (
                    <>
                      {/* Backdrop */}
                      <div 
                        className="fixed inset-0 z-40"
                        onClick={() => setIsSortModalOpen(false)}
                      />
                      
                      {/* Dropdown */}
                      <div className={`absolute top-full right-0 mt-2 w-48 rounded-xl border shadow-lg z-50 ${
                        isDark ? 'bg-black border-gray-700' : 'bg-white border-gray-200'
                      }`}>
                        <div className="py-2">
                          {sortOptions.map((option) => (
                            <button
                              key={option.id}
                              onClick={() => handleSortChange(option.id)}
                              className={`w-full flex items-center space-x-3 px-3 py-2 text-sm transition-colors duration-200 cursor-pointer ${
                                sortBy === option.id
                                  ? isDark 
                                    ? 'bg-white/10 text-white'
                                    : 'bg-gray-100 text-black'
                                  : isDark
                                    ? 'text-gray-300 hover:bg-white/5'
                                    : 'text-gray-600 hover:bg-gray-50'
                              }`}
                            >
                              <option.icon className="w-4 h-4" />
                              <span className="font-medium">{option.label}</span>
                              {sortBy === option.id && (
                                <HiOutlineBadgeCheck className={`w-4 h-4 ml-auto ${
                                  isDark ? 'text-white' : 'text-black'
                                }`} />
                              )}
                            </button>
                          ))}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Games Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {filteredDiscoverGames.map((game) => (
                <div
                  key={game.id}
                  className={`group relative rounded-2xl overflow-hidden border transition-all duration-300 cursor-pointer flex flex-col hover:bg-white/5 ${
                    isDark ? 'border-gray-700' : 'border-gray-200'
                  }`}
                >
                  {/* Game Image with Overlay */}
                  <div className="relative h-40 overflow-hidden bg-gray-800">
                    <img 
                      src={game.image} 
                      alt={game.name} 
                      className="w-full h-full object-cover object-center group-hover:scale-110 transition-transform duration-500" 
                      style={{ minHeight: '160px' }}
                    />
                    <div className={`absolute inset-0 bg-gradient-to-t ${game.gradient} opacity-80`}></div>
                    
                    {/* Top Badges */}
                    <div className="absolute top-3 left-3 right-3 flex justify-between items-start">
                      <div className="flex space-x-2">
                        {game.rating >= 4.8 && (
                          <span className="bg-yellow-500 text-black px-2 py-1 rounded-full text-xs font-bold">
                            HOT
                          </span>
                        )}
                      </div>
                      <div className="flex items-center space-x-1 bg-black/30 backdrop-blur-sm rounded-full px-2 py-1">
                        <HiOutlineStar className="w-3 h-3 text-yellow-400" />
                        <span className="text-xs font-semibold text-white">{game.rating}</span>
                      </div>
                    </div>

                  </div>

                  {/* Game Info */}
                  <div className={`p-3 ${isDark ? 'bg-gray-800' : 'bg-white'} flex flex-col`}>
                      <div>
                      <h3 className={`text-base font-bold mb-1 ${isDark ? 'text-white' : 'text-black'}`}>
                        {game.name}
                      </h3>
                      <p className={`text-sm ${isDark ? 'text-gray-300' : 'text-gray-600'} mb-2`}>
                        {game.description}
                      </p>

                      {/* Game Stats */}
                      <div className="flex items-center justify-between mb-0">
                      <div className="flex items-center space-x-4">
                        <div className="flex items-center space-x-1">
                          <div className={`w-2 h-2 rounded-full ${
                            game.genre === 'RPG' ? 'bg-purple-500' :
                            game.genre === 'Battle Royale' ? 'bg-red-500' :
                            game.genre === 'Strategy' ? 'bg-blue-500' :
                            game.genre === 'Space' ? 'bg-green-500' :
                            'bg-orange-500'
                          }`}></div>
                          <span className={`text-xs font-medium ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                            {game.genre}
                          </span>
                      </div>
                        <div className="flex items-center space-x-1">
                          <HiOutlineUsers className={`w-3 h-3 ${isDark ? 'text-gray-400' : 'text-gray-500'}`} />
                          <span className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                            {game.players}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center space-x-1">
                        <HiOutlineStar className="w-3 h-3 text-yellow-400" />
                        <span className={`text-xs font-semibold ${isDark ? 'text-white' : 'text-black'}`}>
                          {game.rating}
                        </span>
                      </div>
                    </div>
                    </div>

                    {/* Action Button */}
                    <button className="w-full bg-yellow-500 hover:bg-yellow-400 text-black font-bold py-2 px-4 rounded-lg text-sm transition-all duration-300 mt-2 cursor-pointer">
                        LAUNCH GAME
                      </button>
                  </div>
                </div>
              ))}
            </div>

            {/* Load More Button */}
            <div className="mt-8 text-center">
              <button className={`px-8 py-3 rounded-xl font-semibold transition-all duration-300 cursor-pointer ${
                isDark 
                  ? 'bg-white/10 text-white hover:bg-white/20' 
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}>
                Load More Games
              </button>
            </div>
          </div>
        )}

        {/* Tournaments Tab */}
        {activeTab === 'tournaments' && (
          <div>
            {selectedTournament ? (
              // Tournament Details View
              <div>
                {(() => {
                  const tournament = tournaments.find(t => t.id === selectedTournament);
                  if (!tournament) return <div>Tournament not found</div>;
                  
                  return (
                    <div className="space-y-6">
                      {/* Back Button */}
                      <div className="flex items-center mb-6">
                        <button
                          onClick={() => setSelectedTournament(null)}
                          className={`mr-4 text-white hover:text-gray-300 transition-colors duration-300 cursor-pointer`}
                        >
                          <HiOutlineArrowLeft className="w-6 h-6" />
                        </button>
                        <h2 className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-black'}`}>
                          Tournaments
                        </h2>
                      </div>

                      {/* Tournament Header */}
                      <div className={`relative rounded-lg border overflow-hidden ${
                        isDark ? 'border-white/20' : 'border-gray-300'
                      }`}>
                        <div className="flex">
                          <div className="w-48 h-32 bg-gray-800 flex items-center justify-center overflow-hidden">
                            <img src={tournament.image} alt={tournament.name} className="max-w-full max-h-full object-contain" />
                          </div>
                          <div className={`absolute inset-0 bg-gradient-to-r ${tournament.gradient} opacity-20`}></div>
                          <div className="flex-1 p-6 relative z-10">
                            <div className="flex justify-between items-start mb-4">
                              <div>
                                <h2 className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-black'} mb-2`}>
                                  {tournament.name}
                                </h2>
                                <p className={`text-lg ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                                  {tournament.game}
                                </p>
                              </div>
                              <div className="text-right">
                                <span className={`px-3 py-1 rounded-full text-sm font-semibold ${
                                  isDark 
                                    ? 'bg-white/20 text-white' 
                                    : 'bg-gray-200 text-gray-800'
                                }`}>
                                  {tournament.status === 'active' ? 'Active' : 'Upcoming'}
                                </span>
                              </div>
                            </div>
                            
                            {tournament.description && (
                              <p className={`text-sm ${isDark ? 'text-gray-300' : 'text-gray-700'} mb-4`}>
                                {tournament.description}
                              </p>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Tournament Stats Grid */}
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <div className={`p-4 rounded-lg border transition-all duration-300 ${
                          isDark ? 'bg-white/5 border-white/10' : 'bg-gray-50 border-gray-200'
                        }`}>
                          <div className="flex items-center justify-between mb-2">
                            <span className={`text-xs font-medium ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>Prize Pool</span>
                            <HiOutlineCurrencyDollar className="w-4 h-4 text-green-500" />
                          </div>
                          <p className={`text-xl font-bold ${isDark ? 'text-white' : 'text-black'}`}>{tournament.prize}</p>
                        </div>
                        <div className={`p-4 rounded-lg border transition-all duration-300 ${
                          isDark ? 'bg-white/5 border-white/10' : 'bg-gray-50 border-gray-200'
                        }`}>
                          <div className="flex items-center justify-between mb-2">
                            <span className={`text-xs font-medium ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>Entry Fee</span>
                            <HiOutlineGift className="w-4 h-4 text-yellow-500" />
                          </div>
                          <p className={`text-xl font-bold ${isDark ? 'text-white' : 'text-black'}`}>{tournament.entryFee}</p>
                        </div>
                        <div className={`p-4 rounded-lg border transition-all duration-300 ${
                          isDark ? 'bg-white/5 border-white/10' : 'bg-gray-50 border-gray-200'
                        }`}>
                          <div className="flex items-center justify-between mb-2">
                            <span className={`text-xs font-medium ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>Format</span>
                            <HiOutlineUsers className="w-4 h-4 text-blue-500" />
                          </div>
                          <p className={`text-xl font-bold ${isDark ? 'text-white' : 'text-black'}`}>{tournament.format || 'Elimination'}</p>
                        </div>
                        <div className={`p-4 rounded-lg border transition-all duration-300 ${
                          isDark ? 'bg-white/5 border-white/10' : 'bg-gray-50 border-gray-200'
                        }`}>
                          <div className="flex items-center justify-between mb-2">
                            <span className={`text-xs font-medium ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>Duration</span>
                            <HiOutlineClock className="w-4 h-4 text-purple-500" />
                          </div>
                          <p className={`text-xl font-bold ${isDark ? 'text-white' : 'text-black'}`}>{tournament.duration || '3 days'}</p>
                        </div>
                      </div>

                      {/* Participants Progress */}
                      <div className={`p-6 rounded-lg border transition-all duration-300 ${
                        isDark ? 'bg-white/5 border-white/10' : 'bg-gray-50 border-gray-200'
                      }`}>
                        <h3 className={`text-lg font-semibold mb-4 ${isDark ? 'text-white' : 'text-black'}`}>Participants</h3>
                        <div className="flex justify-between items-center mb-2">
                          <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                            {tournament.participants} of {tournament.maxParticipants} slots filled
                          </span>
                          <span className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-black'}`}>
                            {Math.round((tournament.participants / tournament.maxParticipants) * 100)}%
                          </span>
                        </div>
                        <div className={`w-full bg-gray-200 rounded-full h-3 ${isDark ? 'bg-gray-700' : 'bg-gray-200'}`}>
                          <div 
                            className="bg-gradient-to-r from-blue-500 to-purple-500 h-3 rounded-full transition-all duration-300"
                            style={{ width: `${(tournament.participants / tournament.maxParticipants) * 100}%` }}
                          ></div>
                        </div>
                      </div>

                      {/* Tournament Details */}
                      <div className={`p-6 rounded-lg border transition-all duration-300 ${
                        isDark ? 'bg-white/5 border-white/10' : 'bg-gray-50 border-gray-200'
                      }`}>
                        <h3 className={`text-lg font-semibold mb-4 ${isDark ? 'text-white' : 'text-black'}`}>Tournament Details</h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div className="space-y-3">
                            <div className="flex items-center space-x-3">
                              <HiOutlineCalendar className={`w-5 h-5 ${isDark ? 'text-gray-400' : 'text-gray-600'}`} />
                              <div>
                                <p className={`text-sm font-medium ${isDark ? 'text-white' : 'text-black'}`}>Start Date</p>
                                <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{tournament.startDate}</p>
                              </div>
                            </div>
                            <div className="flex items-center space-x-3">
                              <HiOutlineCalendar className={`w-5 h-5 ${isDark ? 'text-gray-400' : 'text-gray-600'}`} />
                              <div>
                                <p className={`text-sm font-medium ${isDark ? 'text-white' : 'text-black'}`}>End Date</p>
                                <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{tournament.endDate}</p>
                              </div>
                            </div>
                            <div className="flex items-center space-x-3">
                              <HiOutlineUsers className={`w-5 h-5 ${isDark ? 'text-gray-400' : 'text-gray-600'}`} />
                              <div>
                                <p className={`text-sm font-medium ${isDark ? 'text-white' : 'text-black'}`}>Skill Level</p>
                                <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{tournament.skillLevel || 'All Levels'}</p>
                              </div>
                            </div>
                          </div>
                          <div className="space-y-3">
                            <div className="flex items-center space-x-3">
                              <HiOutlineGift className={`w-5 h-5 ${isDark ? 'text-gray-400' : 'text-gray-600'}`} />
                              <div>
                                <p className={`text-sm font-medium ${isDark ? 'text-white' : 'text-black'}`}>Region</p>
                                <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{tournament.region || 'Global'}</p>
                              </div>
                            </div>
                            <div className="flex items-center space-x-3">
                              <HiOutlineUsers className={`w-5 h-5 ${isDark ? 'text-gray-400' : 'text-gray-600'}`} />
                              <div>
                                <p className={`text-sm font-medium ${isDark ? 'text-white' : 'text-black'}`}>Organizer</p>
                                <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{tournament.organizer || 'CAW Gaming'}</p>
                              </div>
                            </div>
                            <div className="flex items-center space-x-3">
                              <HiOutlineClock className={`w-5 h-5 ${isDark ? 'text-gray-400' : 'text-gray-600'}`} />
                              <div>
                                <p className={`text-sm font-medium ${isDark ? 'text-white' : 'text-black'}`}>Registration Deadline</p>
                                <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{tournament.startDate}</p>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Action Buttons */}
                      <div className="flex justify-center space-x-4">
                        <button className={`px-6 py-3 rounded-lg text-sm font-medium transition-all duration-300 cursor-pointer ${
                          tournament.status === 'active'
                            ? 'bg-yellow-500 hover:bg-yellow-400 text-black'
                            : 'bg-yellow-500 hover:bg-yellow-400 text-black'
                        }`}>
                          <HiOutlinePlay className="w-4 h-4 inline mr-2" />
                          {tournament.status === 'active' ? 'Join Now' : 'Register'}
                        </button>
                        <button className={`px-6 py-3 rounded-lg text-sm font-medium transition-all duration-300 cursor-pointer ${
                          isDark 
                            ? 'bg-white/10 text-white hover:bg-white/20' 
                            : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                        }`}>
                          <Share className={`w-4 h-4 inline mr-2 transition-all duration-300 ${
                            isDark ? 'stroke-white stroke-[1.5]' : 'stroke-gray-600'
                          }`} />
                          Share Tournament
                        </button>
                      </div>
                    </div>
                  );
                })()}
              </div>
            ) : (
              // Tournament List View
              <div>
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-6">
              <div>
                <h2 className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-black'}`}>Tournaments</h2>
                <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'} mt-1`}>
                  Compete in exciting tournaments and win amazing prizes
                </p>
              </div>
              <div className="flex space-x-3 mt-4 sm:mt-0">
                <button className={`px-4 py-2 rounded-lg text-sm font-medium transition-all duration-300 cursor-pointer ${
                  isDark 
                    ? 'bg-white/10 text-white hover:bg-white/20' 
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}>
                  <HiOutlineFilter className="w-4 h-4 inline mr-2" />
                  Filter
                </button>
                <button className={`px-4 py-2 rounded-lg text-sm font-medium transition-all duration-300 cursor-pointer ${
                  isDark 
                    ? 'bg-white/10 text-white hover:bg-white/20' 
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}>
                  <HiOutlineCalendar className="w-4 h-4 inline mr-2" />
                  Schedule
                </button>
              </div>
            </div>

            {/* Tournament Stats */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
              <div className={`p-4 rounded-lg border transition-all duration-300 ${
                isDark ? 'bg-white/5 border-white/10' : 'bg-gray-50 border-gray-200'
              }`}>
                <div className="flex items-center justify-between mb-2">
                  <span className={`text-xs font-medium ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>Active Tournaments</span>
                  <HiOutlineFire className="w-4 h-4 text-red-500" />
                </div>
                <p className={`text-lg font-bold ${isDark ? 'text-white' : 'text-black'}`}>2</p>
              </div>
              <div className={`p-4 rounded-lg border transition-all duration-300 ${
                isDark ? 'bg-white/5 border-white/10' : 'bg-gray-50 border-gray-200'
              }`}>
                <div className="flex items-center justify-between mb-2">
                  <span className={`text-xs font-medium ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>Total Prize Pool</span>
                  <HiOutlineCurrencyDollar className="w-4 h-4 text-green-500" />
                </div>
                <p className={`text-lg font-bold ${isDark ? 'text-white' : 'text-black'}`}>40.5T CAW</p>
              </div>
              <div className={`p-4 rounded-lg border transition-all duration-300 ${
                isDark ? 'bg-white/5 border-white/10' : 'bg-gray-50 border-gray-200'
              }`}>
                <div className="flex items-center justify-between mb-2">
                  <span className={`text-xs font-medium ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>Total Participants</span>
                  <HiOutlineUsers className="w-4 h-4 text-blue-500" />
                </div>
                <p className={`text-lg font-bold ${isDark ? 'text-white' : 'text-black'}`}>6,240</p>
              </div>
              <div className={`p-4 rounded-lg border transition-all duration-300 ${
                isDark ? 'bg-white/5 border-white/10' : 'bg-gray-50 border-gray-200'
              }`}>
                <div className="flex items-center justify-between mb-2">
                  <span className={`text-xs font-medium ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>Your Entries</span>
                  <HiOutlineGift className="w-4 h-4 text-yellow-500" />
                </div>
                <p className={`text-lg font-bold ${isDark ? 'text-white' : 'text-black'}`}>3</p>
              </div>
            </div>

            <div className="space-y-4">
              {tournaments.map((tournament) => (
                <div
                  key={tournament.id}
                  className={`relative rounded-lg border transition-all duration-300 ${
                    isDark ? 'border-white/20' : 'border-gray-300'
                  }`}
                >
                  <div className="flex">
                    <div className="w-32 h-24 bg-gray-800 flex items-center justify-center overflow-hidden rounded-l-lg">
                      <img src={tournament.image} alt={tournament.name} className="max-w-full max-h-full object-contain" />
                    </div>
                    <div className={`absolute inset-0 bg-gradient-to-r ${tournament.gradient} opacity-20 rounded-lg`}></div>
                    <div className="flex-1 p-4 relative z-10">
                      <div className="flex justify-between items-start mb-2">
                        <div>
                          <h3 className={`text-lg font-bold ${isDark ? 'text-white' : 'text-black'}`}>{tournament.name}</h3>
                          <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{tournament.game}</p>
                        </div>
                        <div className="text-right">
                          <span className={`px-2 py-1 rounded-full text-xs font-semibold ${
                            isDark 
                              ? 'bg-white/20 text-white' 
                              : 'bg-gray-200 text-gray-800'
                          }`}>
                            {tournament.status === 'active' ? 'Active' : 'Upcoming'}
                          </span>
                        </div>
                      </div>
                      
                      {/* Tournament Description */}
                      {tournament.description && (
                        <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'} mb-3`}>
                          {tournament.description}
                        </p>
                      )}

                      {/* Tournament Details Grid */}
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
                        <div>
                          <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>Prize Pool</p>
                          <p className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-black'}`}>{tournament.prize}</p>
                        </div>
                        <div>
                          <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>Entry Fee</p>
                          <p className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-black'}`}>{tournament.entryFee}</p>
                        </div>
                        <div>
                          <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>Format</p>
                          <p className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-black'}`}>{tournament.format || 'Elimination'}</p>
                        </div>
                        <div>
                          <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>Duration</p>
                          <p className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-black'}`}>{tournament.duration || '3 days'}</p>
                        </div>
                      </div>

                      {/* Participants Progress Bar */}
                      <div className="mb-3">
                        <div className="flex justify-between items-center mb-1">
                          <span className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>Participants</span>
                          <span className={`text-xs font-medium ${isDark ? 'text-white' : 'text-black'}`}>
                            {tournament.participants}/{tournament.maxParticipants}
                          </span>
                        </div>
                        <div className={`w-full bg-gray-200 rounded-full h-2 ${isDark ? 'bg-gray-700' : 'bg-gray-200'}`}>
                          <div 
                            className="bg-gradient-to-r from-blue-500 to-purple-500 h-2 rounded-full transition-all duration-300"
                            style={{ width: `${(tournament.participants / tournament.maxParticipants) * 100}%` }}
                          ></div>
                        </div>
                      </div>

                      {/* Tournament Info and Actions */}
                      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3">
                        <div className="flex flex-wrap gap-4 text-xs">
                          <div className="flex items-center space-x-1">
                            <HiOutlineCalendar className={`w-3 h-3 ${isDark ? 'text-gray-400' : 'text-gray-600'}`} />
                          <span className={isDark ? 'text-gray-400' : 'text-gray-600'}>
                              {tournament.startDate} - {tournament.endDate}
                          </span>
                          </div>
                          <div className="flex items-center space-x-1">
                            <HiOutlineUsers className={`w-3 h-3 ${isDark ? 'text-gray-400' : 'text-gray-600'}`} />
                            <span className={isDark ? 'text-gray-400' : 'text-gray-600'}>{tournament.skillLevel || 'All Levels'}</span>
                          </div>
                          <div className="flex items-center space-x-1">
                            <HiOutlineGift className={`w-3 h-3 ${isDark ? 'text-gray-400' : 'text-gray-600'}`} />
                            <span className={isDark ? 'text-gray-400' : 'text-gray-600'}>{tournament.region || 'Global'}</span>
                          </div>
                        </div>
                        <div className="flex space-x-2">
                          <button 
                            onClick={() => setSelectedTournament(tournament.id)}
                            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-300 cursor-pointer ${
                            isDark 
                              ? 'bg-white/10 text-white hover:bg-white/20' 
                                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                            }`}
                          >
                            <HiOutlineEye className="w-3 h-3 inline mr-1" />
                            Details
                          </button>
                          <button className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-300 cursor-pointer ${
                            tournament.status === 'active'
                              ? 'bg-yellow-500 hover:bg-yellow-400 text-black'
                              : 'bg-yellow-500 hover:bg-yellow-400 text-black'
                          }`}>
                            <HiOutlinePlay className="w-3 h-3 inline mr-1" />
                            {tournament.status === 'active' ? 'Join Now' : 'Register'}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
              </div>
            )}
          </div>
        )}

        {/* Leaderboards Tab */}
        {activeTab === 'leaderboards' && (
          <div>
            <div className="flex justify-between items-center mb-4">
              <h2 className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-black'}`}>Leaderboards</h2>
              <div className="flex space-x-3 ml-2 md:ml-0">
                {['daily', 'weekly', 'monthly'].map((period) => (
                  <button
                    key={period}
                    onClick={() => setLeaderboardPeriod(period)}
                    className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors duration-300 cursor-pointer ${
                      leaderboardPeriod === period
                        ? isDark
                          ? 'bg-yellow-500 text-black'
                          : 'bg-yellow-500 text-black'
                        : isDark
                          ? 'bg-white/10 text-gray-300 hover:bg-white/20'
                          : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    {period.charAt(0).toUpperCase() + period.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-3">
              {leaderboards.map((player, index) => (
                <div
                  key={player.id}
                  className={`flex items-center p-4 rounded-lg border transition-all duration-300 ${
                    isDark ? 'border-gray-700' : 'border-gray-200'
                  } ${index < 3 ? (isDark ? 'bg-white/5' : 'bg-gray-50') : ''}`}
                >
                  <div className="flex items-center space-x-4 flex-1">
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-gradient-to-r from-yellow-400 to-orange-500 text-black font-bold text-sm">
                      {player.rank}
                    </div>
                    <img 
                      src={player.avatar} 
                      alt={player.username} 
                      className="w-10 h-10 rounded-full object-cover"
                    />
                    <div className="flex-1">
                      <div className="flex items-center space-x-2">
                        <h3 className={`font-semibold ${isDark ? 'text-white' : 'text-black'}`}>{player.username}</h3>
                        {player.badge === 'Crown' && <HiOutlineStar className="w-4 h-4 text-yellow-500" />}
                        {player.badge === 'Trophy' && <HiOutlineEmojiHappy className="w-4 h-4 text-yellow-500" />}
                        {player.badge === 'Medal' && <HiOutlineBadgeCheck className="w-4 h-4 text-yellow-500" />}
                        {player.badge === 'Star' && <HiOutlineStar className="w-4 h-4 text-yellow-500" />}
                      </div>
                      <div className="flex space-x-4 text-sm">
                        <span className={isDark ? 'text-gray-400' : 'text-gray-600'}>
                          {player.xp.toLocaleString()} XP
                        </span>
                        <span className={isDark ? 'text-gray-400' : 'text-gray-600'}>
                          {player.gamesPlayed} games
                        </span>
                        <span className={isDark ? 'text-gray-400' : 'text-gray-600'}>
                          {player.winRate}% win rate
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className={`text-lg font-bold ${isDark ? 'text-white' : 'text-black'}`}>
                      #{player.rank}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

      </div>

      {/* Mobile Bottom Navbar */}
      <MobileBottomNavbar 
        activeTab={activeBottomTab}
        onTabChange={(tab) => setActiveBottomTab(tab)}
        isVisible={true}
      />
    </MainLayout>
  )
}

export default GameFiPage