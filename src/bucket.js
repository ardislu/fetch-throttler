/**
 * @typedef {Object} BucketOptions
 * @property {number} [initialTokens=1] The number of tokens immediately available after the bucket is instantiated.
 * The default value is `1`.
 * @property {number} [interval=1000] The duration (in milliseconds) that elapses in between each token replenishment.
 * The default value is `1000`.
 * @property {number} [tokensPerInterval=1] The number of tokens that are added after each interval. The default value
 * is `1`.
 * @property {number} [maxTokens=initialTokens] The maximum number of tokens that may be available at one time. The default
 * value is `initialTokens`, or `1` if `initialTokens` is `0`.
 */

/**
 * @typedef {Object} Queuer
 * @property {number} count The number of tokens that will be consumed by the queuer.
 * @property {()=>void} resolve Callback that resolves the promise associated with this queuer (i.e., resolves the
 * `removeTokens` promise).
 */

/** 
 * A `FinalizationRegistry` to clear ongoing intervals within a bucket if the bucket has been garbage collected.
 * @type {FinalizationRegistry<ReturnType<typeof setInterval>>}
 */
const registry = new FinalizationRegistry(clearInterval);

/**
 * A basic implementation of the "token bucket" abstraction.
 */
export class Bucket {
  #tokens;
  #interval;
  #tokensPerInterval;
  #maxTokens;

  /** @type {ReturnType<typeof setInterval> | undefined} */
  #intervalId;
  /** @type {Array<Queuer>} */
  #queue = [];

  /** @param {BucketOptions} options */
  constructor(options = {}) {
    this.#tokens = options.initialTokens ?? 1;
    this.#interval = options.interval ?? 1000;
    this.#tokensPerInterval = options.tokensPerInterval ?? 1;
    this.#maxTokens = options.maxTokens ?? (this.#tokens === 0 ? 1 : this.#tokens);
  }

  /** The number of tokens currently available to take immediately from the bucket. */
  get tokens() {
    return this.#tokens;
  }

  /** The duration (in milliseconds) that elapses in between each token replenishment. */
  get interval() {
    return this.#interval;
  }

  /** The number of tokens that are added after each interval. */
  get tokensPerInterval() {
    return this.#tokensPerInterval;
  }

  /** The maximum number of tokens that may be available at one time. */
  get maxTokens() {
    return this.#maxTokens;
  }

  /**
   * Get in a queue (first in, first out) to remove a given number of tokens from the bucket.
   * @param {number} count The number of tokens to remove from the bucket.
   * @returns {Promise<void>} A promise that will fulfill when the tokens are successfully removed from the bucket, or reject
   * if the requested token count exceeds the bucket's maximum capacity.
   */
  removeTokens(count) {
    const { promise, resolve, reject } = /** @type {ReturnType<typeof Promise.withResolvers<void>>} */(Promise.withResolvers());
    if (count > this.#maxTokens) {
      reject(new RangeError(`Requested token count of ${count} exceeds bucket's maximum capacity of ${this.#maxTokens}.`));
    }
    this.#queue.push({ count, resolve });
    this.#take();
    if (this.#intervalId === undefined && this.#tokens < this.#maxTokens) {
      this.#start();
    }
    return promise;
  }

  /** Remove as many `Queuer`s from the queue as possible, in order of entry (first in, first out). */
  #take() {
    let i;
    for (i = 0; i < this.#queue.length; i++) {
      const next = this.#queue[i];
      if (this.#tokens >= next.count) {
        this.#tokens -= next.count;
        next.resolve();
      }
      else {
        break;
      }
    }
    this.#queue = this.#queue.slice(i);
  }

  /** Start a replenishment and `take` loop until the queue is empty and the bucket is at max capacity. */
  #start() {
    const ref = new WeakRef(this);
    this.#intervalId = setInterval(() => {
      const self = ref.deref();
      if (self === undefined) { return; }
      self.#tokens = Math.min(self.#tokens + self.#tokensPerInterval, self.#maxTokens);
      self.#take();
      if (self.#tokens === self.#maxTokens && self.#queue.length === 0) {
        clearInterval(self.#intervalId);
        self.#intervalId = undefined;
      }
    }, this.#interval);
    registry.register(this, this.#intervalId);
  }
}
