import { useAccount, useReadContract } from "wagmi";
import { Address, erc20Abi, zeroAddress } from "viem";
import { sepolia }       from 'wagmi/chains'

export default function useAllowance(token: Address, spender: Address, forOwner?: Address | undefined) {
  let { address: owner } = useAccount();
	owner = forOwner || owner;

  const { data, isLoading, error, refetch } = useReadContract({
    address: token,
    abi: erc20Abi,
    chainId: sepolia.id,
    functionName: "allowance",
    args: [owner ?? zeroAddress, spender],
    query: {
      enabled: !!owner,
    },
  });

  return {
    allowance: data || 0n,
    isLoading,
    error,
    refetch,
  };
}
