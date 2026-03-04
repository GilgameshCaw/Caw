import React from 'react'
import { Link } from 'react-router-dom'
import MainLayout from '~/layouts/MainLayout'
import { useTheme } from '~/hooks/useTheme'
import { HiArrowLeft, HiExternalLink, HiCode, HiDocumentText, HiGlobe, HiCurrencyDollar, HiUserGroup, HiChartBar, HiBeaker } from 'react-icons/hi'
import { useChainId } from 'wagmi'
import { chains } from '~/config/chains'
import { sepolia, baseSepolia } from 'wagmi/chains'

interface ResourceItem {
  icon: React.ReactNode
  title: string
  description: string
  url: string
}

const ResourcesPage: React.FC = () => {
  const { isDark } = useTheme()
  const chainId = useChainId()

  // Check if we're on a testnet
  const isTestnet = chainId === sepolia.id || chainId === baseSepolia.id ||
    chains.l1.chainId === sepolia.id || chains.l2.chainId === baseSepolia.id

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

  return (
    <MainLayout>
      <div className="max-w-2xl mx-auto px-6 py-4">
        {/* Header */}
        <div className="flex items-center gap-4 mb-6">
          <Link
            to="/settings"
            className={`p-2 rounded-full transition-colors cursor-pointer ${
              isDark ? 'hover:bg-white/10' : 'hover:bg-gray-100'
            }`}
          >
            <HiArrowLeft className="w-5 h-5" />
          </Link>
          <div>
            <h1 className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
              Resources
            </h1>
            <p className={`text-sm ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
              Links and information
            </p>
          </div>
        </div>

        {/* Testnet Section - only show on testnet */}
        {isTestnet && (
          <section className="mb-8">
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
        <section className="mb-8">
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
        <section className="mb-8">
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
        <section className="mb-8">
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
                <code className={`text-xs mt-1 block break-all ${isDark ? 'text-yellow-500' : 'text-yellow-700'}`}>
                  0xf3b9569F82B18aEf890De263B84189bd33EBe452
                </code>
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
    </MainLayout>
  )
}

export default ResourcesPage
