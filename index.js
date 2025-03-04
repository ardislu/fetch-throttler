const STORE = {
  fetch: globalThis.fetch
}
Object.freeze(STORE);

/**
 * @typedef {Object} Throttle
 * @property {string|Array<string>} hostname A hostname or array of hostnames that this throttling applies to. If
 * multiple hostname are provided, all hostnames share the same throttle.
 * @property {number} tokensPerInterval The number of tokens that are added after each interval.
 * @property {number|'second'|'minute'|'hour'|'day'} interval The duration (in milliseconds) which must elapse before
 * tokens are added. May also be keyword strings `second`, `minute`, `hour`, or `day` which will be converted to the
 * corresponding milliseconds value.
 * @property {number} [maxTokens] The maximum number of tokens which may be accumulated. By default, this value is
 * set to `tokensPerInterval`.
 * @property {(request: Request) => boolean} [shouldThrottle] Function that returns `true` if a given `Request`
 * should be throttled or `false` if not. By default, all `GET`, `POST`, `PUT`, `DELETE`, and `PATCH` requests
 * are throttled.
 * @property {string|string[][]|Record<string,string>|URLSearchParams} [requestParams] Additional URL parameters
 * to pass with `fetch` calls to the hostname(s) (e.g., API key parameter).
 * @property {RequestInit} [requestOptions] Additional request options to pass with `fetch` calls to the hostname(s)
 * (e.g., `Authorization` header).
 */

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
 * A basic implementation of the "token bucket" abstraction.
 */
export class Bucket {
  #tokens;
  #interval;
  #tokensPerInterval;
  #maxTokens;

  #intervalId = null;
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
   * Get a `Promise` that resolves when the given number of tokens are successfully removed from the bucket.
   * @param {number} count The number of tokens to remove from the bucket.
   * @returns {void}
   */
  async removeTokens(count) {
    const { promise, resolve } = Promise.withResolvers();
    this.#queue.push({ count, resolve });
    this.#take();
    if (this.#intervalId === null && this.#tokens < this.#maxTokens) {
      this.#start();
    }
    return promise;
  }

  #take() {
    let i;
    for (i = 0; i < this.#queue.length; i++) {
      const next = this.#queue[i];
      if (next !== undefined && this.#tokens >= next.count) {
        this.#tokens -= next.count;
        next.resolve();
      }
      else {
        break;
      }
    }
    this.#queue = this.#queue.slice(i);
  }

  #start() {
    this.#intervalId = setInterval(() => {
      const newTokens = this.#tokens + this.#tokensPerInterval;
      if (newTokens > this.#maxTokens) {
        this.#tokens = this.#maxTokens;
      }
      else {
        this.#tokens = newTokens;
      }

      this.#take();

      if (this.#tokens === this.#maxTokens && this.#queue.length === 0) {
        clearInterval(this.#intervalId);
        this.#intervalId = null;
      }
    }, this.#interval);
  }
}

/**
 * Set `globalThis.fetch` to its original value before any `FetchThrottler` instances were created, undoing any
 * `dangerouslySetGlobalFetch` calls.
 */
export function restoreFetch() {
  globalThis.fetch = STORE.fetch;
}

/**
 * A rate limiter for `fetch` calls.
 */
export class FetchThrottler {
  #id = 0;

  /** @type {Map<string,number>} */
  #hostnames = new Map();

  /** @type {Map<number,Throttle>} */
  #throttles = new Map();

  /** @type {Map<number,Bucket>} */
  #buckets = new Map();

  /**
   * @param {Throttle|Array<Throttle>} [throttle] A `Throttle` or array of `Throttle`s to initially configure for this instance.
   */
  constructor(throttle) {
    this.restoreFetch = restoreFetch;
    if (throttle !== undefined) {
      this.add(throttle);
    }
  }

