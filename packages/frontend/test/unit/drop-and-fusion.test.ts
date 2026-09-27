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
	test.each(['normal', 'square'] as const)('%s: 同じシードと記録から同じ結末になる', (mode) => {
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
