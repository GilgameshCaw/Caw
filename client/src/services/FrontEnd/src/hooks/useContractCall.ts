import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useEstimateGas, useGasPrice, useWriteContract, usePublicClient } from "wagmi";
import {
  Abi,
  BaseError,
  ContractFunctionName,
  encodeFunctionData,
  EncodeFunctionDataParameters,
  formatEther,
  type StateOverride,
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
  /**
   * When provided, gas is estimated with this viem stateOverride AND with the
   * estimate enabled even while `disabled` is true. Lets the caller simulate a
   * call that would otherwise revert pre-approval (e.g. fake CAW balance +
   * allowance) to show a display-only gas figure. Never used for the real tx.
   */
  gasEstimateStateOverride?: StateOverride;
  /**
   * Optional `from` address for the override-estimate ONLY. eth_estimateGas
   * needs a from-address; when no wallet is connected the hook's own
   * useAccount() is undefined, so the caller can supply a placeholder/proxy
   * address here (paired with a stateOverride that funds it). Never used for the
   * real tx — the actual writeContract always uses the connected account.
   */
  gasEstimateAccount?: `0x${string}`;
}

export interface UseContractCallReturn {
  call: () => Promise<`0x${string}`>;
  gasCostEth?: number;
  /** Estimated gas LIMIT (units) for the active estimate, override or normal. */
  gasLimit?: bigint;
  /** Current network gas PRICE in wei. Exposed so callers can recompute the
   *  cost with a clamped price (e.g. capping inflated testnet base fees). */
  gasPriceWei?: bigint;
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
  gasEstimateStateOverride,
  gasEstimateAccount,
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
    query: { enabled: !!account && !disabled && !gasEstimateStateOverride },
  });
  const { data: gasPrice } = useGasPrice();

  const { writeContractAsync, status } = useWriteContract();
  const publicClient = usePublicClient();

  // Override-estimate path: when gasEstimateStateOverride is provided, run a
  // manual publicClient.estimateGas with stateOverride so the estimate succeeds
  // even when the call would revert without real balance/allowance. This is
  // purely display-only — the override never affects the actual tx.
  const [overrideGasLimit, setOverrideGasLimit] = useState<bigint | undefined>();
  // `from` for the override-estimate: prefer the caller-supplied estimate
  // account (lets the estimate run even with no wallet connected), else the
  // connected account.
  const estimateFromAccount = gasEstimateAccount ?? account;
  // BigInt-safe stable key for the stateOverride array (it holds BigInt values
  // like balance: maxUint256, which plain JSON.stringify can't serialize).
  const overrideKey = gasEstimateStateOverride
    ? JSON.stringify(gasEstimateStateOverride, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
    : undefined;
  // Stable identity ref for stateOverride to avoid spurious re-runs
  useEffect(() => {
    if (!gasEstimateStateOverride || !estimateFromAccount || !publicClient) {
      setOverrideGasLimit(undefined);
      return;
    }
    let cancelled = false;
    publicClient
      .estimateGas({
        account: estimateFromAccount,
        to: address,
        data,
        value,
        stateOverride: gasEstimateStateOverride,
      })
      .then((limit) => {
        if (!cancelled) setOverrideGasLimit(limit);
      })
      .catch((err) => {
        if (!cancelled) {
          console.warn(`[useContractCall] ${functionName} override gas estimate failed:`, (err as Error).message?.slice(0, 200));
          setOverrideGasLimit(undefined);
        }
      });
    return () => { cancelled = true; };
  // Re-run when call params change. overrideKey gives a stable string identity
  // for the StateOverride array without requiring the caller to memoise the
  // reference. Plain JSON.stringify throws on the BigInt values the override
  // contains (e.g. balance: maxUint256), so serialize BigInts as strings.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estimateFromAccount, address, data, value, overrideKey, publicClient]);

  // Prefer override estimate when provided (enables display even pre-approval)
  const effectiveGasLimit = gasEstimateStateOverride ? overrideGasLimit : gasLimit;
  const gasCostEth = useMemo(() => {
    if (!gasEstimateStateOverride && gasError) {
      console.warn(`[useContractCall] ${functionName} gas estimate failed:`, gasError.message?.slice(0, 200));
    }
    if (!effectiveGasLimit || !gasPrice) return;
    const wei = effectiveGasLimit * gasPrice;
    const eth = Number(formatEther(wei));
    return eth;
  }, [effectiveGasLimit, gasPrice, gasError, gasEstimateStateOverride, functionName]);

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

  return { call, gasCostEth, gasLimit: effectiveGasLimit, gasPriceWei: gasPrice, status };
}
