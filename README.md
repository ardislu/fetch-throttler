# Fetch Throttler

Zero dependency rate limiting for `fetch` calls that works as a drop-in replacement with no build process.

API based on [node-rate-limiter](https://github.com/jhurliman/node-rate-limiter) and the
["token bucket" abstraction](https://en.wikipedia.org/wiki/Token_bucket), but tailored for `fetch` calls.