  get throttles() {
    return [...this.#throttles.values()];
  }

  /**
   * Create a new throttle.
   * @param {Throttle|Array<Throttle>} throttle A `Throttle` or array of `Throttle`s to add.
   */
  add(throttle) {
    if (Array.isArray(throttle)) {
      for (const t of throttle) {
        this.remove(t.hostname);
        this.#addThrottle(t);
      };
    }
    else {
      this.remove(throttle.hostname);
      this.#addThrottle(throttle);
    }
  }

  /**
   * Stop throttling requests to a hostname.
   * @param {string} hostname A hostname associated with an existing throttle. If no other hostnames are associated with the throttle,
   * the throttle is deleted. Otherwise, the throttle continues to be active but is no longer applicable to the given hostname.
   */
  remove(hostname) {
    if (Array.isArray(hostname)) {
      for (const h of hostname) {
        this.#removeThrottle(h);
      }
    }
    else {
      this.#removeThrottle(hostname);
    }
  }

  /**
   * Delete all throttles.
   */
  clear() {
    this.#buckets.clear();
    this.#throttles.clear();
    this.#hostnames.clear();
  }

  /**
   * 
   * @param {string|URL|Request} resource 
   * @param {RequestInit} [options]
   * @returns 
   */
  async fetch(request, options) {
    const newUrl = new URL(request);
    const hostname = newUrl.hostname;
    const throttleId = this.#hostnames.get(hostname);
    if (throttleId === undefined) { // No throttle set for this hostname, bypass
      return STORE.fetch(request, options);
    }

    const throttle = this.#throttles.get(throttleId);
    const bucket = this.#buckets.get(throttleId);

    // Configure newRequest by merging custom throttle options
    const newParams = new URLSearchParams({
      ...Object.fromEntries(newUrl.searchParams),
      ...Object.fromEntries(throttle.requestParams)
    });
    newUrl.search = `?${newParams}`;
    const newHeaders = new Headers(options.headers);
    Object.entries(throttle.requestOptions?.headers ?? {}).forEach(e => newHeaders.set(e[0], e[1]));
    const newOptions = Object.fromEntries([
      ...Object.entries(options),
      ...Object.entries(throttle.requestOptions),
      ['headers', newHeaders]
    ]);
    const newRequest = new Request(newUrl, newOptions);

    // Block until tokens are removed from the bucket then fetch
    await bucket.removeTokens(options.throttleTokens ?? 1);
    return STORE.fetch(newRequest);
  }

  /**
   * Set `globalThis.fetch` to `this.fetch`. Use if you need to throttle `globalThis.fetch` calls but can't replace
   * the calls with `this.fetch` (e.g., if the calls are nested in a library that can't be updated easily).
   * 
   * **DANGER**: This operation may have unexpected side effects, only use it if you understand what you are doing.
   */
  dangerouslySetGlobalFetch() {
    globalThis.fetch = this.fetch;
  }

  toJSON() {
    return this.throttles;
  }

  #addThrottle(throttle) {
    // Input sanitation
    if (typeof throttle.interval === 'string') {
      switch (throttle.interval) {
        case 'second': throttle.interval = 1000; break;
        case 'minute': throttle.interval = 60 * 1000; break;
        case 'hour': throttle.interval = 60 * 60 * 1000; break;
        case 'day': throttle.interval = 24 * 60 * 60 * 1000; break;
        default: throw new Error(`${throttle.interval} is not a valid value.`);
      }
    }
    throttle.maxTokens ??= throttle.tokensPerInterval;
    throttle.shouldThrottle ??= (request) => ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(request.method);
    throttle.requestParams = throttle.requestParams ? new URLSearchParams(throttle.requestParams) : new URLSearchParams({});
    throttle.requestOptions ??= {};

    const bucket = new Bucket({
      initialTokens: throttle.maxTokens,
      interval: throttle.interval,
      tokensPerInterval: throttle.tokensPerInterval,
    });

    // Set mappings
    const throttleId = this.#id++;
    if (Array.isArray(throttle.hostname)) {
      throttle.hostname.forEach(h => this.#hostnames.set(h, throttleId));
    }
    else {
      this.#hostnames.set(throttle.hostname, throttleId);
    }
    this.#throttles.set(throttleId, throttle);
    this.#buckets.set(throttleId, bucket);
  }

  #removeThrottle(hostname) {
    const throttleId = this.#hostnames.get(hostname);
    if (throttleId === undefined) {
      return;
    }
    this.#hostnames.delete(hostname);
    const throttle = this.#throttles.get(throttleId);
    if (Array.isArray(throttle.hostname)) {
      const i = throttle.hostname.indexOf(hostname);
      throttle.hostname.splice(i, 1);
      if (throttle.hostname.length > 0) {
        return; // Keep throttle active because other hostnames are using it
      }
    }
    this.#throttles.delete(throttleId);
    this.#buckets.delete(throttleId);
  }

  get [Symbol.toStringTag]() {
    return 'FetchThrottler';
  }
}
