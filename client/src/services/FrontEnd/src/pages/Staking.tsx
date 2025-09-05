import React, { useEffect, useState, useCallback } from "react"
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
import { useTheme } from '~/hooks/useTheme'

const CLIENT_ID = 1; // Define CLIENT_ID constant

type StakingTab = 'stake' | 'unstake' | 'info'

const Staking = () => {
  const { isDark } = useTheme()
  const [searchParams, setSearchParams] = useSearchParams()
  const activeToken = useActiveToken()
  const activeTab = (searchParams.get('action') as StakingTab) || 'stake'
  const tokenId = activeToken?.tokenId

  const tabs: StakingTab[] = ['stake', 'unstake', 'info']

  const renderHeader = (tab: StakingTab) => {
    const titles = {
      stake: 'Deposit CAW',
      unstake: 'Withdraw CAW', 
      info: 'Staking Info'
    }
    return <FormHeader title={titles[tab]} subtitle={titles[tab]} />
  }

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
  const { data: quote, error, failureReason, fetchStatus } = useReadContract({
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
    } else if (needsApproval) {
      await approve.call();
    } else {
      await stake.call();
    }
  }, [wrongChain, needsApproval, approve, stake]);

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
  const handleSwitchChain = (network: string) => switchChain({ chainId: chains[network as keyof typeof chains].chainId });
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

  const handleWithdraw = async (event: React.FormEvent) => {
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

  const handleWithdrawInit = async (event: React.FormEvent) => {
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
        Pending Withdraw: {convertToText(withdrawable, 18)} CAW
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
        className="btn btn-submit"
      >
        {isMainnet ? "Switch Network" : "Initialize Withdrawal"}
      </SubmitButton>
    </div>
  )
}

/** Info panel */
function InfoPanel() {
  return (
    <div className="prose text-sm p-4">
      <p>
        Staking CAW requires a minted username NFT, which will retain the staked amount, and accrue rewards.
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

export { Staking }