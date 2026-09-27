/*
 * SPDX-FileCopyrightText: mk-go project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as Matter from 'matter-js';
import { DropAndFusionGame } from 'misskey-bubble-game';

vi.mock('@/i.js', () => ({ $i: { id: 'user1' } }));
import { clearDropAndFusionSave, isDropAndFusionSaveExpired, loadDropAndFusionSave, SAVE_MAX_AGE_MS, writeDropAndFusionSave } from '@/utility/drop-and-fusion-save.js';
import { fastForwardGame } from '@/utility/drop-and-fusion-fast-forward.js';

type Mode = ConstructorParameters<typeof DropAndFusionGame>[0]['gameMode'];

function newGame(mode: Mode, seed: string) {
	// 描画設定は本番では必ず渡される。渡さないと matter-js が render の既定値を
	// 埋められずに落ちる。
	return new DropAndFusionGame({ seed, gameMode: mode, getMonoRenderOptions: () => ({}) });
}

// 決定的な乱数 (mulberry32)。ボットの落とす位置に使う。
function botRng(seed: number) {
	let a = seed;
	return () => {
		a |= 0; a = a + 0x6D2B79F5 | 0;
		let t = Math.imul(a ^ a >>> 15, 1 | a);
		t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
		return ((t ^ t >>> 14) >>> 0) / 4294967296;
	};
}

/**
 * Plays a game with a bot that drops at random positions every 35 frames until
 * the game is over.
 */
function playUntilOver(mode: Mode, seed: string, bot: number) {
	const g = newGame(mode, seed);
	const rng = botRng(bot);
	let score = 0;
	let over = false;
	let warningSince: number | null = null;
	let recoveries = 0;
	let warnedForAtOver = 0;
	g.on('changeScore', v => { score = v; });
	g.on('overflowWarning', v => {
		if (v) {
			warningSince = g.frame;
		} else if (!over && warningSince != null) {
			// ゲームオーバーの後にも false が来るので、over を立てる前の分だけ数える。
			recoveries++;
			warningSince = null;
		}
	});
	g.on('gameOver', () => {
		warnedForAtOver = warningSince == null ? 0 : g.frame - warningSince;
		over = true;
	});
	g.start();
	while (!over && g.frame < 60 * 60 * 10) {
		if (g.frame % 35 === 0) g.drop(30 + rng() * 390);
		if (!g.tick()) break;
	}
	return { over, frame: g.frame, score, logs: g.getLogs(), recoveries, warnedForAtOver, grace: g.msToFrame(g.OVERFLOW_GRACE_MS) };
}

/** Re-runs recorded operations the way replay / resume do. */
function replay(mode: Mode, seed: string, serialized: number[][]) {
	const logs = DropAndFusionGame.deserializeLogs(serialized);
	const g = newGame(mode, seed);
	let score = 0;
	let overAt: number | null = null;
	g.on('changeScore', v => { score = v; });
	g.on('gameOver', () => { overAt = g.frame; });
	g.start();
	let next = 0;
	while (g.frame < 60 * 60 * 10) {
		while (next < logs.length && logs[next].frame === g.frame) {
			const log = logs[next++];
			if (log.operation === 'drop') g.drop(log.x);
			else if (log.operation === 'hold') g.hold();
			else g.surrender();
		}
		if (!g.tick()) break;
	}
	return { overAt, score };
}

/**
 * mk-go: はみ出しの判定に 2 秒の猶予を持たせる (#3193)。
 *
 * **即時判定に戻すと、警告が出た時点で終わる。** その場合「警告が解けて続いた」回数が
 * 0 になり、終わったときの警告の長さも 0 になるので、どちらのアサーションでも落ちる。
 */
