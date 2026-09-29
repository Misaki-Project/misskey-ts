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
import type { RoleLevelConfig } from '@/utility/role-level-api.js';

const props = defineProps<{ modelValue: RoleLevelConfig; readonly?: boolean }>();
const config = computed(() => props.modelValue);

const curveTypes = [
	{ label: i18n.ts._roleLevel.constant, value: 'const' },
	{ label: i18n.ts._roleLevel.linear, value: 'linear' },
	{ label: i18n.ts._roleLevel.exponential, value: 'exponential' },
];

function addCurve() {
	config.value.experienceCurve.push({ type: 'const', levelUps: 1, base: 100, additional: 0, exponential: 1 });
}

function removeCurve(index: number) {
	config.value.experienceCurve.splice(index, 1);
}

</script>

<style lang="scss" module>
.item { padding: 16px; }
.itemHeader { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
</style>
