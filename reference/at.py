"""Setting 1 AT simulation."""
from bisect import bisect_right
from collections import Counter, deque
from dataclasses import dataclass, field
from itertools import accumulate
from random import Random
from statistics import median


BELL, CHERRY, FREEZE, WATERMELON, CHANCE, REPLAY, MISS = range(7)
BELL_ORDERS = (942, 942, 8741, 8741, 8741, 8742)
FLAGS = (sum(BELL_ORDERS), 1024, 8, 512, 256, 8978, 17909)
FLAG_LIMITS = tuple(accumulate(FLAGS))
PAYOUTS = (1, 4, 2, 6, 12, 0, 0)
CZ_TRIGGER = {CHERRY: 0.25, WATERMELON: 0.50, CHANCE: 0.75}
ACCEL_TRIGGER = {CHERRY: 0.50, WATERMELON: 0.50, CHANCE: 0.25}
SPECIAL_ADDED_GAMES = (10, 20, 30, 50, 100, 300)
SPECIAL_ADDED_WEIGHTS = (7500, 2000, 450, 40, 9, 1)
STOCK_AWARDS = {
    CHERRY: (75, 20, 4, 1),
    WATERMELON: (75, 10, 10, 5),
    CHANCE: (0, 80, 10, 10),
}
A, B, HEAVEN = range(3)
TABLES = (
    ((100, 150, 200, 250, 300, 350, 400, 450, 500), (5, 5, 10, 10, 30, 10, 10, 10, 10)),
    ((100, 150, 200, 250, 300), (10, 10, 15, 15, 50)),
    ((50, 100), (25, 75)),
)
TRANSITIONS = ((50, 30, 20), (70, 20, 10), (50, 25, 25))
SEED = 20261118
TRIALS = 10_000
SET_GAMES = 50
STRONG_STOCK_RATE = 0.10


@dataclass(frozen=True)
class ATParameters:
    tables: tuple = TABLES
    rare_cz_multiplier: float = 1.0
    cz_special_rate: float = 1.0
    strong_stock_rate: float = STRONG_STOCK_RATE
    freeze_extension: int = 100
    restart_stocks: int = 2
    return_stock_rate: float = 0.01
    acceleration_enabled: bool = False
    special_added_games_rate: float = 0.5


BASELINE = ATParameters()


def draw_start_net(rng):
    while True:
        value = rng.gauss(-1000, 1000)
        if -5000 <= value <= 999:
            return round(value)


def spin(rng, mode):
    """Return flag and payout. Mode 0 uses a fixed legal stop order."""
    ticket = rng.randrange(65536)
    flag = bisect_right(FLAG_LIMITS, ticket)
    payout = PAYOUTS[flag]
    if flag == BELL:
        if mode == 6 or (mode == 3 and rng.random() < 0.619):
            payout = 15
        elif mode == 0 and ticket < BELL_ORDERS[0]:
            payout = 15
    return flag, payout


def net_payout(flag, payout):
    return payout if flag == REPLAY else payout - 3


def cz_hit(flag):
    return CHERRY <= flag <= REPLAY


@dataclass
class Stocks:
    weak: int = 0
    strong: int = 0

    @property
    def count(self):
        return self.weak + self.strong

    def add(self, rng, count=1, *, strong_rate=STRONG_STOCK_RATE):
        for _ in range(count):
            if rng.random() < strong_rate:
                self.strong += 1
            else:
                self.weak += 1

    def take(self):
        if self.strong:
            self.strong -= 1
            return 6
        self.weak -= 1
        return 3


@dataclass
class Result:
    start_net: int = 0
    set_limited: bool = False
    net: int = 0
    games: int = 0
    sets: int = 0
    cz: int = 0
    table_cz: int = 0
    cz_specials: int = 0
    specials: int = 0
    freezes: int = 0
    cuts: int = 0
    cut_stock_activations: int = 0
    cut_stock_cuts: int = 0
    ending_stocks: Counter = field(default_factory=Counter)
    returns: int = 0
    gap_direct_entries: int = 0
    gap_games: int = 0
    gap_net: int = 0
    reached_2000: bool = False
    set_games: Counter = field(default_factory=Counter)
    set_net: Counter = field(default_factory=Counter)
    acceleration_activations: int = 0
    max_acceleration_multiplier: int = 1
    special_rewards: Counter = field(default_factory=Counter)


