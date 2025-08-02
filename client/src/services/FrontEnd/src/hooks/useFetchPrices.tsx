import { useQuery } from "@tanstack/react-query"
import TOKENS from "~/constants/tokens"
import { usePriceStore } from "~/store/tokenDataStore";


export function useFetchPrices() {
  const setPriceMap = usePriceStore(s => s.setPriceMap);

  return useQuery({
    queryKey:   ["tokenUsdPrices"],
    queryFn:    async () => {
      const ids = ["ethereum", ...Object.values(TOKENS).map(token => token.coingeckoId)].join(",");
      const resp = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`
      );
      const json = (await resp.json()) as Record<string,{ usd:number }>;
      return Object.fromEntries(
        Object.entries(json).map(([id, { usd }]) => [id, usd])
      );
    },
    onSuccess:  prices => setPriceMap(prices),
    // optionally poll every 10 minutes:
    refetchInterval: 600_000,
  });
}
