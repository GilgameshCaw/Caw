// src/services/FrontEnd/src/components/CawStakingForm.tsx
import React, { useEffect, useState, useCallback, useMemo } from "react"
import { useSignAndSubmitAction } from '~/api/actions'
import { useSearchParams } from "react-router-dom"
import { CgExternal } from "react-icons/cg"
import { FormHeader } from "~/components/forms/FormHeader"
import { SubmitButton } from "~/components/buttons/SubmitButton"
import { Input } from "~/components/Input"
import { GasPriceLine } from "~/components/GasPriceLine"
import { TokenData } from "~/types";
import { handleError, convertToText } from "~/utils";
import useContractCall from "~/hooks/useContractCall";
import useAllowance from "~/hooks/useAllowance";
import { useAccount, useConnections, useReadContract, useSwitchChain } from "wagmi"
import { useActiveToken, useTokenDataStore } from "~/store/tokenDataStore"
import { erc20Abi, cawNameAbi, cawNameL2Abi } from "~/../../../abi/generated"
import { CAW_ADDRESS, CAW_NAMES_ADDRESS, CAW_NAMES_L2_ADDRESS } from "~/../../../abi/addresses"
import { maxUint256, parseUnits } from "viem";
import MainLayout from '~/layouts/MainLayout'
import { sepolia, baseSepolia } from 'wagmi/chains'
import { chains } from '~/config/chains'
import { Link } from 'react-router-dom'

const tabs = ["stake", "unstake", "info"] as const
const CLIENT_ID = Number(import.meta.env.VITE_CLIENT_ID)
type Tab = (typeof tabs)[number]

/** little tooltip about staking */
const Tooltip: React.FC = () => (
  <div className="w-60 text-white">
    “Stake CAW on L2 to earn messaging credits—and earn back any
    cross‐chain fees you pay when you withdraw.”
  </div>
)

function renderHeader(active: Tab) {
  switch (active) {
    case "stake":
      return (
        <FormHeader
          title="Stake CAW"
          subtitle={
            <span>
              Earn rewards from every action, from every user{" "}
              <a
                href={`https://etherscan.io/address/${CAW_NAMES_L2_ADDRESS}`}
                target="_blank"
                className="text-accent inline-flex items-center gap-0.5"
              >
                <CgExternal className="-mb-0.5" /> contract
              </a>
            </span>
          }
          tooltip={<Tooltip />}
        />
      )
    case "unstake":
      return <FormHeader title="Withdraw CAW" subtitle="" />
    case "info":
      return <FormHeader title="Info" subtitle="Staking contract details" />
  }
}

