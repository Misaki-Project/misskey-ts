<!--
SPDX-FileCopyrightText: Misaki Project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkFolder v-if="config" :defaultOpen="ranges.length > 0">
	<template #icon><i class="ti ti-trending-up"></i></template>
	<template #label>{{ i18n.ts._roleLevel.policyRanges }}</template>
	<template #suffix>{{ ranges.length }}</template>
	<div class="_gaps_s">
		<MkInfo>{{ i18n.ts._roleLevel.perPolicyRangesDescription }}</MkInfo>
		<div v-for="(range, index) in ranges" :key="rangeIdentity(range)" class="_panel _gaps_s" :class="$style.range">
			<div :class="$style.header">
				<b>{{ i18n.tsx._roleLevel.range({ n: index + 1 }) }}</b>
				<MkButton v-if="!readonly" danger small @click="removeRange(range)"><i class="ti ti-trash"></i></MkButton>
			</div>
			<MkSelect v-model="range.type" :items="rangeTypes" :readonly="readonly">
				<template #label>{{ i18n.ts._roleLevel.rangeType }}</template>
			</MkSelect>
			<div :class="$style.columns">
				<MkInput v-model="range.start" type="number" :min="1" :max="maxStage" :readonly="readonly"><template #label>{{ i18n.ts._roleLevel.startStage }}</template></MkInput>
				<MkInput v-model="range.end" type="number" :min="2" :max="maxStage + 1" :readonly="readonly"><template #label>{{ i18n.ts._roleLevel.endStage }}</template></MkInput>
			</div>
			<MkInput v-if="range.type === 'const'" v-model="range.valueText" :readonly="readonly" @change="parseValue(range)">
				<template #label>{{ i18n.ts._roleLevel.constantValue }}</template>
				<template #caption>{{ i18n.ts._roleLevel.constantValueDescription }}</template>
			</MkInput>
			<template v-else>
				<MkInput v-model="range.base" type="number" :readonly="readonly"><template #label>{{ i18n.ts._roleLevel.multiplierBase }}</template></MkInput>
				<MkInput v-model="range.additional" type="number" :readonly="readonly"><template #label>{{ i18n.ts._roleLevel.multiplierAdditional }}</template></MkInput>
			</template>
		</div>
		<MkButton v-if="!readonly" @click="addRange"><i class="ti ti-plus"></i> {{ i18n.ts._roleLevel.addPolicyRange }}</MkButton>
	</div>
</MkFolder>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import MkButton from '@/components/MkButton.vue';
import MkFolder from '@/components/MkFolder.vue';
import MkInfo from '@/components/MkInfo.vue';
import MkInput from '@/components/MkInput.vue';
import MkSelect from '@/components/MkSelect.vue';
import { i18n } from '@/i18n.js';
import { instance } from '@/instance.js';
import type { RoleLevelConfig, RoleLevelPolicyRange } from '@/utility/role-level-api.js';

type EditableRange = Omit<RoleLevelPolicyRange, 'key' | 'base' | 'additional'> & {
	key: string;
	base: number;
	additional: number;
	valueText: string;
};

const props = defineProps<{
	config?: RoleLevelConfig;
	policyKey: string;
	readonly?: boolean;
}>();

const numericPolicyKeys = new Set([
	'antennaLimit', 'avatarDecorationLimit', 'chunkedUploadMaxConcurrentSessions',
	'chunkedUploadMaxPendingMb', 'clipLimit', 'driveCapacityMb', 'emojiApplicationMaxPending',
	'emojiApplicationMaxPerDay', 'emojiApplicationMaxPerMonth', 'emojiApplicationMaxPerWeek',
	'inviteExpirationTime', 'inviteLimit', 'inviteLimitCycle', 'maxFileSizeMb', 'mentionLimit',
	'noteDraftLimit', 'noteEachClipsLimit', 'pinLimit', 'rateLimitFactor', 'scheduledNoteLimit',
	'userEachUserListsLimit', 'userListLimit', 'webhookLimit', 'wordMuteLimit',
]);

const maxStage = computed(() => 1 + (props.config?.experienceCurve.reduce((sum, curve) => sum + Number(curve.levelUps), 0) ?? 0));
const ranges = computed(() => (props.config?.policyRanges ?? []).filter(range => range.key === props.policyKey) as EditableRange[]);
const rangeTypes = computed(() => [
	{ label: i18n.ts._roleLevel.constant, value: 'const' },
	...(numericPolicyKeys.has(props.policyKey) ? [{ label: i18n.ts._roleLevel.multiplier, value: 'multiplier' }] : []),
]);

for (const range of ranges.value) prepareRange(range);

function prepareRange(range: EditableRange) {
	range.valueText ??= JSON.stringify(range.value ?? null);
	range.base ??= 0;
	range.additional ??= 0;
}

function rangeIdentity(range: EditableRange) {
	return `${range.start}:${range.end}:${props.config?.policyRanges.indexOf(range) ?? -1}`;
}

function addRange() {
	if (!props.config) return;
	const previous = ranges.value.at(-1);
	const start = Math.min(previous?.end ?? 1, maxStage.value);
	const defaultValue = (instance.policies as unknown as Record<string, unknown>)[props.policyKey] ?? null;
	const range: EditableRange = {
		type: 'const',
		key: props.policyKey,
		start,
		end: Math.min(maxStage.value + 1, start + 1),
		value: defaultValue,
		valueText: JSON.stringify(defaultValue),
		base: typeof defaultValue === 'number' ? defaultValue : 0,
		additional: 0,
	};
	props.config.policyRanges.push(range);
}

function removeRange(range: EditableRange) {
	if (!props.config) return;
	const index = props.config.policyRanges.indexOf(range);
	if (index >= 0) props.config.policyRanges.splice(index, 1);
}

function parseValue(range: EditableRange) {
	try {
		range.value = JSON.parse(range.valueText ?? 'null');
	} catch {
		range.value = range.valueText ?? '';
	}
}
</script>

<style lang="scss" module>
.range {
	padding: 16px;
}

.header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
}

.columns {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: 12px;
}
</style>
