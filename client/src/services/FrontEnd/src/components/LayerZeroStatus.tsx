import React from 'react'
import { baseSepolia } from 'wagmi/chains'
import { chains } from '~/config/chains'

interface LayerZeroStatusProps {
  address: string
  message?: string
  /** Always use dark styling (e.g. onboarding). Default false = theme-aware. */
  alwaysDark?: boolean
  isDark?: boolean
}

const LayerZeroStatus: React.FC<LayerZeroStatusProps> = ({
  address,
  message = 'Waiting for your staked CAW to appear?',
  alwaysDark = false,
  isDark = true,
}) => {
  const dark = alwaysDark || isDark
  const scanUrl = `https://${chains.l2.chainId === baseSepolia.id ? 'testnet.' : ''}layerzeroscan.com/address/${address}`

  return (
    <div className={`p-3 rounded-lg border transition-all duration-300 ${
      dark ? 'bg-[#070D19]/85 border-blue-500/30' : 'bg-blue-50 border-blue-200'
    }`}>
      <div className="flex items-start gap-2">
        <div className="flex-1">
          <p className={`text-xs leading-relaxed transition-colors duration-300 ${
            dark ? 'text-blue-200' : 'text-blue-800'
          }`}>
            {message}
            <br />
            Cross-chain transfers might be processing in the background.
            <br />
            <br />
            <a
              href={scanUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={`font-semibold hover:underline ${
                dark ? 'text-blue-300' : 'text-blue-600'
              }`}
            >
              Check status here →
            </a>
          </p>
        </div>
      </div>
    </div>
  )
}

export default LayerZeroStatus