class AT:
    def __init__(self, rng, start_net=None, parameters=BASELINE):
        self.rng = rng
        self.parameters = parameters
        self.zone_net = draw_start_net(rng) if start_net is None else start_net
        self.result = Result(start_net=self.zone_net)
        self.stocks = Stocks()
        self.pool = Stocks()
        self.initial_zone_eligible_for_2000 = self.zone_net <= -999
        self.ending = False
        self.cut_after_set = False
        self.mode = 3
        self.remaining = 100
        self.rare_preludes = deque()
        self.reset_acceleration()
        self.reset_table(B)

    def reset_acceleration(self):
        self.acceleration_multiplier = 1
        self.acceleration_remaining = 0
        self.rare_preludes.clear()

    def reset_table(self, table):
        self.table = table
        values, weights = self.parameters.tables[table]
        self.threshold = self.rng.choices(values, weights)[0]
        self.table_net = 0

    def at_spin(self, regular=False):
        flag, payout = spin(self.rng, self.mode)
        net = net_payout(flag, payout)
        result = self.result
        result.games += 1
        result.net += net
        result.reached_2000 |= result.net >= 2000
        self.zone_net += net
        if regular:
            result.set_games[self.mode] += 1
            result.set_net[self.mode] += net
        self.check_ending()
        return flag, payout

    def check_ending(self):
        if self.zone_net > 2200 and not self.ending:
            self.ending = True
            self.result.ending_stocks[self.stocks.count] += 1

    def award(self, flag, frozen=False, cz=False):
        count = 1
        if flag in STOCK_AWARDS:
            count = self.rng.choices(range(2, 6), STOCK_AWARDS[flag])[0]
        if frozen:
            self.stocks.strong += count
            return
        if cz and count >= 3 and self.rng.random() >= 0.25:
            self.pool.add(self.rng, count - 2, strong_rate=self.parameters.strong_stock_rate)
            count = 2
        self.stocks.add(self.rng, count, strong_rate=self.parameters.strong_stock_rate)

    def freeze(self):
        self.result.freezes += 1
        self.remaining += self.parameters.freeze_extension
        self.stocks.weak += 1

    def play_special_zone(self, frozen):
        self.result.specials += 1
        rewards = self.result.special_rewards
        rewards[frozen, "entries"] += 1
        while not self.ending:
            flag, payout = self.at_spin()
            if self.ending:
                return False
            if flag == FREEZE:
                return True
            if not (cz_hit(flag) or (flag == BELL and payout == 15)):
                return False
            if (
                self.parameters.special_added_games_rate
                and self.rng.random() < self.parameters.special_added_games_rate
            ):
                games = self.rng.choices(SPECIAL_ADDED_GAMES, SPECIAL_ADDED_WEIGHTS)[0]
                self.remaining += games
                rewards[frozen, "game_awards"] += 1
                rewards[frozen, "added_games"] += games
            else:
                weak, strong = self.stocks.weak, self.stocks.strong
                self.award(flag, frozen=frozen)
                rewards[frozen, "stock_awards"] += 1
                rewards[frozen, "weak_stocks"] += self.stocks.weak - weak
                rewards[frozen, "strong_stocks"] += self.stocks.strong - strong
        return False

    def special(self, frozen=False):
        while self.play_special_zone(frozen):
            self.freeze()
            frozen = True

    def play_cz(self, from_table=False):
        self.result.cz += 1
        self.result.table_cz += from_table
        for game in range(3):
            flag, _ = self.at_spin()
            if self.ending:
                break
            if flag == FREEZE:
                self.freeze()
                self.special(frozen=True)
            elif cz_hit(flag):
                self.award(flag, cz=True)
                if game == 2 and (
                    self.parameters.cz_special_rate == 1.0
                    or self.rng.random() < self.parameters.cz_special_rate
                ):
                    self.result.cz_specials += 1
                    self.special()
            elif self.rng.random() < self.parameters.return_stock_rate:
                self.pool.add(self.rng, strong_rate=self.parameters.strong_stock_rate)
            if self.ending:
                break

    def count_table_net(self, net, in_prelude):
        counted = max(net, 0)
        if self.acceleration_remaining and not in_prelude:
            counted *= self.acceleration_multiplier
            self.acceleration_remaining -= 1
            if not self.acceleration_remaining:
                self.acceleration_multiplier = 1
        self.table_net += counted

    def resolve_rare_preludes(self, final_game):
        while self.rare_preludes and not self.ending:
            delay, outcome = self.rare_preludes[0]
            if delay and not final_game:
                break
            self.rare_preludes.popleft()
            if outcome == "cz":
                self.play_cz()
            elif outcome == "acceleration":
                self.acceleration_remaining = 10
                self.acceleration_multiplier += 1
                self.result.acceleration_activations += 1
                self.result.max_acceleration_multiplier = max(
                    self.result.max_acceleration_multiplier, self.acceleration_multiplier
                )

    def play_set_game(self):
        self.remaining -= 1
        flag, payout = self.at_spin(regular=True)
        if self.ending:
            return
        in_prelude = bool(self.rare_preludes)
        self.count_table_net(net_payout(flag, payout), in_prelude)
        table_hit = self.table_net >= self.threshold
        if table_hit:
            self.reset_table(self.rng.choices(range(len(TABLES)), TRANSITIONS[self.table])[0])
        if in_prelude:
            delay, outcome = self.rare_preludes[0]
            self.rare_preludes[0] = (delay - 1, outcome)
        rare_hit = False
        if flag in CZ_TRIGGER:
            draw = self.rng.random()
            cz_rate = CZ_TRIGGER[flag] * self.parameters.rare_cz_multiplier
            if self.parameters.acceleration_enabled:
                outcome = "none"
                if draw < cz_rate:
                    outcome = "cz"
                elif draw < cz_rate + ACCEL_TRIGGER[flag]:
                    outcome = "acceleration"
                self.rare_preludes.append((self.rng.randint(2, 8), outcome))
            else:
                rare_hit = draw < cz_rate
        if flag == FREEZE:
            self.freeze()
            self.special(frozen=True)
        if rare_hit and not self.ending:
            self.play_cz()
        self.resolve_rare_preludes(final_game=self.remaining == 0)
        if table_hit and not self.ending:
            self.play_cz(from_table=True)

    def gap_spin(self):
        self.result.games += 1
        self.result.gap_games += 1
        flag, payout = spin(self.rng, 0)
        net = net_payout(flag, payout)
        self.result.gap_net += net
        return flag, net

    def cut_zone(self):
        self.result.cuts += 1
        self.gap_spin()
        self.zone_net = 0
        self.initial_zone_eligible_for_2000 = False
        self.reset_acceleration()

    def start_new_zone_after_cut(self):
        self.cut_zone()
        self.ending = self.cut_after_set = False
        self.mode, self.remaining = 3, SET_GAMES
        self.stocks = Stocks(weak=self.parameters.restart_stocks)
        self.pool = Stocks()
        self.reset_table(self.rng.choice((A, B, HEAVEN)))

    def play_return_window(self):
        self.reset_acceleration()
        if self.rng.random() < self.parameters.return_stock_rate:
            self.pool.add(self.rng, strong_rate=self.parameters.strong_stock_rate)
        for _ in range(32):
            flag, net = self.gap_spin()
            self.zone_net += net
            if self.zone_net >= 2400:
                self.cut_zone()
            if flag == FREEZE:
                self.result.gap_direct_entries += 1
                self.stocks.weak += self.pool.weak
                self.stocks.strong += self.pool.strong + 1
                self.pool = Stocks()
                self.mode, self.remaining = 3, 100
                self.reset_table(B)
                return True

        if not self.pool.count:
            return False
        self.result.returns += 1
        self.stocks, self.pool = self.pool, Stocks()
        self.start_stock_set()
        return True

    def start_stock_set(self, after_set=False):
        self.remaining = SET_GAMES
        meets_2000_condition = self.initial_zone_eligible_for_2000 and self.result.net >= 2000
        self.cut_after_set = (
            after_set
            and not self.stocks.strong
            and 1 <= self.stocks.weak <= 3
            and (meets_2000_condition or self.zone_net > 1000)
        )
        # Eligible weak stocks are exchangeable. A uniform choice removes
        # one weak stock, exactly as in an ordinary weak-stock release.
        self.mode = self.stocks.take()
        self.result.cut_stock_activations += self.cut_after_set

    def run(self, max_sets=None):
        while True:
            if self.result.sets == max_sets:
                self.result.set_limited = True
                return self.result
            self.result.sets += 1
            self.check_ending()
            while self.remaining and not self.ending:
                self.play_set_game()
            if self.ending:
                while self.zone_net < 2400:
                    self.at_spin()
                self.start_new_zone_after_cut()
                continue
            if self.cut_after_set:
                self.result.cut_stock_cuts += 1
                self.start_new_zone_after_cut()
                continue

            if self.stocks.count:
                if self.result.sets == max_sets:
                    self.result.set_limited = True
                    return self.result
                self.start_stock_set(after_set=True)
            elif not self.play_return_window():
                return self.result


