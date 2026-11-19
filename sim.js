"use strict";

(() => {
  const [BELL, CHERRY, FREEZE, WATERMELON, CHANCE, REPLAY, MISS] = [0, 1, 2, 3, 4, 5, 6];
  const [A, B, HEAVEN] = [0, 1, 2];
  const seed = 20261118;
  const setGames = 50;
  const flagCounts = [942 + 942 + 8741 + 8741 + 8741 + 8742, 1024, 8, 512, 256, 8978, 17909];
  const flagLimits = flagCounts.map((_, index) => flagCounts.slice(0, index + 1).reduce((a, b) => a + b));
  const payouts = [1, 4, 2, 6, 12, 0, 0];
  const czTrigger = { [CHERRY]: .25, [WATERMELON]: .50, [CHANCE]: .75 };
  const accelTrigger = { [CHERRY]: .50, [WATERMELON]: .50, [CHANCE]: .25 };
  const stockAwards = { [CHERRY]: [75, 20, 4, 1], [WATERMELON]: [75, 10, 10, 5], [CHANCE]: [0, 80, 10, 10] };
  const tables = [
    [[100, 150, 200, 250, 300, 350, 400, 450, 500], [5, 5, 10, 10, 30, 10, 10, 10, 10]],
    [[100, 150, 200, 250, 300], [10, 10, 15, 15, 50]],
    [[50, 100], [25, 75]],
  ];
  const transitions = [[50, 30, 20], [70, 20, 10], [50, 25, 25]];
  const baseline = Object.freeze({
    tables, thresholdMultiplier: 1, rareCzMultiplier: 1, czSpecialRate: 1,
    strongStockRate: .10, freezeExtension: 100, restartStocks: 2, returnStockRate: .01,
    accelerationEnabled: false, specialAddedGamesRate: .50,
  });

  // CPython Random: MT19937 with integer seed words in little-endian order.
  class Random {
    constructor(seedValue) {
      let value = BigInt(seedValue);
      if (value < 0n) value = -value;
      const words = [];
      do {
        words.push(Number(value & 0xffffffffn));
        value >>= 32n;
      } while (value);
      const state = this.state = new Uint32Array(624);
      state[0] = 19650218;
      for (let i = 1; i < 624; i++) {
        const prev = state[i - 1];
        state[i] = Math.imul(prev ^ (prev >>> 30), 1812433253) + i;
      }
      let i = 1;
      let j = 0;
      for (let k = Math.max(624, words.length); k > 0; k--) {
        const prev = state[i - 1];
        state[i] = (state[i] ^ Math.imul(prev ^ (prev >>> 30), 1664525)) + words[j] + j;
        if (++i === 624) { state[0] = state[623]; i = 1; }
        if (++j === words.length) j = 0;
      }
      for (let k = 623; k > 0; k--) {
        const prev = state[i - 1];
        state[i] = (state[i] ^ Math.imul(prev ^ (prev >>> 30), 1566083941)) - i;
        if (++i === 624) { state[0] = state[623]; i = 1; }
      }
      state[0] = 0x80000000;
      this.index = 624;
      this.gaussNext = null;
    }

    uint32() {
      const state = this.state;
      if (this.index === 624) {
        for (let i = 0; i < 624; i++) {
          const bits = (state[i] & 0x80000000) | (state[(i + 1) % 624] & 0x7fffffff);
          state[i] = state[(i + 397) % 624] ^ (bits >>> 1) ^ ((bits & 1) ? 0x9908b0df : 0);
        }
        this.index = 0;
      }
      let y = state[this.index++];
      y ^= y >>> 11;
      y ^= (y << 7) & 0x9d2c5680;
      y ^= (y << 15) & 0xefc60000;
      return (y ^ (y >>> 18)) >>> 0;
    }

    trialSeed() {
      const low = BigInt(this.uint32());
      return low | (BigInt(this.uint32()) << 32n);
    }

    below(n) {
      const shift = Math.clz32(n);
      let value;
      do { value = this.uint32() >>> shift; } while (value >= n);
      return value;
    }

    random() {
      return ((this.uint32() >>> 5) * 67108864 + (this.uint32() >>> 6)) / 9007199254740992;
    }

    weighted(values, weights) {
      const target = this.random() * weights.reduce((a, b) => a + b);
      let cumulative = 0;
      for (let i = 0; i < weights.length - 1; i++) {
        cumulative += weights[i];
        if (target < cumulative) return values[i];
      }
      return values[values.length - 1];
    }

    gauss() {
      let z = this.gaussNext;
      this.gaussNext = null;
      if (z === null) {
        const angle = this.random() * (2 * Math.PI);
        const radius = Math.sqrt(-2 * Math.log(1 - this.random()));
        z = Math.cos(angle) * radius;
        this.gaussNext = Math.sin(angle) * radius;
      }
      return -1000 + z * 1000;
    }
  }

  function drawStartNet(rng) {
    let value;
    do { value = rng.gauss(); } while (value < -5000 || value > 999);
    const floor = Math.floor(value);
    return value - floor === .5 && floor % 2 === 0 ? floor : Math.round(value) || 0;
  }

  function spin(rng, mode) {
    const ticket = rng.below(65536);
    let flag = BELL;
    while (flag < MISS && ticket >= flagLimits[flag]) flag++;
    let payout = payouts[flag];
    if (flag === BELL && (mode === 6 || (mode === 3 && rng.random() < .619) || (mode === 0 && ticket < 942))) {
      payout = 15;
    }
    return [flag, payout];
  }

  const netPayout = (flag, payout) => flag === REPLAY ? payout : payout - 3;
  const czHit = flag => flag >= CHERRY && flag <= REPLAY;
  const increment = (counts, key, amount = 1) => { counts[key] = (counts[key] ?? 0) + amount; };

  class Stocks {
    constructor(weak = 0) {
      this.weak = weak;
      this.strong = 0;
    }

    get count() { return this.weak + this.strong; }

    add(rng, strongRate, count = 1) {
      for (let i = 0; i < count; i++) {
        if (rng.random() < strongRate) this.strong++;
        else this.weak++;
      }
    }

    take() {
      if (this.strong) {
        this.strong--;
        return 6;
      }
      this.weak--;
      return 3;
    }
  }

  class AT {
    constructor(rng, startNet, parameters) {
      this.rng = rng;
      this.p = parameters;
      this.zoneNet = startNet ?? drawStartNet(rng);
      this.result = {
        startNet: this.zoneNet, setLimited: false, net: 0, games: 0, sets: 0,
        cz: 0, tableCz: 0, czSpecials: 0, specials: 0, freezes: 0, cuts: 0,
        cutStockActivations: 0, cutStockCuts: 0, endingStocks: {}, returns: 0,
        gapDirectEntries: 0, gapGames: 0, gapNet: 0, reached2000: false, setGames: {},
        setNet: {}, accelerationActivations: 0, maxAccelerationMultiplier: 1,
        specialRewards: { normal: {}, freeze: {} },
      };
      this.stocks = new Stocks();
      this.pool = new Stocks();
      this.initialZoneEligibleFor2000 = this.zoneNet <= -999;
      this.ending = false;
      this.cutAfterSet = false;
      this.mode = 3;
      this.remaining = 100;
      this.resetAcceleration();
      this.resetTable(B);
    }

    resetAcceleration() {
      this.accelerationMultiplier = 1;
      this.accelerationRemaining = 0;
      this.rarePreludes = [];
    }

    resetTable(table) {
      this.table = table;
      const [values, weights] = this.p.tables[table];
      this.threshold = this.rng.weighted(values, weights) * this.p.thresholdMultiplier;
      this.tableNet = 0;
    }

    atSpin(regular = false) {
      const [flag, payout] = spin(this.rng, this.mode);
      const net = netPayout(flag, payout);
      const result = this.result;
      result.games++;
      result.net += net;
      result.reached2000 ||= result.net >= 2000;
      this.zoneNet += net;
      if (regular) {
        increment(result.setGames, this.mode);
        increment(result.setNet, this.mode, net);
      }
      this.checkEnding();
      return [flag, payout];
    }

    checkEnding() {
      if (this.zoneNet > 2200 && !this.ending) {
        this.ending = true;
        increment(this.result.endingStocks, this.stocks.count);
      }
    }

    award(flag, frozen = false, cz = false) {
      let count = stockAwards[flag] ? this.rng.weighted([2, 3, 4, 5], stockAwards[flag]) : 1;
      if (frozen) {
        this.stocks.strong += count;
        return;
      }
      if (cz && count >= 3 && this.rng.random() >= .25) {
        this.pool.add(this.rng, this.p.strongStockRate, count - 2);
        count = 2;
      }
      this.stocks.add(this.rng, this.p.strongStockRate, count);
    }

    freeze() {
      this.result.freezes++;
      this.remaining += this.p.freezeExtension;
      this.stocks.weak++;
    }

    playSpecialZone(frozen) {
      this.result.specials++;
      const rewards = this.result.specialRewards[frozen ? "freeze" : "normal"];
      increment(rewards, "entries");
      while (!this.ending) {
        const [flag, payout] = this.atSpin();
        if (this.ending) return false;
        if (flag === FREEZE) return true;
        if (!(czHit(flag) || (flag === BELL && payout === 15))) return false;
        const rate = this.p.specialAddedGamesRate;
        if (rate && this.rng.random() < rate) {
          const games = this.rng.weighted([10, 20, 30, 50, 100, 300], [7500, 2000, 450, 40, 9, 1]);
          this.remaining += games;
          increment(rewards, "gameAwards");
          increment(rewards, "addedGames", games);
        } else {
          const { weak, strong } = this.stocks;
          this.award(flag, frozen);
          increment(rewards, "stockAwards");
          increment(rewards, "weakStocks", this.stocks.weak - weak);
          increment(rewards, "strongStocks", this.stocks.strong - strong);
        }
      }
      return false;
    }

    special(frozen = false) {
      while (this.playSpecialZone(frozen)) {
        this.freeze();
        frozen = true;
      }
    }

    playCz(fromTable = false) {
      this.result.cz++;
      if (fromTable) this.result.tableCz++;
      for (let game = 0; game < 3 && !this.ending; game++) {
        const [flag] = this.atSpin();
        if (this.ending) break;
        if (flag === FREEZE) {
          this.freeze();
          this.special(true);
        } else if (czHit(flag)) {
          this.award(flag, false, true);
          if (game === 2 && (this.p.czSpecialRate === 1 || this.rng.random() < this.p.czSpecialRate)) {
            this.result.czSpecials++;
            this.special();
          }
        } else if (this.rng.random() < this.p.returnStockRate) {
          this.pool.add(this.rng, this.p.strongStockRate);
        }
      }
    }

    countTableNet(net, inPrelude) {
      let counted = Math.max(net, 0);
      if (this.accelerationRemaining && !inPrelude) {
        counted *= this.accelerationMultiplier;
        if (--this.accelerationRemaining === 0) this.accelerationMultiplier = 1;
      }
      this.tableNet += counted;
    }

    resolveRarePreludes(finalGame) {
      while (this.rarePreludes.length && !this.ending) {
        const prelude = this.rarePreludes[0];
        if (prelude.delay && !finalGame) break;
        this.rarePreludes.shift();
        if (prelude.outcome === "cz") this.playCz();
        if (prelude.outcome === "acceleration") {
          this.accelerationRemaining = 10;
          this.accelerationMultiplier++;
          this.result.accelerationActivations++;
          this.result.maxAccelerationMultiplier = Math.max(this.result.maxAccelerationMultiplier, this.accelerationMultiplier);
        }
      }
    }

    playSetGame() {
      this.remaining--;
      const [flag, payout] = this.atSpin(true);
      if (this.ending) return;
      const prelude = this.rarePreludes[0];
      this.countTableNet(netPayout(flag, payout), Boolean(prelude));
      const tableHit = this.tableNet >= this.threshold;
      if (tableHit) this.resetTable(this.rng.weighted([A, B, HEAVEN], transitions[this.table]));
      if (prelude) prelude.delay--;
      let rareHit = false;
      if (czTrigger[flag] !== undefined) {
        const draw = this.rng.random();
        const czRate = czTrigger[flag] * this.p.rareCzMultiplier;
        if (this.p.accelerationEnabled) {
          let outcome = "none";
          if (draw < czRate) outcome = "cz";
          else if (draw < czRate + accelTrigger[flag]) outcome = "acceleration";
          this.rarePreludes.push({ delay: 2 + this.rng.below(7), outcome });
        } else {
          rareHit = draw < czRate;
        }
      }
      if (flag === FREEZE) {
        this.freeze();
        this.special(true);
      }
      if (rareHit && !this.ending) this.playCz();
      this.resolveRarePreludes(this.remaining === 0);
      if (tableHit && !this.ending) this.playCz(true);
    }

    gapSpin() {
      this.result.games++;
      this.result.gapGames++;
      const [flag, payout] = spin(this.rng, 0);
      const net = netPayout(flag, payout);
      this.result.gapNet += net;
      return [flag, net];
    }

    cutZone() {
      this.result.cuts++;
      this.gapSpin();
      this.zoneNet = 0;
      this.initialZoneEligibleFor2000 = false;
      this.resetAcceleration();
    }

    startNewZoneAfterCut() {
      this.cutZone();
      this.ending = this.cutAfterSet = false;
      this.mode = 3;
      this.remaining = setGames;
      this.stocks = new Stocks(this.p.restartStocks);
      this.pool = new Stocks();
      this.resetTable(this.rng.below(3));
    }

    playReturnWindow() {
      this.resetAcceleration();
      if (this.rng.random() < this.p.returnStockRate) {
        this.pool.add(this.rng, this.p.strongStockRate);
      }
      for (let game = 0; game < 32; game++) {
        const [flag, net] = this.gapSpin();
        this.zoneNet += net;
        if (this.zoneNet >= 2400) this.cutZone();
        if (flag === FREEZE) {
          this.result.gapDirectEntries++;
          this.stocks.weak += this.pool.weak;
          this.stocks.strong += this.pool.strong + 1;
          this.pool = new Stocks();
          this.mode = 3;
          this.remaining = 100;
          this.resetTable(B);
          return true;
        }
      }
      if (!this.pool.count) return false;
      this.result.returns++;
      this.stocks = this.pool;
      this.pool = new Stocks();
      this.startStockSet();
      return true;
    }

    startStockSet(afterSet = false) {
      this.remaining = setGames;
      const meets2000Condition = this.initialZoneEligibleFor2000 && this.result.net >= 2000;
      this.cutAfterSet = afterSet && !this.stocks.strong && this.stocks.weak >= 1
        && this.stocks.weak <= 3 && (meets2000Condition || this.zoneNet > 1000);
      this.mode = this.stocks.take();
      if (this.cutAfterSet) this.result.cutStockActivations++;
    }

    run(maxSets) {
      while (this.result.sets !== maxSets) {
        this.result.sets++;
        this.checkEnding();
        while (this.remaining && !this.ending) this.playSetGame();
        if (this.ending) {
          while (this.zoneNet < 2400) this.atSpin();
          this.startNewZoneAfterCut();
        } else if (this.cutAfterSet) {
          this.result.cutStockCuts++;
          this.startNewZoneAfterCut();
        } else if (this.stocks.count) {
          if (this.result.sets === maxSets) break;
          this.startStockSet(true);
        } else if (!this.playReturnWindow()) {
          return this.result;
        }
      }
      this.result.setLimited = true;
      return this.result;
    }
  }

  function* simulateTrials({ trials = 10000, seed: seedValue = seed, startNet = null, maxSets = null, parameters = {} } = {}) {
    if (!Number.isSafeInteger(trials) || trials < 1) throw new RangeError("trials must be a positive integer");
    if (maxSets !== null && (!Number.isSafeInteger(maxSets) || maxSets < 1)) throw new RangeError("maxSets must be a positive integer");
    const p = { ...baseline, ...parameters };
    const rng = new Random(seedValue);
    for (let i = 0; i < trials; i++) {
      yield new AT(new Random(rng.trialSeed()), startNet, p).run(maxSets);
    }
  }

  const simulate = options => Array.from(simulateTrials(options));

  function summarize(results) {
    const trials = results.length;
    const net = results.map(result => result.net).sort((a, b) => a - b);
    const mean = field => results.reduce((total, result) => total + result[field], 0) / trials;
    const rate = predicate => results.filter(predicate).length / trials;
    const meanNet = mean("net");
    const meanSets = mean("sets");
    const tableCzPerSet = mean("tableCz") / meanSets;
    const rareCzPerSet = mean("cz") / meanSets - tableCzPerSet;
    return {
      trials, meanNet, meanSets, minNet: net[0], maxNet: net[trials - 1],
      medianNet: (net[Math.floor((trials - 1) / 2)] + net[Math.floor(trials / 2)]) / 2,
      endingRate: rate(result => Object.keys(result.endingStocks).length > 0),
      zoneCutRate: rate(result => result.cuts > 0),
      cutStockActivationRate: rate(result => result.cutStockActivations > 0),
      returnRate: rate(result => result.returns > 0),
      freezeRate: rate(result => result.freezes > 0),
      tableCzPerSet, rareCzPerSet,
    };
  }

  const api = { simulate, simulateTrials, summarize };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
    if (require.main === module) {
      const assert = require("node:assert/strict");
      const results = simulate();
      const summary = summarize(results);
      const reference = { meanNet: 2572.9, medianNet: 768.5, endingRate: .2364, meanSets: 12.31 };
      const meanRelativeError = (summary.meanNet - reference.meanNet) / reference.meanNet;
      console.log(JSON.stringify({ summary, reference, meanRelativeError }, null, 2));
      assert.ok(Math.abs(meanRelativeError) <= .05, "Mean differs from Python by more than 5%");
      for (const [metric, value] of Object.entries(reference)) {
        const digits = { meanNet: 1, medianNet: 1, endingRate: 4, meanSets: 2 }[metric];
        assert.equal(Number(summary[metric].toFixed(digits)), value, metric);
      }
      if (process.argv[2]) {
        const python = JSON.parse(require("node:fs").readFileSync(process.argv[2], "utf8"));
        assert.deepEqual(results.map(result => result.net), python.net);
        console.log("Python と全試行の差枚が一致しました。");
      }
      console.log("ベースライン検証に合格しました。");
    }
  } else {
    globalThis.ATSimulator = api;
  }
})();
