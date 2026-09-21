const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const configStore = require('./config-store');

// Simple token-bucket throttle. Multi-GB template uploads (routes/
// templates.js) write straight to a k3s local-path PVC that -- on this
// homelab's Raspberry Pi nodes -- shares one physical disk with etcd's own
// data dir (see project memory: no separate device per node). A large
// write's I/O burst can starve etcd's fsyncs badly enough to flip the node
// NotReady mid-upload, killing the browser's connection at whatever byte
// count that happened to land on. Pacing the write over more wall-clock
// time gives etcd's small, frequent fsyncs room to land in the gaps,
// independent of which node's disk actually backs the PVC -- unlike the
// per-node SSD migration this protects all three nodes uniformly.
class ThrottleTransform extends Transform {
  constructor(bytesPerSec) {
    super();
    this.bytesPerSec = bytesPerSec;
    this.tokens = bytesPerSec; // start with a full bucket, not throttled from byte zero
    this.lastRefill = Date.now();
  }

  _transform(chunk, _enc, cb) {
    this._consume(chunk, cb);
  }

  _consume(chunk, cb) {
    const now = Date.now();
    this.tokens = Math.min(this.bytesPerSec, this.tokens + ((now - this.lastRefill) / 1000) * this.bytesPerSec);
    this.lastRefill = now;

    if (chunk.length <= this.tokens) {
      this.tokens -= chunk.length;
      this.push(chunk);
      return cb();
    }
    // Not enough tokens for the whole chunk -- push what the bucket can
    // afford right now, then wait for the remainder to "cost" enough time
    // to refill before pushing the rest. Recurses rather than looping so
    // each wait is a real setTimeout, not a busy-loop.
    const affordable = Math.floor(this.tokens);
    if (affordable > 0) {
      this.push(chunk.subarray(0, affordable));
      this.tokens -= affordable;
      chunk = chunk.subarray(affordable);
    }
    const waitMs = Math.max(10, Math.ceil((chunk.length / this.bytesPerSec) * 1000));
    setTimeout(() => this._consume(chunk, cb), waitMs);
  }
}

// Multer custom StorageEngine (see multer's own StorageEngine docs -- just
// _handleFile/_removeFile). Reads the rate limit from config-store live on
// every call rather than baking it in at construction time, so changing it
// on the Settings page takes effect on the very next upload with no pod
// restart needed -- same "Settings-driven, not env-var-frozen" convention
// as every other runtime-adjustable knob in this app.
class ThrottledDiskStorage {
  constructor({ uploadDir }) {
    this.uploadDir = uploadDir;
  }

  _handleFile(_req, file, cb) {
    const finalPath = path.join(this.uploadDir, crypto.randomBytes(16).toString('hex'));
    const writeStream = fs.createWriteStream(finalPath);
    const mbps = configStore.get().uploadRateLimitMbps;
    const bytesPerSec = mbps > 0 ? mbps * 1024 * 1024 : 0;
    const source = bytesPerSec > 0 ? file.stream.pipe(new ThrottleTransform(bytesPerSec)) : file.stream;

    let size = 0;
    source.on('data', (chunk) => { size += chunk.length; });
    source.on('error', (err) => { writeStream.destroy(); cb(err); });
    writeStream.on('error', cb);
    writeStream.on('finish', () => cb(null, { path: finalPath, size }));
    source.pipe(writeStream);
  }

  _removeFile(_req, file, cb) {
    fs.unlink(file.path, () => cb());
  }
}

function throttledDiskStorage(opts) {
  return new ThrottledDiskStorage(opts);
}

module.exports = { throttledDiskStorage, ThrottleTransform };
