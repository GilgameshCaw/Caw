import { useCallback, useMemo } from "react";
import { useAccount, useEstimateGas, useGasPrice, useWriteContract, usePublicClient } from "wagmi";
import {
  Abi,
  BaseError,
  ContractFunctionName,
  encodeFunctionData,
  EncodeFunctionDataParameters,
  formatEther,
} from "viem";

interface UseContractCallParams {
  disabled: boolean;
  onPending?: (hash: `0x${string}`) => void;
  onSuccess?: (hash: `0x${string}`) => void;
  onError?: (err: BaseError) => void;
}

export interface UseContractCallArgs extends UseContractCallParams {
  address: `0x${string}`;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
}

export interface UseContractCallReturn {
  call: () => Promise<`0x${string}`>;
  gasCostEth?: number;
  status: "idle" | "pending" | "error" | "success";
}

export default function useContractCall<
  const abi extends Abi | readonly unknown[],
  functionName extends ContractFunctionName<abi>,
>({
  address,
  abi: _abi,
  functionName: _functionName,
  args: _args,
  value,
  disabled,
  onPending,
  onSuccess,
  onError,
}: UseContractCallArgs & EncodeFunctionDataParameters<abi, functionName>): UseContractCallReturn {
  /* fix types */
  const { abi, args } = { abi: _abi, args: _args } as EncodeFunctionDataParameters;
  const functionName = _functionName as string;

  const { address: account } = useAccount();
  const data = encodeFunctionData({ abi, functionName, args });

  const { data: gasLimit } = useEstimateGas({
    account,
    to: address,
    data,
    value,
    query: { enabled: !!account && !disabled },
  });
  const { data: gasPrice } = useGasPrice();

  const gasCostEth = useMemo(() => {
    if (!gasLimit || !gasPrice) return;
    const wei = gasLimit * gasPrice;
    const eth = Number(formatEther(wei));
    return eth;
  }, [gasLimit, gasPrice]);

  const { writeContractAsync, status } = useWriteContract();
  const publicClient = usePublicClient();

  const call = useCallback(async () => {
    if (!account) throw new Error("Wallet is not connected");
    if (disabled) throw new Error("Contract call is disabled");

    try {
      const hash = await writeContractAsync({
        address,
        abi,
        functionName,
        args,
        value,
      });

      onPending?.(hash);
      await publicClient?.waitForTransactionReceipt({ hash });
      onSuccess?.(hash);
      return hash;
    } catch (err) {
      onError?.(err as BaseError);
      throw err;
    }
  }, [address, abi, functionName, args, value, writeContractAsync, publicClient, onPending, onSuccess, onError]);

  return { call, gasCostEth, status };
}
