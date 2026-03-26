// src/components/ProfileChooser.tsx
import React, { useState, useEffect, useRef } from "react";
import ConnectButton from "~/components/buttons/ConnectButton";
import { useTokenDataStore, useActiveToken } from "~/store/tokenDataStore";
import { formatAddress, formatUnitsCompact, convertToText } from "~/utils";
import UsernameSvg from "./UsernameSvg";
import { Link } from 'react-router-dom'
import { TokenData } from "~/types";
import { useAccount } from "wagmi";
import { useConnectModal } from '@rainbow-me/rainbowkit';
import { Address } from "viem";
import { useTheme } from "~/hooks/useTheme";
import { apiFetch } from "~/api/client";
import { useHasActiveSession } from '~/hooks/useHasActiveSession';
import cawLogo from '~/assets/images/caw-logo.png';

const ProfileChooser: React.FC = () => {
  const { isConnected, address } = useAccount();
  const { openConnectModal } = useConnectModal();
  const hasActiveSession = useHasActiveSession();
  const activeToken = useActiveToken()
  const lastAddress = useTokenDataStore(state => state.lastAddress);
  const activeTokenId = useTokenDataStore(state => state.activeTokenId);
  const tokensByAddress = useTokenDataStore(s => s.tokensByAddress);
  const removeAddress = useTokenDataStore(s => s.removeAddress);
  const { isDark } = useTheme()
  const avatars = useTokenDataStore(s => s.avatarsByTokenId)
  const setAvatar = useTokenDataStore(s => s.setAvatar)

  // Fetch avatar for the active token on mount and when it changes
  useEffect(() => {
    if (!activeToken) return
    const fetchAvatar = async () => {
      try {
        const data = await apiFetch(`/api/users/${activeToken.username}`)
        setAvatar(activeToken.tokenId, data.avatarUrl || null)
      } catch {}
    }
    fetchAvatar()
  }, [activeToken?.tokenId])

  const setLastAddress = useTokenDataStore(s => s.setLastAddress)
  const setActiveTokenId = useTokenDataStore(state => state.setActiveTokenId);;
  const [isDropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const selectedToken = activeToken;

  const hasHydrated = useTokenDataStore(s => s.hasHydrated);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setDropdownOpen(false);
      }
    };

    if (isDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isDropdownOpen]);

  if (hasHydrated && !selectedToken) {
    // Check if there are ANY profiles in the browser
    const hasAnyProfiles = Object.values(tokensByAddress).some(tokens => tokens.length > 0);

    // If no wallet connected and no profiles exist, show "Connect Wallet"
    if (!isConnected && !hasActiveSession && !hasAnyProfiles) {
      return (
        <div className="mb-2 flex justify-center">
          <ConnectButton />
        </div>
      );
    }

    // Otherwise show "create your profile"
    return (
      <div className="mb-2">
        <a href="/usernames/new" className={`inline-flex items-center gap-2 px-4 py-3 rounded-2xl transition-all duration-200 font-medium text-sm shadow-lg hover:shadow-xl hover:scale-105 ${
          isDark
            ? 'bg-white/10 text-white border border-white/20 hover:bg-white/20 hover:border-white/30'
            : 'bg-gray-200 text-black border border-gray-300 hover:bg-gray-300 hover:border-gray-400'
        }`}>
          <span className="text-lg">+</span>
          Create a profile
        </a>
      </div>
    );
  }

  // --- handlers ---
  const toggleDropdown = () => {
    const willOpen = !isDropdownOpen
    setDropdownOpen(willOpen)
    // Fetch avatars for all tokens when opening dropdown
    if (willOpen) {
      const allTokens = Object.values(tokensByAddress).flat()
      for (const token of allTokens) {
        apiFetch(`/api/users/${token.username}`)
          .then(data => setAvatar(token.tokenId, data.avatarUrl || null))
          .catch(() => {})
      }
    }
  };

  const handleRemoveAddress = (address: Address) => {
    removeAddress(address);
  };

  const handleSelectProfile = (token: TokenData) => {
    setActiveTokenId(token.tokenId)
    // Update lastAddress so useTokenDataUpdate refetches data for this token's owner
    if (token.address) {
      setLastAddress(token.address.toLowerCase())
    }
    setDropdownOpen(false);
    // useEffect will fetch avatar when activeToken.tokenId changes
  };

  const walletMismatch = address?.toLowerCase() != activeToken?.address?.toLowerCase();
  const notCurrentAddress = !hasActiveSession && walletMismatch;
  const quickSignWithWrongWallet = hasActiveSession && walletMismatch && isConnected;

  // Normalize all addresses to lowercase to prevent duplicates with different cases
  const normalizedTokensByAddress: Record<Address, TokenData[]> = {}
  for (const [addr, tokens] of Object.entries(tokensByAddress)) {
    const normalizedAddr = addr.toLowerCase() as Address
    if (!normalizedTokensByAddress[normalizedAddr]) {
      normalizedTokensByAddress[normalizedAddr] = []
    }
    // Add tokens if not already present (by tokenId)
    for (const token of tokens) {
      if (!normalizedTokensByAddress[normalizedAddr].some(t => t.tokenId === token.tokenId)) {
        normalizedTokensByAddress[normalizedAddr].push(token)
      }
    }
  }

  const visibleTokensByAddress = { ...normalizedTokensByAddress }
  const normalizedAddress = address?.toLowerCase() as Address | undefined
  if (normalizedAddress && (!visibleTokensByAddress[normalizedAddress] || visibleTokensByAddress[normalizedAddress].length == 0))
      visibleTokensByAddress[normalizedAddress] = [];

  // --- main render when tokens exist ---
  return (
    <div ref={dropdownRef} className="relative flex flex-col text-left left-[0%]">
      <button
        onClick={toggleDropdown}
        className="flex items-center p-1 cursor-pointer"
      >
        <div className="rounded-full overflow-hidden w-[50px] m-3">
          <img src={avatars[selectedToken.tokenId] || cawLogo} className="w-full h-full object-cover" />
        </div>
        <div className="text-left">
          <div className="m-5">
          </div>

          <div className={`font-bold text-lg transition-all duration-300 ${
            isDark ? 'text-white' : 'text-black'
          }`}>
            {selectedToken.username}
          </div>
          <div className={`opacity-40 text-sm transition-all duration-300 ${
            isDark ? 'text-gray-300' : 'text-gray-600'
          }`}>
            {selectedToken.stakedAmount > 0n ? formatUnitsCompact(selectedToken.stakedAmount,18) : "No"} CAW
          </div>
          {notCurrentAddress && (
            <div className="text-2xs text-red-500">
              {isConnected ? "(Wrong Address)" : "not connected"}
            </div>
          )}
          {quickSignWithWrongWallet && (
            <div className="text-2xs text-yellow-500">
              (Quick Sign)
            </div>
          )}
        </div>

      </button>

      {isDropdownOpen && (
        <ul
          className={`absolute bottom-0 mt-2 shadow-lg rounded-md overflow-hidden z-[9999] transition-all duration-300 ${
            isDark ? 'bg-black border border-white/20' : 'bg-white border border-gray-200'
          }`}
          style={{
            right: window.innerWidth < 1100 ? 'auto' : '0',
            left: window.innerWidth < 1100 ? '15px' : 'auto'
          }}
        >
          {Object.entries(visibleTokensByAddress).map(([ownerAddress, tokenList]) => (
            <li key={ownerAddress} className={`border-b transition-all duration-300 ${
              isDark ? 'border-gray-700' : 'border-gray-200'
            }`}>
              {/* group header */}
              <div className={`px-4 py-2 text-xs font-semibold flex space-between transition-all duration-300 ${
                isDark ? 'bg-gray-900 text-white' : 'bg-gray-100 text-black'
              }`}>
                <div className="">
                  {ownerAddress}
                </div>
                {normalizedAddress == ownerAddress ? (
                  <div className="w-[15px] pl-2 text-right">
                    ←
                  </div>
                ) : (
                  <button
                    onClick={() => handleRemoveAddress(ownerAddress as Address)}
                    className="hover:bg-[#ffffff33] cursor-pointer show-hover-parent w-[14px] px-0 ml-2 text-[8px] bg-[#ffffff22] rounded-xs"
                  >
                    X
                  </button>
                ) }
              </div>
              {/* tokens for that address */}
              <ul className="">
                {tokenList.map(token => (
                  <li key={token.tokenId}>
                    <button
                      onClick={() => handleSelectProfile(token)}
                      className={`cursor-pointer flex items-center px-4 py-2 w-full text-left transition-all duration-200 ${
                        isDark 
                          ? 'hover:bg-gray-800 text-white' 
                          : 'hover:bg-gray-100 text-black'
                      }`}
                    >
                      <div className="rounded-full overflow-hidden w-8 h-8 mr-3">
                        <img src={avatars[token.tokenId] || cawLogo} alt={token.username} className="w-full h-full object-cover" />
                      </div>
                      <div>
                        <div className="font-bold">{token.username}</div>
                        <div className="text-xs text-gray-400">
                          {token.stakedAmount > 0n ? convertToText(token.stakedAmount) : "No"} CAW staked
                        </div>
                      </div>
                    </button>
                  </li>
                ))}
                  {normalizedAddress == ownerAddress && (
                    <li className="text-xs text-center pt-1 pb-3">
                      <Link to={`/mint`} className="block">
                        + Create new profile
                      </Link>
                    </li>
                  )}
              </ul>
            </li>
          ))}
          {!isConnected && (
            <li className="text-xs text-center pt-1 pb-3">
              <button onClick={() => openConnectModal?.()} className="cursor-pointer">
                + Connect wallet
              </button>
            </li>
          )}
        </ul>

      )}

    </div>
  );
};

export default ProfileChooser;

