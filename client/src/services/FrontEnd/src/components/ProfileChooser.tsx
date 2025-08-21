// src/components/ProfileChooser.tsx
import React, { useState, useEffect } from "react";
import ConnectButton from "~/components/buttons/ConnectButton";
import { useTokenDataStore, useActiveToken } from "~/store/tokenDataStore";
import { formatAddress, formatUnitsCompact, convertToText } from "~/utils";
import UsernameSvg from "./UsernameSvg";
import { Link } from 'react-router-dom'
import { TokenData } from "~/types";
import { useAccount } from "wagmi";
import { Address } from "viem";


const ProfileChooser: React.FC = () => {
  const { isConnected, address } = useAccount();
  const activeToken = useActiveToken()
  const lastAddress = useTokenDataStore(state => state.lastAddress);
  const activeTokenId = useTokenDataStore(state => state.activeTokenId);
  const tokensByAddress = useTokenDataStore(s => s.tokensByAddress);
  const removeAddress = useTokenDataStore(s => s.removeAddress);

  const setLastAddress = useTokenDataStore(s => s.setLastAddress)
  const setActiveTokenId = useTokenDataStore(state => state.setActiveTokenId);;
  const [isDropdownOpen, setDropdownOpen] = useState(false);

  const selectedToken = activeToken;



  const hasHydrated = useTokenDataStore(s => s.hasHydrated);
  console.log("tokens by address", hasHydrated, tokensByAddress)

  if (hasHydrated && !selectedToken)
    return (
      <div className="mb-2">
      <a href="/mint" className="bg-gray-900/80 px-5 py-3 rounded-md hover:bg-gray-900 text-sm ">
        + create your profile
      </a>
      </div>
    );

  // --- handlers ---
  const toggleDropdown = () => setDropdownOpen(open => !open);

  const handleRemoveAddress = (address: Address) => {
    removeAddress(address);
  };

  const handleSelectProfile = (token: TokenData) => {
    setActiveTokenId(token.tokenId)
    setDropdownOpen(false);
  };

  const notCurrentAddress = address != activeToken.address;

  const visibleTokensByAddress = { ...tokensByAddress }
  if (address && (!visibleTokensByAddress[address] || visibleTokensByAddress[address].length == 0))
      visibleTokensByAddress[address] = [];

  // --- main render when tokens exist ---
  return (
    <div className="relative flex flex-col text-left left-[0%]">
      <button
        onClick={toggleDropdown}
        className="flex items-center p-1 cursor-pointer"
      >
        <div className="rounded-full overflow-hidden w-[50px] m-3">
          <img src="/images/logo.jpeg" />
        </div>
        <div className="text-left">
          <div className="m-5">
          </div>


          <div className="font-bold text-lg">
            {selectedToken.username}
          </div>
          <div className="opacity-40 text-sm">
            {selectedToken.stakedAmount > 0n ? formatUnitsCompact(selectedToken.stakedAmount,18) : "No"} CAW
          </div>
          <div className={`${notCurrentAddress ? '' : 'hidden'} text-2xs text-red-500`}>
            {isConnected ? "(Wrong Address)" : "not connected"}
          </div>
        </div>

      </button>

      {isDropdownOpen && (
        <ul className="absolute left-0 w-fit bg-black right-0 bottom-0 mt-2 shadow-lg rounded-md overflow-hidden z-10">
          {Object.entries(visibleTokensByAddress).map(([ownerAddress, tokenList]) => (
            <li key={ownerAddress} className="hover-parent border-b border-gray-700">
              {/* group header */}
              <div className="pl-4 pr-2 py-2 bg-gray-900 text-xs font-semibold flex space-between">
                <div className="pl-4">
                  {ownerAddress}
                </div>
                {address == ownerAddress ? (
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
                      className="cursor-pointer flex items-center px-4 py-2 hover:bg-gray-800 w-full text-left"
                    >
                      <div className="rounded-full overflow-hidden w-8 h-8 mr-3">
                        <img src="/images/logo.jpeg" alt={token.username} />
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
                  {address == ownerAddress && (
                    <li className="text-xs text-center pt-1 pb-3">
                      <Link to={`/mint`} className="block">
                        + Mint a username
                      </Link>
                    </li>
                  )}
              </ul>
            </li>
          ))}
        </ul>

      )}

    </div>
  );
};

export default ProfileChooser;

