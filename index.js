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
 * @typedef {Object} Bucket
 * @property {number} tokens The number of tokens available.
 * @property {number} tokensPerInterval The number of tokens that are added after each interval.
 * @property {number} maxTokens The maximum number of tokens that may be available at one time.
 * @property {(count: number) => Promise<void>} removeTokens Get a `Promise` that resolves when the given number of
 * tokens are successfully removed from the bucket.
 * @property {() => void} stop Call this function to clear the `setInterval` callback refreshing this bucket.
 */

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
    this.#buckets.forEach(b => b.stop());
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

    // Instantiate token bucket
    const bucket = {
      tokens: throttle.maxTokens,
      tokensPerInterval: throttle.tokensPerInterval,
      maxTokens: throttle.maxTokens,
      pending: []
    };
    const intervalId = setInterval(function () {
      // Add new tokens
      const newTokens = bucket.tokens + bucket.tokensPerInterval;
      if (newTokens > bucket.maxTokens) {
        bucket.tokens = bucket.maxTokens;
      }
      else {
        bucket.tokens = newTokens;
      }

      // Clear next in line if there are sufficient tokens
      let i;
      for (i = 0; i < bucket.pending.length; i++) {
        const next = bucket.pending[i];
        if (next !== undefined && bucket.tokens >= next.count) {
          bucket.tokens -= next.count;
          next.resolve();
        }
        else {
          break;
        }
      }
      bucket.pending = bucket.pending.slice(i);
    }, throttle.interval);
    bucket.stop = function () { clearInterval(intervalId); }
    bucket.removeTokens = function (count) {
      if (count > bucket.maxTokens) {
        throw new Error(`Requested count ${count} exceeds maximum tokens ${bucket.maxTokens}.`);
      }
      const { promise, resolve } = Promise.withResolvers();
      bucket.pending.push({ count, promise, resolve });
      return promise;
    }

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
    this.#buckets.get(throttleId).stop();
    this.#buckets.delete(throttleId);
  }

  get [Symbol.toStringTag]() {
    return 'FetchThrottler';
  }
}