def simulate(trials=TRIALS, seed=SEED, start_net=None, max_sets=None, *, parameters=BASELINE):
    if trials < 1:
        raise ValueError("trials must be positive")
    if max_sets is not None and max_sets < 1:
        raise ValueError("max_sets must be positive")
    rng = Random(seed)
    # A shared trial seed keeps starting conditions aligned across scenarios.
    return [
        AT(Random(rng.getrandbits(64)), start_net, parameters).run(max_sets)
        for _ in range(trials)
    ]


def summarize(results):
    count = len(results)
    totals = {key: sum(getattr(r, key) for r in results) for key in (
        "net", "games", "sets", "cz", "table_cz", "cz_specials", "specials", "gap_games"
    )}
    distribution = Counter(r.sets for r in results)
    ending_stocks = Counter()
    special_rewards = Counter()
    for result in results:
        ending_stocks.update(result.ending_stocks)
        special_rewards.update(result.special_rewards)
    net = [r.net for r in results]
    accelerations = sum(r.acceleration_activations for r in results)
    return {
        "trials": count,
        "set_limited_trials": sum(r.set_limited for r in results),
        "mean_net": totals["net"] / count,
        "mean_games": totals["games"] / count,
        "mean_sets": totals["sets"] / count,
        "min_net": min(net),
        "median_net": median(net),
        "max_net": max(net),
        "reached_2000_rate": sum(r.reached_2000 for r in results) / count,
        "set_counts": dict(sorted(distribution.items())),
        "next_set_rate": (totals["sets"] - count) / totals["sets"],
        "net_per_set_game": {
            mode: (
                sum(r.set_net[mode] for r in results) / games if games else None
            )
            for mode in (3, 6)
            for games in [sum(r.set_games[mode] for r in results)]
        },
        "cz_per_set": totals["cz"] / totals["sets"],
        "table_cz_per_set": totals["table_cz"] / totals["sets"],
        "rare_cz_per_set": (totals["cz"] - totals["table_cz"]) / totals["sets"],
        "special_entry_per_cz": totals["cz_specials"] / totals["cz"] if totals["cz"] else None,
        "specials_per_trial": totals["specials"] / count,
        "special_trial_rate": sum(r.specials > 0 for r in results) / count,
        "acceleration_activations": accelerations,
        "acceleration_activations_per_trial": accelerations / count,
        "max_acceleration_multiplier_counts": dict(sorted(
            Counter(r.max_acceleration_multiplier for r in results).items()
        )),
        "special_rewards": {
            "all": summarize_special_rewards(special_rewards, (False, True)),
            "normal": summarize_special_rewards(special_rewards, (False,)),
            "freeze": summarize_special_rewards(special_rewards, (True,)),
        },
        "freeze_rate": sum(r.freezes > 0 for r in results) / count,
        "zone_cuts": sum(r.cuts for r in results),
        "zone_cut_rate": sum(r.cuts > 0 for r in results) / count,
        "cut_stock_activations": sum(r.cut_stock_activations for r in results),
        "cut_stock_activation_rate": sum(r.cut_stock_activations > 0 for r in results) / count,
        "cut_stock_cuts": sum(r.cut_stock_cuts for r in results),
        "endings": sum(ending_stocks.values()),
        "ending_rate": sum(bool(r.ending_stocks) for r in results) / count,
        "ending_stock_counts": dict(sorted(ending_stocks.items())),
        "return_rate": sum(r.returns > 0 for r in results) / count,
        "gap_direct_entry_rate": sum(r.gap_direct_entries > 0 for r in results) / count,
        "mean_gap_games": totals["gap_games"] / count,
        "mean_gap_net": sum(r.gap_net for r in results) / count,
        "mean_net_including_gaps": sum(r.net + r.gap_net for r in results) / count,
    }


def summarize_special_rewards(rewards, kinds):
    totals = {
        name: sum(rewards[kind, name] for kind in kinds)
        for name in ("entries", "stock_awards", "game_awards", "weak_stocks", "strong_stocks", "added_games")
    }
    entries = totals["entries"]
    stocks = totals["weak_stocks"] + totals["strong_stocks"]
    return {
        **totals,
        "stocks_per_entry": stocks / entries if entries else None,
        "weak_stocks_per_entry": totals["weak_stocks"] / entries if entries else None,
        "strong_stocks_per_entry": totals["strong_stocks"] / entries if entries else None,
        "added_games_per_entry": totals["added_games"] / entries if entries else None,
    }
