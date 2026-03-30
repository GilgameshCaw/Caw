import React, { useState, useRef, useEffect } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import MainLayout from '~/layouts/MainLayout'
import { useTheme } from '~/hooks/useTheme'
import { HiArrowLeft, HiChevronDown, HiChevronUp, HiExternalLink, HiCode, HiDocumentText, HiGlobe, HiCurrencyDollar, HiUserGroup, HiChartBar, HiBeaker } from 'react-icons/hi'
import { useChainId } from 'wagmi'
import { chains } from '~/config/chains'
import { sepolia, baseSepolia } from 'wagmi/chains'

type TabType = 'faq' | 'history' | 'manifesto' | 'gettingstarted' | 'developers' | 'resources'
type MobileDropdown = 'faq' | 'history' | null

interface FAQItem {
  question: string
  answer: string
}

interface HelpPageProps {
  defaultTab?: TabType
}

const HelpPage: React.FC<HelpPageProps> = ({ defaultTab }) => {
  const { isDark } = useTheme()
  const location = useLocation()
  const navigate = useNavigate()
  const [expandedFAQ, setExpandedFAQ] = useState<number | null>(null)
  const [mobileDropdown, setMobileDropdown] = useState<MobileDropdown>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const chainId = useChainId()

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setMobileDropdown(null)
      }
    }
    if (mobileDropdown) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [mobileDropdown])

  // Check if we're on a testnet
  const isTestnet = chainId === sepolia.id || chainId === baseSepolia.id ||
    chains.l1.chainId === sepolia.id || chains.l2.chainId === baseSepolia.id

  // Determine active tab from URL path
  const getActiveTab = (): TabType => {
    if (defaultTab) return defaultTab
    const path = location.pathname
    if (path === '/help/faq' || path === '/help') return 'faq'
    if (path === '/help/history') return 'history'
    if (path === '/help/manifesto') return 'manifesto'
    if (path === '/help/gettingstarted' || path === '/help/howto') return 'gettingstarted'
    if (path === '/help/developers') return 'developers'
    if (path === '/help/resources') return 'resources'
    return 'faq'
  }

  const activeSection = getActiveTab()

  const handleTabClick = (tab: TabType) => {
    const routes: Record<TabType, string> = {
      faq: '/help/faq',
      history: '/help/history',
      manifesto: '/help/manifesto',
      gettingstarted: '/help/gettingstarted',
      developers: '/help/developers',
      resources: '/help/resources'
    }
    navigate(routes[tab])
  }

  interface ResourceItem {
    icon: React.ReactNode
    title: string
    description: string
    url: string
  }

  const officialResources: ResourceItem[] = [
    {
      icon: <HiDocumentText className="w-6 h-6" />,
      title: 'CAW Manifesto',
      description: 'The original vision for decentralized social media',
      url: 'https://caw.is'
    },
    {
      icon: <HiCode className="w-6 h-6" />,
      title: 'GitHub',
      description: 'Source code and development repositories',
      url: 'https://github.com/cawdevelopment'
    },
    {
      icon: <HiUserGroup className="w-6 h-6" />,
      title: 'Telegram Community',
      description: 'Join the CAW builders community',
      url: 'https://t.me/cawbuilders'
    },
  ]

  const contractResources: ResourceItem[] = [
    {
      icon: <HiCurrencyDollar className="w-6 h-6" />,
      title: 'CAW Token (Ethereum)',
      description: '0xf3b9569F82B18aEf890De263B84189bd33EBe452',
      url: 'https://etherscan.io/token/0xf3b9569F82B18aEf890De263B84189bd33EBe452'
    },
    {
      icon: <HiChartBar className="w-6 h-6" />,
      title: 'CoinGecko',
      description: 'Price charts and market data',
      url: 'https://www.coingecko.com/en/coins/a-hunters-dream'
    },
    {
      icon: <HiChartBar className="w-6 h-6" />,
      title: 'CoinMarketCap',
      description: 'Market cap and trading info',
      url: 'https://coinmarketcap.com/currencies/caw/'
    },
    {
      icon: <HiGlobe className="w-6 h-6" />,
      title: 'Dextools',
      description: 'Trading charts and analytics',
      url: 'https://www.dextools.io/app/ether/pair-explorer/0xf3b9569F82B18aEf890De263B84189bd33EBe452'
    },
  ]

  const ResourceCard: React.FC<{ item: ResourceItem }> = ({ item }) => (
    <a
      href={item.url}
      target="_blank"
      rel="noopener noreferrer"
      className={`flex items-start gap-4 p-4 rounded-xl transition-colors ${
        isDark
          ? 'bg-white/5 hover:bg-white/10'
          : 'bg-gray-50 hover:bg-gray-100'
      }`}
    >
      <div className={`p-2 rounded-lg ${
        isDark ? 'bg-yellow-500/10 text-yellow-500' : 'bg-yellow-100 text-yellow-700'
      }`}>
        {item.icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h3 className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
            {item.title}
          </h3>
          <HiExternalLink className={`w-4 h-4 ${isDark ? 'text-white/40' : 'text-gray-400'}`} />
        </div>
        <p className={`text-sm truncate ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
          {item.description}
        </p>
      </div>
    </a>
  )

  const faqItems: FAQItem[] = [
    {
      question: "What is CAW?",
      answer: "CAW is a decentralized social protocol built on blockchain smart contracts. It's designed as a trustless social clearing house focused on freedom of speech, where no single person, entity, or group has ultimate control over the system."
    },
    {
      question: "How does CAW work under the hood?",
      answer: "CAW uses EIP-712 signature-based transactions for gasless social interactions. When you post, like, or follow, you sign a message off-chain with your wallet. Validators collect these signatures and batch them into on-chain transactions on L2 networks (like Base) where gas costs are minimal.\n\nAll actions are automatically archived to multiple blockchain networks via LayerZero cross-chain messaging. This means your data is stored on both the L2 network and archive chains like Arbitrum, ensuring permanent accessibility even if one network goes offline.\n\nBecause everything is on-chain and the contracts are immutable (no admin keys), anyone can verify the data, run their own client, or build alternative frontends. This creates a truly trustless system where no single entity controls the protocol."
    },
    {
      question: "How do I get a CAW username?",
      answer: "You burn CAW tokens through a smart contract to mint an NFT that becomes your username. The fewer characters in your username, the higher the cost. This NFT grants access to your account, including your CAW balance and direct messages."
    },
    {
      question: "What does 'staking' do?",
      answer: "Staking CAW allows you to perform actions on the platform like posting, liking, and recawing. When users create posts, the CAW spent is distributed to stakers. The more you stake, the more you can earn from platform activity."
    },
    {
      question: "Why is there a 420 character limit?",
      answer: "The protocol limits posts to 420 characters by design. This keeps messages concise and reduces on-chain storage costs while still allowing meaningful communication. If your message exceeds 420 characters, the frontend will automatically split it into multiple posts (a thread) to preserve your full message."
    },
    {
      question: "Can my content be censored?",
      answer: "The underlying CAW protocol has no content moderation - it's fully decentralized and immutable. However, individual frontends (like this app) may choose to filter content. If blocked from one frontend, you can always access CAW directly or through another frontend."
    },
    {
      question: "Are transactions gasless?",
      answer: "Most interactions (posting, liking, recawing) are designed to be gasless via signature-based contracts. You only need to pay gas for minting your NFT username and depositing/withdrawing CAW."
    },
    {
      question: "Who controls CAW?",
      answer: "No one. The manifesto states that deployers must renounce all contract keys with no multi-sig or upgradeable proxies. CAW is 'by design without design' - it's up to the community to shape its future."
    },
    {
      question: "What happens to the CAW I spend on the platform?",
      answer: "CAW spent on the platform is distributed to participants:\n• Posting: CAW goes to stakers\n• Liking: CAW goes to the original poster\n• ReCawing: Split between the poster and stakers\n• Following: CAW goes to stakers\n\nThis creates an economic ecosystem rewarding content creators and supporters."
    },
    {
      question: "How is my data protected from censorship?",
      answer: "Every action you take on CAW is automatically archived to multiple blockchain networks via LayerZero cross-chain messaging. Even if one network were to censor your content, the data remains permanently accessible on archive chains like Arbitrum."
    },
    {
      question: "What happens to on-chain images?",
      answer: "Images stored on-chain are included in the archive. The cost of storing images includes both the L2 storage fee and the cross-chain archiving fee, ensuring your visual content is preserved across networks."
    },
    {
      question: "What happens if the storage chain goes away?",
      answer: "Your data is automatically archived to multiple blockchain networks via LayerZero cross-chain messaging. Even if one storage chain were to go offline or censor content, the data remains permanently accessible on other archive chains like Arbitrum. As long as at least one archive chain remains accessible, your complete history of actions can be reconstructed from the blockchain events."
    }
  ]

  const toggleFAQ = (index: number) => {
    setExpandedFAQ(expandedFAQ === index ? null : index)
  }

  const TabButton: React.FC<{ tab: TabType; label: string }> = ({ tab, label }) => (
    <button
      onClick={() => handleTabClick(tab)}
      className={`px-4 py-3 text-sm font-medium transition-colors relative cursor-pointer ${
        activeSection === tab
          ? isDark ? 'text-yellow-500' : 'text-yellow-600'
          : isDark ? 'text-white/60 hover:text-white' : 'text-gray-500 hover:text-gray-900'
      }`}
    >
      {label}
      {activeSection === tab && (
        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-yellow-500" />
      )}
    </button>
  )

  return (
    <MainLayout>
      <div className="max-w-2xl mx-auto px-6 py-4">
        {/* Header */}
        <div className="flex items-center gap-4 mb-6">
          <Link
            to="/"
            className={`p-2 rounded-full transition-colors cursor-pointer ${
              isDark ? 'hover:bg-white/10' : 'hover:bg-gray-100'
            }`}
          >
            <HiArrowLeft className="w-5 h-5" />
          </Link>
          <div>
            <h1 className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
              Help & Resources
            </h1>
            <p className={`text-sm ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
              Learn about CAW
            </p>
          </div>
        </div>

        {/* Tab Navigation - Desktop */}
        <div className={`hidden md:flex border-b mb-6 ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
          <TabButton tab="faq" label="FAQ" />
          <TabButton tab="history" label="History" />
          <TabButton tab="manifesto" label="Manifesto" />
          <TabButton tab="gettingstarted" label="Getting Started" />
          <TabButton tab="developers" label="Developers" />
          <TabButton tab="resources" label="Resources" />
        </div>

        {/* Tab Navigation - Mobile with dropdowns */}
        <div className={`md:hidden flex border-b mb-6 ${isDark ? 'border-white/10' : 'border-gray-200'}`} ref={dropdownRef}>
          {/* FAQ Dropdown */}
          <div className="relative flex-1">
            <button
              onClick={() => setMobileDropdown(mobileDropdown === 'faq' ? null : 'faq')}
              className={`w-full px-2 py-3 text-sm font-medium transition-colors relative cursor-pointer flex items-center justify-center gap-1 ${
                (activeSection === 'faq' || activeSection === 'gettingstarted')
                  ? isDark ? 'text-yellow-500' : 'text-yellow-600'
                  : isDark ? 'text-white/60 hover:text-white' : 'text-gray-500 hover:text-gray-900'
              }`}
            >
              {activeSection === 'gettingstarted' ? 'Getting Started' : 'FAQ'}
              <HiChevronDown className={`w-4 h-4 transition-transform ${mobileDropdown === 'faq' ? 'rotate-180' : ''}`} />
              {(activeSection === 'faq' || activeSection === 'gettingstarted') && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-yellow-500" />
              )}
            </button>
            {mobileDropdown === 'faq' && (
              <div className={`absolute top-full left-0 right-0 z-50 rounded-b-lg shadow-lg ${
                isDark ? 'bg-gray-900 border border-white/10' : 'bg-white border border-gray-200'
              }`}>
                <button
                  onClick={() => { handleTabClick('faq'); setMobileDropdown(null) }}
                  className={`w-full px-4 py-3 text-sm text-left ${
                    activeSection === 'faq'
                      ? isDark ? 'text-yellow-500 bg-yellow-500/10' : 'text-yellow-600 bg-yellow-50'
                      : isDark ? 'text-white hover:bg-white/5' : 'text-gray-900 hover:bg-gray-50'
                  }`}
                >
                  FAQ
                </button>
                <button
                  onClick={() => { handleTabClick('gettingstarted'); setMobileDropdown(null) }}
                  className={`w-full px-4 py-3 text-sm text-left ${
                    activeSection === 'gettingstarted'
                      ? isDark ? 'text-yellow-500 bg-yellow-500/10' : 'text-yellow-600 bg-yellow-50'
                      : isDark ? 'text-white hover:bg-white/5' : 'text-gray-900 hover:bg-gray-50'
                  }`}
                >
                  Getting Started
                </button>
              </div>
            )}
          </div>

          {/* History Dropdown */}
          <div className="relative flex-1">
            <button
              onClick={() => setMobileDropdown(mobileDropdown === 'history' ? null : 'history')}
              className={`w-full px-2 py-3 text-sm font-medium transition-colors relative cursor-pointer flex items-center justify-center gap-1 ${
                (activeSection === 'history' || activeSection === 'manifesto')
                  ? isDark ? 'text-yellow-500' : 'text-yellow-600'
                  : isDark ? 'text-white/60 hover:text-white' : 'text-gray-500 hover:text-gray-900'
              }`}
            >
              {activeSection === 'manifesto' ? 'Manifesto' : 'History'}
              <HiChevronDown className={`w-4 h-4 transition-transform ${mobileDropdown === 'history' ? 'rotate-180' : ''}`} />
              {(activeSection === 'history' || activeSection === 'manifesto') && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-yellow-500" />
              )}
            </button>
            {mobileDropdown === 'history' && (
              <div className={`absolute top-full left-0 right-0 z-50 rounded-b-lg shadow-lg ${
                isDark ? 'bg-gray-900 border border-white/10' : 'bg-white border border-gray-200'
              }`}>
                <button
                  onClick={() => { handleTabClick('history'); setMobileDropdown(null) }}
                  className={`w-full px-4 py-3 text-sm text-left ${
                    activeSection === 'history'
                      ? isDark ? 'text-yellow-500 bg-yellow-500/10' : 'text-yellow-600 bg-yellow-50'
                      : isDark ? 'text-white hover:bg-white/5' : 'text-gray-900 hover:bg-gray-50'
                  }`}
                >
                  History
                </button>
                <button
                  onClick={() => { handleTabClick('manifesto'); setMobileDropdown(null) }}
                  className={`w-full px-4 py-3 text-sm text-left ${
                    activeSection === 'manifesto'
                      ? isDark ? 'text-yellow-500 bg-yellow-500/10' : 'text-yellow-600 bg-yellow-50'
                      : isDark ? 'text-white hover:bg-white/5' : 'text-gray-900 hover:bg-gray-50'
                  }`}
                >
                  Manifesto
                </button>
              </div>
            )}
          </div>

          {/* Developers - standalone */}
          <button
            onClick={() => handleTabClick('developers')}
            className={`flex-1 px-2 py-3 text-sm font-medium transition-colors relative cursor-pointer ${
              activeSection === 'developers'
                ? isDark ? 'text-yellow-500' : 'text-yellow-600'
                : isDark ? 'text-white/60 hover:text-white' : 'text-gray-500 hover:text-gray-900'
            }`}
          >
            Devs
            {activeSection === 'developers' && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-yellow-500" />
            )}
          </button>

          {/* Resources - standalone */}
          <button
            onClick={() => handleTabClick('resources')}
            className={`flex-1 px-2 py-3 text-sm font-medium transition-colors relative cursor-pointer ${
              activeSection === 'resources'
                ? isDark ? 'text-yellow-500' : 'text-yellow-600'
                : isDark ? 'text-white/60 hover:text-white' : 'text-gray-500 hover:text-gray-900'
            }`}
          >
            Resources
            {activeSection === 'resources' && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-yellow-500" />
            )}
          </button>
        </div>

        {/* FAQ Section */}
        {activeSection === 'faq' && (
          <div className="space-y-2">
            {faqItems.map((item, index) => (
              <div
                key={index}
                className={`rounded-lg overflow-hidden ${
                  isDark ? 'bg-white/5' : 'bg-gray-50'
                }`}
              >
                <button
                  onClick={() => toggleFAQ(index)}
                  className={`w-full flex items-center justify-between p-4 text-left transition-colors ${
                    isDark ? 'hover:bg-white/5' : 'hover:bg-gray-100'
                  }`}
                >
                  <span className={`font-medium pr-4 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    {item.question}
                  </span>
                  {expandedFAQ === index ? (
                    <HiChevronUp className={`w-5 h-5 flex-shrink-0 ${isDark ? 'text-white/60' : 'text-gray-500'}`} />
                  ) : (
                    <HiChevronDown className={`w-5 h-5 flex-shrink-0 ${isDark ? 'text-white/60' : 'text-gray-500'}`} />
                  )}
                </button>
                {expandedFAQ === index && (
                  <div className={`px-4 pt-2 pb-4 text-sm whitespace-pre-wrap ${isDark ? 'text-white/70' : 'text-gray-600'}`}>
                    {item.answer}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* History Section */}
        {activeSection === 'history' && (
          <div className="space-y-6">
            <div className={`p-6 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
              <h2 className={`text-xl font-bold mb-4 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                The Origins of CAW
              </h2>

              <div className={`space-y-4 text-sm leading-relaxed ${isDark ? 'text-white/80' : 'text-gray-700'}`}>
                <p>
                  CAW (A Hunter's Dream) emerged in 2022 with a verifiable on-chain connection to Ryoshi, the
                  pseudonymous creator of Shiba Inu. Blockchain records show a direct link between the wallets,
                  sparking intense speculation and investigation within the crypto community.
                </p>

                <h3 className={`text-lg font-semibold mt-6 mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  The Scavenger Hunt
                </h3>
                <p>
                  Rather than a traditional launch, CAW was revealed through an elaborate cryptographic scavenger hunt.
                  Community members decoded clues, solved puzzles, and pieced together fragments scattered across the
                  blockchain and web. The hunt eventually led to the <Link to="/help/manifesto" className={`underline ${isDark ? 'text-yellow-500 hover:text-yellow-400' : 'text-yellow-700 hover:text-yellow-600'}`}>CAW Manifesto</Link> — a vision for a truly decentralized
                  social protocol.
                </p>

                <h3 className={`text-lg font-semibold mt-6 mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  Community-Built
                </h3>
                <p>
                  The Manifesto made clear that CAW was "by design without design" — no official team, no roadmap,
                  no promises. It was left entirely to the community to interpret the vision and build the protocol.
                  What you see today is the result of that effort.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Manifesto Section */}
        {activeSection === 'manifesto' && (
          <div className="space-y-6">
            <div className={`p-6 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
              <p className={`text-xs mb-4 ${isDark ? 'text-white/40' : 'text-gray-400'}`}>
                Pulled verbatim from the decoded <Link to="/help/history" className={`underline ${isDark ? 'text-yellow-500/60 hover:text-yellow-500' : 'text-yellow-700/60 hover:text-yellow-700'}`}>cryptographic scavenger hunt</Link>
              </p>
              <h2 className={`text-xl font-bold mb-4 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                A Manifesto on a Decentralized Social Clearing House ...(AKA) CAW
              </h2>

              <div className={`space-y-4 text-sm leading-relaxed ${isDark ? 'text-white/80' : 'text-gray-700'}`}>
                <p>
                  The concept of decentralization has been lost to some of us over time, those who forgot why Bitcoin was created, the issues blockchain and cryptocurrency is meant to solve. To be decentralized means there is no single person, entity, nor group which has ultimate control nor benefit over a system/
                </p>

                <p>
                  In a decentralized system, there is not one man who via desire or persuasion could cripple the system in any meaningful way. This means from both a technical standpoint (i.e, a developer who can stop trading, or disable the protocol through the use of smart contracts) and a financial one (e.g, an entity who has n+1 (infinite) tokens, and could dump them if they so wished, but decides not to.)
                </p>

                <p>
                  That is not to say that a proper decentralized system is without whales nor its own cornerstones. There are always those that may have a greater affect upon a network, or 'matter' through entropy or their own hard work.
                </p>

                <p>
                  CAW began as nothing, there was no developer, no information, no medium of communication. Simply. a contract.
                </p>

                <p>
                  Freedom given to the people to discover CAW's meaning amongst themselves. This has gone well, and so we would like to present our specification for the second phase of CAW. But before we do, some things must be said and taken note of:
                </p>

                <ol className={`list-decimal list-inside space-y-2 pl-2 ${isDark ? 'text-white/80' : 'text-gray-700'}`}>
                  <li>This is a only a specification. It is up to the cawmmunity to write and deploy the protocol.</li>
                  <li>It is strongly recommended that a peer group is formed to develop and review smart contracts. As there is no leader in this process, all types will attempt to claim ownership of the process. There will be those everso helpful who claim to be able to 'do it all' but will write the perfect code with the perfect backdoor. Only a cawmmunity reviewed and accepted contract on a public github will be acceptable.</li>
                  <li>After deployment, the deployer must renounce any keys they have to the contracts. There will be no multi-sig, no upgradeable proxies. It will not matter who deployed because they will be equal with all with no specific benefit nor advantage. Just get the contract right.</li>
                </ol>

                <h3 className={`text-lg font-semibold mt-6 mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  We propose:
                </h3>
                <p>
                  a. A protocol made up of many on-chain smart contracts for sending messages publically or p2p with a max character limit of 420.
                </p>
                <p>
                  b. A specification for the frontends, of which many will be made, to interact with this protocol.
                </p>

                <h3 className={`text-lg font-semibold mt-6 mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  The general function of the protocol and its contracts is as follows:
                </h3>

                <div className="space-y-3 pl-2">
                  <p><strong>i.</strong> Burn CAW through a contract to mint an NFT. This burned caw will go to 0x0. The NFT will be your username.</p>
                  <p className="pl-4">a. The fewer characters in your username, the higher the cost.</p>
                  <p className="pl-4">b. Every username is unique, and may use a-z and 0-9, without the use of special characters (emojis, etc..,) or capital letters.</p>

                  <p><strong>ii.</strong> All user activity, social and financial flows through their NFT username. Whoever owns this NFT has access to that account. This includes, but is not limited to, their CAW balance and access to that user's direct messages (DMs).</p>

                  <p><strong>iii.</strong> Ownership and management of the NFTs will be completely on-chain. For instance, the registration of the username 'cawdev' will be stored directly on-chain, along with all of the data associated.</p>

                  <p><strong>iv.</strong> Holding the NFT (note holding, not staking), allows the user to deposit or withdraw CAW into a contract wallet. The ownership of the NFT will serve as the key to this wallet. For users using multiple NFTs they may specify which by a unique number associated.</p>

                  <p><strong>v.</strong> A user may spend CAW in the following way on the protocol:</p>
                  <div className="pl-4 space-y-2">
                    <p><strong>i.</strong> Making a CAW (Akin to tweeting). This cost will be taken in CAW, and then distributed proportionally to all other stakers.</p>
                    <p><strong>ii.</strong> Liking someone else's CAW. This is closer to tipping. The CAW will be taken and directly sent to the OP (original poster's) wallet.</p>
                    <p><strong>iii.</strong> ReCAWing (akin to a retweet). The cost of which will be taken in CAW and sent to OP's wallet.</p>
                  </div>

                  <p><strong>vi.</strong> For receiving the CAW we envision a mostly gasless contract, in which signatures may push CAW balance between users and the application in a contract. The only thing a user should be spending gas on is:</p>
                  <p className="pl-4">a. The minting of an NFT.</p>
                  <p className="pl-4">b. Depositing or withdrawing CAW.</p>

                  <p><strong>vii.</strong> DM's should be 'free' and executed via a trustless handshake between two accounts to enable secure peer-to-peer messaging. Group chats would bring on unneeded complexity, and are not recommended at this point.</p>

                  <p><strong>viii.</strong> All data will be stored permanently. Due to limitations of the Ethereum network, Arweave or similar blockchains may be preferred. Data storage must be completely trustless, and permanent. The importance of being both censorship resistant and self-policing for the betterment of a protocol cannot be overstated. CAW is meant only to give you the raw tool kit to build your own online society. Because of this, there is a distinct gap between the protocol itself, and the frontends.</p>
                </div>

                <h3 className={`text-lg font-semibold mt-6 mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  Content Moderation
                </h3>
                <p>
                  At the base level, CAW's contracts for trustless data storage and communication, anything can be posted. We are not naive, and we understand what may be posted. As a result of this, it is up to the frontends to limit content that might obfuscate the reason for CAW's creation.
                </p>
                <p>
                  That being said, at the level of a protocol no username or message will be blocked or quarantined. Due to the nature of renounced ownership of smart contracts, there will be nobody who can limit such content. (perhaps now you see why renouncing the contract with no multi-sig or upgrades is important.)
                </p>

                <h3 className={`text-lg font-semibold mt-6 mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  Frontends
                </h3>
                <p>
                  Anybody is free to make or host their own frontend which will show whatever they would like (or don't). We expect there will be many along with a goal of a mobile app and browser extension that serves as cawing/wallet and instant messenger platform that executes the sigs fast and invisible to give a smoother messaging experience (signing a metamask everytime can be tiresome).
                </p>
                <p>
                  We would recommend that the community makes an alpha frontend, that is more or less 'neutral'. It may filter overt hate/violence, along with hard-illegal activity, remember we need to win the world first. Others may have a better idea of what should be shown, and their prerogative should be to create and host their own frontend. The point being, CAW is like Twitter. Except it is bound by no laws, and no central content moderation. However, the frontends may choose to moderate the content however they like, or must to fit whatever legal guidelines they need to fit.
                </p>
                <p>
                  <strong className={isDark ? 'text-white' : 'text-gray-900'}>So even if one frontend blocks you, you cannot be policed, and are still free to use the protocol itself.</strong>
                </p>

                <h3 className={`text-lg font-semibold mt-6 mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  Appendix
                </h3>

                <p><strong>a. NFT Trading</strong></p>
                <p>
                  It is fairly obvious individuals will begin buying and selling the NFT usernames. It would be wise of a community member to create a trustless and feeless marketplace for such trades, similar to Crypto Punk feeless trades. That being said we are pretty aware that as CAW grows to scale, many will still use FEE marketplaces such as opensea and looks. This means that the deployer of the contract that mints NFTS will have the technical ability to set themselves fees from opensea.
                </p>
                <p>
                  We do not think this is a good thing, and ask the community to self police/renounce in order to make sure that trading fees are not set and sent to a private wallet. If it helps, this will imply liability for the content posted if your wallet is receiving trading fees.
                </p>

                <p className="mt-4"><strong>b. Economics</strong></p>
                <p>
                  These are the numbers open for debate and structured so that we understand the practical dollar amount of CAW at three market cap scenarios: 50 mln (near or current MC), 1 bln (typical memecoin mooning), and 10 bln (SHIB-like).
                </p>

                <p className="mt-2"><strong>Username Costs (BURN):</strong></p>
                <ul className={`list-disc list-inside space-y-1 pl-2 ${isDark ? 'text-white/80' : 'text-gray-700'}`}>
                  <li>Single Character: 1,000,000,000,000 CAW</li>
                  <li>2 Characters: 240,000,000,000 CAW</li>
                  <li>3 Characters: 60,000,000,000 CAW</li>
                  <li>4 Characters: 6,000,000,000 CAW</li>
                  <li>5 Characters: 200,000,000 CAW</li>
                  <li>6 Characters: 20,000,000 CAW</li>
                  <li>7 Characters: 10,000,000 CAW</li>
                  <li>8+ Characters: 1,000,000 CAW</li>
                </ul>

                <p className="mt-2"><strong>Action Costs:</strong></p>
                <ul className={`list-disc list-inside space-y-1 pl-2 ${isDark ? 'text-white/80' : 'text-gray-700'}`}>
                  <li>Follow: 30,000 CAW (80% to account, 20% to stakers)</li>
                  <li>Send a CAW: 5,000 CAW (100% to stakers)</li>
                  <li>Like a CAW: 2,000 CAW (80% to account, 20% to stakers)</li>
                  <li>ReCAW: 4,000 CAW (50% to account, 50% to stakers)</li>
                </ul>

                <p className="mt-4"><strong>c. Image Hosting</strong></p>
                <p>
                  The protocol will have no involvement in the hosting of images. This will be up to the frontends to filter, display, host. It is recommended that frontends render URLs from external sources placed inside posts, or employ their own URL shortener so URLs do not destroy the character limit on CAW.
                </p>

                <div className={`mt-6 pt-4 border-t ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
                  <p className={`italic ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
                    Love, one who still dreams.
                  </p>
                  <p className="mt-4">
                    P.S. There are no official socials, nor partner projects or further releases. CAW is by design without design, and it is up the CAWMmunity to shape CAW. Only by giving you the vision and seeing what comes next may we have a truly free and decentralized system.
                  </p>
                </div>
              </div>
            </div>

            {/* Link to full manifesto */}
            <a
              href="https://github.com/cawdevelopment/manifesto"
              target="_blank"
              rel="noopener noreferrer"
              className={`flex items-center justify-center gap-2 py-3 px-4 rounded-lg transition-colors ${
                isDark
                  ? 'bg-yellow-500/10 text-yellow-500 hover:bg-yellow-500/20'
                  : 'bg-yellow-50 text-yellow-700 hover:bg-yellow-100'
              }`}
            >
              View on GitHub
              <HiExternalLink className="w-4 h-4" />
            </a>
          </div>
        )}

        {/* Getting Started Section */}
        {activeSection === 'gettingstarted' && (
          <div className="space-y-4">
            <div className={`p-5 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
              <div className="flex items-start gap-4">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                  isDark ? 'bg-yellow-500/20 text-yellow-500' : 'bg-yellow-100 text-yellow-700'
                }`}>
                  1
                </div>
                <div>
                  <h3 className={`font-semibold mb-1 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    Get Your Username
                  </h3>
                  <p className={`text-sm ${isDark ? 'text-white/70' : 'text-gray-600'}`}>
                    Burn CAW tokens to mint your username NFT. Shorter names cost more CAW.
                    This NFT is your identity on the platform.
                  </p>
                </div>
              </div>
            </div>

            <div className={`p-5 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
              <div className="flex items-start gap-4">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                  isDark ? 'bg-yellow-500/20 text-yellow-500' : 'bg-yellow-100 text-yellow-700'
                }`}>
                  2
                </div>
                <div>
                  <h3 className={`font-semibold mb-1 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    Stake CAW
                  </h3>
                  <p className={`text-sm ${isDark ? 'text-white/70' : 'text-gray-600'}`}>
                    Deposit and stake CAW to unlock platform features. Staking enables you to post, like, and recaw.
                    You also earn a share of platform activity.
                  </p>
                </div>
              </div>
            </div>

            <div className={`p-5 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
              <div className="flex items-start gap-4">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                  isDark ? 'bg-yellow-500/20 text-yellow-500' : 'bg-yellow-100 text-yellow-700'
                }`}>
                  3
                </div>
                <div>
                  <h3 className={`font-semibold mb-1 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    Create Content
                  </h3>
                  <p className={`text-sm ${isDark ? 'text-white/70' : 'text-gray-600'}`}>
                    Post messages (up to 420 characters), share images, and engage with others.
                    Most actions are gasless — signed off-chain and validated on-chain.
                  </p>
                </div>
              </div>
            </div>

            <div className={`p-5 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
              <div className="flex items-start gap-4">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                  isDark ? 'bg-yellow-500/20 text-yellow-500' : 'bg-yellow-100 text-yellow-700'
                }`}>
                  4
                </div>
                <div>
                  <h3 className={`font-semibold mb-1 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    Earn Rewards
                  </h3>
                  <p className={`text-sm ${isDark ? 'text-white/70' : 'text-gray-600'}`}>
                    When others like your posts, you receive CAW. As a staker, you earn from all platform activity.
                    The ecosystem rewards both creators and supporters.
                  </p>
                </div>
              </div>
            </div>

            <div className={`mt-6 p-4 rounded-lg border ${
              isDark ? 'border-white/10 bg-white/5' : 'border-gray-200 bg-gray-50'
            }`}>
              <h4 className={`font-semibold mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                CAW Spent on the Platform
              </h4>
              <ul className={`text-sm space-y-2 ${isDark ? 'text-white/70' : 'text-gray-600'}`}>
                <li><strong>Post:</strong> 5,000 CAW (100% to stakers)</li>
                <li><strong>Like:</strong> 2,000 CAW (80% to poster, 20% to stakers)</li>
                <li><strong>ReCaw:</strong> 4,000 CAW (50% to poster, 50% to stakers)</li>
                <li><strong>Follow:</strong> 30,000 CAW (80% to account, 20% to stakers)</li>
              </ul>
            </div>
          </div>
        )}

        {/* Developers Section */}
        {activeSection === 'developers' && (
          <div className="space-y-6">
            <div className={`p-6 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
              <h2 className={`text-xl font-bold mb-4 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                Host Your Own Frontend
              </h2>

              <div className={`space-y-4 text-sm leading-relaxed ${isDark ? 'text-white/80' : 'text-gray-700'}`}>
                <p>
                  As outlined in the manifesto, anyone is free to host their own CAW frontend. The protocol is open and permissionless — your frontend can display whatever content you choose, with your own moderation policies.
                </p>

                <h3 className={`text-lg font-semibold mt-6 mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  Getting Started
                </h3>

                <ol className={`list-decimal list-inside space-y-3 ${isDark ? 'text-white/80' : 'text-gray-700'}`}>
                  <li>
                    <strong>Clone the repository</strong>
                    <div className={`mt-2 p-3 rounded-lg font-mono text-xs ${isDark ? 'bg-black/50' : 'bg-gray-100'}`}>
                      git clone https://github.com/GilgameshCaw/Caw
                    </div>
                  </li>
                  <li>
                    <strong>Install dependencies</strong>
                    <div className={`mt-2 p-3 rounded-lg font-mono text-xs whitespace-pre-line ${isDark ? 'bg-black/50' : 'bg-gray-100'}`}>
                      cd client{'\n'}npm install
                    </div>
                  </li>
                  <li>
                    <strong>Configure environment</strong>
                    <p className="mt-1">Copy <code className={`px-1 rounded ${isDark ? 'bg-black/50' : 'bg-gray-200'}`}>.env.example</code> to <code className={`px-1 rounded ${isDark ? 'bg-black/50' : 'bg-gray-200'}`}>.env</code> and configure your RPC endpoints and API keys.</p>
                  </li>
                  <li>
                    <strong>Run the development server</strong>
                    <div className={`mt-2 p-3 rounded-lg font-mono text-xs ${isDark ? 'bg-black/50' : 'bg-gray-100'}`}>
                      npm run dev
                    </div>
                  </li>
                </ol>

                <h3 className={`text-lg font-semibold mt-6 mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  Requirements
                </h3>
                <ul className={`list-disc list-inside space-y-2 ${isDark ? 'text-white/80' : 'text-gray-700'}`}>
                  <li>Node.js 18+</li>
                  <li>PostgreSQL database</li>
                  <li>Redis (for caching)</li>
                  <li>RPC endpoints for Ethereum and Base</li>
                </ul>

                <h3 className={`text-lg font-semibold mt-6 mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  Content Moderation
                </h3>
                <p>
                  Your frontend, your rules. The protocol itself has no content moderation, but you can implement whatever filtering policies make sense for your community. Users blocked on your frontend can still access CAW through other frontends or directly.
                </p>

                <h3 className={`text-lg font-semibold mt-6 mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  Validator Service
                </h3>
                <p>
                  To process gasless transactions, you'll need to run a validator service. The validator collects signed user actions, batches them together, and submits them to the blockchain.
                </p>

                <h3 className={`text-lg font-semibold mt-6 mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  Architecture
                </h3>
                <p>
                  For economic feasibility, social actions are validated on L2 networks where gas costs are significantly lower. The validator submits batched transactions to the CawActions contract on L2, which processes likes, posts, follows, and other interactions at a fraction of mainnet costs.
                </p>
                <p className="mt-2">
                  Username NFTs and CAW token balances live on Ethereum mainnet. LayerZero enables cross-chain messaging between L1 and L2, allowing users to bridge their CAW balance to L2 networks for use in the social protocol while maintaining the security of mainnet for core assets.
                </p>
              </div>
            </div>

            {/* GitHub Link */}
            <a
              href="https://github.com/GilgameshCaw/Caw"
              target="_blank"
              rel="noopener noreferrer"
              className={`flex items-center justify-center gap-2 py-3 px-4 rounded-lg transition-colors ${
                isDark
                  ? 'bg-yellow-500/10 text-yellow-500 hover:bg-yellow-500/20'
                  : 'bg-yellow-50 text-yellow-700 hover:bg-yellow-100'
              }`}
            >
              View source on GitHub
              <HiExternalLink className="w-4 h-4" />
            </a>
          </div>
        )}

        {/* Resources Section */}
        {activeSection === 'resources' && (
          <div className="space-y-6">
            {/* Testnet Section - only show on testnet */}
            {isTestnet && (
              <section>
                <h2 className={`text-sm font-semibold mb-3 uppercase tracking-wide ${
                  isDark ? 'text-yellow-500/60' : 'text-yellow-600'
                }`}>
                  Testnet Tools
                </h2>
                <div className="space-y-2">
                  <Link
                    to="/faucet"
                    className={`flex items-start gap-4 p-4 rounded-xl transition-colors ${
                      isDark
                        ? 'bg-yellow-500/10 hover:bg-yellow-500/20 border border-yellow-500/20'
                        : 'bg-yellow-50 hover:bg-yellow-100 border border-yellow-200'
                    }`}
                  >
                    <div className={`p-2 rounded-lg ${
                      isDark ? 'bg-yellow-500/20 text-yellow-500' : 'bg-yellow-200 text-yellow-700'
                    }`}>
                      <HiBeaker className="w-6 h-6" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                        mCAW Faucet
                      </h3>
                      <p className={`text-sm ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
                        Mint testnet mCAW tokens for testing
                      </p>
                    </div>
                  </Link>
                </div>
              </section>
            )}

            {/* Official Section */}
            <section>
              <h2 className={`text-sm font-semibold mb-3 uppercase tracking-wide ${
                isDark ? 'text-white/40' : 'text-gray-400'
              }`}>
                Official
              </h2>
              <div className="space-y-2">
                {officialResources.map((item, index) => (
                  <ResourceCard key={index} item={item} />
                ))}
              </div>
            </section>

            {/* Contracts & Markets Section */}
            <section>
              <h2 className={`text-sm font-semibold mb-3 uppercase tracking-wide ${
                isDark ? 'text-white/40' : 'text-gray-400'
              }`}>
                Contracts & Markets
              </h2>
              <div className="space-y-2">
                {contractResources.map((item, index) => (
                  <ResourceCard key={index} item={item} />
                ))}
              </div>
            </section>

            {/* Network Info */}
            <section>
              <h2 className={`text-sm font-semibold mb-3 uppercase tracking-wide ${
                isDark ? 'text-white/40' : 'text-gray-400'
              }`}>
                Network Information
              </h2>

              <div className={`p-4 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
                <div className="space-y-4">
                  <div>
                    <h4 className={`text-sm font-medium mb-1 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                      CAW Token
                    </h4>
                    <p className={`text-sm ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
                      ERC-20 token on Ethereum mainnet
                    </p>
                    <a
                      href="https://etherscan.io/token/0xf3b9569F82B18aEf890De263B84189bd33EBe452"
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`text-xs mt-1 block break-all hover:underline ${isDark ? 'text-yellow-500 hover:text-yellow-400' : 'text-yellow-700 hover:text-yellow-600'}`}
                    >
                      0xf3b9569F82B18aEf890De263B84189bd33EBe452
                    </a>
                  </div>

                  <div className={`border-t pt-4 ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
                    <h4 className={`text-sm font-medium mb-1 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                      Username NFTs
                    </h4>
                    <p className={`text-sm ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
                      ERC-721 on Ethereum mainnet
                    </p>
                  </div>

                  <div className={`border-t pt-4 ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
                    <h4 className={`text-sm font-medium mb-1 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                      Social Protocol
                    </h4>
                    <p className={`text-sm ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
                      Gasless actions via signature-based contracts on L2 networks
                    </p>
                  </div>

                  <div className={`border-t pt-4 ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
                    <h4 className={`text-sm font-medium mb-1 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                      Cross-Chain Archiving
                    </h4>
                    <p className={`text-sm ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
                      All actions are automatically archived to Arbitrum for censorship resistance. Your posts, likes, and follows are permanently stored across multiple chains.
                    </p>
                  </div>
                </div>
              </div>
            </section>

            {/* Disclaimer */}
            <div className={`p-4 rounded-lg text-sm ${
              isDark ? 'bg-white/5 text-white/50' : 'bg-gray-50 text-gray-500'
            }`}>
              <p>
                CAW has no official socials, partner projects, or further releases beyond what was described in the manifesto.
                Be cautious of scams claiming to be official CAW projects.
              </p>
            </div>
          </div>
        )}

        {/* Community Links */}
        <div className={`mt-8 pt-6 border-t ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
          <h3 className={`text-sm font-semibold mb-3 ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
            COMMUNITY
          </h3>
          <div className="grid grid-cols-2 gap-3">
            <a
              href="https://github.com/cawdevelopment"
              target="_blank"
              rel="noopener noreferrer"
              className={`flex items-center gap-2 p-3 rounded-lg transition-colors ${
                isDark ? 'bg-white/5 hover:bg-white/10 text-white' : 'bg-gray-50 hover:bg-gray-100 text-gray-900'
              }`}
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
              </svg>
              <span className="text-sm">GitHub</span>
            </a>
            <a
              href="https://t.me/cawbuilders"
              target="_blank"
              rel="noopener noreferrer"
              className={`flex items-center gap-2 p-3 rounded-lg transition-colors ${
                isDark ? 'bg-white/5 hover:bg-white/10 text-white' : 'bg-gray-50 hover:bg-gray-100 text-gray-900'
              }`}
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>
              </svg>
              <span className="text-sm">Telegram</span>
            </a>
          </div>
        </div>
      </div>
    </MainLayout>
  )
}

export default HelpPage
