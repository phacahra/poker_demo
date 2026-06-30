/* =========================================================================
 *  poker-engine.js  —  แกนหลักของระบบโป๊กเกอร์ (ไม่พึ่ง DOM, ใช้ซ้ำได้)
 *  - การ์ด / สำรับ / สับไพ่
 *  - ตัวประเมินไพ่ 5-7 ใบ (hand evaluator)
 *  - Monte Carlo equity (คำนวณ % โอกาสชนะ)
 *  ทุกอย่างเป็น pure functions เพื่อให้ทดสอบและนำไปใช้ซ้ำได้ง่าย
 * ========================================================================= */

(function (global) {
  'use strict';

  /* ----- ค่าคงที่พื้นฐาน ----------------------------------------------- */
  // อันดับไพ่: 2..14 (J=11, Q=12, K=13, A=14)
  const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
  // ดอก: 0=♣ clubs, 1=♦ diamonds, 2=♥ hearts, 3=♠ spades
  const SUITS = [0, 1, 2, 3];
  const SUIT_SYMBOL = ['♣', '♦', '♥', '♠'];
  const SUIT_NAME_TH = ['ดอกจิก', 'ข้าวหลามตัด', 'โพแดง', 'โพดำ'];
  const RANK_LABEL = {
    2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
    10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A',
  };

  // ชื่อหมวดไพ่ (เรียงจากต่ำ 0 ไปสูง 9)
  const CATEGORY_TH = [
    'ไพ่สูง (High Card)',
    'วันแพร์ (One Pair)',
    'ทูแพร์ (Two Pair)',
    'ตอง (Three of a Kind)',
    'สเตรท (Straight)',
    'ฟลัช (Flush)',
    'ฟูลเฮาส์ (Full House)',
    'โฟร์การ์ด (Four of a Kind)',
    'สเตรทฟลัช (Straight Flush)',
    'รอยัลฟลัช (Royal Flush)',
  ];

  /* ----- การ์ด --------------------------------------------------------- */
  // การ์ดเก็บเป็น object { rank, suit } — แต่ภายในใช้ integer id (0..51) ก็ได้
  function makeCard(rank, suit) {
    return { rank: rank, suit: suit };
  }
  function cardId(card) {
    return (card.rank - 2) * 4 + card.suit; // 0..51
  }
  function cardLabel(card) {
    return RANK_LABEL[card.rank] + SUIT_SYMBOL[card.suit];
  }
  function isRed(card) {
    return card.suit === 1 || card.suit === 2;
  }
  // แปลง string เช่น "As", "Td", "9c" -> card
  function parseCard(str) {
    str = str.trim();
    if (str.length < 2) return null;
    const rankPart = str.slice(0, -1).toUpperCase();
    const suitPart = str.slice(-1).toLowerCase();
    const rankMap = { A: 14, K: 13, Q: 12, J: 11, T: 10, '10': 10 };
    const rank = rankMap[rankPart] || parseInt(rankPart, 10);
    const suitMap = { c: 0, d: 1, h: 2, s: 3 };
    const suit = suitMap[suitPart];
    if (!rank || rank < 2 || rank > 14 || suit === undefined) return null;
    return makeCard(rank, suit);
  }

  /* ----- สำรับ --------------------------------------------------------- */
  function freshDeck() {
    const deck = [];
    for (const r of RANKS) for (const s of SUITS) deck.push(makeCard(r, s));
    return deck;
  }
  // Fisher–Yates shuffle
  function shuffle(deck, rng) {
    rng = rng || Math.random;
    const a = deck.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  // สำรับที่ตัดการ์ดที่ใช้ไปแล้วออก (สำหรับ Monte Carlo)
  function deckExcluding(usedCards) {
    const used = new Set(usedCards.map(cardId));
    return freshDeck().filter((c) => !used.has(cardId(c)));
  }

  /* ----- ตัวประเมินไพ่ 5 ใบ -------------------------------------------- *
   * คืนค่าเป็น array [category, tiebreak1, tiebreak2, ...]
   * ซึ่งเปรียบเทียบกันแบบ lexicographic ได้ตรงๆ (มากกว่า = ดีกว่า)
   * --------------------------------------------------------------------- */
  function rank5(cards) {
    const ranks = cards.map((c) => c.rank).sort((a, b) => b - a);
    const suits = cards.map((c) => c.suit);
    const isFlush = suits.every((s) => s === suits[0]);

    // นับจำนวนแต่ละ rank
    const counts = {};
    for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
    // เรียงตาม (จำนวนมากก่อน, แล้วค่าสูงก่อน)
    const grouped = Object.keys(counts)
      .map((r) => ({ rank: +r, n: counts[r] }))
      .sort((a, b) => b.n - a.n || b.rank - a.rank);

    // ตรวจสเตรท (รวมกรณี A-2-3-4-5 = wheel)
    const uniq = [...new Set(ranks)].sort((a, b) => b - a);
    let straightHigh = 0;
    if (uniq.length === 5) {
      if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
      else if (uniq[0] === 14 && uniq[1] === 5 && uniq[4] === 2) straightHigh = 5; // wheel
    }

    const pattern = grouped.map((g) => g.n).join(''); // เช่น "32" = full house
    const kickers = grouped.map((g) => g.rank);

    if (isFlush && straightHigh) {
      // รอยัลฟลัช = สเตรทฟลัชที่ขึ้นต้นด้วย A
      return straightHigh === 14 ? [9] : [8, straightHigh];
    }
    if (pattern === '41') return [7, kickers[0], kickers[1]];          // โฟร์การ์ด
    if (pattern === '32') return [6, kickers[0], kickers[1]];          // ฟูลเฮาส์
    if (isFlush) return [5, ...ranks];                                 // ฟลัช
    if (straightHigh) return [4, straightHigh];                        // สเตรท
    if (pattern === '311') return [3, kickers[0], kickers[1], kickers[2]]; // ตอง
    if (pattern === '221') return [2, kickers[0], kickers[1], kickers[2]]; // ทูแพร์
    if (pattern === '2111') return [1, ...kickers];                    // วันแพร์
    return [0, ...ranks];                                              // ไพ่สูง
  }

  // เปรียบเทียบ score สองชุด: คืน >0 ถ้า a ดีกว่า, <0 ถ้า b ดีกว่า, 0 เสมอ
  function compareScore(a, b) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const av = a[i] || 0, bv = b[i] || 0;
      if (av !== bv) return av - bv;
    }
    return 0;
  }

  /* ----- ประเมินไพ่ที่ดีที่สุดจาก 5-7 ใบ ------------------------------- */
  function combinations(arr, k) {
    const res = [];
    const n = arr.length;
    const idx = [];
    (function rec(start, depth) {
      if (depth === k) { res.push(idx.map((i) => arr[i])); return; }
      for (let i = start; i < n; i++) { idx[depth] = i; rec(i + 1, depth + 1); }
    })(0, 0);
    return res;
  }

  // คืน { score, cards(5 ใบที่ใช้), category } ของมือที่ดีที่สุด
  function evaluateBest(cards) {
    if (cards.length < 5) throw new Error('ต้องมีอย่างน้อย 5 ใบ');
    let best = null;
    for (const combo of combinations(cards, 5)) {
      const score = rank5(combo);
      if (!best || compareScore(score, best.score) > 0) {
        best = { score: score, cards: combo };
      }
    }
    best.category = best.score[0];
    best.categoryName = CATEGORY_TH[best.score[0]];
    return best;
  }

  /* ----- Monte Carlo equity ------------------------------------------- *
   * heroHole: array 2 ใบ
   * board: array 0-5 ใบ (ที่เปิดแล้ว)
   * opponents: จำนวนคู่ต่อสู้ (สุ่มไพ่ให้)
   * villainHole: (option) array 2 ใบ ถ้าอยากระบุไพ่คู่ต่อสู้ตรงๆ (1 คน)
   * iterations: จำนวนรอบจำลอง
   * คืน { win, tie, lose } เป็นเปอร์เซ็นต์
   * --------------------------------------------------------------------- */
  function monteCarlo(opts) {
    const heroHole = opts.heroHole;
    const board = opts.board || [];
    const opponents = opts.villainHole ? 1 : (opts.opponents || 1);
    const villainHole = opts.villainHole || null;
    const iters = opts.iterations || 10000;

    let win = 0, tie = 0, lose = 0;
    const known = [...heroHole, ...board];
    if (villainHole) known.push(...villainHole);
    const baseDeck = deckExcluding(known);

    for (let it = 0; it < iters; it++) {
      const deck = shuffle(baseDeck);
      let di = 0;
      // เติมไพ่กลางให้ครบ 5 ใบ
      const fullBoard = board.slice();
      while (fullBoard.length < 5) fullBoard.push(deck[di++]);

      // ไพ่คู่ต่อสู้
      const villains = [];
      if (villainHole) {
        villains.push(villainHole);
      } else {
        for (let o = 0; o < opponents; o++) {
          villains.push([deck[di++], deck[di++]]);
        }
      }

      const heroScore = evaluateBest([...heroHole, ...fullBoard]).score;
      let bestVillain = null;
      for (const v of villains) {
        const s = evaluateBest([...v, ...fullBoard]).score;
        if (!bestVillain || compareScore(s, bestVillain) > 0) bestVillain = s;
      }
      const cmp = compareScore(heroScore, bestVillain);
      if (cmp > 0) win++;
      else if (cmp === 0) tie++;
      else lose++;
    }
    return {
      win: (win / iters) * 100,
      tie: (tie / iters) * 100,
      lose: (lose / iters) * 100,
      iterations: iters,
    };
  }

  /* ----- ส่งออก ------------------------------------------------------- */
  global.Poker = {
    RANKS, SUITS, SUIT_SYMBOL, SUIT_NAME_TH, RANK_LABEL, CATEGORY_TH,
    makeCard, cardId, cardLabel, isRed, parseCard,
    freshDeck, shuffle, deckExcluding,
    rank5, compareScore, evaluateBest, combinations,
    monteCarlo,
  };
})(typeof window !== 'undefined' ? window : globalThis);
