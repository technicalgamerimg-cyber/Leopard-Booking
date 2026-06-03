// In-memory circuit breaker for external API calls.
// No external dependencies — uses only Node.js built-ins.
//
// States:
//   CLOSED    → normal operation, all calls proceed
//   OPEN      → calls fail fast (no network attempt) for `resetTimeout` ms
//   HALF_OPEN → one test call allowed; success → CLOSED, failure → OPEN again

class CircuitBreaker {
  constructor({ name, threshold = 5, resetTimeoutMs = 60_000 } = {}) {
    this.name = name;
    this.threshold = threshold;
    this.resetTimeoutMs = resetTimeoutMs;
    this.failures = 0;
    this.state = "CLOSED";
    this.openedAt = null;
  }

  _checkHalfOpen() {
    if (this.state === "OPEN" && this.openedAt) {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed >= this.resetTimeoutMs) {
        this.state = "HALF_OPEN";
        console.info(`[circuit-breaker] ${this.name}: HALF_OPEN — allowing one test call`);
      }
    }
  }

  isOpen() {
    this._checkHalfOpen();
    return this.state === "OPEN";
  }

  /**
   * Returns a failure result object instead of making the API call.
   * Used by the client when the breaker is open.
   */
  openResult() {
    const reopensIn = Math.max(
      0,
      Math.round((this.resetTimeoutMs - (Date.now() - this.openedAt)) / 1000),
    );
    return {
      ok: false,
      code: "LEOPARDS_CIRCUIT_OPEN",
      message: `Leopards API temporarily unavailable. Retrying in ~${reopensIn}s.`,
      httpStatus: null,
      leopardStatus: null,
    };
  }

  recordSuccess() {
    if (this.state !== "CLOSED") {
      console.info(`[circuit-breaker] ${this.name}: CLOSED — API recovered`);
    }
    this.failures = 0;
    this.state = "CLOSED";
    this.openedAt = null;
  }

  /**
   * Call this only for infrastructure failures (HTTP 5xx, network errors, timeouts).
   * Business-level Leopards rejections (status: 0) should NOT trip the breaker.
   */
  recordFailure() {
    this.failures += 1;
    if (this.state === "HALF_OPEN" || this.failures >= this.threshold) {
      this.state = "OPEN";
      this.openedAt = Date.now();
      console.error(
        `[circuit-breaker] ${this.name}: OPENED after ${this.failures} infrastructure failure(s)`,
      );
    }
  }
}

// Module-level singleton — one breaker per Node.js process instance.
export const leopardBreaker = new CircuitBreaker({
  name: "leopards-api",
  threshold: 5,
  resetTimeoutMs: 60_000,
});
