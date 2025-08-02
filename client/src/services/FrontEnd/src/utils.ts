import { BaseError, formatUnits } from "viem";
import { Duration, formatDuration, milliseconds } from "date-fns";

export const isPlural = (num: number) => `${parseInt(`${num}`)}`.at(-1) !== "1";

export const bigIntMax = (...args: bigint[]) => args.reduce((m, e) => (e > m ? e : m));
export const bigIntMin = (...args: bigint[]) => args.reduce((m, e) => (e < m ? e : m));

export const convertToNumber = (input: bigint | undefined, decimals: number = 18) => {
	if (input == undefined) return 0;
  return Number(formatUnits(input, decimals));
};

export const formatNumber = (numberToFormat: number | undefined, minDecimals: number = 2, maxDecimals: number = 2): string => {
	if (numberToFormat == undefined) return '0';

  const locale = "en-us";
  const decimalDigits = {
    minimumFractionDigits: minDecimals,
    maximumFractionDigits: maxDecimals,
  };

  return numberToFormat.toLocaleString(locale, decimalDigits);
};

export const formatNumberCompact = (input: number, minimumFractionDigits?: number, maximumFractionDigits?: number) => {
	if (input == undefined) return '0';
  const formatter = Intl.NumberFormat("en", { notation: "compact", minimumFractionDigits, maximumFractionDigits });

  return formatter.format(input);
};

export const formatUnitsCompact = (input: bigint, decimals: number = 18) => {
  const formatter = Intl.NumberFormat("en", { notation: "compact" });
  const number = Number(formatUnits(input, decimals));

  return formatter.format(number);
};

export const convertToText = (input: bigint, decimals: number = 18, fractionDigits: number = 2) => {
  return formatNumber(Number(formatUnits(input, decimals)), 2, fractionDigits);
};

export const formatAddress = (address: string, first: number = 6, last: number = 4, separator: string = "...") =>
  `${address.slice(0, first)}${separator}${address.slice(-last)}`;

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const leftPad = (value: number = 0) => `0${value}`.slice(-2);

export const formatTimeRemaining = (duration: Duration): string | undefined => {
  if (duration.months) {
    const days = Math.round(milliseconds(duration) / 1000 / 60 / 60 / 24);
    const suffix = `${days}`.at(-1) === "1" ? "day" : "days";
    return `${days} ${suffix}`;
  } else if (duration.days) {
    if (duration.hours)
      return formatDuration(duration, { format: ["days"] }) + " and " + formatDuration(duration, { format: ["hours"] });
    else return formatDuration(duration, { format: ["days"] });
  } else if (duration.hours) {
    return formatDuration(duration, { format: ["hours"] });
  } else {
    return `${leftPad(duration.minutes)}:${leftPad(duration.seconds)}`;
  }
};

export const getDecimalsFor = (value: number) => {
  let decimals = 0;

  while (Number(formatNumber(value, 0, decimals)) === 0 && decimals < 8) {
    decimals += 1;
  }
  decimals += 2;

  return decimals;
};

export const handleError = (err: BaseError, id: string) => {
  console.error(err);
};
