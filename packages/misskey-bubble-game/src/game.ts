/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter } from 'eventemitter3';
import * as Matter from 'matter-js';
import seedrandom from 'seedrandom';
import { NORAML_MONOS, SQUARE_MONOS, SWEETS_MONOS, YEN_MONOS } from './monos.js';

export type Mono = {
	id: string;
	level: number;
	sizeX: number;
	sizeY: number;
	shape: 'circle' | 'rectangle' | 'custom';
	vertices?: Matter.Vector[][];
	verticesSize?: number;
	score: number;
	dropCandidate: boolean;
};

type Log = {
	frame: number;
	operation: 'drop';
	x: number;
} | {
	frame: number;
	operation: 'hold';
} | {
	frame: number;
	operation: 'surrender';
};

export class DropAndFusionGame extends EventEmitter<{
	changeScore: (newScore: number) => void;
	changeCombo: (newCombo: number) => void;
	changeStock: (newStock: { id: string; mono: Mono }[]) => void;
	changeHolding: (newHolding: { id: string; mono: Mono } | null) => void;
	dropped: (x: number) => void;
	fusioned: (x: number, y: number, nextMono: Mono | null, scoreDelta: number) => void;
	collision: (energy: number, bodyA: Matter.Body, bodyB: Matter.Body) => void;
	monoAdded: (mono: Mono) => void;
	/**
	 * Emitted when a mono starts or stops overflowing the box (mk-go, #3193).
	 * `true` while at least one mono stays in the overflow area.
	 */
	overflowWarning: (overflowing: boolean) => void;
	gameOver: () => void;
}> {
	private PHYSICS_QUALITY_FACTOR = 16; // 低いほどパフォーマンスが高いがガタガタして安定しなくなる、逆に高すぎても何故か不安定になる
	private COMBO_INTERVAL = 60; // frame
	// mk-go: 4 = はみ出しの判定を「判定領域に 2 秒とどまったら」に変えた (#3193)。
	// 同じ操作の記録でも結果が変わるので、版を分けないと古いリプレイや途中保存が
	// 別の結末になる。**static も持つ** — 途中保存 (#3192) の版をゲームを作る前に
	// 比べるため。
	public static readonly VERSION = 4;
	public readonly GAME_VERSION = DropAndFusionGame.VERSION;
	public readonly GAME_WIDTH = 450;
	public readonly GAME_HEIGHT = 600;
	public readonly DROP_COOLTIME = 30; // frame
	public readonly PLAYAREA_MARGIN = 25;
	private STOCK_MAX = 4;
	/**
	 * How long a mono may stay in the overflow area before the game is over
	 * (mk-go, #3193).
	 */
	public readonly OVERFLOW_GRACE_MS = 2000;
	private WALL_THICKNESS = 100;
	// mk-go (#3194): bouncy / space で左右の壁を上へ伸ばす高さ。理由は constructor の
	// 壁の組み立てを参照。space は空気抵抗が 0 で重力が弱いので、玉が上へ弾かれると
	// 高く上がる (上向きの速さ 5.34 で約 3800。実際のプレイで出た最大値)。余裕を持たせる。
	private CONTAINING_WALL_EXTRA_HEIGHT = 6000;
	private TICK_DELTA = 1000 / 60; // 60fps

	public frame = 0;
	public engine: Matter.Engine;
	private tickCallbackQueue: { frame: number; callback: () => void; }[] = [];
	private overflowCollider: Matter.Body;
	private isGameOver = false;
	private gameMode: 'normal' | 'yen' | 'square' | 'sweets' | 'space' | 'bouncy';
	private rng: () => number;
	private logs: Log[] = [];

	/**
	 * フィールドに出ていて、かつ合体の対象となるアイテム
	 */
	private fusionReadyBodyIds: Matter.Body['id'][] = [];

	private gameOverReadyBodyIds: Matter.Body['id'][] = [];

	/**
	 * mk-go (#3193): 判定領域に入った玉と、入ったフレーム。出たら (合体して消えたら) 消す。
	 */
	private overflowingSince = new Map<Matter.Body['id'], number>();
	private overflowing = false;

	/**
	 * fusion予約アイテムのペア
	 * TODO: これらのモノは光らせるなどの演出をすると視覚的に楽しそう
	 */
	private fusionReservedPairs: { bodyA: Matter.Body; bodyB: Matter.Body }[] = [];

	private latestDroppedAt = 0; // frame
	private latestFusionedAt = 0; // frame
	private stock: { id: string; mono: Mono }[] = [];
	private holding: { id: string; mono: Mono } | null = null;

	public get monoDefinitions() {
		switch (this.gameMode) {
			case 'normal': return NORAML_MONOS;
			case 'yen': return YEN_MONOS;
			case 'square': return SQUARE_MONOS;
			case 'sweets': return SWEETS_MONOS;
			case 'space': return NORAML_MONOS;
			case 'bouncy': return NORAML_MONOS;
		}
	}

	private _combo = 0;
	private get combo() {
		return this._combo;
	}
	private set combo(value: number) {
		this._combo = value;
		this.emit('changeCombo', value);
	}

	private _score = 0;
	private get score() {
		return this._score;
	}
	private set score(value: number) {
		this._score = value;
		this.emit('changeScore', value);
	}

	private getMonoRenderOptions: null | ((mono: Mono) => Partial<Matter.IBodyRenderOptions>) = null;

	public replayPlaybackRate = 1;

	constructor(env: {
		seed: string;
		gameMode: DropAndFusionGame['gameMode'];
		getMonoRenderOptions?: (mono: Mono) => Partial<Matter.IBodyRenderOptions>;
	}) {
		super();

		//#region BIND
		this.tick = this.tick.bind(this);
		//#endregion

		this.gameMode = env.gameMode;
		this.getMonoRenderOptions = env.getMonoRenderOptions ?? null;
		this.rng = seedrandom(env.seed);

		// sweetsモードは重いため
		const physicsQualityFactor = this.gameMode === 'sweets' ? 4 : this.PHYSICS_QUALITY_FACTOR;
		this.engine = Matter.Engine.create({
			constraintIterations: 2 * physicsQualityFactor,
			positionIterations: 6 * physicsQualityFactor,
			velocityIterations: 4 * physicsQualityFactor,
			gravity: {
				x: 0,
				y: this.gameMode === 'space' ? 0.0125 : 1,
			},
			timing: {
				timeScale: 2,
			},
			enableSleeping: false,
		});

		this.engine.world.bodies = [];

		//#region walls
		const WALL_OPTIONS: Matter.IChamferableBodyDefinition = {
			label: '_wall_',
			isStatic: true,
			friction: 0.7,
			slop: this.gameMode === 'space' ? 0.01 : 0.7,
			render: {
				strokeStyle: 'transparent',
				fillStyle: 'transparent',
			},
		};

		// mk-go (#3194): bouncy / space は左右の壁を上へ伸ばし (見えない)、下の角を塞ぐ。
		// はみ出しの判定に猶予がある (#3193) と、漂う玉 (space) は壁の上を越え、よく弾む
		// 玉 (bouncy) は挟まれて角から押し出され、どちらも箱の外へ出て消えたままゲームが
		// 続く。**既存のモードは変えない** — 壁の形が変わると、同じ記録でも結末が変わる
		// (版 4 のリプレイと途中保存が別の盤面になる)。内側の面は同じ。
		// 各対策を外すと流出が再発することは実測で確かめた (壁の厚さは効かなかったので
		// 本家のまま)。
		// **角も塞ぐ。** 本家の床は GAME_WIDTH の幅しか無く、左右の壁は床の上面の高さで
		// 終わっているので、壁の下・床の外 (左下 / 右下の角の外側) に隙間がある。挟まれた
		// 玉はそこから抜けていた (実測: (-94, 712) で消えた)。床を壁の外まで広げ、壁を
		// 床の下まで伸ばす。
		const containsEscapes = this.gameMode === 'bouncy' || this.gameMode === 'space';
		const thickness = this.WALL_THICKNESS;
		const wallTop = containsEscapes ? -this.CONTAINING_WALL_EXTRA_HEIGHT : 0;
		const wallBottom = containsEscapes ? this.GAME_HEIGHT + thickness : this.GAME_HEIGHT;
		// 床は壁の外側の面まで。はみ出させると、壁の外に玉が載る段差ができる。
		const floorWidth = containsEscapes ? this.GAME_WIDTH + ((thickness - this.PLAYAREA_MARGIN) * 2) : this.GAME_WIDTH;
		Matter.Composite.add(this.engine.world, [
			Matter.Bodies.rectangle(this.GAME_WIDTH / 2, this.GAME_HEIGHT + (thickness / 2) - this.PLAYAREA_MARGIN, floorWidth, thickness, WALL_OPTIONS),
			Matter.Bodies.rectangle(this.GAME_WIDTH + (thickness / 2) - this.PLAYAREA_MARGIN, (wallTop + wallBottom) / 2, thickness, wallBottom - wallTop, WALL_OPTIONS),
			Matter.Bodies.rectangle(-((thickness / 2) - this.PLAYAREA_MARGIN), (wallTop + wallBottom) / 2, thickness, wallBottom - wallTop, WALL_OPTIONS),
		]);
		//#endregion

		this.overflowCollider = Matter.Bodies.rectangle(this.GAME_WIDTH / 2, 0, this.GAME_WIDTH, 200, {
			label: '_overflow_',
			isStatic: true,
			isSensor: true,
			render: {
				strokeStyle: 'transparent',
				fillStyle: 'transparent',
			},
		});
		Matter.Composite.add(this.engine.world, this.overflowCollider);
	}

	public msToFrame(ms: number) {
		return Math.round(ms / this.TICK_DELTA);
	}

	public frameToMs(frame: number) {
		return frame * this.TICK_DELTA;
	}

	/**
	 * Body physics for the BOUNCY mode (mk-go, #3194).
	 *
	 * 重力は通常のまま、玉の性質だけを変える。**空気抵抗は通常のまま** — 0 にすると
	 * 玉がいつまでも止まらない。
	 */
	private static readonly BOUNCY_PHYSICS = {
		restitution: 0.9,
		friction: 0.01,
		frictionStatic: 0,
		// 速さの上限 (matter-js の velocity の単位。timeScale が 2 なので 1 tick に動く
		// 距離はこの約 2 倍)。よく弾む玉は挟まれると 60 を超える速さで押し出され、その
		// 勢いのまま壁の中を進んで抜ける。normal の最大は実測 13.2 (同じ単位) なので、
		// 普通の動きには効かない値にしてある。
		maxSpeed: 15,
		// ほぼ止まっている玉に当たったときの跳ね返りを補う相手の速さの上限。物理エンジンは
		// 積み重なった玉への衝突で勢いを下の玉と床へ逃がすので、落ちている玉に当たっても
		// ほとんど跳ねない (実測: 同じ玉が床で 169px 跳ねるのに、玉の上では 1px に満たない。
		// 弾みを上げても玉の上は伸びない)。止まっている玉を床と同じ「動かない相手」とみなして補う。
		// 単位は maxSpeed と同じ (tick 後の velocity)。
		restingSpeed: 0.75,
		// 補う量の係数。目標は「近づいた速さ x 弾み x この係数」の離れる速さ。玉の上で床より
		// 少し高く跳ねるくらいを、実際に遊んで決めた (同じ玉で 1.0 なら 157px / 1.2 で 219px /
		// 1.4 で 283px、床は 169px)。
		assistRatio: 1.2,
	};

	/**
	 * Collisions of the BOUNCY mode with a (nearly) resting mono, to be given a
	 * proper rebound after the engine update (mk-go, #3194).
	 */
	private bounceAssists: { mover: Matter.Body; other: Matter.Body; nx: number; ny: number; approach: number }[] = [];

	private createBody(mono: Mono, x: number, y: number) {
		const bouncy = this.gameMode === 'bouncy';
		const options = {
			label: mono.id,
			density: this.gameMode === 'space' ? 0.01 : ((mono.sizeX * mono.sizeY) / 10000),
			restitution: this.gameMode === 'space' ? 0.5 : bouncy ? DropAndFusionGame.BOUNCY_PHYSICS.restitution : 0.2,
			frictionAir: this.gameMode === 'space' ? 0 : 0.01,
			friction: this.gameMode === 'space' ? 0.5 : bouncy ? DropAndFusionGame.BOUNCY_PHYSICS.friction : 0.7,
			frictionStatic: this.gameMode === 'space' ? 0 : bouncy ? DropAndFusionGame.BOUNCY_PHYSICS.frictionStatic : 5,
			slop: this.gameMode === 'space' ? 0.01 : 0.7,
			//mass: 0,
			render: this.getMonoRenderOptions ? this.getMonoRenderOptions(mono) : undefined,
		} satisfies Matter.IChamferableBodyDefinition;
		if (mono.shape === 'circle') {
			return Matter.Bodies.circle(x, y, mono.sizeX / 2, options);
		} else if (mono.shape === 'rectangle') {
			return Matter.Bodies.rectangle(x, y, mono.sizeX, mono.sizeY, options);
		} else if (mono.shape === 'custom' && mono.vertices != null && mono.verticesSize != null) { //eslint-disable-line @typescript-eslint/no-unnecessary-condition
			return Matter.Bodies.fromVertices(x, y, mono.vertices.map(i => i.map(j => ({
				x: (j.x / mono.verticesSize!) * mono.sizeX, //eslint-disable-line @typescript-eslint/no-non-null-assertion
				y: (j.y / mono.verticesSize!) * mono.sizeY, //eslint-disable-line @typescript-eslint/no-non-null-assertion
			}))), options);
		} else {
			throw new Error('unrecognized shape');
		}
	}

	private fusion(bodyA: Matter.Body, bodyB: Matter.Body) {
		if (this.latestFusionedAt > this.frame - this.COMBO_INTERVAL) {
			this.combo++;
		} else {
			this.combo = 1;
		}
		this.latestFusionedAt = this.frame;

		const newX = (bodyA.position.x + bodyB.position.x) / 2;
		const newY = (bodyA.position.y + bodyB.position.y) / 2;

		this.fusionReadyBodyIds = this.fusionReadyBodyIds.filter(x => x !== bodyA.id && x !== bodyB.id);
		this.gameOverReadyBodyIds = this.gameOverReadyBodyIds.filter(x => x !== bodyA.id && x !== bodyB.id);
		Matter.Composite.remove(this.engine.world, [bodyA, bodyB]);

		const currentMono = this.monoDefinitions.find(y => y.id === bodyA.label);

		if (currentMono == null) {
			throw new Error('Current Mono Not Found');
		}

		const nextMono = this.monoDefinitions.find(x => x.level === currentMono.level + 1) ?? null;

		if (nextMono) {
			const body = this.createBody(nextMono, newX, newY);
			Matter.Composite.add(this.engine.world, body);

			// 連鎖してfusionした場合の分かりやすさのため少し間を置いてからfusion対象になるようにする
			this.tickCallbackQueue.push({
				frame: this.frame + this.msToFrame(100),
				callback: () => {
					this.fusionReadyBodyIds.push(body.id);
				},
			});

			this.emit('monoAdded', nextMono);
		}

		const hasComboBonus = this.gameMode !== 'yen' && this.gameMode !== 'sweets';
		const comboBonus = hasComboBonus ? 1 + ((this.combo - 1) / 5) : 1;
		const additionalScore = Math.round(currentMono.score * comboBonus);
		this.score += additionalScore;

		this.emit('fusioned', newX, newY, nextMono, additionalScore);
	}

	private onCollision(event: Matter.IEventCollision<Matter.Engine>) {
		for (const pairs of event.pairs) {
			const { bodyA, bodyB } = pairs;

			const shouldFusion = (bodyA.label === bodyB.label) &&
				!this.fusionReservedPairs.some(x =>
					x.bodyA.id === bodyA.id ||
					x.bodyA.id === bodyB.id ||
					x.bodyB.id === bodyA.id ||
					x.bodyB.id === bodyB.id);

			if (shouldFusion) {
				if (this.fusionReadyBodyIds.includes(bodyA.id) && this.fusionReadyBodyIds.includes(bodyB.id)) {
					this.fusion(bodyA, bodyB);
				} else {
					this.fusionReservedPairs.push({ bodyA, bodyB });
					this.tickCallbackQueue.push({
						frame: this.frame + this.msToFrame(100),
						callback: () => {
							this.fusionReservedPairs = this.fusionReservedPairs.filter(x => x.bodyA.id !== bodyA.id && x.bodyB.id !== bodyB.id);
							this.fusion(bodyA, bodyB);
						},
					});
				}
			} else {
				const energy = pairs.collision.depth;

				if (bodyA.label === '_overflow_' || bodyB.label === '_overflow_') continue;

				if (bodyA.label !== '_wall_' && bodyB.label !== '_wall_') {
					this.recordBounceAssist(bodyA.parent, bodyB.parent);
				}

				if (bodyA.label !== '_wall_' && bodyB.label !== '_wall_') {
					if (!this.gameOverReadyBodyIds.includes(bodyA.id)) this.gameOverReadyBodyIds.push(bodyA.id);
					if (!this.gameOverReadyBodyIds.includes(bodyB.id)) this.gameOverReadyBodyIds.push(bodyB.id);
				}

				this.emit('collision', energy, bodyA, bodyB);
			}
		}
	}

	private recordBounceAssist(a: Matter.Body, b: Matter.Body) {
		// bouncy だけ。**条件はここ 1 か所** — 適用 (tick) はモードを見ずに毎回呼ぶ。
		if (this.gameMode !== 'bouncy') return;
		// **単位を tick 後に揃える。** 衝突の通知は Engine.update の途中 (位置を進めた直後) に
		// 来るので、ここの velocity は 1 step の移動量で、tick 後の値 (applyBounceAssists と
		// limitSpeed が読む) の timeScale 倍になっている。揃えないと近づく速さを 2 倍に
		// 見積もり、跳ね返りが元の速さを上回る。
		const scale = 1 / this.engine.timing.timeScale;
		const va = { x: a.velocity.x * scale, y: a.velocity.y * scale };
		const vb = { x: b.velocity.x * scale, y: b.velocity.y * scale };
		const speedA = Math.sqrt((va.x * va.x) + (va.y * va.y));
		const speedB = Math.sqrt((vb.x * vb.x) + (vb.y * vb.y));
		const [mover, other, vm, vo] = speedA >= speedB ? [a, b, va, vb] : [b, a, vb, va];
		if (Math.min(speedA, speedB) > DropAndFusionGame.BOUNCY_PHYSICS.restingSpeed) return;
		const dx = other.position.x - mover.position.x;
		const dy = other.position.y - mover.position.y;
		const d = Math.sqrt((dx * dx) + (dy * dy));
		if (d === 0) return;
		const nx = dx / d;
		const ny = dy / d;
		// 衝突の瞬間 (まだ解決前) に近づいていた速さ。
		const approach = ((vm.x - vo.x) * nx) + ((vm.y - vo.y) * ny);
		if (approach <= 0) return;
		this.bounceAssists.push({ mover, other, nx, ny, approach });
	}

	/**
	 * Gives a mono that hit a resting mono about the rebound it would get from the
	 * floor (mk-go, #3194). 物理エンジンが解決した後に離れていく速さが、近づいた速さ x
	 * 弾みに届かなければ、その差を動いていた側に足す。記録順に処理するので決定的。
	 */
	private applyBounceAssists() {
		const assists = this.bounceAssists;
		if (assists.length === 0) return;
		this.bounceAssists = [];
		const alive = new Set(this.engine.world.bodies.map(b => b.id));
		for (const { mover, other, nx, ny, approach } of assists) {
			// 合体で消えた玉は対象外。
			if (!alive.has(mover.id) || !alive.has(other.id)) continue;
			// 動いていた側**自身**の離れる速さで見る (当てられた相手の動きに左右されない)。
			const separating = -((mover.velocity.x * nx) + (mover.velocity.y * ny));
			const wanted = approach * DropAndFusionGame.BOUNCY_PHYSICS.restitution * DropAndFusionGame.BOUNCY_PHYSICS.assistRatio;
			if (separating >= wanted) continue;
			const add = wanted - separating;
			Matter.Body.setVelocity(mover, {
				x: mover.velocity.x - (nx * add),
				y: mover.velocity.y - (ny * add),
			});
		}
	}

	private limitSpeed(maxSpeed: number) {
		for (const b of this.engine.world.bodies) {
			if (b.isStatic) continue;
			// Math.hypot は丸めがエンジンごとに違いうる (仕様が正確な丸めを要求しない)。
			// リプレイの結末がブラウザで変わらないよう、sqrt で計算する。
			const speed = Math.sqrt((b.velocity.x * b.velocity.x) + (b.velocity.y * b.velocity.y));
			if (speed > maxSpeed) {
				Matter.Body.setVelocity(b, {
					x: b.velocity.x * (maxSpeed / speed),
					y: b.velocity.y * (maxSpeed / speed),
				});
			}
		}
	}

	/**
	 * Ends the game when a mono has stayed in the overflow area for
	 * OVERFLOW_GRACE_MS (mk-go, #3193).
	 *
	 * 本家は判定領域に**1 フレームでも触れたら**終わる。合体で生まれた大きい玉が
	 * 周りの玉を押し広げると、玉が一瞬上へ弾かれることがあり、盤面に余裕があるのに
	 * 終わっていた。
	 *
	 * **毎フレーム重なりを調べる** (衝突イベントの発火順に頼らない)。合体して
	 * 消えた玉は world から外れているので、ここで自然に記録から落ちる。
	 * **フレーム数で数える** — 実時間を使うとリプレイと途中保存の早送りが別の
	 * 結果になる。
	 */
	private checkOverflow() {
		// 他の玉とぶつかったことのある玉だけを数える (落とした直後の玉が上部を
		// 通過しても終わらない)。複数の部品でできた玉 (sweets) は、部品の id で
		// 記録されていることがあるので、部品まで見る。
		const candidates = this.engine.world.bodies.filter(b =>
			b.id !== this.overflowCollider.id &&
			b.parts.some(p => this.gameOverReadyBodyIds.includes(p.id)));

		const hits = new Set<Matter.Body['id']>();
		for (const collision of Matter.Query.collides(this.overflowCollider, candidates)) {
			const other = collision.bodyA.parent.id === this.overflowCollider.id ? collision.bodyB : collision.bodyA;
			hits.add(other.parent.id);
		}

		// 念のため: 壁や床を丸ごと突き抜けて失われた玉があれば終了する。本家は判定領域に
		// 触れた瞬間に終わるので、箱の外へ出た玉がそのまま残ることは無かった。猶予を
		// 持たせた今、起きると玉が消えたまま続き、実質「玉を捨てる」操作になる (よく弾む
		// 物理で実際に起きた。今のモードでは実測 0)。**壁の内側の面では判定しない** —
		// 挟まれた玉は一瞬めり込んで次の tick で押し戻される。そこで終わらせると、それ
		// 自体が理不尽なゲームオーバーになる。
		for (const b of this.engine.world.bodies) {
			if (b.isStatic) continue;
			if (b.position.x < -this.WALL_THICKNESS || b.position.x > this.GAME_WIDTH + this.WALL_THICKNESS || b.position.y > this.GAME_HEIGHT + this.WALL_THICKNESS) {
				this.gameOver();
				return;
			}
		}

		for (const id of [...this.overflowingSince.keys()]) {
			if (!hits.has(id)) this.overflowingSince.delete(id);
		}
		for (const id of hits) {
			if (!this.overflowingSince.has(id)) this.overflowingSince.set(id, this.frame);
		}

		const overflowing = this.overflowingSince.size > 0;
		if (overflowing !== this.overflowing) {
			this.overflowing = overflowing;
			this.emit('overflowWarning', overflowing);
		}

		const grace = this.msToFrame(this.OVERFLOW_GRACE_MS);
		for (const since of this.overflowingSince.values()) {
			if (this.frame - since >= grace) {
				this.gameOver();
				return;
			}
		}
	}

	public surrender() {
		this.logs.push({
			frame: this.frame,
			operation: 'surrender',
		});

		this.gameOver();
	}

	private gameOver() {
		if (this.isGameOver) return;
		this.isGameOver = true;
		// **gameOver を先に出す。** 警告の解除を先に出すと、受け取る側からは
		// 「はみ出しが解けて続いた」ように見える。
		this.emit('gameOver');
		if (this.overflowing) {
			this.overflowing = false;
			this.emit('overflowWarning', false);
		}
	}

	public start() {
		for (let i = 0; i < this.STOCK_MAX; i++) {
			this.stock.push({
				id: this.rng().toString(),
				mono: this.monoDefinitions.filter(x => x.dropCandidate)[Math.floor(this.rng() * this.monoDefinitions.filter(x => x.dropCandidate).length)],
			});
		}
		this.emit('changeStock', this.stock);

		Matter.Events.on(this.engine, 'collisionStart', this.onCollision.bind(this));
	}

	public getLogs() {
		return this.logs;
	}

	public tick() {
		this.frame++;

		if (this.latestFusionedAt < this.frame - this.COMBO_INTERVAL) {
			this.combo = 0;
		}

		this.tickCallbackQueue = this.tickCallbackQueue.filter(x => {
			if (x.frame === this.frame) {
				x.callback();
				return false;
			} else {
				return true;
			}
		});

		Matter.Engine.update(this.engine, this.TICK_DELTA);

		// 記録は bouncy のときだけ (recordBounceAssist)。ほかのモードでは空なので何も起きない。
		this.applyBounceAssists();
		if (this.gameMode === 'bouncy') this.limitSpeed(DropAndFusionGame.BOUNCY_PHYSICS.maxSpeed);

		if (!this.isGameOver) this.checkOverflow();

		const hasNextTick = !this.isGameOver;

		return hasNextTick;
	}

	public getActiveMonos() {
		return this.engine.world.bodies
			.map(x => this.monoDefinitions.find((mono) => mono.id === x.label))
			.filter(x => x !== undefined);
	}

	public drop(_x: number) {
		if (this.isGameOver) return;
		if (this.frame - this.latestDroppedAt < this.DROP_COOLTIME) return;

		const head = this.stock.shift();
		if (!head) return;

		this.stock.push({
			id: this.rng().toString(),
			mono: this.monoDefinitions.filter(x => x.dropCandidate)[Math.floor(this.rng() * this.monoDefinitions.filter(x => x.dropCandidate).length)],
		});
		this.emit('changeStock', this.stock);

		const inputX = Math.round(_x);
		const x = Math.min(this.GAME_WIDTH - this.PLAYAREA_MARGIN - (head.mono.sizeX / 2), Math.max(this.PLAYAREA_MARGIN + (head.mono.sizeX / 2), inputX));
		const body = this.createBody(head.mono, x, 50 + head.mono.sizeY / 2);
		this.logs.push({
			frame: this.frame,
			operation: 'drop',
			x: inputX,
		});

		// add force
		if (this.gameMode === 'space') {
			Matter.Body.applyForce(body, body.position, {
				x: 0,
				y: (Math.PI * head.mono.sizeX * head.mono.sizeY) / 65536,
			});
		}

		Matter.Composite.add(this.engine.world, body);

		this.fusionReadyBodyIds.push(body.id);
		this.latestDroppedAt = this.frame;

		this.emit('dropped', x);
		this.emit('monoAdded', head.mono);
	}

	public hold() {
		if (this.isGameOver) return;

		this.logs.push({
			frame: this.frame,
			operation: 'hold',
		});

		if (this.holding) {
			const head = this.stock.shift();
			if (!head) return;
			this.stock.unshift(this.holding);
			this.holding = head;
			this.emit('changeHolding', this.holding);
			this.emit('changeStock', this.stock);
		} else {
			const head = this.stock.shift();
			if (!head) return;
			this.holding = head;
			this.stock.push({
				id: this.rng().toString(),
				mono: this.monoDefinitions.filter(x => x.dropCandidate)[Math.floor(this.rng() * this.monoDefinitions.filter(x => x.dropCandidate).length)],
			});
			this.emit('changeHolding', this.holding);
			this.emit('changeStock', this.stock);
		}
	}

	public static serializeLogs(logs: Log[]) {
		const _logs: number[][] = [];

		for (let i = 0; i < logs.length; i++) {
			const log = logs[i];
			const frameDelta = i === 0 ? log.frame : log.frame - logs[i - 1].frame;

			switch (log.operation) {
				case 'drop':
					_logs.push([frameDelta, 0, log.x]);
					break;
				case 'hold':
					_logs.push([frameDelta, 1]);
					break;
				case 'surrender':
					_logs.push([frameDelta, 2]);
					break;
			}
		}

		return _logs;
	}

	public static deserializeLogs(logs: number[][]) {
		const _logs: Log[] = [];

		let frame = 0;

		for (const log of logs) {
			const frameDelta = log[0];
			frame += frameDelta;

			const operation = log[1];

			switch (operation) {
				case 0:
					_logs.push({
						frame,
						operation: 'drop',
						x: log[2],
					});
					break;
				case 1:
					_logs.push({
						frame,
						operation: 'hold',
					});
					break;
				case 2:
					_logs.push({
						frame,
						operation: 'surrender',
					});
					break;
			}
		}

		return _logs;
	}

	public dispose() {
		Matter.World.clear(this.engine.world, false);
		Matter.Engine.clear(this.engine);
	}
}