export const Staking: React.FC = () => {
  // tab state in URL ?action=...
  const [searchParams, setSearchParams] = useSearchParams()
  const activeTab = (searchParams.get("action") as Tab) ?? "stake"
  // when filter changes reset to stake if invalid
  useEffect(() => {
    if (!tabs.includes(activeTab)) {
      setSearchParams({ action: "stake" })
    }
  }, [activeTab, setSearchParams])

  // wallet + profile
  const { address } = useAccount()
  const tokenId     = useTokenDataStore(s => s.activeTokenId)
  // const withdrawable= useTokenDataStore(s =>
  //   (s.tokens ?? []).find(t => t.tokenId === tokenId)?.withdrawable.raw ?? 0n
  // )

  const activeToken = useActiveToken();
  return (
    <MainLayout>
      <div className="w-[80%] m-auto">
        <div className="pl-1">{renderHeader(activeTab)}</div>
        { activeToken ?
          <div>
            <div className="text-xl pt-4">
              Active account: @{activeToken.username}
            </div>
            <div className="pt-6 md:py-8">
              <div className="tabs-fade relative -mx-4 mb-2.5">
                <div className="relative flex overflow-x-scroll">
                  <div className="sm:text-md mb-2.5 flex gap-2 px-4 text-sm font-semibold whitespace-nowrap md:text-lg">
                    {tabs.map(tab => (
                      <button
                        key={tab}
                        onClick={() => setSearchParams({action: tab})}
                        className={`tab ${activeTab === tab ? "tab-active" : ""}`}
                      >
                        {tab === "stake" ? "Deposit" : tab === "unstake" ? "Withdraw" : "Info"}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              {activeTab === "stake" && <StakePanel tokenId={tokenId} />}
              {activeTab === "unstake" && (
                <UnstakePanel token={activeToken} />
              )}
              {activeTab === "info" && <InfoPanel />}
            </div>
          </div>
          :
          <div className="text-xl pt-4">
            No active account.
            You must first <Link className='underline' to={`/mint`}>create a profile</Link>
          </div>
        }
      </div>
    </MainLayout>
  )
}

/** Deposit panel */
function StakePanel({ tokenId }: { tokenId?: number }) {
  const { switchChain } = useSwitchChain();
  const handleSwitchChain = () => switchChain({ chainId: chains.l1.chainId });
  const { allowance } = useAllowance(CAW_ADDRESS, CAW_NAMES_ADDRESS);
  const [ amount, setAmount ]       = useState<string>("")
  const [ depositFee, setDepositFee ]    = useState<bigint>(0n)
  const { address } = useAccount();

  const connections = useConnections();
  const wrongChain = connections[0]?.chainId != chains.l1.chainId;

  const { data: balance, isLoading: balanceLoading } = useReadContract({
    address:      CAW_ADDRESS,
    abi:          erc20Abi,
    chainId: chains.l1.chainId,
    functionName: "balanceOf",
    args:         [ address! ],
    query: {
      enabled:      !!tokenId && !!address
    }
  })


  // quote on‐chain L2 deposit fee
  const { data: quote, error,failureReason, fetchStatus } = useReadContract({
    abi: cawNameAbi,
    chainId: chains.l1.chainId,
    functionName: "depositQuote",
    address: CAW_NAMES_ADDRESS,
    args: [ CLIENT_ID, tokenId ?? 0, parseUnits(amount || "0", 18), chains.l2.layerZero, false ],
    query: {
      enabled: !!tokenId && !!amount
    }
  })
  console.log('error', error, failureReason, fetchStatus)


  useEffect(() => {
    if (quote?.nativeFee != null) setDepositFee(BigInt(quote.nativeFee))
  }, [quote])

  const insufficientBalance = !balance || BigInt(amount) > balance;
  const needsApproval = !allowance || BigInt(amount) > allowance;


  const approve = useContractCall({
    address: CAW_ADDRESS,
    abi: erc20Abi,
    functionName: "approve",
    args: [CAW_NAMES_ADDRESS, maxUint256],
    disabled: !amount || insufficientBalance,
    onError: (err) => handleError(err, "stake"),
    onPending: () => { },
    onSuccess: () => { },
  });

  console.log("NATIVE FEE:", quote);
  const stake = useContractCall({
    address: CAW_NAMES_ADDRESS,
    abi: cawNameAbi,
    functionName: "deposit",
    args: [ CLIENT_ID, tokenId || 0, parseUnits((amount || 0).toString(), 18), chains.l2.layerZero, 0n ],
    disabled:      !tokenId || !amount || depositFee == 0n,
    value: depositFee,
    onPending: () => { },
    onSuccess: (hash) => {
    },
    onError: (err) => handleError(err, "stake"),
  });

  const handleSubmit = useCallback(async () => {
    if (wrongChain) {
      handleSwitchChain()
    } if (needsApproval) {
      await approve.call();
    } else {
      await stake.call();
    }
  }, [needsApproval, approve, stake]);


  // const gasCostWei = (tx as any)?.gasPrice?.mul((tx as any)?.gasLimit) ?? 0n

  return (
    <div className="space-y-4">
      <Input
        balance={{ raw: balance || 0n, usd: 0 }}
        value={amount}
        onChange={setAmount}
      />
      <SubmitButton
        onClick={handleSubmit}
        disabled={!tokenId || (!needsApproval && (!amount || depositFee == 0n))}
        loading={false}
        className="btn btn-submit"
      >
        {wrongChain ? "Switch Network" : (needsApproval ? "Approve" : "Deposit")}
      </SubmitButton>
    </div>
  )
}

/** Withdraw panel */
function UnstakePanel({ token }: { token?: TokenData }) {
  const { switchChain } = useSwitchChain();
  const handleSwitchChain = (network) => switchChain({ chainId: chains[network].chainId });
  const signAndSubmit     = useSignAndSubmitAction()
  const [ amount, setAmount ]       = useState<string>("")
  const [ nativeFee, setFee ]    = useState<bigint>(0n)
  const withdrawable = token?.withdrawable || 0;
  const { isConnected } = useAccount()

  const connections = useConnections();
  const isMainnet = connections[0]?.chainId == chains.l1.chainId;


  // quote withdraw fee on L2
  const { data: quote } = useReadContract({
    address:      CAW_NAMES_ADDRESS,
    abi:          cawNameAbi,
    functionName: "withdrawQuote",
    args:         [CLIENT_ID, false],
    query: {
      enabled: !!token
    }
  })

  const unstake = useContractCall({
    address: CAW_NAMES_ADDRESS,
    abi: cawNameAbi,
    functionName: "withdraw",
    args: [ CLIENT_ID, Number((token?.tokenId ?? 0n)), 0n ],
    disabled: !token?.tokenId || nativeFee == 0n,
    value: nativeFee,
    onPending: () => { },
    onSuccess: (hash) => {
    },
    onError: (err) => handleError(err, "stake"),
  });

  const handleWithdraw = async (event) => {
    if (!token) return
    event.preventDefault()
    try {
      if (!isMainnet) {
        handleSwitchChain("l1")
      } else {
        unstake.call();
      }
    } catch (err) {
      console.error('withdraw failed', err)
    } finally {
    }
  }

  const handleWithdrawInit = async (event) => {
    if (!token) return
    event.preventDefault()
    try {
      if (isMainnet) {
        handleSwitchChain("l2")
      } else {
        await signAndSubmit({
          senderId:        token.tokenId,
          actionType:      'withdraw',
          recipients: [token.tokenId],
          amounts: [BigInt(amount) * 10n**18n],
        })
      }
      // maybe optimistically update UI here…
    } catch (err) {
      console.error('withdraw failed', err)
    } finally {
    }
  }

  useEffect(() => {
    if (quote?.nativeFee != null) setFee(BigInt(quote.nativeFee))
  }, [quote])



  return (
    <div className="space-y-4">
      <div className={token && token.withdrawable == 0n ? 'hidden' : '' }>
        Pending Withdraw: {convertToText(withdrawable.toString(), 18)} CAW
        {isConnected && 
          <SubmitButton onClick={handleWithdraw} className="btn btn-submit" >
            {!isMainnet ? "Switch Network" : "Withdraw"}
          </SubmitButton>
        }
      </div>

    <hr className="mb-8"/>
        Withdraw
      <Input
        balance={{ raw: token?.stakedAmount || 0n, usd: 0 }}
        value={amount}
        onChange={setAmount}
      />
      <SubmitButton
        onClick={handleWithdrawInit}
        // disabled={!write}
        // loading={isLoading}
        className="btn btn-submit"
      >
        {isMainnet ? "Switch Network" : "Initialize Withdrawal"}
      </SubmitButton>
    </div>
  )
      // <GasPriceLine gas={unstake.gasCostWei + nativeFee} />
}

/** Info panel */
function InfoPanel() {
  return (
    <div className="prose text-sm p-4">
      <p>
        Staking CAW requires a minted username NFT, which will retain the staked amount, and accrew rewards.
      </p>
    <br/>
      <p>
        With every action (CAW, RECAW, LIKE, FOLLOW, etc...)
        on the CAW Protocol, a small CAW fee is collected and
        automatically distributed to all CAW stakers in
        proportion to their deposits.
      </p>
      <br/>
      <p>
        Rewards accrue in real time, and can be withdrawn at any moment.
      </p>
    </div>
  )
}

