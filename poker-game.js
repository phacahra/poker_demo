/* =========================================================================
 *  poker-game.js  —  เครื่องยนต์เกม Texas Hold'em (Cash game, 1 คน vs บอท)
 *  รองรับ: blinds, รอบเดิมพัน 4 รอบ, fold/check/call/raise/all-in,
 *          side pot อย่างง่าย, showdown ด้วยตัวประเมินไพ่จาก poker-engine.js
 *  ตรรกะปิดรอบใช้ "acted flag": รอบจบเมื่อไม่มีผู้เล่นที่ยังเดินได้คนใด
 *  ค้างสถานะ acted=false (ทุกคนตอบสนองต่อเดิมพันล่าสุดครบแล้ว)
 * ========================================================================= */
(function (global) {
  'use strict';
  const P = global.Poker;

  class HoldemGame {
    /* config: { players:[{name,isHuman,stack}], smallBlind, bigBlind } */
    constructor(config) {
      this.smallBlind = config.smallBlind || 10;
      this.bigBlind = config.bigBlind || 20;
      this.players = config.players.map((p, i) => ({
        id: i,
        name: p.name,
        isHuman: !!p.isHuman,
        stack: p.stack || 1000,
        hole: [],
        folded: false,
        allIn: false,
        acted: false,        // เดินในรอบปัจจุบันแล้วหรือยัง
        betThisRound: 0,     // เดิมพันในรอบปัจจุบัน
        committed: 0,        // เดิมพันสะสมทั้งมือ (สำหรับ side pot)
        inHand: true,
        lastAction: '',
      }));
      this.button = config.players.length - 1;
      this.handNo = 0;
      this.log = [];
      this.stage = 'idle';
    }

    _alive() { return this.players.filter((p) => p.inHand && !p.folded); }
    _canAct() { return this.players.filter((p) => p.inHand && !p.folded && !p.allIn); }
    _addLog(msg) { this.log.push(msg); if (this.log.length > 200) this.log.shift(); }

    /* ----- เริ่มมือใหม่ ----- */
    startHand() {
      const active = this.players.filter((p) => p.stack > 0);
      if (active.length < 2) { this.stage = 'gameover'; return; }

      this.handNo++;
      this.deck = P.shuffle(P.freshDeck());
      this.di = 0;
      this.board = [];
      this.pot = 0;
      this.stage = 'preflop';
      this.lastRaiseSize = this.bigBlind;

      for (const p of this.players) {
        p.hole = []; p.folded = false; p.allIn = false; p.acted = false;
        p.betThisRound = 0; p.committed = 0; p.lastAction = '';
        p.inHand = p.stack > 0;
      }
      do { this.button = (this.button + 1) % this.players.length; }
      while (!this.players[this.button].inHand);

      const order = this._orderFrom(this.button).filter((p) => p.inHand);
      // แจกไพ่ 2 ใบ
      for (let r = 0; r < 2; r++) for (const p of order) p.hole.push(this.deck[this.di++]);

      // ลง blinds (heads-up: ปุ่ม=SB; 3+ คน: คนหลังปุ่ม=SB)
      let sb, bb;
      if (order.length === 2) { sb = this.players[this.button]; bb = order[0] === sb ? order[1] : order.find(p=>p!==sb); }
      else { sb = order[0]; bb = order[1]; }
      this._postBlind(sb, this.smallBlind);
      this._postBlind(bb, this.bigBlind);
      this.currentBet = this.bigBlind;
      this._addLog(`— มือที่ ${this.handNo} — ${sb.name} ลง SB ${this.smallBlind}, ${bb.name} ลง BB ${this.bigBlind}`);

      // เริ่มรอบ preflop: คนเริ่มเดิน = คนถัดจาก BB, ตัวปิด = BB (ได้ option)
      this._beginRound(this.players.indexOf(bb));
    }

    _postBlind(p, amt) {
      const pay = Math.min(amt, p.stack);
      p.stack -= pay; p.betThisRound += pay; p.committed += pay; this.pot += pay;
      if (p.stack === 0) p.allIn = true;
    }

    _orderFrom(idx) {
      const out = [];
      for (let i = 1; i <= this.players.length; i++)
        out.push(this.players[(idx + i) % this.players.length]);
      return out;
    }

    // เริ่มรอบเดิมพันใหม่: รีเซ็ต acted ของคนที่ยังเดินได้, หาคนแรกที่ต้องเดิน
    _beginRound(afterIdx) {
      for (const p of this.players) p.acted = !(p.inHand && !p.folded && !p.allIn);
      this.toAct = this._nextToAct(afterIdx);
    }

    // หา index ถัดไปที่ "ยังเดินได้และยังไม่เดิน (acted=false)" หลัง fromIdx
    _nextToAct(fromIdx) {
      for (let i = 1; i <= this.players.length; i++) {
        const idx = (fromIdx + i) % this.players.length;
        const p = this.players[idx];
        if (p.inHand && !p.folded && !p.allIn && !p.acted) return idx;
      }
      return -1;
    }

    /* ----- ข้อมูลตาปัจจุบัน ----- */
    currentActor() { return this.toAct >= 0 ? this.players[this.toAct] : null; }
    toCall(p) { return Math.max(0, this.currentBet - p.betThisRound); }
    legalActions(p) {
      const need = this.toCall(p);
      const acts = [];
      if (need > 0) acts.push('fold');
      acts.push(need === 0 ? 'check' : 'call');
      if (p.stack > need) acts.push('raise');
      return acts;
    }
    minRaiseTo() { return this.currentBet + this.lastRaiseSize; }
    maxRaiseTo(p) { return p.betThisRound + p.stack; } // all-in

    /* ----- ผู้เล่นลงมือ ----- */
    act(action, amountTo) {
      const p = this.currentActor();
      if (!p) return;
      const need = this.toCall(p);

      if (action === 'fold') {
        p.folded = true; p.lastAction = 'หมอบ';
        this._addLog(`${p.name}: หมอบ`);
      } else if (action === 'check') {
        p.lastAction = 'เช็ค';
        this._addLog(`${p.name}: เช็ค`);
      } else if (action === 'call') {
        const pay = Math.min(need, p.stack);
        this._commit(p, pay);
        p.lastAction = p.allIn ? 'ออลอิน' : `เรียก ${pay}`;
        this._addLog(`${p.name}: เรียก ${pay}${p.allIn ? ' (ออลอิน)' : ''}`);
      } else if (action === 'raise') {
        const oldBet = this.currentBet;
        let target = Math.min(amountTo, this.maxRaiseTo(p));
        const minTo = Math.min(this.minRaiseTo(), this.maxRaiseTo(p));
        if (target < minTo) target = minTo;
        const pay = target - p.betThisRound;
        this._commit(p, pay);
        const raiseSize = p.betThisRound - oldBet;
        if (raiseSize >= this.lastRaiseSize) this.lastRaiseSize = raiseSize;
        this.currentBet = Math.max(this.currentBet, p.betThisRound);
        // เป็นการเพิ่มเดิมพัน -> ทุกคนที่เหลือต้องตอบสนองใหม่
        for (const o of this.players)
          if (o !== p && o.inHand && !o.folded && !o.allIn) o.acted = false;
        p.lastAction = p.allIn ? `ออลอิน ${target}` : `เพิ่มเป็น ${target}`;
        this._addLog(`${p.name}: ${p.lastAction}`);
      }

      p.acted = true;
      this._advance();
    }

    _commit(p, amt) {
      amt = Math.min(amt, p.stack);
      p.stack -= amt; p.betThisRound += amt; p.committed += amt; this.pot += amt;
      if (p.stack === 0) p.allIn = true;
    }

    /* ----- เลื่อนตา / ปิดรอบ ----- */
    _advance() {
      if (this._alive().length === 1) { this._endHand(); return; }
      const next = this._nextToAct(this.toAct);
      if (next === -1) this._nextStreet();   // ทุกคนตอบสนองครบ -> เปิดไพ่ใบถัดไป
      else this.toAct = next;
    }

    _nextStreet() {
      for (const p of this.players) p.betThisRound = 0;
      this.currentBet = 0;
      this.lastRaiseSize = this.bigBlind;

      if (this.stage === 'preflop') { this._deal(3); this.stage = 'flop'; }
      else if (this.stage === 'flop') { this._deal(1); this.stage = 'turn'; }
      else if (this.stage === 'turn') { this._deal(1); this.stage = 'river'; }
      else { this._showdown(); return; }

      this._addLog(`ไพ่กลาง: ${this.board.map(P.cardLabel).join(' ')}`);

      if (this._canAct().length <= 1) { this._runOut(); return; } // ทุกคน all-in -> เปิดต่อ
      this._beginRound(this.button); // postflop เริ่มหลังปุ่ม
    }

    _runOut() {
      while (this.board.length < 5) {
        if (this.stage === 'preflop') { this._deal(3); this.stage = 'flop'; }
        else if (this.stage === 'flop') { this._deal(1); this.stage = 'turn'; }
        else if (this.stage === 'turn') { this._deal(1); this.stage = 'river'; }
        else break;
      }
      this._addLog(`เปิดไพ่จนครบ: ${this.board.map(P.cardLabel).join(' ')}`);
      this._showdown();
    }

    _deal(n) { for (let i = 0; i < n; i++) this.board.push(this.deck[this.di++]); }

    /* ----- จบมือเมื่อเหลือคนเดียว ----- */
    _endHand() {
      const winner = this._alive()[0];
      winner.stack += this.pot;
      this._addLog(`${winner.name} ชนะ ${this.pot} (คนอื่นหมอบหมด)`);
      this.lastResult = { winners: [winner.name], pot: this.pot, showdown: false };
      this.stage = 'handover';
      this.toAct = -1;
    }

    /* ----- showdown พร้อม side pot อย่างง่าย ----- */
    _showdown() {
      this.stage = 'showdown';
      this.toAct = -1;
      const contenders = this._alive();
      for (const p of contenders) p.eval = P.evaluateBest([...p.hole, ...this.board]);

      // แบ่ง side pots ตามยอด committed
      const levels = [...new Set(this.players.filter((p) => p.committed > 0).map((p) => p.committed))].sort((a, b) => a - b);
      const pots = [];
      let prev = 0;
      for (const lv of levels) {
        let amount = 0;
        const eligible = [];
        for (const p of this.players) {
          if (p.committed >= lv) amount += (lv - prev);
          if (p.committed >= lv && p.inHand && !p.folded) eligible.push(p);
        }
        pots.push({ amount, eligible });
        prev = lv;
      }

      const results = [];
      for (const pot of pots) {
        if (pot.amount <= 0 || pot.eligible.length === 0) continue;
        let best = null;
        for (const p of pot.eligible)
          if (!best || P.compareScore(p.eval.score, best) > 0) best = p.eval.score;
        const winners = pot.eligible.filter((p) => P.compareScore(p.eval.score, best) === 0);
        const share = Math.floor(pot.amount / winners.length);
        let rem = pot.amount - share * winners.length;
        for (const w of winners) { w.stack += share; if (rem > 0) { w.stack += 1; rem--; } }
        results.push({ winners: winners.map((w) => w.name), amount: pot.amount, hand: winners[0].eval.categoryName });
      }
      for (const r of results) this._addLog(`${r.winners.join(', ')} ชนะ ${r.amount} ด้วย ${r.hand}`);
      this.lastResult = { showdown: true, pots: results, board: this.board.slice() };
      this.stage = 'handover';
    }

    /* ----- AI บอท ----- */
    botDecision(p) {
      const need = this.toCall(p);
      const legal = this.legalActions(p);
      const oppCount = this._alive().length - 1;
      const eq = P.monteCarlo({
        heroHole: p.hole, board: this.board,
        opponents: Math.max(1, oppCount), iterations: 300,
      });
      const strength = (eq.win + eq.tie / 2) / 100;
      const potOdds = need > 0 ? need / (this.pot + need) : 0;
      const jitter = (Math.random() - 0.5) * 0.12;
      const s = Math.max(0, Math.min(1, strength + jitter));

      if (need === 0) {
        if (s > 0.62 && legal.includes('raise') && Math.random() < 0.7) {
          const size = Math.round((this.pot * (0.5 + Math.random() * 0.5)) / this.bigBlind) * this.bigBlind;
          return { action: 'raise', amountTo: this.currentBet + Math.max(this.bigBlind, size) };
        }
        if (s < 0.25 && legal.includes('raise') && Math.random() < 0.1)
          return { action: 'raise', amountTo: this.currentBet + this.bigBlind * 2 };
        return { action: 'check' };
      }
      if (s < potOdds - 0.05) {
        if (s > 0.18 && need <= this.bigBlind && Math.random() < 0.4) return { action: 'call' };
        return { action: 'fold' };
      }
      if (s > 0.78 && legal.includes('raise') && Math.random() < 0.6) {
        const size = Math.round((this.pot * 0.75) / this.bigBlind) * this.bigBlind;
        return { action: 'raise', amountTo: this.currentBet + Math.max(this.bigBlind, size) };
      }
      return { action: 'call' };
    }

    stepBot() {
      const p = this.currentActor();
      if (!p || p.isHuman) return false;
      const d = this.botDecision(p);
      this.act(d.action, d.amountTo);
      return true;
    }

    needHumanAction() {
      const p = this.currentActor();
      return p && p.isHuman && this.stage !== 'handover' && this.stage !== 'gameover';
    }
  }

  global.HoldemGame = HoldemGame;
})(typeof window !== 'undefined' ? window : globalThis);
