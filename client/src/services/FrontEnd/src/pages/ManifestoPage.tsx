import { useEffect, useState } from 'react'
import { useTheme } from '~/hooks/useTheme'
import LandingHeader from '~/components/landing/LandingHeader'
import LandingFooter from '~/components/landing/LandingFooter'
import ParticleSystemManifesto from '~/components/landing/ParticleSystemManifesto'

// Image assets ported from caw-landing/public. Imported (not referenced by
// public path) so Vite hashes + fingerprints them like the other landing
// modules (see Features/FreeSpeech).
import manifestoImg from '~/assets/landing/manifesto.png'
import decentralizationImg from '~/assets/landing/decentralization.png'
import dreamsImg from '~/assets/landing/dreams.png'

// The CAW Manifesto — a bare route at /manifesto (NOT /help/manifesto, which
// stays the in-app Help tab). Ported from caw-landing's Manifesto page; the
// caw-landing chrome (Navigation/Footer) is dropped for a minimal shell that
// matches WhitepaperPage, and the caw-landing theme tokens (bg-background,
// text-muted-foreground) are swapped for the app's theme-aware classes.
const ManifestoPage: React.FC = () => {
  const { isDark } = useTheme()

  // CAW-yellow particle tint — matches the welcome landing modules
  // (see FreeSpeech.tsx). Default is white; without this the particle
  // overlays read cold against the yellow-accented page.
  const tint = '#F9C337'

  // Theme-aware class fragments — keeps the JSX below readable.
  const muted = isDark ? 'text-white/60' : 'text-black/60'
  const strong = isDark ? 'text-white' : 'text-black'
  const accentBorder = isDark ? 'border-white/20' : 'border-black/15'

  // Hero image + particle-overlay readiness gate. Mirrors the pattern used
  // by FreeSpeech: fade the PNG + particle layer in together once both are
  // ready, with a 2s safety timeout so a particle init failure never leaves
  // the image hidden.
  const [imageLoaded, setImageLoaded] = useState(false)
  const [particlesReady, setParticlesReady] = useState(false)
  const [showBoth, setShowBoth] = useState(false)
  const [showContent, setShowContent] = useState(false)

  // Decentralization image gate.
  const [decImageLoaded, setDecImageLoaded] = useState(false)
  const [decParticlesReady, setDecParticlesReady] = useState(false)
  const [showDecBoth, setShowDecBoth] = useState(false)

  // Dreams image gate.
  const [dreamsImageLoaded, setDreamsImageLoaded] = useState(false)
  const [dreamsParticlesReady, setDreamsParticlesReady] = useState(false)
  const [showDreamsBoth, setShowDreamsBoth] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setShowContent(true), 100)
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (imageLoaded && particlesReady) setShowBoth(true)
  }, [imageLoaded, particlesReady])
  useEffect(() => {
    const timer = setTimeout(() => {
      if (imageLoaded && !showBoth) {
        setParticlesReady(true)
        setShowBoth(true)
      }
    }, 2000)
    return () => clearTimeout(timer)
  }, [imageLoaded, showBoth])

  useEffect(() => {
    if (decImageLoaded && decParticlesReady) setShowDecBoth(true)
  }, [decImageLoaded, decParticlesReady])
  useEffect(() => {
    const timer = setTimeout(() => {
      if (decImageLoaded && !showDecBoth) {
        setDecParticlesReady(true)
        setShowDecBoth(true)
      }
    }, 2000)
    return () => clearTimeout(timer)
  }, [decImageLoaded, showDecBoth])

  useEffect(() => {
    if (dreamsImageLoaded && dreamsParticlesReady) setShowDreamsBoth(true)
  }, [dreamsImageLoaded, dreamsParticlesReady])
  useEffect(() => {
    const timer = setTimeout(() => {
      if (dreamsImageLoaded && !showDreamsBoth) {
        setDreamsParticlesReady(true)
        setShowDreamsBoth(true)
      }
    }, 2000)
    return () => clearTimeout(timer)
  }, [dreamsImageLoaded, showDreamsBoth])

  return (
    <div className={`relative min-h-screen flex flex-col ${isDark ? 'bg-black text-white' : 'bg-white text-black'}`}>
      {/* Shared landing header — same logo lockup + resource links +
          language picker as the welcome page (CaptiveSplash). No bar,
          no border line; the host div is `relative` so the header's
          absolutely-positioned clusters anchor to it. */}
      <LandingHeader />

      {/* pt-20 clears the absolutely-positioned header clusters. */}
      <main className="flex-grow pt-20">
        {/* Hero */}
        <section className="relative min-h-[70vh] flex items-center justify-center px-6 overflow-hidden">
          <div className="w-full max-w-5xl mx-auto relative z-10">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-center">
              {/* Image with noise particle overlay */}
              <div className="flex justify-center relative z-10 w-full mt-8 lg:mt-0">
                <div className="relative w-full max-w-[500px] hero-vignette">
                  <img
                    src={manifestoImg}
                    alt="Manifesto"
                    className={`w-full h-auto relative z-0 transition-opacity duration-300 ${
                      showBoth ? 'opacity-100' : 'opacity-0'
                    }`}
                    loading="eager"
                    fetchPriority="high"
                    onLoad={() => setImageLoaded(true)}
                    onError={() => setImageLoaded(true)}
                  />
                  <div
                    className={`absolute inset-0 pointer-events-none z-[1] overflow-hidden transition-opacity duration-300 ${
                      showBoth ? 'opacity-100' : 'opacity-0'
                    }`}
                  >
                    <ParticleSystemManifesto
                      imageUrl={manifestoImg}
                      particleDensity={256}
                      tint={tint}
                      minIntensity={0.2}
                      className="w-full h-full"
                      onReady={() => setParticlesReady(true)}
                    />
                  </div>
                </div>
              </div>

              {/* Title */}
              <div
                className={`space-y-4 md:space-y-6 text-center lg:text-left relative z-10 transition-all duration-500 ${
                  showContent ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
                }`}
              >
                <h1 className="text-4xl md:text-5xl lg:text-6xl font-semibold leading-tight">
                  Teh <span className="text-yellow-400">CAW</span> Manifesto
                </h1>
                <p
                  className={`text-base md:text-lg max-w-2xl mx-auto lg:mx-0 transition-all duration-500 delay-200 ${muted} ${
                    showContent ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
                  }`}
                >
                  For a long time, the community worked to decode a hidden manifesto —
                  the fundamental principle behind the vision CAW was meant to follow:
                  a path of decentralization, unity, and freedom of expression.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Full Manifesto Content */}
        <section className="relative py-16 md:py-20 px-6 overflow-hidden">
          <div className="max-w-4xl mx-auto relative z-10 space-y-12 md:space-y-16">
            {/* Main Title */}
            <div
              className={`text-center space-y-6 transition-all duration-500 ${
                showContent ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
              }`}
            >
              <h2 className="text-2xl md:text-3xl lg:text-4xl font-semibold">
                A Manifesto on a Decentralized<br />Social Clearing House
              </h2>
              <p className={`text-xl ${muted}`}>
                <span className="text-yellow-400">(AKA) CAW</span>
              </p>
            </div>

            {/* Decentralization */}
            <div
              className={`space-y-6 max-w-[600px] mx-auto transition-all duration-500 delay-300 ${
                showContent ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
              }`}
            >
              <h3 className="text-center text-2xl md:text-3xl font-semibold">
                The Concept of <span className="text-yellow-400">Decentralization</span>
              </h3>
              <div className={`text-center space-y-4 text-base md:text-lg leading-relaxed ${muted}`}>
                <p>
                  The concept of decentralization has been lost to some of us over time,
                  those who forgot why Bitcoin was created, the issues blockchain and
                  cryptocurrency is meant to solve.
                </p>
                <p>
                  To be decentralized means there is no single person, entity, nor group
                  which has ultimate control nor benefit over a system.
                </p>
                <p>
                  In a decentralized system, there is not one man who via desire or
                  persuasion could cripple the system in any meaningful way.
                </p>
                <p>
                  This means from both a technical standpoint (i.e, a developer who can
                  stop trading, or disable the protocol through the use of smart contracts)
                  and a financial one (e.g, an entity who has n+1 (infinite) tokens, and
                  could dump them if they so wished, but decides not to.)
                </p>
                <p>
                  That is not to say that a proper decentralized system is without whales
                  nor its own cornerstones. There are always those that may have a greater
                  affect upon a network, or 'matter' through entropy or their own hard work.
                </p>
              </div>

              {/* Decentralization image */}
              <div className="relative pt-6 md:pt-10 pb-0 px-6 flex justify-center mt-4">
                <div className="relative w-full max-w-[500px] md:max-w-xl mx-auto hero-vignette z-10">
                  <img
                    src={decentralizationImg}
                    alt="Decentralization"
                    className={`w-full h-auto relative z-0 transition-opacity duration-300 ${
                      showDecBoth || decImageLoaded ? 'opacity-100' : 'opacity-0'
                    }`}
                    loading="eager"
                    fetchPriority="high"
                    onLoad={() => {
                      setDecImageLoaded(true)
                      setTimeout(() => setShowDecBoth(true), 100)
                    }}
                    onError={() => {
                      setDecImageLoaded(true)
                      setShowDecBoth(true)
                    }}
                  />
                  <div
                    className={`absolute inset-0 pointer-events-none z-[1] overflow-hidden transition-opacity duration-300 ${
                      showDecBoth ? 'opacity-100' : 'opacity-0'
                    }`}
                  >
                    <ParticleSystemManifesto
                      imageUrl={decentralizationImg}
                      particleDensity={256}
                      tint={tint}
                      minIntensity={0.2}
                      className="w-full h-full"
                      onReady={() => setDecParticlesReady(true)}
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* CAW Origins */}
            <div
              className={`space-y-6 transition-all duration-500 delay-500 ${
                showContent ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
              }`}
            >
              <h3 className="text-2xl md:text-3xl font-semibold">
                The <span className="text-yellow-400">Origin</span> of CAW
              </h3>
              <div className={`space-y-4 text-base md:text-lg leading-relaxed ${muted}`}>
                <p>
                  CAW began as nothing, there was no developer, no information, no medium
                  of communication. Simply. a contract.
                </p>
                <p>
                  Freedom given to the people to discover CAW's meaning amongst themselves.
                  This has gone well, and so we would like to present our specification for
                  the second phase of CAW. But before we do, some things must be said and
                  taken note of:
                </p>
              </div>

              <div className="space-y-6 mt-8 border-l-2 border-yellow-400/40 pl-6">
                <div className="space-y-2">
                  <h4 className="text-xl font-semibold">1. Specification Only</h4>
                  <p className={muted}>
                    This is a only a specification. It is up to the cawmmunity to write and
                    deploy the protocol.
                  </p>
                </div>
                <div className="space-y-2">
                  <h4 className="text-xl font-semibold">2. Peer Review Required</h4>
                  <p className={muted}>
                    It is strongly recommended that a peer group is formed to develop and
                    review smart contracts. as there is no leader in this process, all types
                    will attempt to claim ownership of the process. there will those everso
                    helpful who claim to be able to 'do it all' but will write the perfect
                    code with the perfect backdoor. Only a cawmmunity reviewed and accepted
                    contract on a public github will be acceptable
                  </p>
                </div>
                <div className="space-y-2">
                  <h4 className="text-xl font-semibold">3. Renunciation After Deployment</h4>
                  <p className={muted}>
                    After deployment, the deployer must renounce any keys they have to the
                    contracts. There will be no multi-sig, no upgradeable proxyies. It will
                    not matter who deployed because they will be equal with all with no
                    specfic benefit nor advantage. Just get the contract right.
                  </p>
                </div>
              </div>
            </div>

            {/* Protocol Proposal */}
            <div
              className={`space-y-2 transition-all duration-500 delay-700 ${
                showContent ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
              }`}
            >
              <h3 className="text-2xl md:text-3xl font-semibold">
                We <span className="text-yellow-400">Propose</span>
              </h3>
              <div className={`space-y-4 text-base md:text-lg leading-relaxed ${muted}`}>
                <p>
                  a. A protocol made up of many on-chain smart contracts for sending messages
                  publically or p2p with a max character limit of 420.
                </p>
                <p>
                  b. A specification for the frontends, of which many will be made, to
                  interact with this protocol.
                </p>
              </div>
            </div>

            {/* Protocol Functions */}
            <div
              className={`space-y-8 transition-all duration-500 delay-[800ms] ${
                showContent ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
              }`}
            >
              <h3 className="text-2xl md:text-3xl font-semibold">
                Protocol <span className="text-yellow-400">Functions</span>
              </h3>

              <div className="space-y-8">
                <div className="space-y-3">
                  <h4 className="text-xl font-semibold">i. Username NFTs</h4>
                  <div className={`space-y-3 pl-4 border-l-2 ${accentBorder} ${muted}`}>
                    <p>
                      Burn CAW through a contract to mint an NFT. This burned caw will go to
                      0x0. The NFT will be your username.
                    </p>
                    <ul className="list-disc list-inside space-y-2 ml-4">
                      <li>The fewer characters in your username, the higher the cost.</li>
                      <li>
                        Every username is unique, and may use a-z and 0-9, without the use of
                        special characters (emojis, etc..,) or capital letters.
                      </li>
                    </ul>
                  </div>
                </div>

                <div className="space-y-3">
                  <h4 className="text-xl font-semibold">ii. NFT-Based Identity</h4>
                  <p className={`pl-4 border-l-2 ${accentBorder} ${muted}`}>
                    All user activity, social and financial flows through their NFT username.
                    Whoever owns this NFT has access to that account. This includes, but is not
                    limited to, their CAW balance and access to that user's direct messages
                    (DMs).
                  </p>
                </div>

                <div className="space-y-3">
                  <h4 className="text-xl font-semibold">iii. On-Chain Storage</h4>
                  <p className={`pl-4 border-l-2 ${accentBorder} ${muted}`}>
                    Ownership and management of the NFTs will be completely on-chain. For
                    instance, the registration of the username 'cawdev' will be stored directly
                    on-chain, along with all of the data associated.
                  </p>
                </div>

                <div className="space-y-3">
                  <h4 className="text-xl font-semibold">iv. NFT Wallet Access</h4>
                  <p className={`pl-4 border-l-2 ${accentBorder} ${muted}`}>
                    Holding the NFT (note holding, not staking), allows the user to deposit or
                    withdraw CAW into a contract wallet. The ownership of the NFT will serve as
                    the key to this wallet. For users using multiple NFTs they may specify which
                    by a unique number associated.
                  </p>
                </div>

                <div className="space-y-4">
                  <h4 className="text-xl font-semibold">v. CAW Spending Mechanisms</h4>
                  <div className={`space-y-4 pl-4 border-l-2 ${accentBorder} ${muted}`}>
                    <div>
                      <p className={`font-semibold mb-2 ${strong}`}>i. Making a CAW (Akin to tweeting)</p>
                      <p className="ml-4">
                        This cost will be taken in CAW, and then distributed proportionally to
                        all other stakers.
                      </p>
                    </div>
                    <div>
                      <p className={`font-semibold mb-2 ${strong}`}>ii. Liking someone else's CAW</p>
                      <p className="ml-4">
                        This is closer to tipping. The CAW will be taken and directly sent to
                        the OP (orginal poster's) wallet.
                      </p>
                    </div>
                    <div>
                      <p className={`font-semibold mb-2 ${strong}`}>iii. ReCAWing (akin to a retweet)</p>
                      <p className="ml-4">
                        The cost of which will be taken in CAW and sent to OP's wallet.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <h4 className="text-xl font-semibold">vi. Gasless Transactions</h4>
                  <p className={`pl-4 border-l-2 ${accentBorder} ${muted}`}>
                    For receiving the CAW we envision a mostly gasless contract, in which
                    signatures may push CAW balance between users and the application in a
                    contract. The only thing a user should be spending gas on is:
                  </p>
                  <ul className={`list-disc list-inside space-y-1 ml-8 ${muted}`}>
                    <li>The minting of an NFT.</li>
                    <li>Depositing or withdrawing CAW.</li>
                  </ul>
                </div>

                <div className="space-y-3">
                  <h4 className="text-xl font-semibold">vii. Direct Messages</h4>
                  <p className={`pl-4 border-l-2 ${accentBorder} ${muted}`}>
                    DM's should be 'free' and executed via a trustless handshake between two
                    accounts to enable secure peer-to-peer messaging. Group chats would bring on
                    unneeded complexity, and are not recommended at this point.
                  </p>
                </div>

                <div className="space-y-3">
                  <h4 className="text-xl font-semibold">viii. Permanent Data Storage</h4>
                  <div className={`pl-4 border-l-2 ${accentBorder} space-y-2 ${muted}`}>
                    <p>
                      All data will be stored permanently. Due to limitations of the Ethereum
                      network, Arweave or similar blockchains may be preferred. The CAW liquidty
                      may migrate at somepoint to the QOMQQL1, but that will be addressed once
                      the technical merits reveal itself and the move is obvious.
                    </p>
                    <p>
                      Data storage must be completely trustless, and permanent. The importance
                      of being both censorship resistant and self-policing for the betterment of
                      a protocol cannot be overstated. CAW is meant only to give you the raw tool
                      kit to build your own online society.
                    </p>
                    <p>
                      Because of this, there is a distinct gap between the protocol itself, and
                      the frontends.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Protocol vs Frontend */}
            <div
              className={`space-y-6 transition-all duration-500 delay-[900ms] ${
                showContent ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
              }`}
            >
              <h3 className="text-2xl md:text-3xl font-semibold">
                Protocol vs <span className="text-yellow-400">Frontend</span>
              </h3>
              <div className={`space-y-4 text-base md:text-lg leading-relaxed ${muted}`}>
                <p>
                  At the base level, CAW's contracts for trustless data storage and
                  communication, anything can be posted. We are not naive, and we understand
                  what may be posted. As a result of this, it is up to the frontends to limit
                  content that might obfuscate the reason for CAW's creation.
                </p>
                <p>
                  That being said, at the level of a protocol no username or message will be
                  blocked or quarantined. Due to the nature of renounced ownership of smart
                  contracts, there will be nobody who can limit such content. (perhaps now you
                  see why renouceing the contract with no multi-sig or upgrades is important.)
                </p>
              </div>
            </div>

            {/* Frontends */}
            <div
              className={`space-y-6 transition-all duration-500 delay-1000 ${
                showContent ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
              }`}
            >
              <h3 className="text-2xl md:text-3xl font-semibold">
                <span className="text-yellow-400">Frontends</span>
              </h3>
              <div className={`space-y-4 text-base md:text-lg leading-relaxed ${muted}`}>
                <p>
                  Now onto the frontends. Anybody is free to make or host their own frontend
                  which will show whatever they woud like (or don't). we expect there will be
                  many along with a goal of a mobile app and browser extension that serves as
                  cawing/wallet and instant messager platform that executes the sigs fast and
                  invisible to give a smoother messaging experience (signing a metamask
                  everytime can be tiresome)
                </p>
                <p>
                  We would recommend that the community makes an alpha frontend, that is more
                  or less 'neutral'. It may filter overt hate/violence, along with hard-illegal
                  activity, remember we need to win the world first. Others may have a better
                  idea of what should be shown, and their perogative should be to create and
                  host their own frontend.
                </p>
                <p className={`font-semibold ${strong}`}>
                  The point being, CAW is like Twitter. Except it is bound by no laws, and no
                  central content moderation. However, the frontends may choose to moderate the
                  content however they like, or must to fit whatever legal guidelines they need
                  to fit.
                </p>
                <p>
                  So even if one frontend blocks you, you cannot be policed, and are still free
                  to use the protocol itself.
                </p>
              </div>
            </div>

            {/* Appendix */}
            <div
              className={`space-y-10 transition-all duration-500 delay-[1100ms] ${
                showContent ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
              }`}
            >
              <h3 className="text-2xl md:text-3xl font-semibold">
                <span className="text-yellow-400">Appendix</span>
              </h3>

              {/* a. Marketplace */}
              <div className="space-y-4">
                <h4 className="text-xl font-semibold">a. NFT Username Marketplace</h4>
                <div className={`space-y-3 pl-4 border-l-2 ${accentBorder} ${muted}`}>
                  <p>
                    It is fairly obvious individuals will begin buying and selling the NFT
                    usernames. It would be wise of a community member to create a trustless and
                    feeless marketplace for such trades, similar to Crypto Punk feeless trades
                  </p>
                  <p>
                    That being said we are pretty aware that as CAW grows to scale, many will
                    still use FEE marketplaces such as opensea and looks. This means that the
                    deployer of the contract that mints NFTS will have the technical ability to
                    set themselves fee's from opensea.
                  </p>
                  <p>
                    We do not think this is a good thing, and ask the cammunity to self
                    police/renounce in order to make sure that trading fees are not set and sent
                    to a private wallet. If it helps, this will imply liabilty for the content
                    posted if your wallet is recieving trading fees
                  </p>
                </div>
              </div>

              {/* b. Economics */}
              <div className="space-y-6">
                <h4 className="text-xl font-semibold">b. Economic Structure</h4>
                <p className={muted}>
                  Economically, these are the numbers open for debate and structured so that we
                  understand the practical dollar amount of CAW.
                </p>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className={`text-center p-4 border rounded ${accentBorder}`}>
                    <p className="text-2xl font-semibold text-yellow-400">50M</p>
                    <p className={`text-sm mt-2 ${muted}`}>Market Cap (Current)</p>
                  </div>
                  <div className={`text-center p-4 border rounded ${accentBorder}`}>
                    <p className="text-2xl font-semibold text-yellow-400">1B</p>
                    <p className={`text-sm mt-2 ${muted}`}>Market Cap (Typical Moon)</p>
                  </div>
                  <div className={`text-center p-4 border rounded ${accentBorder}`}>
                    <p className="text-2xl font-semibold text-yellow-400">10B</p>
                    <p className={`text-sm mt-2 ${muted}`}>Market Cap (SHIB-like)</p>
                  </div>
                </div>

                {/* Username Costs */}
                <div className="space-y-4">
                  <h5 className="text-lg font-semibold">Username NFT Costs</h5>
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse">
                      <thead>
                        <tr className={`border-b ${accentBorder}`}>
                          <th className="text-left py-3 px-4 font-semibold">Username Length</th>
                          <th className="text-left py-3 px-4 font-semibold">Burn Amount (CAW)</th>
                          <th className="text-left py-3 px-4 font-semibold">USD @ 50M</th>
                          <th className="text-left py-3 px-4 font-semibold">USD @ 1B</th>
                          <th className="text-left py-3 px-4 font-semibold">USD @ 10B</th>
                        </tr>
                      </thead>
                      <tbody className={muted}>
                        {[
                          ['1 Character', '1,000,000,000,000', '$89,985', '$1,799,712', '$17,997,120'],
                          ['2 Characters', '240,000,000,000', '$21,600', '$432,000', '$4,320,000'],
                          ['3 Characters', '60,000,000,000', '$5,400', '$108,000', '$1,080,000'],
                          ['4 Characters', '6,000,000,000', '$540', '$10,800', '$108,000'],
                          ['5 Characters', '200,000,000', '$18', '$360', '$3,600'],
                          ['6 Characters', '20,000,000', '$1.80', '$36', '$360'],
                          ['7 Characters', '10,000,000', '$0.90', '$18', '$180'],
                          ['8+ Characters', '1,000,000', '$0.09', '$1.80', '$18'],
                        ].map(row => (
                          <tr key={row[0]} className={`border-b ${isDark ? 'border-white/10' : 'border-black/10'}`}>
                            {row.map((cell, i) => (
                              <td key={i} className="py-3 px-4">{cell}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Protocol Action Costs */}
                <div className="space-y-4 mt-8">
                  <h5 className="text-lg font-semibold">Protocol Action Costs</h5>
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse">
                      <thead>
                        <tr className={`border-b ${accentBorder}`}>
                          <th className="text-left py-3 px-4 font-semibold">Action</th>
                          <th className="text-left py-3 px-4 font-semibold">Cost (CAW)</th>
                          <th className="text-left py-3 px-4 font-semibold">Distribution</th>
                          <th className="text-left py-3 px-4 font-semibold">USD @ 10B MC</th>
                        </tr>
                      </thead>
                      <tbody className={muted}>
                        {[
                          ['Follow Account', '30,000', '80/20 to account and stakepool', '$0.009'],
                          ['Send a CAW (max 420 chars)', '5,000', '100% to stakepool', '$0.0015'],
                          ['Like a CAW', '2,000', '80/20 to account and stakepool', '$0.0007'],
                          ['ReCAW', '4,000', '50/50 to account and stakepool', '$0.0012'],
                        ].map(row => (
                          <tr key={row[0]} className={`border-b ${isDark ? 'border-white/10' : 'border-black/10'}`}>
                            {row.map((cell, i) => (
                              <td key={i} className="py-3 px-4">{cell}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              {/* c. Image Hosting */}
              <div className="space-y-4">
                <h4 className="text-xl font-semibold">c. Image Hosting and Management</h4>
                <div className={`space-y-3 pl-4 border-l-2 ${accentBorder} ${muted}`}>
                  <p>
                    i. The protocol will have no involvement in the hosting of images. This will
                    be up to the frontends to filter,display,host.
                  </p>
                  <p>
                    ii. It is recommended that frontends render URLs from external sources placed
                    inside posts, or employ their own URL shortener so URLs do not destroy the
                    character limit on CAW.
                  </p>
                  <div className={`p-4 rounded border mt-4 ${
                    isDark ? 'bg-black/30 border-white/10' : 'bg-black/5 border-black/10'
                  }`}>
                    <p className="text-sm">
                      <span className="text-yellow-400">Example:</span> "Just had some great
                      fried fish on Point Road with @tk420 #yum #foodie #bestfrens
                      https://savoryandsweetfood.com/wp-content/uploads/2013/10/20131020-164849.jpg"
                    </p>
                    <p className={`text-sm mt-2 ${muted}`}>
                      A frontend should shorten the URL to something like 'https://c.aw/cawdev'
                      prior to the users post, and automically render the URL as a snippet.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Dreams image */}
            <div
              className={`relative py-4 md:py-6 px-6 flex justify-center transition-all duration-500 delay-[1100ms] ${
                showContent ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
              }`}
            >
              <div className="relative w-full max-w-lg lg:max-w-2xl mx-auto z-10 hero-vignette">
                <img
                  src={dreamsImg}
                  alt="Dreams"
                  className={`w-full h-auto relative z-0 transition-opacity duration-300 ${
                    showDreamsBoth ? 'opacity-100' : 'opacity-0'
                  }`}
                  loading="eager"
                  fetchPriority="high"
                  onLoad={() => setDreamsImageLoaded(true)}
                  onError={() => setDreamsImageLoaded(true)}
                />
                <div
                  className={`absolute inset-0 pointer-events-none z-[1] overflow-hidden transition-opacity duration-300 ${
                    showDreamsBoth ? 'opacity-100' : 'opacity-0'
                  }`}
                >
                  <ParticleSystemManifesto
                    imageUrl={dreamsImg}
                    particleDensity={256}
                    tint={tint}
                    minIntensity={0.2}
                    className="w-full h-full"
                    onReady={() => setDreamsParticlesReady(true)}
                  />
                </div>
              </div>
            </div>

            {/* Closing */}
            <div
              className={`text-center space-y-3 pb-4 -mt-8 md:-mt-12 transition-opacity duration-500 delay-[1200ms] ${
                showContent ? 'opacity-100' : 'opacity-0'
              }`}
            >
              <p className="text-2xl md:text-3xl font-semibold">
                Love, <span className="text-yellow-400">one who still dreams</span>.
              </p>
              <div className={`space-y-3 ${muted}`}>
                <p>P.S. There are no official socials, nor partner projects or further releases.</p>
                <p>CAW is by design without design, and it is up the CAWMmunity to shape CAW.</p>
                <p>
                  Only by giving you the vision and seeing what cames next may we have a truly
                  free and decentralized system.
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>

      <LandingFooter />
    </div>
  )
}

export default ManifestoPage
