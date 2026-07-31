// A daily sweep touching hundreds of rows one at a time — an SMS per buyer, a
// renewal check per tenancy — turns a few seconds of real work into minutes
// of waiting on network round trips that could have overlapped. No queue, no
// dependency: a fixed number of lanes each pulling the next item until the
// list is empty.
async function mapWithConcurrency(items, limit, worker) {
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

module.exports = { mapWithConcurrency };
