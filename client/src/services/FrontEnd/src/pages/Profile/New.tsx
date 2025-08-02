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
    onSuccess:    hash => console.log('minted!', hash),
    onError:      err  => console.error(err),
  })

  const waiting = approveStatus.match(/pending/) || mintStatus.match(/pending/)

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
      <div className="max-w-md mx-auto p-6 space-y-4">
        <h1 className="text-2xl font-bold text-center">Mint a Username</h1>

        <div className="text-xs border-1 rounded-md p-5 mb-10">
          - 1 Character (rare!) BURN 1T CAW ($89,985)
          <br/>
          - 2 Character - BURN 240B CAW ($21,600)
          <br/>
          - 3 Character - BURN 60B CAW ($5400)
          <br/>
          - 4 Character - BURN 6B CAW ($540)
          <br/>
          - 5 Character - BURN 200M CAW ($18)
          <br/>
          - 6 Character - BURN 20M CAW ($1.80)
          <br/>
          - 7 Character -BURN 10M CAW ($0.10)
          <br/>
          - 8+ Characters - BURN 1M CAW ($0.01)
        </div>

        <input
          type="text"
          value={username}
          pattern="[A-Za-z0-9]*"
          onChange={e => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9]/g, ''))}
          className="w-full p-2 bg-gray-900 border border-gray-700 rounded text-white"
          placeholder="Enter your username (a–z, 0–9)"
        />

        <div className="text-right text-gray-400">
          Balance:
          <span className="font-mono"> {formatNumberCompact(convertToNumber(balance))}</span> CAW
        </div>
        <div className="text-right text-gray-400">
          Cost:
          <span className="font-mono"> {formatNumber(convertToNumber(cost, 18),0)}</span> CAW

        </div>
        {!!cost && cost > 0 && <UsernameSvg username={username}/>}

      <SubmitButton
        onClick={handleSubmit}
        disabled={usernameTaken || (waiting || (!needsApproval && (!cost || cost == 0n || !!insufficientBalance))) || false}
        loading={false}
        className="btn btn-submit mt-0"
      >
        {submitText}
      </SubmitButton>

        {gasCostEth != null && (
          <div className="text-sm text-gray-500">
            est. gas: {gasCostEth.toFixed(4)} ETH
          </div>
        )}
      </div>
    </MainLayout>
  )
}

export default NewProfile