describe('bubble game overflow grace (#3193)', () => {
	test('版は 4', () => {
		expect(DropAndFusionGame.VERSION).toBe(4);
		expect(newGame('normal', 's').GAME_VERSION).toBe(4);
	});

	// 終わったときに警告が 2 秒以上続いていること。**即時判定に戻すと 0 で終わる。**
	// (警告は「どれかの玉がはみ出している間」なので、玉が入れ替わると 2 秒より長くなる)
	test.each(['normal', 'square'] as const)('%s: 2 秒とどまったら終わる', (mode) => {
		const r = playUntilOver(mode, 'seed-a', 1);
		expect(r.over).toBe(true);
		expect(r.warnedForAtOver).toBeGreaterThanOrEqual(r.grace);
	});

	// 一瞬はみ出しても終わらない。ゲームによっては一度も解けないまま終わるので、
	// 解ける場面があるシードで見る。
	test('一瞬はみ出しても、出れば終わらない', () => {
		const r = playUntilOver('normal', 'seed-a', 1);
		expect(r.recoveries).toBeGreaterThan(0);
	});

	// リプレイと途中保存 (#3192) の早送りは、同じシードと操作の記録から同じ結末に
	// なることが前提。判定を実時間で数えるとここが崩れる。
	test.each(['normal', 'square', 'bouncy', 'space'] as const)('%s: 同じシードと記録から同じ結末になる', (mode) => {
		const r = playUntilOver(mode, 'seed-b', 2);
		const serialized = DropAndFusionGame.serializeLogs(r.logs);
		const again = replay(mode, 'seed-b', serialized);
		expect(again.overAt).toBe(r.frame);
		expect(again.score).toBe(r.score);
	});
});

/**
 * mk-go: 途中保存 (#3192)。盤面ではなくシードと操作の記録だけを持つ。
 */
describe('bubble game save (#3192)', () => {
	beforeEach(() => {
		window.localStorage.clear();
	});

	const save = { v: 4, m: 'normal', s: 'seed', l: [[10, 0, 200], [40, 1]] };

	test('書いたものを読める / 消せる', () => {
		writeDropAndFusionSave(save);
		expect(loadDropAndFusionSave('normal')).toEqual(save);
		clearDropAndFusionSave('normal');
		expect(loadDropAndFusionSave('normal')).toBeNull();
	});

	test('モードごとに別々に持つ', () => {
		writeDropAndFusionSave(save);
		writeDropAndFusionSave({ ...save, m: 'square', s: 'other' });
		expect(loadDropAndFusionSave('normal')?.s).toBe('seed');
		expect(loadDropAndFusionSave('square')?.s).toBe('other');
		expect(loadDropAndFusionSave('yen')).toBeNull();
	});

	test('アカウントごとに別のキーに書く', () => {
		writeDropAndFusionSave(save);
		expect(window.localStorage.getItem('mkgo:dropAndFusion:user1:normal')).not.toBeNull();
	});

	test('壊れた保存は無いものとして扱う', () => {
		window.localStorage.setItem('mkgo:dropAndFusion:user1:normal', '{not json');
		expect(loadDropAndFusionSave('normal')).toBeNull();
		window.localStorage.setItem('mkgo:dropAndFusion:user1:normal', JSON.stringify({ ...save, l: 'x' }));
		expect(loadDropAndFusionSave('normal')).toBeNull();
		// 別のモードの保存がそのキーに入っていても使わない。
		window.localStorage.setItem('mkgo:dropAndFusion:user1:normal', JSON.stringify({ ...save, m: 'yen' }));
		expect(loadDropAndFusionSave('normal')).toBeNull();
	});

	test('保存した記録から早送りすると中断前と同じ局面になる', () => {
		// 途中まで遊んだゲームを「保存した記録」から戻し、同じフレームまで進めた
		// ときのスコアと次の玉が一致するかを見る。
		function track(g: DropAndFusionGame) {
			const state = { score: 0, stock: [] as string[] };
			g.on('changeScore', v => { state.score = v; });
			g.on('changeStock', v => { state.stock = v.map(x => x.id); });
			return state;
		}

		const g = newGame('normal', 'resume-seed');
		const original = track(g);
		const rng = botRng(3);
		g.start();
		while (g.frame < 1500) {
			if (g.frame % 35 === 0) g.drop(30 + rng() * 390);
			g.tick();
		}
		const serialized = DropAndFusionGame.serializeLogs(g.getLogs());

		const r = newGame('normal', 'resume-seed');
		const resumed = track(r);
		r.start();
		const logs = DropAndFusionGame.deserializeLogs(serialized);
		let next = 0;
		while (r.frame < g.frame) {
			while (next < logs.length && logs[next].frame === r.frame) {
				const log = logs[next++];
				if (log.operation === 'drop') r.drop(log.x);
			}
			r.tick();
		}
		expect(original.score).toBeGreaterThan(0);
		expect(resumed.score).toBe(original.score);
		expect(resumed.stock).toEqual(original.stock);
	});
});

