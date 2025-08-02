import { useAccount, useBlockNumber, useReadContract } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { Address, erc20Abi, zeroAddress } from "viem";
import { sepolia, baseSepolia }       from 'wagmi/chains'
import { useEffect } from "react";

export default function useAllowance(token: Address, spender: Address, forOwner?: Address | undefined) {
  let { address: owner } = useAccount();
	owner = forOwner || owner;

  const { data: blockNumber } = useBlockNumber({ watch: true, query: { enabled: !!owner } });
  const queryClient = useQueryClient();

  const { data, isLoading, error, queryKey, refetch } = useReadContract({
    address: token,
    abi: erc20Abi,
    chainId: sepolia.id,
    functionName: "allowance",
    args: [owner ?? zeroAddress, spender],
    query: {
      enabled: !!owner,
    },
  });

  useEffect(() => {
    if (!!owner) {
      queryClient.invalidateQueries({ queryKey });
    }
  }, [blockNumber, queryClient]);

  return {
    allowance: data || 0n,
    isLoading,
    error,
    refetch,
  };
}
