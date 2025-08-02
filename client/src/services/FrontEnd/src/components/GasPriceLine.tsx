import { useEffect, useState } from "react";
import { formatNumber } from "~/utils";
import GasIcon from "~/assets/images/gas.svg?react";

interface GasPriceLineProps {
  gas?: number;
  label?: React.ReactNode;
  className?: string;
}

export const GasPriceLine: React.FC<GasPriceLineProps> = ({ label, gas = 0, className = "" }) => {
  // TODO: get real price
  // TODO: get real price
  // TODO: get real price
  const ethPrice = 1
  const [gasUSD, setGasUSD] = useState<string>();
  const [isLoading, setLoading] = useState(false);

  useEffect(() => {
    if (gas) {
      const usd = formatNumber(gas * ethPrice);
      setGasUSD(usd);
      setLoading(false);
    } else if (gasUSD) {
      setLoading(true);
    }
  }, [gas, ethPrice]);

  return (
    <div className={`text-gray flex justify-between py-3 max-md:px-2 ${className}`}>
      <div>{label}</div>
      <div
        className="flex items-center gap-1 transition-opacity"
        style={{
          visibility: !!gasUSD ? "visible" : "hidden",
          opacity: !!gasUSD ? 1 : 0,
        }}
      >
        <GasIcon width="20" height="20" className="-mt-0.5" />
        <span className="w-[4ch] text-center transition-opacity" style={{ opacity: isLoading ? 0.8 : 1 }}>
          ${gasUSD}
        </span>
      </div>
    </div>
  );
};