/**
 * mk-go: 箱の外へ抜けた玉 (#3193)。
 *
 * 本家は判定領域に触れた瞬間に終わるので、箱の外へ出た玉が残ることは無かった。猶予を
 * 持たせたので、壁を抜けた玉があれば終わらせる (起きないはずの備え)。
 */
describe('bubble game lost mono (#3193)', () => {
	// 壁を抜けて失われた玉が出たら終わらせる (起きないはずの備え)。壁の内側の面で
	// 判定すると、一瞬めり込んだだけで終わる。
	test('箱の外へ抜けた玉があればゲームオーバーになる / めり込んだだけでは終わらない', () => {
		const g = newGame('normal', 'lost');
		let over = false;
		g.on('gameOver', () => { over = true; });
		g.start();
		for (let i = 0; i < g.DROP_COOLTIME; i++) g.tick();
		g.drop(200);
		g.tick();
		const bodies = g.engine.world.bodies;
		const body = bodies[bodies.length - 1];

		// 壁 (内側の面は GAME_WIDTH - PLAYAREA_MARGIN、厚さ 100) の中ほどまでめり込ませる。
		// 1 tick では押し戻しきれず、判定の時点でも中心は壁の中にある。
		Matter.Body.setPosition(body, { x: g.GAME_WIDTH - g.PLAYAREA_MARGIN + 60, y: 300 });
		g.tick();
		expect(body.position.x).toBeGreaterThan(g.GAME_WIDTH - g.PLAYAREA_MARGIN);
		expect(over).toBe(false);

		Matter.Body.setPosition(body, { x: g.GAME_WIDTH + 500, y: 300 });
		Matter.Body.setVelocity(body, { x: 0, y: 0 });
		g.tick();
		expect(over).toBe(true);
	});
});

/**
 * mk-go: 途中保存からの早送り (#3192)。コンポーネントから切り出してあるので、
 * 止まる位置・操作の当て方・中止を直接見る。
 */
describe('bubble game fast-forward (#3192)', () => {
	const noWait = { yieldToBrowser: () => Promise.resolve(), now: () => 0, budgetMs: 1e9 };

	test('最後の操作のフレームの tick まで進めて止まり、保持も同じフレームの 2 つの操作も当てる', async () => {
		const g = newGame('normal', 'ff');
		g.start();
		const logs = DropAndFusionGame.deserializeLogs([[40, 1], [0, 0, 200], [60, 0, 100]]);
		const result = await fastForwardGame(g, logs, { ...noWait, isCancelled: () => false });
		expect(result).toBe('done');
		expect(g.frame).toBe(101);
		expect(g.getLogs().map(x => `${x.frame}:${x.operation}`)).toEqual(['40:hold', '40:drop', '100:drop']);
	});

	test('途中でゲームが終わったら gameOver を返す', async () => {
		const g = newGame('normal', 'ff');
		g.start();
		const logs = DropAndFusionGame.deserializeLogs([[40, 0, 200], [10, 2], [100, 0, 100]]);
		const result = await fastForwardGame(g, logs, { ...noWait, isCancelled: () => false });
		expect(result).toBe('gameOver');
		expect(g.frame).toBe(51);
	});

	// 画面を離れると dispose される。続けると壁の無いゲームを回し続ける。
	test('中止されたら進めるのをやめる', async () => {
		const g = newGame('normal', 'ff');
		g.start();
		const logs = DropAndFusionGame.deserializeLogs([[100, 0, 200], [1000, 0, 100]]);
		let yields = 0;
		let t = 0;
		const result = await fastForwardGame(g, logs, {
			// tick 1 回ごとに 1ms 経つ時計と 10ms の枠。1 回目の区切りの後で中止する。
			now: () => t++,
			budgetMs: 10,
			isCancelled: () => yields > 0,
			yieldToBrowser: () => { yields++; return Promise.resolve(); },
		});
		expect(result).toBe('cancelled');
		expect(g.frame).toBeLessThan(1101);
	});

	test('少しずつ進めて進捗を返す', async () => {
		const g = newGame('normal', 'ff');
		g.start();
		const logs = DropAndFusionGame.deserializeLogs([[300, 0, 200]]);
		let t = 0;
		const progress: number[] = [];
		const result = await fastForwardGame(g, logs, {
			// tick 1 回ごとに 1ms 経つ時計と 50ms の枠 = 50 フレームずつ返る。
			now: () => t++,
			budgetMs: 50,
			isCancelled: () => false,
			yieldToBrowser: () => Promise.resolve(),
			onProgress: p => progress.push(p),
		});
		expect(result).toBe('done');
		expect(progress.length).toBeGreaterThan(3);
		expect(progress[progress.length - 1]).toBe(1);
	});
});

