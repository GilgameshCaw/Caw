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
import { useTheme } from '~/hooks/useTheme'
import { HiOutlineTrendingUp, HiOutlineTrendingDown, HiOutlineInformationCircle } from 'react-icons/hi'

type StakingTab = 'stake' | 'unstake' | 'info'

const Staking = () => {
  const { isDark } = useTheme()
  const [activeTab, setActiveTab] = useState<StakingTab>('stake')
  const [amount, setAmount] = useState<string>("45")

  const mockData = {
    stakedAmount: 500.0,
    withdrawable: 25.0,
    walletBalance: 1000.0,
    actions: 42,
    availableBalance: 750.0
  }

  const renderStakePanel = () => (
    <div className="space-y-6">
      <div>
        <h2 className={`text-xl font-bold mb-2 transition-colors duration-300 ${
          isDark ? 'text-white' : 'text-black'
        }`}>
          Stake CAW
        </h2>
        <p className={`text-sm transition-colors duration-300 ${
          isDark ? 'text-gray-400' : 'text-gray-600'
        }`}>
          Earn rewards from protocol activity
        </p>
      </div>

      {/* Available Balance */}
      <div className="space-y-2">
        <label className={`text-sm font-medium transition-colors duration-300 ${
          isDark ? 'text-gray-300' : 'text-gray-700'
        }`}>
          Available Balance
        </label>
        <div className={`w-full px-4 py-3 rounded-full border transition-all duration-300 bg-black ${
          isDark ? 'border-white/20' : 'border-gray-300'
        }`}>
          <div className="flex items-center justify-between">
            <div className={`text-base font-bold transition-all duration-300 ${
              isDark ? 'text-white' : 'text-black'
            }`}>
              {mockData.availableBalance.toFixed(1)} CAW
            </div>
            <button className={`px-3 py-1 text-xs rounded-full transition-all duration-300 cursor-pointer ${
              isDark ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-gray-200 text-black hover:bg-gray-300'
            }`}>
              Max
            </button>
          </div>
        </div>
      </div>

      {/* Amount to Stake */}
      <div className="space-y-2">
        <label className={`text-sm font-medium transition-colors duration-300 ${
          isDark ? 'text-gray-300' : 'text-gray-700'
        }`}>
          Amount to Stake
        </label>
        <div className="relative">
          <input
            type="number"
            placeholder="0.0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className={`w-full px-4 py-3 pr-12 rounded-full border transition-all duration-300 bg-black ${
              isDark ? 'border-white/20 text-white' : 'border-gray-300 text-black'
            } focus:outline-none focus:ring-0`}
          />
          <div className="absolute right-4 top-1/2 transform -translate-y-1/2">
            <span className={`text-sm font-medium transition-colors duration-300 ${
              isDark ? 'text-gray-400' : 'text-gray-600'
            }`}>
              CAW
            </span>
          </div>
        </div>
      </div>

      {/* Stake Button */}
      <button
        className={`w-full py-3 px-4 rounded-full font-semibold transition-all duration-300 cursor-pointer ${
          !amount || parseFloat(amount) <= 0 || parseFloat(amount) > mockData.availableBalance
            ? (isDark ? 'bg-gray-700 text-gray-400' : 'bg-gray-300 text-gray-600')
            : 'bg-yellow-500 hover:bg-yellow-600 text-black'
        }`}
        disabled={!amount || parseFloat(amount) <= 0 || parseFloat(amount) > mockData.availableBalance}
      >
        {parseFloat(amount || "0") > mockData.availableBalance ? "Insufficient Balance" : "Stake CAW"}
      </button>
    </div>
  )

  const renderUnstakePanel = () => (
    <div className="space-y-6">
      <div>
        <h2 className={`text-xl font-bold mb-2 transition-colors duration-300 ${
          isDark ? 'text-white' : 'text-black'
        }`}>
          Unstake CAW
        </h2>
        <p className={`text-sm transition-colors duration-300 ${
          isDark ? 'text-gray-400' : 'text-gray-600'
        }`}>
          Withdraw your staked tokens
        </p>
      </div>

      {/* Staked Balance */}
      <div className="space-y-2">
        <label className={`text-sm font-medium transition-colors duration-300 ${
          isDark ? 'text-gray-300' : 'text-gray-700'
        }`}>
          Staked Balance
        </label>
        <div className={`w-full px-4 py-3 rounded-full border transition-all duration-300 bg-black ${
          isDark ? 'border-white/20' : 'border-gray-300'
        }`}>
          <div className="flex items-center justify-between">
            <div className={`text-base font-bold transition-all duration-300 ${
              isDark ? 'text-white' : 'text-black'
            }`}>
              {mockData.stakedAmount.toFixed(1)} CAW
            </div>
            <button className={`px-3 py-1 text-xs rounded-full transition-all duration-300 cursor-pointer ${
              isDark ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-gray-200 text-black hover:bg-gray-300'
            }`}>
              Max
            </button>
          </div>
        </div>
      </div>

      {/* Pending Withdrawal */}
      <div className="space-y-2">
        <label className={`text-sm font-medium transition-colors duration-300 ${
          isDark ? 'text-gray-300' : 'text-gray-700'
        }`}>
          Pending Withdrawal
        </label>
        <div className={`w-full px-4 py-3 rounded-full border transition-all duration-300 bg-black ${
          isDark ? 'border-white/20' : 'border-gray-300'
        }`}>
          <div className="flex items-center">
            <div className="w-2 h-2 bg-yellow-500 rounded-full mr-3"></div>
            <div className={`text-base font-bold transition-all duration-300 ${
              isDark ? 'text-yellow-200' : 'text-yellow-800'
            }`}>
              {mockData.withdrawable.toFixed(1)} CAW
            </div>
          </div>
        </div>
      </div>

      {/* Amount to Unstake */}
      <div className="space-y-2">
        <label className={`text-sm font-medium transition-colors duration-300 ${
          isDark ? 'text-gray-300' : 'text-gray-700'
        }`}>
          Amount to Unstake
        </label>
        <div className="relative">
          <input
            type="number"
            placeholder="0.0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className={`w-full px-4 py-3 pr-12 rounded-full border transition-all duration-300 bg-black ${
              isDark ? 'border-white/20 text-white' : 'border-gray-300 text-black'
            } focus:outline-none focus:ring-0`}
          />
          <div className="absolute right-4 top-1/2 transform -translate-y-1/2">
            <span className={`text-sm font-medium transition-colors duration-300 ${
              isDark ? 'text-gray-400' : 'text-gray-600'
            }`}>
              CAW
            </span>
          </div>
        </div>
      </div>

      {/* Unstake Button */}
      <button
        className={`w-full py-3 px-4 rounded-full font-semibold transition-all duration-300 cursor-pointer ${
          !amount || parseFloat(amount) <= 0 || parseFloat(amount) > mockData.stakedAmount
            ? (isDark ? 'bg-gray-700 text-gray-400' : 'bg-gray-300 text-gray-600')
            : 'bg-yellow-500 hover:bg-yellow-600 text-black'
        }`}
        disabled={!amount || parseFloat(amount) <= 0 || parseFloat(amount) > mockData.stakedAmount}
      >
        {parseFloat(amount || "0") > mockData.stakedAmount ? "Insufficient Staked" : "Unstake CAW"}
      </button>
    </div>
  )

  const renderInfoPanel = () => (
    <div className="space-y-6">
      <div>
        <h2 className={`text-xl font-bold mb-2 transition-colors duration-300 ${
          isDark ? 'text-white' : 'text-black'
        }`}>
          How Staking Works
        </h2>
        <p className={`text-sm transition-colors duration-300 ${
          isDark ? 'text-gray-400' : 'text-gray-600'
        }`}>
          Learn about CAW Protocol staking mechanics
        </p>
      </div>

      {/* Requirements */}
      <div className={`p-4 rounded-lg border transition-all duration-300 bg-black ${
        isDark ? 'border-white/20' : 'border-gray-300'
      }`}>
        <div className="flex items-start space-x-3">
          <div className={`w-6 h-6 rounded-full flex items-center justify-center transition-colors duration-300 ${
            isDark ? 'bg-white/10' : 'bg-gray-200'
          }`}>
            <HiOutlineInformationCircle className={`w-4 h-4 transition-colors duration-300 ${
              isDark ? 'text-gray-400' : 'text-gray-600'
            }`} />
          </div>
          <div>
            <h3 className={`font-semibold mb-2 transition-colors duration-300 ${
              isDark ? 'text-white' : 'text-black'
            }`}>
              Requirements
            </h3>
            <p className={`text-sm transition-colors duration-300 ${
              isDark ? 'text-gray-400' : 'text-gray-600'
            }`}>
              Staking CAW requires a minted username NFT, which will retain the staked amount and accrue rewards over time.
            </p>
          </div>
        </div>
      </div>

      {/* Reward Distribution */}
      <div className={`p-4 rounded-lg border transition-all duration-300 bg-black ${
        isDark ? 'border-white/20' : 'border-gray-300'
      }`}>
        <div className="flex items-start space-x-3">
          <div className={`w-6 h-6 rounded-full flex items-center justify-center transition-colors duration-300 ${
            isDark ? 'bg-white/10' : 'bg-gray-200'
          }`}>
            <HiOutlineInformationCircle className={`w-4 h-4 transition-colors duration-300 ${
              isDark ? 'text-gray-400' : 'text-gray-600'
            }`} />
          </div>
          <div>
            <h3 className={`font-semibold mb-2 transition-colors duration-300 ${
              isDark ? 'text-white' : 'text-black'
            }`}>
              Reward Distribution
            </h3>
            <p className={`text-sm transition-colors duration-300 ${
              isDark ? 'text-gray-400' : 'text-gray-600'
            }`}>
              With every action (CAW, RECAW, LIKE, FOLLOW, etc...) on the CAW Protocol, a small CAW fee is collected and automatically distributed to all CAW stakers in proportion to their deposits.
            </p>
          </div>
        </div>
      </div>

      {/* Real-time Rewards */}
      <div className={`p-4 rounded-lg border transition-all duration-300 bg-black ${
        isDark ? 'border-white/20' : 'border-gray-300'
      }`}>
        <div className="flex items-start space-x-3">
          <div className={`w-6 h-6 rounded-full flex items-center justify-center transition-colors duration-300 ${
            isDark ? 'bg-white/10' : 'bg-gray-200'
          }`}>
            <HiOutlineInformationCircle className={`w-4 h-4 transition-colors duration-300 ${
              isDark ? 'text-gray-400' : 'text-gray-600'
            }`} />
          </div>
          <div>
            <h3 className={`font-semibold mb-2 transition-colors duration-300 ${
              isDark ? 'text-white' : 'text-black'
            }`}>
              Real-time Rewards
            </h3>
            <p className={`text-sm transition-colors duration-300 ${
              isDark ? 'text-gray-400' : 'text-gray-600'
            }`}>
              Rewards accrue in real time and can be withdrawn at any moment. No lock-up periods or waiting times.
            </p>
          </div>
        </div>
      </div>
    </div>
  )

  return (
    <MainLayout>
      <div className="max-w-2xl mx-auto px-6 py-4 bg-black">
        {/* Header */}
        <div className="mb-8">
          <h1 className={`text-3xl font-bold mb-2 transition-colors duration-300 ${
            isDark ? 'text-white' : 'text-black'
          }`}>
            CAW Staking
          </h1>
          <p className={`text-base transition-colors duration-300 ${
            isDark ? 'text-gray-400' : 'text-gray-600'
          }`}>
            Earn rewards from every action across the protocol
          </p>
        </div>

        {/* Active Account */}
        <div className="mb-6">
          <div className={`inline-block px-4 py-2 rounded-full transition-all duration-300 ${
            isDark ? 'bg-white/10' : 'bg-gray-200'
          }`}>
            <span className={`text-sm font-medium transition-colors duration-300 ${
              isDark ? 'text-white' : 'text-black'
            }`}>
              Active Account: @user
            </span>
          </div>
        </div>

        {/* Portfolio Overview */}
        <div className="mb-8">
          <h3 className={`text-lg font-semibold mb-4 transition-colors duration-300 ${
            isDark ? 'text-white' : 'text-black'
          }`}>
            Portfolio Overview
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className={`p-4 rounded-lg border transition-all duration-300 bg-black ${
              isDark ? 'border-white/20' : 'border-gray-300'
            }`}>
              <div className={`text-sm transition-colors duration-300 ${
                isDark ? 'text-gray-400' : 'text-gray-600'
              }`}>
                Staked CAW
              </div>
              <div className={`text-lg font-bold transition-colors duration-300 ${
                isDark ? 'text-white' : 'text-black'
              }`}>
                {mockData.stakedAmount.toFixed(1)}
              </div>
            </div>
            
            <div className={`p-4 rounded-lg border transition-all duration-300 bg-black ${
              isDark ? 'border-white/20' : 'border-gray-300'
            }`}>
              <div className={`text-sm transition-colors duration-300 ${
                isDark ? 'text-gray-400' : 'text-gray-600'
              }`}>
                Withdrawable
              </div>
              <div className={`text-lg font-bold transition-colors duration-300 ${
                isDark ? 'text-yellow-200' : 'text-yellow-800'
              }`}>
                {mockData.withdrawable.toFixed(1)}
              </div>
            </div>
            
            <div className={`p-4 rounded-lg border transition-all duration-300 bg-black ${
              isDark ? 'border-white/20' : 'border-gray-300'
            }`}>
              <div className={`text-sm transition-colors duration-300 ${
                isDark ? 'text-gray-400' : 'text-gray-600'
              }`}>
                Wallet Balance
              </div>
              <div className={`text-lg font-bold transition-colors duration-300 ${
                isDark ? 'text-white' : 'text-black'
              }`}>
                {mockData.walletBalance.toFixed(0)}
              </div>
            </div>
            
            <div className={`p-4 rounded-lg border transition-all duration-300 bg-black ${
              isDark ? 'border-white/20' : 'border-gray-300'
            }`}>
              <div className={`text-sm transition-colors duration-300 ${
                isDark ? 'text-gray-400' : 'text-gray-600'
              }`}>
                Actions
              </div>
              <div className={`text-lg font-bold transition-colors duration-300 ${
                isDark ? 'text-white' : 'text-black'
              }`}>
                {mockData.actions}
              </div>
              {activeTab === "stake" && <StakePanel tokenId={tokenId} />}
              {activeTab === "unstake" && (
                <UnstakePanel token={activeToken} />
              )}
              {activeTab === "info" && <InfoPanel />}
            </div>
          </div>
        </div>

        {/* Custom Tabs - Container Style */}
        <div className="mb-6">
          <div className={`relative p-1 rounded-xl transition-all duration-300 ${
            isDark ? 'bg-white/10' : 'bg-gray-200'
          } max-w-md mx-auto`}>
            <div className="flex relative">
                                <button
                    onClick={() => setActiveTab('stake')}
                    className={`flex-1 py-2 px-2 sm:px-6 text-center font-medium text-lg transition-all duration-200 flex items-center justify-center space-x-2 relative z-10 cursor-pointer ${
                      activeTab === 'stake'
                        ? `${isDark ? 'bg-white text-black' : 'bg-black text-white'} rounded-lg shadow-lg`
                        : `${isDark ? 'text-gray-400 hover:text-white' : 'text-gray-600 hover:text-black'}`
                    }`}
                  >
                    <HiOutlineTrendingUp className="w-5 h-5" />
                    <span>Stake</span>
                  </button>
                  
                  <button
                    onClick={() => setActiveTab('unstake')}
                    className={`flex-1 py-2 px-2 sm:px-6 text-center font-medium text-lg transition-all duration-200 flex items-center justify-center space-x-2 relative z-10 cursor-pointer ${
                      activeTab === 'unstake'
                        ? `${isDark ? 'bg-white text-black' : 'bg-black text-white'} rounded-lg shadow-lg`
                        : `${isDark ? 'text-gray-400 hover:text-white' : 'text-gray-600 hover:text-black'}`
                    }`}
                  >
                    <HiOutlineTrendingDown className="w-5 h-5" />
                    <span>Unstake</span>
                  </button>
                  
                  <button
                    onClick={() => setActiveTab('info')}
                    className={`flex-1 py-2 px-2 sm:px-6 text-center font-medium text-lg transition-all duration-200 flex items-center justify-center space-x-2 relative z-10 cursor-pointer ${
                      activeTab === 'info'
                        ? `${isDark ? 'bg-white text-black' : 'bg-black text-white'} rounded-lg shadow-lg`
                        : `${isDark ? 'text-gray-400 hover:text-white' : 'text-gray-600 hover:text-black'}`
                    }`}
                  >
                    <HiOutlineInformationCircle className="w-5 h-5" />
                    <span>Info</span>
                  </button>
            </div>
          </div>
        </div>

        {/* Tab Content */}
        <div className="mt-6">
          {activeTab === 'stake' && renderStakePanel()}
          {activeTab === 'unstake' && renderUnstakePanel()}
          {activeTab === 'info' && renderInfoPanel()}
        </div>
      </div>
    </MainLayout>
  )
}

export { Staking }
