// src/pages/NewProfile.tsx
import { SubmitButton } from "~/components/buttons/SubmitButton"
import React, { useState, useCallback, useMemo } from 'react'
import { useReadContract, useAccount, useConnections, useSwitchChain } from 'wagmi'
import useAllowance from "~/hooks/useAllowance";
import { maxUint256, parseUnits } from "viem";
import MainLayout from '~/layouts/MainLayout'
import useContractCall, { UseContractCallReturn } from '~/hooks/useContractCall'
import { CAW_ADDRESS, CAW_NAMES_ADDRESS, CAW_NAMES_MINTER_ADDRESS } from '~/../../../abi/addresses'  // ← your real values
import { erc20Abi, cawNameAbi, cawNameMinterAbi } from '~/../../../abi/generated'  // ← your real values
import { useActiveToken, useTokenDataStore } from "~/store/tokenDataStore";
import { chains } from '~/config/chains'
import UsernameSvg from '~/components/UsernameSvg'
import { formatNumber, formatNumberCompact, convertToNumber } from "~/utils";
import { formatUnits } from "viem";
import BadgedIcon from '~/assets/images/badged.svg'

const CLIENT_ID = Number(import.meta.env.VITE_CLIENT_ID)

// cost schedule (raw CAW)
const COST_SCHEDULE: Record<number, bigint> = {
  1: 1000_000_000_000n,
  2:   240_000_000_000n,
  3:    60_000_000_000n,
  4:     6_000_000_000n,
  5:       200_000_000n,
  6:        20_000_000n,
  7:        10_000_000n,
}
const DEFAULT_COST = 1_000_000n  // 8+ chars