describe('bubble game save validation (#3192)', () => {
	beforeEach(() => {
		window.localStorage.clear();
	});

	const put = (l: unknown) => window.localStorage.setItem('mkgo:dropAndFusion:user1:normal', JSON.stringify({ v: 4, m: 'normal', s: '1', l }));

	test('フレーム差が小数の保存は使わない (記録のフレームに一致せず操作が飛ぶ)', () => {
		put([[1.5, 0, 200]]);
		expect(loadDropAndFusionSave('normal')).toBeNull();
	});

	test('x 座標の無い「落とす」操作を含む保存は使わない (NaN の位置に玉ができる)', () => {
		put([[5, 0]]);
		expect(loadDropAndFusionSave('normal')).toBeNull();
		put([[5, 1]]);
		expect(loadDropAndFusionSave('normal')).not.toBeNull();
	});

	test('早送りが終わらないほど長い保存は使わない', () => {
		put([[1e9, 0, 200]]);
		expect(loadDropAndFusionSave('normal')).toBeNull();
	});

	test('期限: backend の 7 日より 1 日早く切る', () => {
		expect(SAVE_MAX_AGE_MS).toBe(6 * 24 * 60 * 60 * 1000);
		const now = 10 * 24 * 60 * 60 * 1000;
		const save = (age: number) => ({ v: 4, m: 'normal', s: String(now - age), l: [] });
		expect(isDropAndFusionSaveExpired(save(SAVE_MAX_AGE_MS - 1), now)).toBe(false);
		expect(isDropAndFusionSaveExpired(save(SAVE_MAX_AGE_MS + 1), now)).toBe(true);
		expect(isDropAndFusionSaveExpired({ v: 4, m: 'normal', s: 'x', l: [] }, now)).toBe(true);
	});
});

/**
 * mk-go: BOUNCY モードと、SPACE / BOUNCY の壁 (#3194)。
 *
 * はみ出しの判定に猶予がある (#3193) と、漂う玉 (space) は壁の上を越え、よく弾む玉
 * (bouncy) は挟まれて角から押し出され、箱の外へ出て消えたままゲームが続いた。
 */
