export type Service = {
  name: string;
  validateConfig(config: unknown): Error[];
  start(config: unknown): {
    started: Promise<void>;
    stop(): Promise<void>;
    stats(): Promise<unknown>;
  };
};