export const NewProfile: React.FC = () => {
  const { switchChain } = useSwitchChain();
  const [isSwitchingChain, setIsSwitchingChain] = useState(false);
  const handleSwitchChain = async () => {
    setIsSwitchingChain(true);
    try {
      await switchChain({ chainId: chains.l1.chainId });
    } catch (error) {
      console.error('Failed to switch chain:', error);
    } finally {
      setIsSwitchingChain(false);
    }
  };
  const activeToken = useActiveToken();
  const { isConnected, address }      = useAccount()
  const [username, setUsername] = useState('')
  const [showPricingModal, setShowPricingModal] = useState(false)
  const [mintSuccess, setMintSuccess] = useState(false)
  const [mintedTokenId, setMintedTokenId] = useState<number | null>(null)
  const useAddress = address || activeToken?.owner;
  const setActiveTokenId = useTokenDataStore(state => state.setActiveTokenId);

  // is valid username?
  const isValid = /^[a-z0-9]{1,}$/i.test(username)

  // cost in raw CAW (bigint)
  const cost = useMemo(() => {
    const len = username.length
    if (len === 0) return 0n
    return (COST_SCHEDULE[len as keyof typeof COST_SCHEDULE] ?? DEFAULT_COST) *10n**18n
  }, [username])

  const { data: existingId, isLoading: checkingUsername } = useReadContract({
    address:      CAW_NAMES_MINTER_ADDRESS,
    abi:          cawNameMinterAbi,
    chainId: chains.l1.chainId,
    functionName: "idByUsername",
    args:         [username],
    query: { enabled: username.length > 0 }
  })

  const usernameTaken = !checkingUsername && !!existingId;


  const { data: balance, isLoading: balanceLoading } = useReadContract({
    address:      CAW_ADDRESS,
    abi:          erc20Abi,
    chainId: chains.l1.chainId,
    functionName: "balanceOf",
    args:         [ useAddress! ],
    query: { enabled: !!useAddress }
  })
console.log("BALANCE:", balance)

  // quote on‐chain L2 deposit fee
  const { data: quote, error,failureReason, fetchStatus } = useReadContract({
    abi: cawNameAbi,
    chainId: chains.l1.chainId,
    functionName: "mintQuote",
    address: CAW_NAMES_ADDRESS,
    args: [ CLIENT_ID, false ],
    query: { enabled: true }
  })

  const lzTokenAmount = 0n;
  const insufficientBalance = !balance || cost > balance;

  const connections = useConnections();
  const wrongChain = connections[0]?.chainId != chains.l1.chainId;

  // Reset switching state when chain changes to correct one
  React.useEffect(() => {
    if (!wrongChain && isSwitchingChain) {
      setIsSwitchingChain(false);
    }
  }, [wrongChain, isSwitchingChain]);

  const { allowance } = useAllowance(CAW_ADDRESS, CAW_NAMES_MINTER_ADDRESS, useAddress);
  const needsApproval = !allowance || allowance == 0n || BigInt(cost) > allowance;

  const { call: approve, status: approveStatus } = useContractCall({
    abi: erc20Abi,
    address: CAW_ADDRESS,
    functionName: "approve",
    args: [CAW_NAMES_MINTER_ADDRESS, maxUint256],
    disabled: wrongChain || !needsApproval,
  });


  // hook into mint function
  const { call: mint, status: mintStatus, gasCostEth }: UseContractCallReturn = useContractCall({
    value:        quote?.nativeFee || 0n,

    functionName: 'mint',
    abi:      cawNameMinterAbi,
    address: CAW_NAMES_MINTER_ADDRESS,
    args:         [CLIENT_ID, username, lzTokenAmount],
    disabled:     !quote || !address || !isValid || needsApproval,
    onPending:    hash => console.log('tx pending', hash),
    onSuccess:    async (hash) => {
      console.log('minted!', hash)

      // Wait a bit for the transaction to be indexed, then fetch the new token
      setTimeout(async () => {
        try {
          // Fetch the tokenId for the newly minted username
          const response = await fetch(`http://localhost:4000/api/tokens/by-address/${address}`)
          const data = await response.json()

          // Find the token with the matching username
          const newToken = data.tokens?.find((t: any) => t.username.toLowerCase() === username.toLowerCase())

          if (newToken) {
            setMintedTokenId(newToken.tokenId)
            // Switch to the newly minted token
            setActiveTokenId(newToken.tokenId)
          }
        } catch (err) {
          console.error('Failed to fetch new token:', err)
        }

        setMintSuccess(true)
      }, 3000) // Wait 3 seconds for indexing
    },
    onError:      err  => console.error(err),
  })

  const waiting = Boolean(approveStatus.match(/pending/)) || Boolean(mintStatus.match(/pending/))

  const handleSubmit = useCallback(async () => {
    if (wrongChain) {
      handleSwitchChain()
    } else if (needsApproval) {
      await approve();
    } else {
      await mint();
    }
  }, [wrongChain, needsApproval, approve, mint, handleSwitchChain]);

  let submitText;
  if (isSwitchingChain) {
    submitText = (
      <div className="flex items-center justify-center space-x-2">
        <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/>
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
        </svg>
        <span>Switching...</span>
      </div>
    )
  } else if (wrongChain)
    submitText = "Switch Network"
  else if (waiting) {
    if (mintStatus === 'pending') {
      submitText = (
        <div className="flex items-center justify-center space-x-2">
          <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
          </svg>
          <span>Minting...</span>
        </div>
      )
    } else if (approveStatus === 'pending') {
      submitText = (
        <div className="flex items-center justify-center space-x-2">
          <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
          </svg>
          <span>Approving...</span>
        </div>
      )
    } else {
      submitText = "Processing..."
    }
  } else if (needsApproval)
    submitText = "Approve"
  else if (usernameTaken)
    submitText = "username taken"
  else submitText = "Mint"

  // Show loading screen while waiting for mint to complete
  if (mintStatus === 'pending' || (mintStatus === 'success' && !mintSuccess)) {
    return (
      <MainLayout>
        <div className="max-w-md mx-auto p-6 space-y-4 mt-8">
          <div className="text-center space-y-6">
            {/* Loading animation */}
            <div className="flex justify-center">
              <div className="w-32 h-32 rounded-full bg-yellow-500/20 flex items-center justify-center">
                <svg className="animate-spin h-20 w-20 text-yellow-500" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
                </svg>
              </div>
            </div>

            <h1 className="text-4xl font-bold text-white">Minting Your Username...</h1>

            <div className="space-y-2">
              <p className="text-xl text-gray-300">
                Creating
              </p>
              <p className="text-3xl font-bold text-yellow-500">
                @{username}
              </p>
            </div>

            {/* Show the username SVG */}
            <div className="flex justify-center items-center my-8">
              <div className="w-44 h-44 opacity-50">
                <UsernameSvg username={username}/>
              </div>
            </div>

            <div className="space-y-4">
              <p className="text-gray-400">
                Please wait while your transaction is being processed on the blockchain...
              </p>
              {mintStatus === 'success' && (
                <p className="text-yellow-500 text-sm">
                  Transaction confirmed! Indexing your new username...
                </p>
              )}
            </div>
          </div>
        </div>
      </MainLayout>
    )
  }

  // Show success screen if mint was successful
  if (mintSuccess) {
    return (
      <MainLayout>
        <div className="max-w-md mx-auto p-6 space-y-4 mt-8">
          <div className="text-center space-y-6">
            {/* Success checkmark animation */}
            <div className="flex justify-center">
              <div className="w-32 h-32 rounded-full bg-green-500/20 flex items-center justify-center animate-pulse">
                <svg className="w-20 h-20 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
            </div>

            <h1 className="text-4xl font-bold text-white">Congratulations! 🎉</h1>

            <div className="space-y-2">
              <p className="text-xl text-gray-300">
                You've successfully minted
              </p>
              <p className="text-3xl font-bold text-yellow-500">
                @{username}
              </p>
            </div>

            {/* Show the username SVG */}
            <div className="flex justify-center items-center my-8">
              <div className="w-44 h-44">
                <UsernameSvg username={username}/>
              </div>
            </div>

            <div className="space-y-4">
              <p className="text-gray-400">
                Your CAW username is now active and ready to use!
              </p>

              <button
                onClick={() => window.location.href = '/profile'}
                className="w-full py-3 bg-yellow-500 hover:bg-yellow-600 text-black font-bold rounded-full transition-all duration-300"
              >
                Go to Profile
              </button>

              <button
                onClick={() => {
                  setMintSuccess(false)
                  setUsername('')
                }}
                className="w-full py-3 border border-white/20 hover:border-white/40 text-white font-semibold rounded-full transition-all duration-300"
              >
                Mint Another Username
              </button>
            </div>
          </div>
        </div>
      </MainLayout>
    )
  }

  return (
    <MainLayout>
      <div className="max-w-md mx-auto p-6 space-y-4 mt-8"> {/* Cambiado de mt-16 a mt-8 para subir todo el contenido */}
        <h1 className="text-4xl font-bold text-center">Mint a Username</h1>

        {/* Imagen generada del username - siempre visible */}
        <div className="flex justify-center items-center mb-6 mt-16">
            <div className="w-44 h-44">
                <UsernameSvg username={username}/>
            </div>
        </div>

        <div className="mt-16 space-y-4"> {/* Cambiado de mt-32 a mt-16 para subir el formulario */}
            <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                    </svg>
                </div>
                <input
                    type="text"
                    value={username}
                    pattern="[A-Za-z0-9]*"
                    onChange={e => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9]/g, ''))}
                    className="w-full pl-10 pr-12 py-3 bg-black border border-white/20 rounded-full text-white placeholder-white/50 focus:outline-none focus:border-white/30 focus:bg-black transition-all duration-300"
                    placeholder="Enter your username"
                />
                <div className="absolute inset-y-0 right-0 pr-3 flex items-center">
                    <div 
                        className="relative"
                        onMouseEnter={() => setShowPricingModal(true)}
                        onMouseLeave={() => setShowPricingModal(false)}
                    >
                        <button 
                            className="text-gray-400 hover:text-white transition-colors duration-200"
                        >
                            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                        </button>
                        
                        {/* Modal de precios */}
                        {showPricingModal && (
                            <div className="absolute bottom-full right-0 mb-6 w-96 bg-black border border-white/20 rounded-lg p-6 shadow-xl z-50">
                                <div className="text-sm font-medium text-center text-white mb-4">Username Pricing</div>
                                <div className="space-y-3">
                                    <div className="flex justify-between text-xs items-center">
                                        <div className="flex items-center space-x-2">
                                            <img src={BadgedIcon} alt="Verified" className="w-4 h-4" />
                                            <span className="text-gray-300">1 Character (rare!)</span>
                                        </div>
                                        <div className="text-right">
                                            <div className="font-mono text-white">BURN 1T CAW</div>
                                            <div className="text-gray-400">($89,985)</div>
                                        </div>
                                    </div>
                                    <div className="flex justify-between text-xs items-center">
                                        <div className="flex items-center space-x-2">
                                            <img src={BadgedIcon} alt="Verified" className="w-4 h-4" />
                                            <span className="text-gray-300">2-3 Characters</span>
                                        </div>
                                        <div className="text-right">
                                            <div className="font-mono text-white">BURN 240B-60B CAW</div>
                                            <div className="text-gray-400">($21,600 - $5,400)</div>
                                        </div>
                                    </div>
                                    <div className="flex justify-between text-xs items-center">
                                        <div className="flex items-center space-x-2">
                                            <img src={BadgedIcon} alt="Verified" className="w-4 h-4" />
                                            <span className="text-gray-300">4-7 Characters</span>
                                        </div>
                                        <div className="text-right">
                                            <div className="font-mono text-white">BURN 6B-10M CAW</div>
                                            <div className="text-gray-400">($540 - $0.10)</div>
                                        </div>
                                    </div>
                                    <div className="flex justify-between text-xs items-center">
                                        <div className="flex items-center space-x-2">
                                            <img src={BadgedIcon} alt="Verified" className="w-4 h-4" />
                                            <span className="text-gray-300">8+ Characters</span>
                                        </div>
                                        <div className="text-right">
                                            <div className="font-mono text-white">BURN 1M CAW</div>
                                            <div className="text-gray-400">($0.01)</div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            <div className="flex justify-between items-center text-sm">
                <div className="text-gray-400">
                    Balance: <span className="font-mono text-white">{formatNumberCompact(convertToNumber(balance))} CAW</span>
                </div>
                <div className="text-gray-400">
                    Cost: <span className="font-mono text-white">{formatNumber(convertToNumber(cost, 18),0)} CAW</span>
                </div>
            </div>

            <SubmitButton
                onClick={handleSubmit}
                disabled={usernameTaken || (waiting || (!needsApproval && (!cost || cost == 0n || !!insufficientBalance))) || false}
                loading={false}
                className="btn btn-submit mt-0 transition-all duration-300"
            >
                {submitText}
            </SubmitButton>

            {gasCostEth != null && (
                <div className="text-sm text-gray-500">
                    est. gas: {gasCostEth.toFixed(4)} ETH
                </div>
            )}
        </div>
      </div>
    </MainLayout>
  )
}

export default NewProfile

