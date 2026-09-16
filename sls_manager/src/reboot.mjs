// A successful command response only acknowledges sending. Fresh uptime proves the restart.
export class RebootTracker {
  constructor() {
    this.entries = new Map();
  }
  begin(id, transport, samples, now = Date.now()) {
    if (this.entries.get(id)?.pending) return null;
    const record = {
      pending: true,
      transport,
      startedAt: now,
      confirmedAt: null,
      source: null,
      baseline: new Map(samples.map((s) => [s.source, s])),
    };
    this.entries.set(id, record);
    return record;
  }
  observe(id, samples) {
    const record = this.entries.get(id);
    if (!record?.pending) return this.snapshot(id);
    for (const sample of samples) {
      if (sample.at <= record.startedAt) continue;
      const bootAt = sample.at - sample.uptime * 1000;
      const before = record.baseline.get(sample.source);
      // Allow integer-second rounding, but require a changed boot time when a baseline exists.
      const changed = !before || bootAt - (before.at - before.uptime * 1000) > 3000;
      if (changed && bootAt >= record.startedAt - 1000 && bootAt <= sample.at) {
        record.pending = false;
        record.confirmedAt = sample.at;
        record.source = sample.source;
        break;
      }
    }
    return this.snapshot(id);
  }
  snapshot(id) {
    const record = this.entries.get(id);
    if (!record) return null;
    return {
      pending: record.pending,
      transport: record.transport,
      startedAt: record.startedAt,
      confirmedAt: record.confirmedAt,
      source: record.source,
      delayed: record.pending && Date.now() - record.startedAt > 180000,
    };
  }
  remove(id) {
    this.entries.delete(id);
  }
}
