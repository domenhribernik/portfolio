// Xorshift32 seeded PRNG — portable, reproducible across sessions
export class PRNG {
  constructor(seed) {
    this.state = seed >>> 0 || 1;
  }

  next() {
    let x = this.state;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 0x100000000;
  }

  // integer in [0, n)
  int(n) { return Math.floor(this.next() * n); }

  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}
