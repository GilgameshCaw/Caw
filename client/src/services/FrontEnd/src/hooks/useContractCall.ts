import { useCallback, useMemo, useRef } from "react";
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

  const { data: gasLimit, error: gasError } = useEstimateGas({
    account,
    to: address,
    data,
    value,
    query: { enabled: !!account && !disabled },
  });
  const { data: gasPrice } = useGasPrice();

  const gasCostEth = useMemo(() => {
    if (gasError) console.warn(`[useContractCall] ${functionName} gas estimate failed:`, gasError.message?.slice(0, 200));
    if (!gasLimit || !gasPrice) return;
    const wei = gasLimit * gasPrice;
    const eth = Number(formatEther(wei));
    return eth;
  }, [gasLimit, gasPrice, gasError, functionName]);

  const { writeContractAsync, status } = useWriteContract();
  const publicClient = usePublicClient();

  // Use refs so the call always reads the latest values regardless of closure timing
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const accountRef = useRef(account);
  accountRef.current = account;

  const call = useCallback(async () => {
    console.log(`[useContractCall] ${functionName} called — disabled:`, disabledRef.current, 'account:', !!accountRef.current)
    // Pre-flight checks. Fire onError before throwing so callers that wired
    // up onError (e.g. to clear a "Pending..." button label) get the signal
    // even when the call bails out before reaching writeContractAsync. Without
    // this, a click that hits a disabled gate would leave the caller's pending
    // state stuck because the throw bypasses the try/catch below.
    if (!accountRef.current) {
      const err = new Error("Wallet is not connected") as BaseError;
      onError?.(err);
      throw err;
    }
    if (disabledRef.current) {
      const err = new Error("Contract call is disabled") as BaseError;
      onError?.(err);
      throw err;
    }

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
