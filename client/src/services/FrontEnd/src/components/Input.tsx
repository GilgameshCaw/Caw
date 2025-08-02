import { ChangeEventHandler, useMemo } from "react";
import { formatUnits, parseUnits } from "viem";
import { convertToText, formatNumber } from "~/utils";
import { Amount, TokenData } from "~/types";

interface InputProps {
  value: string;
  onChange: (value: string) => void;
  balance: Amount;
  className?: string;
  disabled?: boolean;
  readonly?: boolean;
  icon?: React.ReactNode;
  error?: string;
  showBalance?: boolean;
}

export const Input: React.FC<InputProps> = ({
  value,
  onChange,
  balance,
  className = "",
  disabled = false,
  readonly = false,
  icon,
  error,
  showBalance = true,
}) => {

  const token = {
    symbol: 'CAW',
    decimals: 18,
    price: 0.000000001,
  }

  const { price } = token;
  const amountUSD = useMemo(() => Number(value || 0) * price, [value, price]);
  const invalid = useMemo(
    () => !readonly && !!value && parseUnits(value, token.decimals) > balance.raw,
    [value, balance]
  );

  const handleMax = () => onChange(formatUnits(balance.raw, token.decimals));

  const handleInputChange: ChangeEventHandler<HTMLInputElement> = (event) => {
    let value = event.target.value.replace(/,/g, "");

    if (/^0\d/.test(value)) {
      value = value.slice(1);
    }

    if (/^\.\d/.test(value)) {
      value = `0${value}`;
    }

    if (value === "" || /^\d*\.?\d*$/.test(value)) {
      onChange(value);
    }
  };


  return (
    <div
      className={`border-gray/10 has-[:focus]:outline-primary bg-base-100 flex flex-col gap-2 rounded-xs border-1 px-7 py-3 outline-2 outline-transparent ${className} ${invalid && "has-[:focus]:!outline-error !text-error bg-[#f00]"}`}
    >
      <div className="flex items-center gap-2">
        <input
          className="h-10 w-full border-none bg-transparent p-0 text-5xl font-medium placeholder:text-white focus:outline-none disabled:bg-transparent"
          value={value}
          placeholder="0"
          onChange={handleInputChange}
          disabled={disabled || readonly}
        />
        <div className="border-gray/30 bg-base-300 flex min-w-28 flex-shrink-0 items-center justify-evenly gap-2 rounded-sm border-1 px-1 py-1 text-white select-none md:min-w-34 md:px-3 md:py-2">
      <div
        className={""}
        style={{
          width: 32,
          height: 32,
        }}
      >
        <img
          src={`/images/logo.jpeg`}
          className="h-full w-auto"
          style={{
            width: 32,
            height: 32,
            minWidth: 32,
            minHeight: 32,
          }}
        />
      </div>
          <span className="pr-1 text-lg leading-none font-bold whitespace-nowrap">{token.symbol}</span>
        </div>
      </div>
      {showBalance && (
        <div className="text-gray/90">
          <div className="flex w-full justify-between">
            <span>${amountUSD ? formatNumber(amountUSD) : "0.00"}</span>
            {!readonly && balance && (
              <div>
                <span className="mr-3">
                  {balance.raw > 0n ? convertToText(balance.raw, token.decimals) : "0.00"} {token.symbol}
                </span>
                <button className="btn btn-max" onClick={handleMax} disabled={!balance.raw}>
                  MAX
                </button>
              </div>
            )}
          </div>
          {!!error ? <span className="text-right">{error}</span> : <div />}
        </div>
      )}
    </div>
  );
};
