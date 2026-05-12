import React, { useState, useRef, useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { Link, useNavigate } from '~/utils/localizedRouter'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
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
  const t = useT()
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
      title: t('help.resources.official.manifesto.title'),
      description: t('help.resources.official.manifesto.description'),
      url: '/help/manifesto'
    },
    {
      icon: <HiCode className="w-6 h-6" />,
      title: t('help.resources.official.github.title'),
      description: t('help.resources.official.github.description'),
      url: 'https://github.com/cawdevelopment'
    },
    {
      icon: <HiUserGroup className="w-6 h-6" />,
      title: t('help.resources.official.telegram.title'),
      description: t('help.resources.official.telegram.description'),
      url: 'https://t.me/cawbuilders'
    },
  ]

  const contractResources: ResourceItem[] = [
    {
      icon: <HiCurrencyDollar className="w-6 h-6" />,
      title: t('help.resources.contracts.caw_token.title'),
      description: '0xf3b9569F82B18aEf890De263B84189bd33EBe452',
      url: 'https://etherscan.io/token/0xf3b9569F82B18aEf890De263B84189bd33EBe452'
    },
    {
      icon: <HiChartBar className="w-6 h-6" />,
      title: t('help.resources.contracts.coingecko.title'),
      description: t('help.resources.contracts.coingecko.description'),
      url: 'https://www.coingecko.com/en/coins/a-hunters-dream'
    },
    {
      icon: <HiChartBar className="w-6 h-6" />,
      title: t('help.resources.contracts.coinmarketcap.title'),
      description: t('help.resources.contracts.coinmarketcap.description'),
      url: 'https://coinmarketcap.com/currencies/caw/'
    },
    {
      icon: <HiGlobe className="w-6 h-6" />,
      title: t('help.resources.contracts.dextools.title'),
      description: t('help.resources.contracts.dextools.description'),
      url: 'https://www.dextools.io/app/ether/pair-explorer/0xf3b9569F82B18aEf890De263B84189bd33EBe452'
    },
  ]

  const ResourceCard: React.FC<{ item: ResourceItem }> = ({ item }) => {
    const isInternal = item.url.startsWith('/')
    const cls = `flex items-start gap-4 p-4 rounded-xl transition-colors ${
      isDark
        ? 'bg-[#0D0D0D]/85 hover:bg-[#1A1A1A]/85'
        : 'bg-gray-50 hover:bg-gray-100 shadow-xl'
    }`
    const Wrapper = isInternal
      ? ({ children }: { children: React.ReactNode }) => <Link to={item.url} className={cls}>{children}</Link>
      : ({ children }: { children: React.ReactNode }) => <a href={item.url} target="_blank" rel="noopener noreferrer" className={cls}>{children}</a>
    return (
    <Wrapper>
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
    </Wrapper>
  )
  }

  const faqItems: FAQItem[] = [
    {
      question: t('help.faq.q1.question'),
      answer: t('help.faq.q1.answer')
    },
    {
      question: t('help.faq.q2.question'),
      answer: t('help.faq.q2.answer')
    },
    {
      question: t('help.faq.q3.question'),
      answer: t('help.faq.q3.answer')
    },
    {
      question: t('help.faq.q4.question'),
      answer: t('help.faq.q4.answer')
    },
    {
      question: t('help.faq.q5.question'),
      answer: t('help.faq.q5.answer')
    },
    {
      question: t('help.faq.q6.question'),
      answer: t('help.faq.q6.answer')
    },
    {
      question: t('help.faq.q7.question'),
      answer: t('help.faq.q7.answer')
    },
    {
      question: t('help.faq.q8.question'),
      answer: t('help.faq.q8.answer')
    },
    {
      question: t('help.faq.q9.question'),
      answer: t('help.faq.q9.answer')
    },
    {
      question: t('help.faq.q10.question'),
      answer: t('help.faq.q10.answer')
    },
    {
      question: t('help.faq.q11.question'),
      answer: t('help.faq.q11.answer')
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
      <div className={`max-w-2xl mx-auto px-6 py-4 ${isDark ? 'bg-black/80' : 'bg-white/90'} backdrop-blur-sm`}>
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
              {t('help.header.title')}
            </h1>
            <p className={`text-sm ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
              {t('help.header.subtitle')}
            </p>
          </div>
        </div>

        {/* Tab Navigation - Desktop */}
        <div className={`hidden md:flex border-b mb-6 ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
          <TabButton tab="faq" label={t('help.tab.faq')} />
          <TabButton tab="history" label={t('help.tab.history')} />
          <TabButton tab="manifesto" label={t('help.tab.manifesto')} />
          <TabButton tab="gettingstarted" label={t('help.tab.getting_started')} />
          <TabButton tab="developers" label={t('help.tab.developers')} />
          <TabButton tab="resources" label={t('help.tab.resources')} />
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
              {activeSection === 'gettingstarted' ? t('help.tab.getting_started') : t('help.tab.faq')}
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
                  {t('help.tab.faq')}
                </button>
                <button
                  onClick={() => { handleTabClick('gettingstarted'); setMobileDropdown(null) }}
                  className={`w-full px-4 py-3 text-sm text-left ${
                    activeSection === 'gettingstarted'
                      ? isDark ? 'text-yellow-500 bg-yellow-500/10' : 'text-yellow-600 bg-yellow-50'
                      : isDark ? 'text-white hover:bg-white/5' : 'text-gray-900 hover:bg-gray-50'
                  }`}
                >
                  {t('help.tab.getting_started')}
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
              {activeSection === 'manifesto' ? t('help.tab.manifesto') : t('help.tab.history')}
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
                  {t('help.tab.history')}
                </button>
                <button
                  onClick={() => { handleTabClick('manifesto'); setMobileDropdown(null) }}
                  className={`w-full px-4 py-3 text-sm text-left ${
                    activeSection === 'manifesto'
                      ? isDark ? 'text-yellow-500 bg-yellow-500/10' : 'text-yellow-600 bg-yellow-50'
                      : isDark ? 'text-white hover:bg-white/5' : 'text-gray-900 hover:bg-gray-50'
                  }`}
                >
                  {t('help.tab.manifesto')}
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
            {t('help.tab.developers_short')}
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
            {t('help.tab.resources')}
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
                  isDark ? 'bg-[#0D0D0D]/85' : 'bg-gray-50 shadow-xl'
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
            <div className={`p-6 rounded-xl ${isDark ? 'bg-[#0D0D0D]/85' : 'bg-gray-50 shadow-xl'}`}>
              <h2 className={`text-xl font-bold mb-4 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {t('help.history.heading')}
              </h2>

              <div className={`space-y-4 text-sm leading-relaxed ${isDark ? 'text-white/80' : 'text-gray-700'}`}>
                <p>
                  {t('help.history.intro')}
                </p>

                <h3 className={`text-lg font-semibold mt-6 mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {t('help.history.scavenger_hunt.heading')}
                </h3>
                <p>
                  {t('help.history.scavenger_hunt.body_before_link')}
                  <Link to="/help/manifesto" className={`underline ${isDark ? 'text-yellow-500 hover:text-yellow-400' : 'text-yellow-700 hover:text-yellow-600'}`}>{t('help.history.scavenger_hunt.link_text')}</Link>
                  {t('help.history.scavenger_hunt.body_after_link')}
                </p>

                <h3 className={`text-lg font-semibold mt-6 mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {t('help.history.community_built.heading')}
                </h3>
                <p>
                  {t('help.history.community_built.body')}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Manifesto Section */}
        {activeSection === 'manifesto' && (
          <div className="space-y-6">
            <div className={`p-6 rounded-xl ${isDark ? 'bg-[#0D0D0D]/85' : 'bg-gray-50 shadow-xl'}`}>
              <p className={`text-xs mb-4 ${isDark ? 'text-white/40' : 'text-gray-400'}`}>
                {t('help.manifesto.attribution_before_link')}
                <Link to="/help/history" className={`underline ${isDark ? 'text-yellow-500/60 hover:text-yellow-500' : 'text-yellow-700/60 hover:text-yellow-700'}`}>{t('help.manifesto.attribution_link_text')}</Link>
              </p>
              <h2 className={`text-xl font-bold mb-4 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {t('help.manifesto.heading')}
              </h2>

              <div className={`space-y-4 text-sm leading-relaxed ${isDark ? 'text-white/80' : 'text-gray-700'}`}>
                <p>
                  {t('help.manifesto.p1')}
                </p>

                <p>
                  {t('help.manifesto.p2')}
                </p>

                <p>
                  {t('help.manifesto.p3')}
                </p>

                <p>
                  {t('help.manifesto.p4')}
                </p>

                <p>
                  {t('help.manifesto.p5')}
                </p>

                <div className="pl-4 space-y-2">
                  <p>{t('help.manifesto.preamble.item1')}</p>
                  <p>{t('help.manifesto.preamble.item2')}</p>
                  <p>{t('help.manifesto.preamble.item3')}</p>
                </div>

                <h3 className={`text-lg font-semibold mt-6 mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {t('help.manifesto.propose.heading')}
                </h3>
                <p>
                  {t('help.manifesto.propose.a')}
                </p>
                <p>
                  {t('help.manifesto.propose.b')}
                </p>
                <p>
                  {t('help.manifesto.propose.general_function')}
                </p>

                <div className="space-y-3 pl-2">
                  <p><strong>i.</strong> {t('help.manifesto.proto.i')}</p>
                  <p className="pl-4">{t('help.manifesto.proto.i_a')}</p>
                  <p className="pl-4">{t('help.manifesto.proto.i_b')}</p>

                  <p><strong>ii.</strong> {t('help.manifesto.proto.ii')}</p>

                  <p><strong>iii.</strong> {t('help.manifesto.proto.iii')}</p>

                  <p><strong>iv.</strong> {t('help.manifesto.proto.iv')}</p>

                  <p><strong>v.</strong> {t('help.manifesto.proto.v')}</p>
                  <div className="pl-4 space-y-2">
                    <p><strong>i.</strong> {t('help.manifesto.proto.v_i')}</p>
                    <p className="pl-4">{t('help.manifesto.proto.v_i_a')}</p>
                    <p><strong>ii.</strong> {t('help.manifesto.proto.v_ii')}</p>
                    <p className="pl-4">{t('help.manifesto.proto.v_ii_a')}</p>
                    <p><strong>iii.</strong> {t('help.manifesto.proto.v_iii')}</p>
                    <p className="pl-4">{t('help.manifesto.proto.v_iii_a')}</p>
                  </div>

                  <p><strong>vi.</strong> {t('help.manifesto.proto.vi')}</p>
                  <p className="pl-4">{t('help.manifesto.proto.vi_a')}</p>
                  <p className="pl-4">{t('help.manifesto.proto.vi_b')}</p>

                  <p><strong>vii.</strong> {t('help.manifesto.proto.vii')}</p>

                  <p><strong>viii.</strong> {t('help.manifesto.proto.viii')}</p>

                  <p>{t('help.manifesto.proto.data_storage')}</p>
                </div>

                <p>
                  {t('help.manifesto.frontends_intro_a')}
                </p>
                <p>
                  {t('help.manifesto.frontends_intro_b')}
                </p>

                <h3 className={`text-lg font-semibold mt-6 mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {t('help.manifesto.frontends.heading')}
                </h3>
                <p>
                  {t('help.manifesto.frontends.p1')}
                </p>
                <p>
                  {t('help.manifesto.frontends.p2')}
                </p>
                <p>
                  <strong className={isDark ? 'text-white' : 'text-gray-900'}>{t('help.manifesto.frontends.p3_strong')}</strong>
                </p>

                <h3 className={`text-lg font-semibold mt-6 mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {t('help.manifesto.appendix.heading')}
                </h3>

                <p><strong>a.</strong> {t('help.manifesto.appendix.a')}</p>
                <p>
                  {t('help.manifesto.appendix.a_followup')}
                </p>

                <p className="mt-4"><strong>b.</strong> {t('help.manifesto.appendix.b')}</p>
                <p>
                  {t('help.manifesto.appendix.b_mc_i')}<br />
                  {t('help.manifesto.appendix.b_mc_ii')}<br />
                  {t('help.manifesto.appendix.b_mc_iii')}
                </p>
                <p>
                  {t('help.manifesto.appendix.b_caveat')}
                </p>
                <p>{t('help.manifesto.appendix.cost_calcs_intro')}</p>
                <p className="pl-4">
                  {t('help.manifesto.appendix.cost_i')}<br />
                  {t('help.manifesto.appendix.cost_ii')}<br />
                  {t('help.manifesto.appendix.cost_iii')}<br />
                  {t('help.manifesto.appendix.cost_iv')}
                </p>
                <p>
                  {t('help.manifesto.appendix.math_explanation')}
                </p>
                <p>{t('help.manifesto.appendix.recommended_intro')}</p>
                <ul className={`space-y-1 pl-2 ${isDark ? 'text-white/80' : 'text-gray-700'}`}>
                  <li>{t('help.manifesto.appendix.cost.username_1')}</li>
                  <li>{t('help.manifesto.appendix.cost.username_2')}</li>
                  <li>{t('help.manifesto.appendix.cost.username_3')}</li>
                  <li>{t('help.manifesto.appendix.cost.username_4')}</li>
                  <li>{t('help.manifesto.appendix.cost.username_5')}</li>
                  <li>{t('help.manifesto.appendix.cost.username_6')}</li>
                  <li>{t('help.manifesto.appendix.cost.username_7')}</li>
                  <li>{t('help.manifesto.appendix.cost.username_8')}</li>
                </ul>

                <ul className={`space-y-1 pl-2 mt-2 ${isDark ? 'text-white/80' : 'text-gray-700'}`}>
                  <li>{t('help.manifesto.appendix.cost.follow')}</li>
                  <li>{t('help.manifesto.appendix.cost.send_caw')}</li>
                  <li>{t('help.manifesto.appendix.cost.like')}</li>
                  <li>{t('help.manifesto.appendix.cost.recaw')}</li>
                </ul>

                <p className="mt-4"><strong>c.</strong> {t('help.manifesto.appendix.c')}</p>
                <p className="pl-4">
                  {t('help.manifesto.appendix.c_i')}<br />
                  {t('help.manifesto.appendix.c_ii')}
                </p>
                <p>
                  {t('help.manifesto.appendix.c_example')}
                </p>
                <p>
                  {t('help.manifesto.appendix.c_example_explanation')}
                </p>

                <div className={`mt-6 pt-4 border-t ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
                  <p className={`italic ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
                    {t('help.manifesto.signoff')}
                  </p>
                  <p className="mt-4">
                    {t('help.manifesto.ps')}
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
              {t('help.manifesto.view_on_github')}
              <HiExternalLink className="w-4 h-4" />
            </a>
          </div>
        )}

        {/* Getting Started Section */}
        {activeSection === 'gettingstarted' && (
          <div className="space-y-4">
            <div className={`p-5 rounded-xl ${isDark ? 'bg-[#0D0D0D]/85' : 'bg-gray-50 shadow-xl'}`}>
              <div className="flex items-start gap-4">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                  isDark ? 'bg-yellow-500/20 text-yellow-500' : 'bg-yellow-100 text-yellow-700'
                }`}>
                  1
                </div>
                <div>
                  <h3 className={`font-semibold mb-1 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    {t('help.getting_started.step1.heading')}
                  </h3>
                  <p className={`text-sm ${isDark ? 'text-white/70' : 'text-gray-600'}`}>
                    {t('help.getting_started.step1.body')}
                  </p>
                </div>
              </div>
            </div>

            <div className={`p-5 rounded-xl ${isDark ? 'bg-[#0D0D0D]/85' : 'bg-gray-50 shadow-xl'}`}>
              <div className="flex items-start gap-4">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                  isDark ? 'bg-yellow-500/20 text-yellow-500' : 'bg-yellow-100 text-yellow-700'
                }`}>
                  2
                </div>
                <div>
                  <h3 className={`font-semibold mb-1 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    {t('help.getting_started.step2.heading')}
                  </h3>
                  <p className={`text-sm ${isDark ? 'text-white/70' : 'text-gray-600'}`}>
                    {t('help.getting_started.step2.body')}
                  </p>
                </div>
              </div>
            </div>

            <div className={`p-5 rounded-xl ${isDark ? 'bg-[#0D0D0D]/85' : 'bg-gray-50 shadow-xl'}`}>
              <div className="flex items-start gap-4">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                  isDark ? 'bg-yellow-500/20 text-yellow-500' : 'bg-yellow-100 text-yellow-700'
                }`}>
                  3
                </div>
                <div>
                  <h3 className={`font-semibold mb-1 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    {t('help.getting_started.step3.heading')}
                  </h3>
                  <p className={`text-sm ${isDark ? 'text-white/70' : 'text-gray-600'}`}>
                    {t('help.getting_started.step3.body')}
                  </p>
                </div>
              </div>
            </div>

            <div className={`p-5 rounded-xl ${isDark ? 'bg-[#0D0D0D]/85' : 'bg-gray-50 shadow-xl'}`}>
              <div className="flex items-start gap-4">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                  isDark ? 'bg-yellow-500/20 text-yellow-500' : 'bg-yellow-100 text-yellow-700'
                }`}>
                  4
                </div>
                <div>
                  <h3 className={`font-semibold mb-1 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    {t('help.getting_started.step4.heading')}
                  </h3>
                  <p className={`text-sm ${isDark ? 'text-white/70' : 'text-gray-600'}`}>
                    {t('help.getting_started.step4.body')}
                  </p>
                </div>
              </div>
            </div>

            <div className={`mt-6 p-4 rounded-lg border ${
              isDark ? 'border-white/10 bg-[#0D0D0D]/85' : 'border-gray-200 bg-gray-50 shadow-xl'
            }`}>
              <h4 className={`font-semibold mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {t('help.getting_started.spent.heading')}
              </h4>
              <ul className={`text-sm space-y-2 ${isDark ? 'text-white/70' : 'text-gray-600'}`}>
                <li><strong>{t('help.getting_started.spent.post_label')}</strong> {t('help.getting_started.spent.post_value')}</li>
                <li><strong>{t('help.getting_started.spent.like_label')}</strong> {t('help.getting_started.spent.like_value')}</li>
                <li><strong>{t('help.getting_started.spent.recaw_label')}</strong> {t('help.getting_started.spent.recaw_value')}</li>
                <li><strong>{t('help.getting_started.spent.follow_label')}</strong> {t('help.getting_started.spent.follow_value')}</li>
              </ul>
            </div>
          </div>
        )}

        {/* Developers Section */}
        {activeSection === 'developers' && (
          <div className="space-y-6">
            {/* Architecture Overview */}
            <div className={`p-6 rounded-xl ${isDark ? 'bg-[#0D0D0D]/85' : 'bg-gray-50 shadow-xl'}`}>
              <h2 className={`text-xl font-bold mb-4 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {t('help.developers.architecture.heading')}
              </h2>

              <div className={`space-y-4 text-sm leading-relaxed ${isDark ? 'text-white/80' : 'text-gray-700'}`}>
                <p>
                  {t('help.developers.architecture.intro_before_validators')}<strong>{t('help.developers.architecture.validators_strong')}</strong>{t('help.developers.architecture.intro_between')}<strong>{t('help.developers.architecture.frontends_strong')}</strong>{t('help.developers.architecture.intro_after')}
                </p>

                <h3 className={`text-lg font-semibold mt-6 mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {t('help.developers.validators.heading')}
                </h3>
                <p>
                  {t('help.developers.validators.p1')}
                </p>
                <p className="mt-2">
                  {t('help.developers.validators.p2')}
                </p>

                <h3 className={`text-lg font-semibold mt-6 mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {t('help.developers.frontends_role.heading')}
                </h3>
                <p>
                  {t('help.developers.frontends_role.p1')}
                </p>
                <p className="mt-2">
                  {t('help.developers.frontends_role.p2')}
                </p>

                <h3 className={`text-lg font-semibold mt-6 mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {t('help.developers.separation.heading')}
                </h3>
                <p>
                  {t('help.developers.separation.intro')}
                </p>
                <ul className={`list-disc list-inside space-y-2 mt-2 ${isDark ? 'text-white/80' : 'text-gray-700'}`}>
                  <li><strong>{t('help.developers.separation.frontend_only_label')}</strong> {t('help.developers.separation.frontend_only_body')}</li>
                  <li><strong>{t('help.developers.separation.validator_only_label')}</strong> {t('help.developers.separation.validator_only_body')}</li>
                  <li><strong>{t('help.developers.separation.both_label')}</strong> {t('help.developers.separation.both_body')}</li>
                  <li><strong>{t('help.developers.separation.isolated_label')}</strong> {t('help.developers.separation.isolated_body')}</li>
                </ul>
                <p className="mt-2">
                  {t('help.developers.separation.outro')}
                </p>
              </div>
            </div>

            {/* Frontend Hosting */}
            <div className={`p-6 rounded-xl ${isDark ? 'bg-[#0D0D0D]/85' : 'bg-gray-50 shadow-xl'}`}>
              <h2 className={`text-xl font-bold mb-4 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {t('help.developers.host_fe.heading')}
              </h2>

              <div className={`space-y-4 text-sm leading-relaxed ${isDark ? 'text-white/80' : 'text-gray-700'}`}>
                <p>
                  {t('help.developers.host_fe.intro')}
                </p>

                <h3 className={`text-lg font-semibold mt-6 mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {t('help.developers.host_fe.building.heading')}
                </h3>

                <ol className={`list-decimal list-inside space-y-3 ${isDark ? 'text-white/80' : 'text-gray-700'}`}>
                  <li>
                    <strong>{t('help.developers.host_fe.building.step1_label')}</strong>
                    <div className={`mt-2 p-3 rounded-lg font-mono text-xs ${isDark ? 'bg-black/50' : 'bg-gray-100'}`}>
                      git clone https://github.com/GilgameshCaw/Caw
                    </div>
                  </li>
                  <li>
                    <strong>{t('help.developers.host_fe.building.step2_label')}</strong>
                    <div className={`mt-2 p-3 rounded-lg font-mono text-xs ${isDark ? 'bg-black/50' : 'bg-gray-100'}`}>
                      cd client/src/services/FrontEnd
                    </div>
                  </li>
                  <li>
                    <strong>{t('help.developers.host_fe.building.step3_label')}</strong>
                    <div className={`mt-2 p-3 rounded-lg font-mono text-xs ${isDark ? 'bg-black/50' : 'bg-gray-100'}`}>
                      yarn install
                    </div>
                  </li>
                  <li>
                    <strong>{t('help.developers.host_fe.building.step4_label')}</strong>
                    <p className="mt-1">{t('help.developers.host_fe.building.step4_body_before_code')}<code className={`px-1 rounded ${isDark ? 'bg-black/50' : 'bg-gray-200'}`}>.env</code>{t('help.developers.host_fe.building.step4_body_after_code')}</p>
                  </li>
                  <li>
                    <strong>{t('help.developers.host_fe.building.step5_label')}</strong>
                    <div className={`mt-2 p-3 rounded-lg font-mono text-xs ${isDark ? 'bg-black/50' : 'bg-gray-100'}`}>
                      yarn build
                    </div>
                  </li>
                </ol>

                <h3 className={`text-lg font-semibold mt-6 mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {t('help.developers.host_fe.deploy.heading')}
                </h3>
                <p>
                  {t('help.developers.host_fe.deploy.intro_before_code')}<code className={`px-1 rounded ${isDark ? 'bg-black/50' : 'bg-gray-200'}`}>dist/</code>{t('help.developers.host_fe.deploy.intro_after_code')}
                </p>
                <ul className={`list-disc list-inside space-y-2 mt-2 ${isDark ? 'text-white/80' : 'text-gray-700'}`}>
                  <li><strong>{t('help.developers.host_fe.deploy.vercel_label')}</strong> {t('help.developers.host_fe.deploy.vercel_body')}</li>
                  <li><strong>{t('help.developers.host_fe.deploy.netlify_label')}</strong> {t('help.developers.host_fe.deploy.netlify_body')}</li>
                  <li><strong>{t('help.developers.host_fe.deploy.cloudflare_label')}</strong> {t('help.developers.host_fe.deploy.cloudflare_body')}</li>
                  <li><strong>{t('help.developers.host_fe.deploy.github_label')}</strong> {t('help.developers.host_fe.deploy.github_body')}</li>
                  <li><strong>{t('help.developers.host_fe.deploy.ipfs_label')}</strong> {t('help.developers.host_fe.deploy.ipfs_body')}</li>
                </ul>

                <h3 className={`text-lg font-semibold mt-6 mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {t('help.developers.host_fe.moderation.heading')}
                </h3>
                <p>
                  {t('help.developers.host_fe.moderation.body')}
                </p>
              </div>
            </div>

            {/* Validator Hosting */}
            <div className={`p-6 rounded-xl ${isDark ? 'bg-[#0D0D0D]/85' : 'bg-gray-50 shadow-xl'}`}>
              <h2 className={`text-xl font-bold mb-4 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {t('help.developers.run_validator.heading')}
              </h2>

              <div className={`space-y-4 text-sm leading-relaxed ${isDark ? 'text-white/80' : 'text-gray-700'}`}>
                <p>
                  {t('help.developers.run_validator.intro')}
                </p>

                <h3 className={`text-lg font-semibold mt-6 mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {t('help.developers.run_validator.prereq.heading')}
                </h3>
                <ul className={`list-disc list-inside space-y-2 ${isDark ? 'text-white/80' : 'text-gray-700'}`}>
                  <li>{t('help.developers.run_validator.prereq.item1')}</li>
                  <li>{t('help.developers.run_validator.prereq.item2')}</li>
                  <li>{t('help.developers.run_validator.prereq.item3')}</li>
                  <li>{t('help.developers.run_validator.prereq.item4')}</li>
                </ul>

                <h3 className={`text-lg font-semibold mt-6 mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {t('help.developers.run_validator.quick.heading')}
                </h3>
                <p>
                  {t('help.developers.run_validator.quick.intro')}
                </p>
                <div className={`mt-2 p-3 rounded-lg font-mono text-xs ${isDark ? 'bg-black/50' : 'bg-gray-100'}`}>
                  curl -sSL https://raw.githubusercontent.com/GilgameshCaw/Caw/master/install.sh | bash
                </div>
                <p className="mt-2">
                  {t('help.developers.run_validator.quick.installer_intro')}
                </p>
                <ul className={`list-disc list-inside space-y-1 mt-2 ${isDark ? 'text-white/80' : 'text-gray-700'}`}>
                  <li>{t('help.developers.run_validator.quick.installer_item1')}</li>
                  <li>{t('help.developers.run_validator.quick.installer_item2')}</li>
                  <li>{t('help.developers.run_validator.quick.installer_item3')}</li>
                  <li>{t('help.developers.run_validator.quick.installer_item4')}</li>
                  <li>{t('help.developers.run_validator.quick.installer_item5')}</li>
                </ul>

                <h3 className={`text-lg font-semibold mt-6 mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {t('help.developers.run_validator.manual.heading')}
                </h3>
                <p>
                  {t('help.developers.run_validator.manual.intro')}
                </p>
                <ol className={`list-decimal list-inside space-y-2 mt-2 ${isDark ? 'text-white/80' : 'text-gray-700'}`}>
                  <li>{t('help.developers.run_validator.manual.item1')}</li>
                  <li>{t('help.developers.run_validator.manual.item2')}</li>
                  <li>{t('help.developers.run_validator.manual.item3_before_code')}<code className={`px-1 rounded ${isDark ? 'bg-black/50' : 'bg-gray-200'}`}>.env</code>{t('help.developers.run_validator.manual.item3_after_code')}</li>
                  <li>{t('help.developers.run_validator.manual.item4_before_code')}<code className={`px-1 rounded ${isDark ? 'bg-black/50' : 'bg-gray-200'}`}>npm run prisma:push</code></li>
                  <li>{t('help.developers.run_validator.manual.item5_before_code')}<code className={`px-1 rounded ${isDark ? 'bg-black/50' : 'bg-gray-200'}`}>npm run dev</code></li>
                </ol>

                <h3 className={`text-lg font-semibold mt-6 mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {t('help.developers.run_validator.economics.heading')}
                </h3>
                <p>
                  {t('help.developers.run_validator.economics.body')}
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
              {t('help.developers.view_source')}
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
                  {t('help.resources.testnet.heading')}
                </h2>
                <div className="space-y-2">
                  <Link
                    to="/faucet"
                    className={`flex items-start gap-4 p-4 rounded-xl transition-colors ${
                      isDark
                        ? 'bg-yellow-500/10 hover:bg-yellow-500/20 border border-yellow-500/20'
                        : 'bg-yellow-50 hover:bg-yellow-100 border border-yellow-200 shadow-xl'
                    }`}
                  >
                    <div className={`p-2 rounded-lg ${
                      isDark ? 'bg-yellow-500/20 text-yellow-500' : 'bg-yellow-200 text-yellow-700'
                    }`}>
                      <HiBeaker className="w-6 h-6" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                        {t('help.resources.testnet.faucet_title')}
                      </h3>
                      <p className={`text-sm ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
                        {t('help.resources.testnet.faucet_description')}
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
                {t('help.resources.official.heading')}
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
                {t('help.resources.contracts.heading')}
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
                {t('help.resources.network.heading')}
              </h2>

              <div className={`p-4 rounded-xl ${isDark ? 'bg-[#0D0D0D]/85' : 'bg-gray-50 shadow-xl'}`}>
                <div className="space-y-4">
                  <div>
                    <h4 className={`text-sm font-medium mb-1 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                      {t('help.resources.network.caw_token.title')}
                    </h4>
                    <p className={`text-sm ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
                      {t('help.resources.network.caw_token.description')}
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
                      {t('help.resources.network.username_nfts.title')}
                    </h4>
                    <p className={`text-sm ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
                      {t('help.resources.network.username_nfts.description')}
                    </p>
                  </div>

                  <div className={`border-t pt-4 ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
                    <h4 className={`text-sm font-medium mb-1 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                      {t('help.resources.network.social.title')}
                    </h4>
                    <p className={`text-sm ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
                      {t('help.resources.network.social.description')}
                    </p>
                  </div>

                  <div className={`border-t pt-4 ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
                    <h4 className={`text-sm font-medium mb-1 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                      {t('help.resources.network.archive.title')}
                    </h4>
                    <p className={`text-sm ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
                      {t('help.resources.network.archive.description')}
                    </p>
                  </div>
                </div>
              </div>
            </section>

            {/* Disclaimer */}
            <div className={`p-4 rounded-lg text-sm ${
              isDark ? 'bg-[#0D0D0D]/85 text-white/50' : 'bg-gray-50 text-gray-500'
            }`}>
              <p>
                {t('help.resources.disclaimer')}
              </p>
            </div>
          </div>
        )}

        {/* Community Links */}
        <div className={`mt-8 pt-6 border-t ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
          <h3 className={`text-sm font-semibold mb-3 ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
            {t('help.community.heading')}
          </h3>
          <div className="grid grid-cols-2 gap-3">
            <a
              href="https://github.com/cawdevelopment"
              target="_blank"
              rel="noopener noreferrer"
              className={`flex items-center gap-2 p-3 rounded-lg transition-colors ${
                isDark ? 'bg-[#0D0D0D]/85 hover:bg-[#1A1A1A]/85 text-white' : 'bg-gray-50 hover:bg-gray-100 text-gray-900 shadow-xl'
              }`}
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
              </svg>
              <span className="text-sm">{t('help.community.github')}</span>
            </a>
            <a
              href="https://t.me/cawbuilders"
              target="_blank"
              rel="noopener noreferrer"
              className={`flex items-center gap-2 p-3 rounded-lg transition-colors ${
                isDark ? 'bg-[#0D0D0D]/85 hover:bg-[#1A1A1A]/85 text-white' : 'bg-gray-50 hover:bg-gray-100 text-gray-900 shadow-xl'
              }`}
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>
              </svg>
              <span className="text-sm">{t('help.community.telegram')}</span>
            </a>
          </div>
        </div>
      </div>
  )
}

export default HelpPage
