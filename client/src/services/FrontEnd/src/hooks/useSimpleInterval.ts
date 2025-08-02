import { useEffect } from "react";
import { useInterval } from "./useInterval";

const useSimpleInterval = (fn: () => void, interval: number, deps: any[]) => {
  const { start, stop } = useInterval(fn, interval);

  useEffect(() => {
    start();
    return stop;
  }, deps);
};

export default useSimpleInterval;
