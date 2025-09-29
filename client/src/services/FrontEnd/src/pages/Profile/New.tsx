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
import { useActiveToken } from "~/store/tokenDataStore";
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
  const handleSwitchChain = () => switchChain({ chainId: chains.l1.chainId });
  const activeToken = useActiveToken();
  const { isConnected, address }      = useAccount()
  const [username, setUsername] = useState('')
  const [showPricingModal, setShowPricingModal] = useState(false)
  const useAddress = address || activeToken?.owner;

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
    onPending:    hash => {},
    onSuccess:    hash => {},
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
  if (wrongChain)
    submitText = "Switch Network"
  else if (waiting)
    submitText = "waiting..."
  else if (needsApproval)
    submitText = "Approve"
  else if (usernameTaken)
    submitText = "username taken"
  else submitText = "Mint"

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
                    className="w-full pl-10 pr-12 py-3 bg-transparent border border-white/20 rounded-lg text-white placeholder-white/50 focus:outline-none focus:border-white/40 focus:bg-transparent transition-all duration-300"
                    placeholder="Enter your username"
                />
                <div className="absolute inset-y-0 right-0 pr-3 flex items-center">
                    <div 
                        className="relative"
                    >
                        <button 
                            className="text-gray-400 hover:text-white hover:cursor-pointer transition-colors duration-200"
                            onClick={() => setShowPricingModal(!showPricingModal)}
                        >
                            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                        </button>
                        
                        {/* Modal de precios */}
                        {showPricingModal && (
                            <>
                                {/* Overlay */}
                                <div 
                                    className="fixed inset-0 bg-black/50 z-40"
                                    onClick={() => setShowPricingModal(false)}
                                />
                                {/* Modal */}
                                <div className="fixed top-[35%] left-1/2 transform -translate-x-1/2 -translate-y-1/2 md:fixed md:top-[27%] md:left-[51%] md:-translate-x-1/2 md:-translate-y-1/2 mb-6 w-80 md:w-96 bg-black border border-white/20 rounded-lg p-6 shadow-xl z-50">
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
                            </>
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