describe('bubble game bouncy / space (#3194)', () => {
	function droppedBody(mode: Mode) {
		const g = newGame(mode, 'seed');
		g.start();
		for (let i = 0; i < g.DROP_COOLTIME; i++) g.tick();
		g.drop(200);
		const bodies = g.engine.world.bodies;
		return bodies[bodies.length - 1];
	}

	test('bouncy はよく弾み、摩擦がほぼ無い。空気抵抗は通常のまま', () => {
		const b = droppedBody('bouncy');
		expect(b.restitution).toBeCloseTo(0.9);
		expect(b.friction).toBeCloseTo(0.01);
		expect(b.frictionStatic).toBe(0);
		expect(b.frictionAir).toBeCloseTo(0.01);
	});

	test('normal の性質は変わらない', () => {
		const b = droppedBody('normal');
		expect(b.restitution).toBeCloseTo(0.2);
		expect(b.friction).toBeCloseTo(0.7);
		expect(b.frictionStatic).toBe(5);
		expect(b.frictionAir).toBeCloseTo(0.01);
	});

	function walls(mode: Mode) {
		const g = newGame(mode, 'walls');
		const statics = g.engine.world.bodies.filter(b => b.label === '_wall_');
		const floor = statics.find(b => b.position.x === g.GAME_WIDTH / 2)!;
		const sides = statics.filter(b => b !== floor);
		return { g, floor, sides };
	}

	// **既存のモードの壁は本家のまま。** 形が変わると版 4 のリプレイと途中保存の結末が変わる。
	test.each(['normal', 'square', 'yen', 'sweets'] as const)('%s の壁は本家のまま', (mode) => {
		const { g, floor, sides } = walls(mode);
		const W = g.GAME_WIDTH, H = g.GAME_HEIGHT, M = g.PLAYAREA_MARGIN, T = 100;
		const box = (b: typeof floor) => [b.bounds.min.x, b.bounds.min.y, b.bounds.max.x, b.bounds.max.y];
		// 本家の組み立て (厚さ 100) そのまま。
		expect(box(floor)).toEqual([0, H - M, W, H - M + T]);
		expect(sides.map(box).sort((a, b) => a[0] - b[0])).toEqual([
			[M - T, 0, M, H],
			[W - M, 0, W - M + T, H],
		]);
	});

	// 角を塞ぐ (床を壁の外まで広げ、壁を床の下まで伸ばす) / 壁を上へ伸ばす。
	test.each(['bouncy', 'space'] as const)('%s は角が塞がり、壁が上へ伸びている', (mode) => {
		const { g, floor, sides } = walls(mode);
		expect(sides).toHaveLength(2);
		for (const w of sides) {
			expect(w.bounds.min.y).toBeLessThanOrEqual(-6000);
			expect(w.bounds.max.y).toBeGreaterThanOrEqual(floor.bounds.max.y);
		}
		// 床はちょうど壁の外側の面まで。短いと角に隙間ができ、長いと壁の外に玉が載る段差になる。
		const outer = [Math.min(...sides.map(w => w.bounds.min.x)), Math.max(...sides.map(w => w.bounds.max.x))];
		expect([floor.bounds.min.x, floor.bounds.max.x]).toEqual(outer);
		// 内側の面は本家と同じ。
		const inner = sides.map(w => (w.position.x < 0 ? w.bounds.max.x : w.bounds.min.x)).sort((a, b) => a - b);
		expect(inner).toEqual([g.PLAYAREA_MARGIN, g.GAME_WIDTH - g.PLAYAREA_MARGIN]);
		expect(floor.bounds.min.y).toBe(g.GAME_HEIGHT - g.PLAYAREA_MARGIN);
	});

	/**
	 * Drops a mono and returns how far it bounces back up after its first contact.
	 * `onBall` drops it on a mono that is already resting.
	 *
	 * **どちらも 2 番目の玉を測る。** 床の場合は 1 番目をホールドして除ける。大きさが違うと
	 * 跳ね方も違うので、比べる意味が無くなる。
	 */
	function rebound(mode: Mode, onBall: boolean) {
		const g = newGame(mode, 'rebound');
		g.start();
		const ticks = (n: number) => { for (let i = 0; i < n; i++) g.tick(); };
		ticks(g.DROP_COOLTIME);
		if (onBall) {
			g.drop(225);
			ticks(300);
		} else {
			g.hold();
		}
		g.drop(225);
		const bodies = g.engine.world.bodies;
		const body = bodies[bodies.length - 1];
		let lowest: number | null = null;
		let top = Infinity;
		for (let i = 0; i < 400; i++) {
			g.tick();
			if (lowest == null) {
				if (body.velocity.y < 0 && body.position.y > 150) lowest = body.position.y;
			} else {
				top = Math.min(top, body.position.y);
			}
		}
		// 跳ね返りを一度も捉えられなかったら 0 ではなく失敗にする (跳ねない、を空振りで満たさない)。
		expect(lowest).not.toBeNull();
		return { height: lowest! - top, size: body.circleRadius, below: onBall ? bodies[bodies.length - 2].circleRadius : null };
	}

	// 物理エンジンは積み重なった玉への衝突で勢いを下の玉と床へ逃がすので、補わないと
	// 落ちている玉に当たってもほとんど跳ねない (実測 1px 未満。床では 169px)。
	test('bouncy: 止まっている玉に当たっても、床と同じくらい跳ねる', () => {
		const floor = rebound('bouncy', false);
		const onBall = rebound('bouncy', true);
		// 同じ玉を比べている。下の玉とは大きさが違う (同じだと合体してしまう)。
		expect(onBall.size).toBe(floor.size);
		expect(onBall.below).not.toBe(onBall.size);
		expect(floor.height).toBeGreaterThan(100);
		expect(onBall.height).toBeGreaterThan(100);
		expect(onBall.height).toBeLessThan(floor.height * 1.5);
	});

	test('normal は止まっている玉に当たってもほとんど跳ねない (補うのは bouncy だけ)', () => {
		expect(rebound('normal', true).height).toBeLessThan(20);
	});

	// よく弾む玉は挟まれると 60px/tick を超える速さで押し出され、その勢いで壁を抜ける。
	test('bouncy の玉の速さには上限がある', () => {
		const g = newGame('bouncy', 'speed');
		const rng = botRng(9);
		let max = 0;
		g.start();
		while (g.frame < 60 * 60 * 3 && g.tick()) {
			if (g.frame % 35 === 0) g.drop(30 + rng() * 390);
			for (const b of g.engine.world.bodies) {
				if (!b.isStatic) max = Math.max(max, Math.sqrt((b.velocity.x ** 2) + (b.velocity.y ** 2)));
			}
		}
		expect(max).toBeGreaterThan(5);
		expect(max).toBeLessThanOrEqual(15 + 1e-9);
	});

	// 上限は bouncy だけ。既存のモードにかけると版 4 の結末が変わる。square はこの局の
	// 1046 フレーム目に 25.8 まで速くなる (実測)。
	test('既存のモードには速さの上限をかけない', () => {
		const g = newGame('square', 'nocap-3');
		const rng = botRng(3);
		let max = 0;
		g.start();
		while (g.frame < 1100 && g.tick()) {
			if (g.frame % 35 === 0) g.drop(30 + rng() * 390);
			for (const b of g.engine.world.bodies) {
				if (!b.isStatic) max = Math.max(max, Math.sqrt((b.velocity.x ** 2) + (b.velocity.y ** 2)));
			}
		}
		// 上限をかけても丸めで 15 をわずかに超えるので、余裕を持たせて見る。
		expect(max).toBeGreaterThan(16);
	});

	// 壁を上へ伸ばさないと、この 2 局で玉が壁の上を越えて外に居続けた (実測)。
	test.each([[8, 'r8'], [22, 'wall-22']] as const)('space: 玉が壁の上を越えて外に居続けない (bot %i)', (bot, seed) => {
		const g = newGame('space', seed);
		const rng = botRng(bot);
		const inner = { l: g.PLAYAREA_MARGIN, r: g.GAME_WIDTH - g.PLAYAREA_MARGIN, b: g.GAME_HEIGHT - g.PLAYAREA_MARGIN };
		const outSince = new Map<number, number>();
		let longestOut = 0;
		g.start();
		for (;;) {
			if (g.frame % 35 === 0) g.drop(30 + rng() * 390);
			const next = g.tick();
			for (const b of g.engine.world.bodies) {
				if (b.isStatic) continue;
				const out = b.bounds.max.x < inner.l || b.bounds.min.x > inner.r || b.bounds.min.y > inner.b;
				if (!out) {
					outSince.delete(b.id);
					continue;
				}
				if (!outSince.has(b.id)) outSince.set(b.id, g.frame);
				longestOut = Math.max(longestOut, g.frame - outSince.get(b.id)!);
			}
			if (!next || g.frame > 60 * 60 * 10) break;
		}
		expect(longestOut).toBeLessThan(30);
	});
});
