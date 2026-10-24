const EPSILON = 1e-9;

/**
 * Daily spend cap with reservations. The check and the reservation happen in the same
 * synchronous step, so parallel jobs cannot all pass on the same spent total.
 */
export function createBudget({ limit, reservePerJob, spentToday }) {
  let reserved = 0;
  return {
    /** Holds reservePerJob until the returned function is called; throws if the cap would be exceeded. */
    reserve() {
      const spent = spentToday();
      if (spent + reserved + reservePerJob > limit + EPSILON) {
        throw new Error(
          `daily worker budget $${limit} reached ($${spent.toFixed(4)} spent, $${reserved.toFixed(2)} reserved by running jobs) — edit models.json to raise it`,
        );
      }
      reserved += reservePerJob;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        reserved -= reservePerJob;
      };
    },
  };
}
