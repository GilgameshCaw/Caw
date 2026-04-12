/**
 * Heartbeat context passed into each service's start() method.
 *
 * Services MUST call ctx.heartbeat(loopName) at the end of every successful
 * iteration of each background loop they own. The watchdog in runServices.ts
 * tracks per-loop timestamps and restarts the service if any loop stops
 * reporting within its configured timeout.
 *
 * Services with a single loop can call heartbeat() without a name.
 * Services with multiple independent loops (e.g. ValidatorService has a
 * poll loop and a replication loop) should name each one so each is
 * monitored independently.
 */
export type HeartbeatContext = {
  /**
   * Report that a loop has successfully completed an iteration.
   * @param loopName Optional loop identifier. Defaults to 'main'.
   */
  heartbeat(loopName?: string): void;

  /**
   * Declare a loop and its max-staleness timeout. The watchdog treats any
   * declared loop with no heartbeat within its timeout as dead and restarts
   * the service. Loops are implicitly declared on first heartbeat() call
   * with the default timeout if not declared here.
   * @param loopName Loop identifier.
   * @param timeoutMs Max time (ms) since last heartbeat before declaring dead.
   */
  declareLoop(loopName: string, timeoutMs: number): void;
};

export type Service = {
  name: string;
  validateConfig(config: unknown): Error[];
  start(config: unknown, ctx: HeartbeatContext): {
    started: Promise<void>;
    stop(): Promise<void>;
    stats(): Promise<unknown>;
  };
};
