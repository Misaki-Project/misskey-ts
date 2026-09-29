<!--
SPDX-FileCopyrightText: Misaki Project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div class="_gaps_m">
	<MkInfo>{{ i18n.ts._roleLevel.editorDescription }}</MkInfo>

	<MkInput v-model="config.baseLevel" type="number" :min="0" :readonly="readonly">
		<template #label>{{ i18n.ts._roleLevel.baseLevel }}</template>
	</MkInput>

	<MkFolder defaultOpen>
		<template #label>{{ i18n.ts._roleLevel.experienceCurve }}</template>
		<div class="_gaps_m">
			<div v-for="(curve, index) in config.experienceCurve" :key="index" class="_panel _gaps_s" :class="$style.item">
				<div :class="$style.itemHeader">
					<b>{{ i18n.tsx._roleLevel.segment({ n: index + 1 }) }}</b>
					<MkButton v-if="!readonly && config.experienceCurve.length > 1" danger small @click="removeCurve(index)"><i class="ti ti-trash"></i></MkButton>
				</div>
				<MkSelect v-model="curve.type" :items="curveTypes" :readonly="readonly">
					<template #label>{{ i18n.ts._roleLevel.calculation }}</template>
				</MkSelect>
				<MkInput v-model="curve.levelUps" type="number" :min="1" :readonly="readonly"><template #label>{{ i18n.ts._roleLevel.levelUps }}</template></MkInput>
				<MkInput v-model="curve.base" type="number" :min="0" :readonly="readonly"><template #label>{{ i18n.ts._roleLevel.baseExperience }}</template></MkInput>
				<MkInput v-if="curve.type !== 'const'" v-model="curve.additional" type="number" :readonly="readonly"><template #label>{{ i18n.ts._roleLevel.additionalExperience }}</template></MkInput>
				<MkInput v-if="curve.type === 'exponential'" v-model="curve.exponential" type="number" :min="0" :step="0.001" :readonly="readonly"><template #label>{{ i18n.ts._roleLevel.exponential }}</template></MkInput>
			</div>
			<MkButton v-if="!readonly" @click="addCurve"><i class="ti ti-plus"></i> {{ i18n.ts._roleLevel.addSegment }}</MkButton>
		</div>
	</MkFolder>

	<MkFolder defaultOpen>
		<template #label>{{ i18n.ts._roleLevel.policyRanges }}</template>
		<template #caption>{{ i18n.ts._roleLevel.policyRangesDescription }}</template>
		<div class="_gaps_m">
			<div v-for="(range, index) in editableRanges" :key="index" class="_panel _gaps_s" :class="$style.item">
				<div :class="$style.itemHeader">
					<b>{{ i18n.tsx._roleLevel.range({ n: index + 1 }) }}</b>
					<MkButton v-if="!readonly && editableRanges.length > 1" danger small @click="removeRange(index)"><i class="ti ti-trash"></i></MkButton>
				</div>
				<MkSelect v-model="range.type" :items="rangeTypes" :readonly="readonly"><template #label>{{ i18n.ts._roleLevel.rangeType }}</template></MkSelect>
				<div :class="$style.columns">
					<MkInput v-model="range.start" type="number" :min="1" :readonly="readonly"><template #label>{{ i18n.ts._roleLevel.startStage }}</template></MkInput>
					<MkInput v-model="range.end" type="number" :min="2" :readonly="readonly"><template #label>{{ i18n.ts._roleLevel.endStage }}</template></MkInput>
				</div>
				<template v-if="range.type !== 'base'">
					<MkInput v-model="range.key" :readonly="readonly"><template #label>{{ i18n.ts._roleLevel.policyKey }}</template></MkInput>
				</template>
				<MkInput v-if="range.type === 'const'" v-model="range.valueText" :readonly="readonly" @change="parseRangeValue(range)">
					<template #label>{{ i18n.ts._roleLevel.constantValue }}</template>
					<template #caption>{{ i18n.ts._roleLevel.constantValueDescription }}</template>
				</MkInput>
				<template v-if="range.type === 'multiplier'">
					<MkInput v-model="range.base" type="number" :readonly="readonly"><template #label>{{ i18n.ts._roleLevel.multiplierBase }}</template></MkInput>
					<MkInput v-model="range.additional" type="number" :readonly="readonly"><template #label>{{ i18n.ts._roleLevel.multiplierAdditional }}</template></MkInput>
				</template>
			</div>
			<MkButton v-if="!readonly" @click="addRange"><i class="ti ti-plus"></i> {{ i18n.ts._roleLevel.addRange }}</MkButton>
		</div>
	</MkFolder>
</div>
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import MkButton from '@/components/MkButton.vue';
import MkFolder from '@/components/MkFolder.vue';
import MkInfo from '@/components/MkInfo.vue';
import MkInput from '@/components/MkInput.vue';
import MkSelect from '@/components/MkSelect.vue';
import { i18n } from '@/i18n.js';
import type { RoleLevelConfig, RoleLevelPolicyRange } from '@/utility/role-level-api.js';

type EditableRange = Omit<RoleLevelPolicyRange, 'key' | 'base' | 'additional'> & {
	key: string;
	base: number;
	additional: number;
	valueText: string;
};

const props = defineProps<{ modelValue: RoleLevelConfig; readonly?: boolean }>();
const config = computed(() => props.modelValue);
const editableRanges = computed(() => config.value.policyRanges as unknown as EditableRange[]);

for (const range of editableRanges.value) prepareRange(range);

const curveTypes = [
	{ label: i18n.ts._roleLevel.constant, value: 'const' },
	{ label: i18n.ts._roleLevel.linear, value: 'linear' },
	{ label: i18n.ts._roleLevel.exponential, value: 'exponential' },
];
const rangeTypes = [
	{ label: i18n.ts._roleLevel.useBasePolicy, value: 'base' },
	{ label: i18n.ts._roleLevel.constant, value: 'const' },
	{ label: i18n.ts._roleLevel.multiplier, value: 'multiplier' },
];

function prepareRange(range: EditableRange) {
	range.key ??= '';
	range.base ??= 0;
	range.additional ??= 0;
	range.valueText ??= JSON.stringify(range.value ?? null);
}

function addCurve() {
	config.value.experienceCurve.push({ type: 'const', levelUps: 1, base: 100, additional: 0, exponential: 1 });
}

function removeCurve(index: number) {
	config.value.experienceCurve.splice(index, 1);
}

function addRange() {
	const start = editableRanges.value.at(-1)?.end ?? 1;
	const range: EditableRange = { type: 'base', start, end: start + 1, key: '', base: 0, additional: 0, valueText: 'null' };
	editableRanges.value.push(range);
}

function removeRange(index: number) {
	editableRanges.value.splice(index, 1);
}

function parseRangeValue(range: EditableRange) {
	try {
		range.value = JSON.parse(range.valueText ?? 'null');
	} catch {
		range.value = range.valueText ?? '';
	}
}
</script>

<style lang="scss" module>
.item { padding: 16px; }
.itemHeader { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
</style>
