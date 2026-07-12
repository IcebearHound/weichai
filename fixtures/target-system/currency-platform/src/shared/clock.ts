export interface Clock {
  now(): Date;
}

export interface Sleeper {
  sleep(milliseconds: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export const systemSleeper: Sleeper = {
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};
