<!--
SPDX-FileCopyrightText: Misaki Project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkTooltip :showing="showing" :anchorElement="anchorElement" :maxWidth="300" direction="top" @closed="emit('closed')">
	<div :class="$style.root">
		<template v-if="level">
			<div :class="$style.summary">
				<strong :class="$style.level">Lv. {{ level.level.currentLevel }}</strong>
				<template v-if="level.level.nextLevelExp == null">
					(<strong>MAX!!</strong><template v-if="level.level.currentLevelExp > 0"> +{{ level.level.currentLevelExp }}</template>)
				</template>
				<template v-else>({{ level.level.currentLevelExp }} / {{ level.level.nextLevelExp }})</template>
			</div>
			<div :class="$style.gauge" role="progressbar" :aria-valuenow="progress" aria-valuemin="0" aria-valuemax="100">
				<div :class="$style.gaugeValue" :style="{ width: `${progress}%` }"></div>
			</div>
		</template>
		<Mfm v-if="showDescription && role?.description" :text="role.description"/>
	</div>
</MkTooltip>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import MkTooltip from '@/components/MkTooltip.vue';
import type { RoleLevelUserRole } from '@/utility/role-level-api.js';

const props = withDefaults(defineProps<{
	showing: boolean;
	anchorElement: HTMLElement;
	role?: { description: string };
	level?: RoleLevelUserRole;
	showDescription?: boolean;
}>(), {
	showDescription: true,
});

const emit = defineEmits<{
	(ev: 'closed'): void;
}>();

const progress = computed(() => {
	if (props.level == null || props.level.level.nextLevelExp == null) return 100;
	const levelCost = props.level.level.currentLevelExp + props.level.level.nextLevelExp;
	if (levelCost <= 0) return 0;
	return Math.min(100, Math.max(0, (props.level.level.currentLevelExp / levelCost) * 100));
});
</script>

<style lang="scss" module>
.root {
	display: grid;
	gap: 8px;
}

.summary {
	white-space: nowrap;
}

.level {
	font-size: 1.5em;
}

.gauge {
	height: 5px;
	overflow: hidden;
	background: var(--MI_THEME-accentedBg);
	border-radius: 4px;
}

.gaugeValue {
	height: 100%;
	background: var(--MI_THEME-accent);
	transition: width 0.3s;
}
</style>
